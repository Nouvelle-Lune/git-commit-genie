import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { hashContent, SnapshotIdentity, SourceObservation } from '../../services/git/repositorySnapshot';
import {
    buildConsolidationGroups,
    consolidatePending,
    ConsolidationGroup,
    ConsolidationRunner,
    ConsolidationValidation,
    projectConsolidation,
    validateConsolidation,
} from '../../services/memory/consolidator';
import { LLMExecution } from '../../services/llm/llmTypes';
import { AIRunRequest, AIRunResponse } from '../../services/llm/providers';
import { MemoryStore } from '../../services/memory/store';
import { HandbookEntry, InvestigationEpisode } from '../../services/memory/types';
import { MEMORY_DEFAULTS, MemorySettings } from '../../services/memory/settings';

describe('memory consolidation evidence grouping', () => {
    it('groups only exact paths with two direct independent snapshots', () => {
        const episodes = [
            makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/shared.ts' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/shared.ts' }),
            makeEpisode({ episodeId: uuidFor(3), snapshotId: digestFor(3), sourcePath: 'src/other.ts' }),
            makeEpisode({ episodeId: uuidFor(4), snapshotId: digestFor(4), sourcePath: 'src/another.ts' }),
            makeEpisode({ episodeId: uuidFor(5), snapshotId: digestFor(5), sourcePath: 'src/memory-only.ts', tool: 'readMemorySources' }),
            makeEpisode({ episodeId: uuidFor(6), snapshotId: digestFor(6), sourcePath: 'src/memory-only.ts', tool: 'readMemorySources' }),
            makeEpisode({ episodeId: uuidFor(7), snapshotId: digestFor(7), sourcePath: 'src/cancelled.ts', status: 'cancelled' }),
            makeEpisode({ episodeId: uuidFor(8), snapshotId: digestFor(8), sourcePath: 'src/cancelled.ts', status: 'cancelled' }),
        ];

        const groups = buildConsolidationGroups(episodes, []);

        assert.deepEqual(groups.map(group => group.anchorPath), ['src/shared.ts']);
        assert.equal(groups[0].sources.length, 2);
        assert.deepEqual(new Set(groups[0].sources.map(source => source.episode.snapshot.id)),
            new Set([digestFor(1), digestFor(2)]));
    });

    it('projects bounded G/S/V handles and evidence metadata without persistent IDs', () => {
        // Verify the model input nests global S* handles under G* groups and V* snapshots without exposing persistent identifiers.
        const episodes = [
            makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/parser.ts', sourceExcerpt: 'parser snapshot one first' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(1), sourcePath: 'src/parser.ts', sourceExcerpt: 'parser snapshot one second' }),
            makeEpisode({ episodeId: uuidFor(3), snapshotId: digestFor(2), sourcePath: 'src/parser.ts', sourceExcerpt: 'parser snapshot two' }),
            makeEpisode({ episodeId: uuidFor(4), snapshotId: digestFor(1), sourcePath: 'src/other.ts', sourceExcerpt: 'other snapshot one' }),
            makeEpisode({ episodeId: uuidFor(5), snapshotId: digestFor(2), sourcePath: 'src/other.ts', sourceExcerpt: 'other snapshot two' }),
        ];
        const groups = buildConsolidationGroups(episodes, []);
        const projection = projectConsolidation(groups);
        const input = JSON.parse(projection.input) as {
            groups: Array<{
                id: string;
                anchorPath: string;
                independentSnapshots: number;
                snapshots: Array<{
                    id: string;
                    sources: Array<Record<string, unknown>>;
                }>;
            }>;
        };

        assert.deepEqual(Object.keys(input), ['groups']);
        assert.equal(input.groups.length, 2);
        assert.deepEqual(new Set(input.groups.map(group => group.anchorPath)), new Set(['src/other.ts', 'src/parser.ts']));
        assert.equal(input.groups.every(group => !('sources' in group)), true);
        assert.equal(input.groups.every(group => Object.keys(group).join(',') === 'id,anchorPath,independentSnapshots,snapshots'), true);

        const parser = input.groups.find(group => group.anchorPath === 'src/parser.ts')!;
        assert.equal(parser.id, 'G2');
        assert.equal(parser.independentSnapshots, 2);
        assert.equal(parser.snapshots.length, 2);
        assert.deepEqual(parser.snapshots.map(snapshot => snapshot.sources.length), [2, 1]);
        assert.equal(parser.snapshots[0].id, 'V1');
        assert.equal(parser.snapshots[0].sources.every(source => /^S\d+$/.test(String(source.id))), true);
        assert.equal(parser.snapshots[0].sources.length, 2, 'two sources from one V* must share one snapshots item');

        const projectedSources = input.groups.flatMap(group => group.snapshots.flatMap(snapshot =>
            snapshot.sources.map(source => ({ groupId: group.id, snapshotId: snapshot.id, source }))));
        assert.equal(projectedSources.length, 5);
        assert.equal(new Set(projectedSources.map(({ source }) => String(source.id))).size, projectedSources.length,
            'S* handles remain globally unique across groups');
        assert.equal(projection.sources.size, projectedSources.length);
        for (const { groupId, snapshotId, source } of projectedSources) {
            const reference = projection.sources.get(String(source.id));
            assert.ok(reference);
            assert.equal(reference.groupId, groupId);
            assert.equal(reference.snapshot, snapshotId);
            assert.deepEqual(Object.keys(source), ['id', 'tool', 'side', 'startLine', 'endLine', 'truncated', 'excerpt']);
            assert.equal('snapshot' in source, false);
            assert.equal('episodeId' in source, false);
            assert.equal('evidenceId' in source, false);
        }
        assert.equal(input.groups.every(group => group.snapshots.every(snapshot =>
            Object.keys(snapshot).join(',') === 'id,sources' && /^V\d+$/.test(snapshot.id))), true);
        for (const episode of episodes) {
            assert.equal(projection.input.includes(episode.id), false);
            assert.equal(projection.input.includes(episode.snapshot.id), false);
        }
    });
});

describe('memory consolidation validation', () => {
    it('derives one Handbook entry per concern and rejects single-snapshot concerns', () => {
        // Verify valid concerns span distinct V* snapshots and same-V source selections are rejected with S(V) diagnostics.
        const episodes = makeRepeatedEpisodes('src/parser.ts', 2);
        const projection = projectConsolidation(buildConsolidationGroups(episodes, []));
        const group = projection.groups[0];
        const sourceIds = sourceIdsFor(projection, group);
        const valid = validateConsolidation({ groups: [finding(group, sourceIds, 'Cancellation may race with delayed publication.')] }, projection);

        assert.equal(valid.issues.length, 0);
        assert.deepEqual(valid.processedGroupIds, [group.fingerprint]);
        assert.deepEqual(valid.findingGroupIds, [group.fingerprint]);
        assert.equal(valid.entries.length, 1);
        assert.deepEqual(valid.entries[0].targetPaths, ['src/parser.ts']);
        assert.deepEqual(valid.entries[0].triggers, ['src/parser.ts', 'parse']);
        assert.deepEqual(valid.entries[0].concerns, ['Cancellation may race with delayed publication.']);
        assert.deepEqual(new Set(valid.entries[0].supports.map(support => support.episodeId)),
            new Set(episodes.map(episode => episode.id)));

        const sameSnapshotEpisodes = [
            makeEpisode({ episodeId: uuidFor(10), snapshotId: digestFor(10), sourcePath: 'src/same-snapshot.ts', sourceExcerpt: 'first same snapshot excerpt' }),
            makeEpisode({ episodeId: uuidFor(11), snapshotId: digestFor(10), sourcePath: 'src/same-snapshot.ts', sourceExcerpt: 'second same snapshot excerpt' }),
            makeEpisode({ episodeId: uuidFor(12), snapshotId: digestFor(11), sourcePath: 'src/same-snapshot.ts', sourceExcerpt: 'different snapshot excerpt' }),
        ];
        const sameSnapshotProjection = projectConsolidation(
            buildConsolidationGroups(sameSnapshotEpisodes, []),
        );
        const sameSnapshotGroup = sameSnapshotProjection.groups[0];
        const sameSnapshotEntries = [...sameSnapshotProjection.sources.entries()]
            .filter(([, reference]) => reference.groupId === sameSnapshotGroup.id && reference.value.episode.snapshot.id === digestFor(10));
        assert.equal(sameSnapshotEntries.length, 2);
        const sameSnapshotIds = sameSnapshotEntries.map(([id]) => id);
        const sameSnapshotMappings = sameSnapshotEntries.map(([id, reference]) => `${id}(${reference.snapshot})`);
        const rejected = validateConsolidation({
            groups: [finding(sameSnapshotGroup, sameSnapshotIds, 'A concern supported by one snapshot must be removed.')],
        }, sameSnapshotProjection);
        assert.equal(rejected.entries.length, 0);
        assert.deepEqual(rejected.processedGroupIds, []);
        const rejection = rejected.issues.join('\n');
        assert.match(rejection, /sources cover 1\/2 independent snapshots/);
        for (const mapping of sameSnapshotMappings) {
            assert.equal(rejection.includes(mapping), true, `single-snapshot diagnostics must name ${mapping}`);
        }
        assert.match(rejection, /choose same-group sources from at least two distinct V\* snapshots or remove the concern/);

        const oneSnapshot = makeRepeatedEpisodes('src/one.ts', 1);
        assert.deepEqual(buildConsolidationGroups(oneSnapshot, []), []);
    });

    it('accepts no-findings as a completed group with a rationale and no entry', () => {
        const episodes = makeRepeatedEpisodes('src/parser.ts', 2);
        const projection = projectConsolidation(buildConsolidationGroups(episodes, []));
        const group = projection.groups[0];
        const validated = validateConsolidation({ groups: [{
            groupId: group.id,
            outcome: 'no-findings',
            rationale: 'The two excerpts do not support a stable cross-snapshot concern.',
            concerns: [],
        }] }, projection);

        assert.deepEqual(validated.issues, []);
        assert.deepEqual(validated.entries, []);
        assert.deepEqual(validated.processedGroupIds, [group.fingerprint]);
        assert.deepEqual(validated.noFindingGroupIds, [group.fingerprint]);
    });

    it('reports whitespace-only rationale and concern text as validation issues before handbook derivation', () => {
        const episodes = makeRepeatedEpisodes('src/parser.ts', 2);
        const projection = projectConsolidation(buildConsolidationGroups(episodes, []));
        const group = projection.groups[0];
        const sourceIds = sourceIdsFor(projection, group);

        const blankRationale = validateConsolidation({ groups: [{
            ...finding(group, sourceIds, 'A stable concern.'),
            rationale: ' \n\t ',
        }] }, projection);
        assert.equal(blankRationale.entries.length, 0);
        assert.deepEqual(blankRationale.processedGroupIds, []);
        assert.match(blankRationale.issues.join('\n'),
            /groups\.0\.rationale: Too small: expected string to have >=1 characters/);

        const blankConcern = validateConsolidation({ groups: [{
            ...finding(group, sourceIds, ' \n\t '),
        }] }, projection);
        assert.equal(blankConcern.entries.length, 0);
        assert.deepEqual(blankConcern.processedGroupIds, []);
        assert.match(blankConcern.issues.join('\n'),
            /groups\.0\.concerns\.0\.text: Too small: expected string to have >=1 characters/);

        const trimmed = validateConsolidation({ groups: [{
            ...finding(group, sourceIds, '  Trimmed concern.  '),
            rationale: '  Trimmed rationale.  ',
        }] }, projection);
        assert.deepEqual(trimmed.issues, []);
        assert.deepEqual(trimmed.entries.map(entry => entry.concerns), [['Trimmed concern.']]);
    });

    it('reports the actual malformed output instead of silently repairing legacy keys or arrays', () => {
        const episodes = makeRepeatedEpisodes('src/parser.ts', 2);
        const projection = projectConsolidation(buildConsolidationGroups(episodes, []));
        const group = projection.groups[0];
        const sourceIds = sourceIdsFor(projection, group);
        const base = finding(group, sourceIds, 'A stable concern.');

        const wrongKey = validateConsolidation({ groups: [{ ...base, targetPathFIds: ['F1'] }] }, projection);
        assert.equal(wrongKey.entries.length, 0);
        assert.match(wrongKey.issues.join('\n'), /Unrecognized key: "targetPathFIds"/);

        const emptySources = validateConsolidation({ groups: [{
            ...base,
            concerns: [{ text: 'A stable concern.', sourceIds: [] }],
        }] }, projection);
        assert.match(emptySources.issues.join('\n'), /sourceIds.*expected array to have >=2 items/);

        const oversized = validateConsolidation({ groups: [{
            ...base,
            concerns: Array.from({ length: 7 }, (_, index) => ({ text: `Concern ${index}`, sourceIds })),
        }] }, projection);
        assert.match(oversized.issues.join('\n'), /concerns.*expected array to have <=6 items/);

        const oversizedSources = validateConsolidation({ groups: [{
            ...base,
            concerns: [{ text: 'A stable concern.', sourceIds: Array.from({ length: 33 }, (_, index) => `S${index + 1}`) }],
        }] }, projection);
        assert.match(oversizedSources.issues.join('\n'), /sourceIds.*expected array to have <=32 items/);
    });

    it('rejects unknown and cross-group S handles while preserving an independently valid group', () => {
        // Verify a concern citing another G* is rejected and the diagnostic identifies the source's owning G* and V*.
        const episodes = [
            ...makeRepeatedEpisodes('src/alpha.ts', 2, 1),
            ...makeRepeatedEpisodes('src/beta.ts', 2, 3),
        ];
        const projection = projectConsolidation(buildConsolidationGroups(episodes, []));
        const alpha = projection.groups.find(group => group.anchorPath === 'src/alpha.ts')!;
        const beta = projection.groups.find(group => group.anchorPath === 'src/beta.ts')!;
        const betaSources = sourceIdsFor(projection, beta);
        const alphaSources = sourceIdsFor(projection, alpha);

        const crossGroup = validateConsolidation({ groups: [
            finding(alpha, betaSources, 'Cross-group source must fail.'),
            finding(beta, betaSources, 'Beta remains independently valid.'),
        ] }, projection);
        assert.equal(crossGroup.entries.length, 1);
        assert.deepEqual(crossGroup.processedGroupIds, [beta.fingerprint]);
        const betaReference = projection.sources.get(betaSources[0]);
        assert.ok(betaReference);
        assert.match(crossGroup.issues.join('\n'), new RegExp(
            `source ID ${betaSources[0]} belongs to ${beta.id} \\(${betaSources[0]} is in ${betaReference.snapshot}\\)`,
        ));

        const unknown = validateConsolidation({ groups: [
            finding(alpha, [alphaSources[0], 'S999'], 'Unknown source must fail.'),
            finding(beta, betaSources, 'Beta remains independently valid.'),
        ] }, projection);
        assert.equal(unknown.entries.length, 1);
        assert.deepEqual(unknown.processedGroupIds, [beta.fingerprint]);
        assert.match(unknown.issues.join('\n'), /source ID S999 was not supplied/);
    });

    it('keeps valid groups processed when sibling structure or envelope validation fails', () => {
        const episodes = [
            ...makeRepeatedEpisodes('src/alpha.ts', 2, 1),
            ...makeRepeatedEpisodes('src/beta.ts', 2, 3),
        ];
        const projection = projectConsolidation(buildConsolidationGroups(episodes, []));
        const alpha = projection.groups.find(group => group.anchorPath === 'src/alpha.ts')!;
        const beta = projection.groups.find(group => group.anchorPath === 'src/beta.ts')!;
        const alphaSources = sourceIdsFor(projection, alpha);
        const betaSources = sourceIdsFor(projection, beta);
        const validBeta = finding(beta, betaSources, 'Beta remains independently valid.');

        const unknownKey = validateConsolidation({ groups: [
            { ...finding(alpha, alphaSources, 'Alpha has an invalid legacy field.'), targetPathFIds: ['F1'] },
            validBeta,
        ] }, projection);
        assert.equal(unknownKey.entries.length, 1);
        assert.deepEqual(unknownKey.processedGroupIds, [beta.fingerprint]);
        assert.match(unknownKey.issues.join('\n'), /groups\.0: Unrecognized key: "targetPathFIds"/);

        const emptySourceIds = validateConsolidation({ groups: [
            {
                ...finding(alpha, alphaSources, 'Alpha has an empty source selection.'),
                concerns: [{ text: 'Alpha has an empty source selection.', sourceIds: [] }],
            },
            validBeta,
        ] }, projection);
        assert.equal(emptySourceIds.entries.length, 1);
        assert.deepEqual(emptySourceIds.processedGroupIds, [beta.fingerprint]);
        assert.match(emptySourceIds.issues.join('\n'),
            /groups\.0\.concerns\.0\.sourceIds: Too small: expected array to have >=2 items/);

        const oversizedEnvelope = validateConsolidation({
            metadata: 'unexpected',
            groups: [
                finding(alpha, alphaSources, 'Alpha remains valid.'),
                validBeta,
                ...Array.from({ length: 11 }, (_, index) => ({
                    groupId: `G${100 + index}`,
                    outcome: 'no-findings',
                    rationale: 'Unknown extra group.',
                    concerns: [],
                })),
            ],
        }, projection);
        assert.equal(oversizedEnvelope.entries.length, 2);
        assert.deepEqual(oversizedEnvelope.processedGroupIds, [alpha.fingerprint, beta.fingerprint]);
        assert.match(oversizedEnvelope.issues.join('\n'), /<root>: unrecognized key "metadata"/);
        assert.match(oversizedEnvelope.issues.join('\n'), /groups: expected at most 12 items/);
    });

    it('fails globally when the envelope or its groups field has the wrong shape', () => {
        const episodes = makeRepeatedEpisodes('src/parser.ts', 2);
        const projection = projectConsolidation(buildConsolidationGroups(episodes, []));

        const nonObject = validateConsolidation([], projection);
        assert.deepEqual(nonObject.processedGroupIds, []);
        assert.match(nonObject.issues.join('\n'), /<root>: expected an object containing groups/);

        const nonArray = validateConsolidation({ groups: {}, metadata: 'unexpected' }, projection);
        assert.deepEqual(nonArray.processedGroupIds, []);
        assert.match(nonArray.issues.join('\n'), /<root>: unrecognized key "metadata"/);
        assert.match(nonArray.issues.join('\n'), /groups: expected an array/);
    });

    it('requires every projected group exactly once and rejects duplicate or unknown groups', () => {
        const episodes = [
            ...makeRepeatedEpisodes('src/alpha.ts', 2, 1),
            ...makeRepeatedEpisodes('src/beta.ts', 2, 3),
        ];
        const projection = projectConsolidation(buildConsolidationGroups(episodes, []));
        const alpha = projection.groups.find(group => group.anchorPath === 'src/alpha.ts')!;
        const beta = projection.groups.find(group => group.anchorPath === 'src/beta.ts')!;
        const alphaResult = finding(alpha, sourceIdsFor(projection, alpha), 'Alpha concern.');

        const missing = validateConsolidation({ groups: [alphaResult] }, projection);
        assert.match(missing.issues.join('\n'), /G2: result is missing/);
        assert.equal(missing.processedGroupIds.length, 1, 'a valid group remains publishable while another group is missing');

        const duplicate = validateConsolidation({ groups: [alphaResult, alphaResult, finding(beta, sourceIdsFor(projection, beta), 'Beta concern.')] }, projection);
        assert.match(duplicate.issues.join('\n'), /G1: result appears more than once/);
        assert.equal(duplicate.processedGroupIds.length, 1);

        const unknown = validateConsolidation({ groups: [alphaResult, finding(beta, sourceIdsFor(projection, beta), 'Beta concern.'), {
            groupId: 'G999', outcome: 'no-findings', rationale: 'Unknown group.', concerns: [],
        }] }, projection);
        assert.match(unknown.issues.join('\n'), /G999: group ID was not supplied/);
        assert.equal(unknown.processedGroupIds.length, 2);
    });
});

describe('consolidatePending', function () {
    this.timeout(20_000);

    it('does not group public directory overlap or readMemorySources-only observations', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '1'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, [
                makeEpisode({ repositoryId, episodeId: uuidFor(10), snapshotId: digestFor(10), sourcePath: 'src/first.ts' }),
                makeEpisode({ repositoryId, episodeId: uuidFor(11), snapshotId: digestFor(11), sourcePath: 'src/second.ts' }),
                makeEpisode({ repositoryId, episodeId: uuidFor(12), snapshotId: digestFor(12), sourcePath: 'src/memory.ts', tool: 'readMemorySources' }),
                makeEpisode({ repositoryId, episodeId: uuidFor(13), snapshotId: digestFor(13), sourcePath: 'src/memory.ts', tool: 'readMemorySources' }),
            ]);
            let calls = 0;

            const result = await consolidatePending(store, makeValidationRunner(async () => {
                calls += 1;
                throw new Error('runner should not be called');
            }), new AbortController().signal);

            assert.deepEqual(result, { status: 'not-ready', pendingCount: 1, threshold: 2 });
            assert.equal(calls, 0);
        });
    });

    it('publishes a finding, derives its paths and supports, and stores the group fingerprint', async () => {
        // Verify consolidation consumers read S* handles from nested V* snapshots and publish the validated result unchanged.
        await withTempStorage(async storageRoot => {
            const repositoryId = '2'.repeat(64);
            const episodes = makeRepeatedEpisodes('src/parser.ts', 2, 20, repositoryId);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, episodes);
            let input = '';
            const runner = makeValidationRunner(async (request, _signal, validate) => {
                input = request;
                const projected = JSON.parse(request) as {
                    groups: Array<{ id: string; snapshots: Array<{ sources: Array<{ id: string }> }> }>;
                };
                const group = projected.groups[0];
                const sourceIds = group.snapshots.flatMap(snapshot => snapshot.sources.map(source => source.id));
                const raw = { groups: [{
                    groupId: group.id,
                    outcome: 'findings',
                    rationale: 'Repeated direct evidence supports this concern.',
                    concerns: [{ text: 'Parser state may be observed before publication.', sourceIds: sourceIds.slice(0, 2) }],
                }] };
                return { value: validate(raw), attempts: 1 };
            });

            const result = await consolidatePending(store, runner, new AbortController().signal);

            assert.deepEqual(result, {
                status: 'published', groupCount: 1, handbookCount: 1, noFindingCount: 0,
                failedGroupCount: 0, skippedGroups: 0, deferredPaths: [], retryCount: 0,
                groupOutcomes: [{ path: 'src/parser.ts', status: 'published' }],
            });
            const projected = JSON.parse(input) as {
                groups: Array<{ snapshots: Array<{ sources: Array<{ id: string }> }> }>;
            };
            assert.equal(projected.groups[0].snapshots.length, 2);
            assert.equal(projected.groups[0].snapshots.flatMap(snapshot => snapshot.sources).length, 2);
            const view = await store.inspect();
            assert.equal(view.handbook.length, 1);
            assert.deepEqual(view.handbook[0].targetPaths, ['src/parser.ts']);
            assert.deepEqual(new Set(view.handbook[0].supports.map(support => support.episodeId)),
                new Set(episodes.map(episode => episode.id)));
            assert.equal(view.consolidated.length, 1);
            assert.match(view.consolidated[0], /^[0-9a-f-]{36}$/);
            assert.equal(view.consolidated[0], buildConsolidationGroups(episodes, [])[0].fingerprint);
        });
    });

    it('publishes no-findings once and re-evaluates the group only after its fingerprint changes', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '3'.repeat(64);
            const episodes = makeRepeatedEpisodes('src/parser.ts', 2, 30, repositoryId);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, episodes);
            const consolidationSettings = makeSettings({ 'consolidation.maxCallsPer24h': 4 });
            const previous = await store.inspect();
            const previousReservation = await store.reserveConsolidation(previous, consolidationSettings['consolidation.maxCallsPer24h']);
            assert.equal(previousReservation.status, 'reserved');
            if (previousReservation.status !== 'reserved') { throw new Error('Expected a previous Handbook reservation.'); }
            await store.publishHandbook(previous, previousReservation.generation, previousReservation.id,
                [makeHandbookEntry(episodes)], []);
            let calls = 0;
            const runner = makeValidationRunner(async (request, _signal, validate) => {
                calls += 1;
                const projected = JSON.parse(request) as { groups: Array<{ id: string }> };
                return {
                    value: validate({ groups: projected.groups.map(group => ({
                        groupId: group.id, outcome: 'no-findings',
                        rationale: 'The evidence does not establish a stable concern.', concerns: [],
                    })) }),
                    attempts: 1,
                };
            });

            assert.deepEqual(await consolidatePending(store, runner, new AbortController().signal, consolidationSettings), {
                status: 'no-findings', groupCount: 1, skippedGroups: 0, deferredPaths: [], retryCount: 0,
                groupOutcomes: [{ path: 'src/parser.ts', status: 'no-findings' }],
            });
            assert.equal(calls, 1);
            assert.deepEqual(await consolidatePending(store, runner, new AbortController().signal, consolidationSettings), {
                status: 'not-ready', pendingCount: 0, threshold: 2,
            });
            assert.equal(calls, 1, 'the same evidence group must not incur another model call');

            const newEpisode = makeEpisode({
                repositoryId, episodeId: uuidFor(32), snapshotId: digestFor(32), sourcePath: 'src/parser.ts',
            });
            await store.recordEpisode(newEpisode, await store.epoch());
            const changed = buildConsolidationGroups([...episodes, newEpisode], []);
            assert.notEqual(changed[0].fingerprint, buildConsolidationGroups(episodes, [])[0].fingerprint);
            const rerun = await consolidatePending(store, runner, new AbortController().signal, consolidationSettings);
            assert.equal(rerun.status, 'no-findings');
            assert.equal(calls, 2);
            assert.deepEqual((await store.inspect()).handbook, [],
                'a completed no-findings group removes an older entry for the same exact path');
        });
    });

    it('does not charge a second consolidation for a duplicate record of the same snapshot evidence', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'a'.repeat(64);
            const original = makeRepeatedEpisodes('src/parser.ts', 2, 33, repositoryId);
            const duplicate = makeEpisode({
                repositoryId,
                episodeId: uuidFor(99),
                snapshotId: original[0].snapshot.id,
                sourcePath: 'src/parser.ts',
            });
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, original);
            let calls = 0;
            const runner = makeValidationRunner(async (request, _signal, validate) => {
                calls += 1;
                const projected = JSON.parse(request) as { groups: Array<{ id: string }> };
                return {
                    value: validate({ groups: projected.groups.map(group => ({
                        groupId: group.id, outcome: 'no-findings', rationale: 'The evidence is unchanged.', concerns: [],
                    })) }),
                    attempts: 1,
                };
            });

            const first = await consolidatePending(store, runner, new AbortController().signal);
            assert.equal(first.status, 'no-findings');
            const firstFingerprint = (await store.inspect()).consolidated[0];
            await store.recordEpisode(duplicate, await store.epoch());

            assert.deepEqual(await consolidatePending(store, runner, new AbortController().signal), {
                status: 'not-ready', pendingCount: 0, threshold: 2,
            });
            assert.equal(calls, 1, 'the duplicate storage record has the same evidence-group fingerprint');
            assert.deepEqual((await store.inspect()).consolidated, [firstFingerprint]);
        });
    });

    it('counts only selected recheck paths when no complete group is available', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'b'.repeat(64);
            const selected = makeRepeatedEpisodes('src/selected.ts', 1, 100, repositoryId);
            const other = makeRepeatedEpisodes('src/other.ts', 2, 101, repositoryId);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, [...selected, ...other]);
            let called = false;
            const runner = makeValidationRunner(async () => {
                called = true;
                throw new Error('A not-ready recheck must not invoke the runner.');
            });

            assert.deepEqual(await consolidatePending(store, runner, new AbortController().signal, MEMORY_DEFAULTS, ['src/selected.ts']), {
                status: 'not-ready', pendingCount: 1, threshold: 2,
            });
            assert.equal(called, false);
        });
    });

    it('publishes valid groups as partial when another group exhausts validation', async () => {
        // Verify one nested G* result can publish while a sibling concern using an unknown S* remains failed.
        await withTempStorage(async storageRoot => {
            const repositoryId = '4'.repeat(64);
            const episodes = [
                ...makeRepeatedEpisodes('src/alpha.ts', 2, 40, repositoryId),
                ...makeRepeatedEpisodes('src/beta.ts', 2, 42, repositoryId),
            ];
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, episodes);
            const runner = makeValidationRunner(async (request, _signal, validate) => {
                const projected = JSON.parse(request) as {
                    groups: Array<{ id: string; snapshots: Array<{ sources: Array<{ id: string }> }> }>;
                };
                const alpha = projected.groups.find(group => group.id === 'G1')!;
                const beta = projected.groups.find(group => group.id === 'G2')!;
                const alphaSourceIds = alpha.snapshots.flatMap(snapshot => snapshot.sources.map(source => source.id));
                const betaSourceIds = beta.snapshots.flatMap(snapshot => snapshot.sources.map(source => source.id));
                const raw = { groups: [
                    {
                        groupId: alpha.id, outcome: 'findings', rationale: 'Alpha is stable.',
                        concerns: [{ text: 'Alpha has a stable cross-snapshot concern.', sourceIds: alphaSourceIds.slice(0, 2) }],
                    },
                    {
                        groupId: beta.id, outcome: 'findings', rationale: 'Beta is malformed.',
                        concerns: [{ text: 'Beta must fail validation.', sourceIds: ['S999', betaSourceIds[0]] }],
                    },
                ] };
                return { value: validate(raw), attempts: 1 };
            });

            const result = await consolidatePending(store, runner, new AbortController().signal, makeSettings({
                'consolidation.maxCallsPer24h': 1,
            }));

            assert.deepEqual(result, {
                status: 'partial', groupCount: 1, handbookCount: 1, noFindingCount: 0,
                failedGroupCount: 1, skippedGroups: 0, deferredPaths: [], retryCount: 0,
                groupOutcomes: [
                    { path: 'src/alpha.ts', status: 'published' },
                    { path: 'src/beta.ts', status: 'failed' },
                ],
            });
            const view = await store.inspect();
            assert.equal(view.handbook.length, 1);
            assert.equal(view.handbook[0].targetPaths[0], 'src/alpha.ts');
            assert.deepEqual(view.consolidated, [buildConsolidationGroups(episodes, [])[0].fingerprint]);
        });
    });

    it('uses execution repair retries without consuming another 24-hour consolidation start allowance', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '5'.repeat(64);
            const episodes = makeRepeatedEpisodes('src/parser.ts', 2, 50, repositoryId);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, episodes);
            let sent = 0;
            const runner = makeValidationRunner(async (request, _signal, validate) => {
                sent += 1;
                const projected = JSON.parse(request) as { groups: Array<{ id: string }> };
                const invalid = validate({ groups: [{ groupId: projected.groups[0].id, outcome: 'findings', rationale: 'invalid', concerns: [] }] });
                assert.ok(invalid.issues.length > 0);
                sent += 1;
                const valid = validate({ groups: [{
                    groupId: projected.groups[0].id, outcome: 'no-findings', rationale: 'No stable concern.', concerns: [],
                }] });
                return { value: valid, attempts: 2 };
            });

            const result = await consolidatePending(store, runner, new AbortController().signal, makeSettings({
                'consolidation.maxCallsPer24h': 1,
            }));
            assert.deepEqual(result, {
                status: 'no-findings', groupCount: 1, skippedGroups: 0, deferredPaths: [], retryCount: 1,
                groupOutcomes: [{ path: 'src/parser.ts', status: 'no-findings' }],
            });
            assert.equal(sent, 2);
            const manifest = JSON.parse(await fs.readFile(path.join(store.directory, 'current.json'), 'utf8')) as { attempts: unknown[] };
            assert.equal(manifest.attempts.length, 1, 'repair retries do not consume another 24-hour consolidation start allowance');
        });
    });

    it('defers complete groups when the batch limit or token budget cannot fit them', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '7'.repeat(64);
            const episodes = Array.from({ length: 13 }, (_, index) => makeRepeatedEpisodes(
                `src/group-${String(index).padStart(2, '0')}.ts`, 2, 70 + index * 2, repositoryId,
            )).flat();
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, episodes);
            let requestedGroups = 0;
            const runner = makeValidationRunner(async (request, _signal, validate) => {
                const projected = JSON.parse(request) as { groups: Array<{ id: string }> };
                requestedGroups = projected.groups.length;
                return {
                    value: validate({ groups: projected.groups.map(group => ({
                        groupId: group.id, outcome: 'no-findings', rationale: 'Deferred groups are processed later.', concerns: [],
                    })) }),
                    attempts: 1,
                };
            });
            const result = await consolidatePending(store, runner, new AbortController().signal);

            assert.equal(result.status, 'no-findings');
            if (result.status === 'no-findings') {
                assert.equal(result.groupCount, 12);
                assert.equal(result.skippedGroups, 1);
                assert.deepEqual(result.deferredPaths, ['src/group-12.ts']);
                assert.deepEqual(result.groupOutcomes.length, 12);
            }
            assert.equal(requestedGroups, 12);
            assert.equal((await store.inspect()).consolidated.length, 12);
        });

        await withTempStorage(async storageRoot => {
            const repositoryId = '8'.repeat(64);
            const large = makeRepeatedEpisodes('src/large.ts', 2, 90, repositoryId, 12_000);
            const small = makeRepeatedEpisodes('src/small.ts', 2, 92, repositoryId);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, [...large, ...small]);
            let request = '';
            const runner = makeValidationRunner(async (input, _signal, validate) => {
                request = input;
                const projected = JSON.parse(input) as { groups: Array<{ id: string }> };
                return {
                    value: validate({ groups: projected.groups.map(group => ({
                        groupId: group.id, outcome: 'no-findings', rationale: 'The complete small group fits.', concerns: [],
                    })) }),
                    attempts: 1,
                };
            }, 100, input => input.includes('large.ts') ? 101 : 0);

            const result = await consolidatePending(store, runner, new AbortController().signal);
            assert.equal(result.status, 'no-findings');
            if (result.status === 'no-findings') {
                assert.equal(result.skippedGroups, 1);
                assert.deepEqual(result.deferredPaths, ['src/large.ts']);
            }
            assert.deepEqual(JSON.parse(request).groups.map((group: { anchorPath: string }) => group.anchorPath), ['src/small.ts']);
            assert.equal((await store.inspect()).consolidated.length, 1);
        });
    });
});

describe('createConsolidationRunner', () => {
    it('uses execution.maxRetries, zero temperature, no transport retries, and includes all local issues in repair input', async () => {
        // Verify a failed first response triggers one repair request with explicit G*->V*->S* evidence guidance and preserves the completed result.
        const groups = buildConsolidationGroups(makeRepeatedEpisodes('src/parser.ts', 2), []);
        const projection = projectConsolidation(groups);
        const group = projection.groups[0];
        const sourceIds = sourceIdsFor(projection, group);
        const requests: AIRunRequest[] = [];
        const accounted: unknown[] = [];
        const attempts: Array<{
            attempt: number;
            totalAttempts: number;
            issues: string[];
            response: AIRunResponse;
            inputFingerprint: string;
        }> = [];
        const execution = makeExecution([
            { targetPathFIds: ['F1'] },
            { groups: [finding(group, sourceIds, 'The corrected concern.')] },
        ], 1, requests, accounted);
        const runner = loadConsolidationRunner()(execution, MEMORY_DEFAULTS,
            (attempt, totalAttempts, issues, response, inputFingerprint) => {
                attempts.push({ attempt, totalAttempts, issues, response, inputFingerprint });
            });

        const result = await runner(
            projection.input,
            new AbortController().signal,
            raw => validateConsolidation(raw, projection),
        );

        assert.equal(result.attempts, 2);
        assert.equal(result.value.issues.length, 0);
        assert.equal(result.value.entries.length, 1);
        assert.deepEqual(result.value.processedGroupIds, [group.fingerprint]);
        assert.equal(requests.length, 2);
        assert.equal(accounted.length, 2);
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0].attempt, 1);
        assert.equal(attempts[0].totalAttempts, 2);
        assert.ok(attempts[0].issues.length > 0);
        assert.equal(attempts[0].response.text, '');
        assert.deepEqual(attempts[0].response.raw, {});
        assert.equal(attempts[0].response.stopReason, 'completed');
        assert.deepEqual(attempts[0].response.structured, { targetPathFIds: ['F1'] });
        assert.equal(attempts[1].issues.length, 0);
        assert.equal(attempts[1].response.stopReason, 'completed');
        assert.equal(attempts[1].inputFingerprint, attempts[0].inputFingerprint);
        assert.equal(requests[0].temperature, 0);
        assert.equal(requests[0].transportRetries, 0);
        assert.equal(requests[0].responseFormat?.name, 'repositoryMemoryConsolidation');
        assert.equal(requests[1].messages?.length, 1);
        assert.equal(requests[1].messages?.[0].role, 'user');
        const repairPrompt = String(requests[1].messages?.[0].content);
        assert.match(repairPrompt, /targetPathFIds/);
        assert.match(repairPrompt, /Return the complete corrected result/);
        assert.match(repairPrompt, /G\* -> V\* -> S\*/);
        assert.match(repairPrompt, /same-group sources/);
        assert.match(repairPrompt, /at least two distinct V\* snapshots/);
        assert.match(repairPrompt, /remove that concern/);
        assert.match(repairPrompt, /return no-findings/);
        assert.match(repairPrompt, /Do not add unrelated sources merely to satisfy the snapshot requirement/);
    });

    it('passes complete diagnostics to onAttempt when a completed response has no structured output', async () => {
        const groups = buildConsolidationGroups(makeRepeatedEpisodes('src/parser.ts', 2), []);
        const projection = projectConsolidation(groups);
        const requests: AIRunRequest[] = [];
        const accounted: unknown[] = [];
        const attempts: Array<{ issues: string[]; response: AIRunResponse }> = [];
        const execution = makeExecution([undefined], 0, requests, accounted, 'completed',
            'provider text without structured output', { provider: 'raw-completed' });
        const runner = loadConsolidationRunner()(execution, MEMORY_DEFAULTS,
            (_attempt, _totalAttempts, issues, response) => attempts.push({ issues, response }));

        const result = await runner(
            projection.input,
            new AbortController().signal,
            raw => validateConsolidation(raw, projection),
        );

        assert.equal(result.attempts, 1);
        assert.equal(attempts.length, 1);
        assert.ok(attempts[0].issues.length > 0);
        assert.equal(attempts[0].response.text, 'provider text without structured output');
        assert.deepEqual(attempts[0].response.raw, { provider: 'raw-completed' });
        assert.equal(attempts[0].response.stopReason, 'completed');
        assert.equal(attempts[0].response.structured, undefined);
        assert.equal(accounted.length, 1);
    });

    it('accounts a completed HTTP response before rejecting a non-completed stop reason', async () => {
        const requests: AIRunRequest[] = [];
        const accounted: unknown[] = [];
        const attempts: Array<{ issues: string[]; response: AIRunResponse }> = [];
        const execution = makeExecution([{ groups: [] }], 2, requests, accounted, 'max_output_tokens',
            'provider stopped before completion', { provider: 'raw-incomplete' });
        const runner = loadConsolidationRunner()(execution, MEMORY_DEFAULTS,
            (_attempt, _totalAttempts, issues, response) => attempts.push({ issues, response }));

        await assert.rejects(
            () => runner('{}', new AbortController().signal, () => ({
                entries: [], processedGroupIds: [], findingGroupIds: [], noFindingGroupIds: [], issues: [],
            })),
            /stopped without a complete response: max_output_tokens/,
        );
        assert.equal(requests.length, 1);
        assert.equal(accounted.length, 1);
        assert.equal(attempts.length, 1);
        assert.match(attempts[0].issues.join('\n'), /Response stopped without completing: max_output_tokens/);
        assert.equal(attempts[0].response.text, 'provider stopped before completion');
        assert.deepEqual(attempts[0].response.raw, { provider: 'raw-incomplete' });
        assert.equal(attempts[0].response.stopReason, 'max_output_tokens');
    });
});

async function withTempStorage<T>(action: (storageRoot: string) => Promise<T>): Promise<T> {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-consolidator-test-'));
    try {
        return await action(storageRoot);
    } finally {
        await fs.rm(storageRoot, { recursive: true, force: true });
    }
}

async function recordAll(store: MemoryStore, episodes: InvestigationEpisode[]): Promise<void> {
    const epoch = await store.epoch();
    for (const episode of episodes) {
        await store.recordEpisode(episode, epoch);
    }
}

function makeValidationRunner(
    action: (input: string, signal: AbortSignal,
        validate: (raw: unknown) => ConsolidationValidation) => Promise<{ value: ConsolidationValidation; attempts: number }>,
    maxInputTokens = 100_000,
    estimateInputTokens: (input: string) => number = () => 0,
): ConsolidationRunner {
    return Object.assign(async (
        input: string,
        signal: AbortSignal,
        validate: (raw: unknown) => ConsolidationValidation,
    ) => action(input, signal, validate), { maxInputTokens, estimateInputTokens });
}

function makeRepeatedEpisodes(
    sourcePath: string,
    count: number,
    startIndex = 1,
    repositoryId = 'a'.repeat(64),
    excerptLength = 0,
): InvestigationEpisode[] {
    return Array.from({ length: count }, (_, index) => makeEpisode({
        repositoryId,
        episodeId: uuidFor(startIndex + index),
        snapshotId: digestFor(startIndex + index),
        sourcePath,
        sourceExcerpt: excerptLength ? `parse evidence for ${sourcePath}`.padEnd(excerptLength, 'x') : undefined,
    }));
}

function makeEpisode(options: {
    episodeId?: string;
    snapshotId?: string;
    repositoryId?: string;
    sourcePath?: string;
    sourceExcerpt?: string;
    changedPaths?: string[];
    changedSymbols?: string[];
    tool?: string;
    status?: InvestigationEpisode['status'];
} = {}): InvestigationEpisode {
    const repositoryId = options.repositoryId ?? 'a'.repeat(64);
    const snapshot = makeSnapshot(options.snapshotId ?? 'a'.repeat(64), repositoryId);
    const sourcePath = options.sourcePath ?? 'src/parser.ts';
    const excerpt = options.sourceExcerpt ?? `parse evidence for ${sourcePath}`;
    const source = makeSource(snapshot, sourcePath, excerpt);
    return {
        version: 1,
        id: options.episodeId ?? randomUUID(),
        createdAt: Date.now(),
        snapshot,
        changedPaths: options.changedPaths ?? [sourcePath],
        changedSymbols: options.changedSymbols ?? ['parse'],
        questions: ['How should this evidence be interpreted?'],
        observations: [{
            step: 0,
            tool: options.tool ?? 'readFileContent',
            arguments: { filePath: sourcePath, startLine: 1, maxLines: 1 },
            ok: true,
            summary: 'read source',
            evidence: [{ id: 'E1', source }],
            durationMs: 1,
            truncated: false,
        }],
        claims: [{ claim: 'Source explains the behavior.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        status: options.status ?? 'complete',
        model: 'consolidator-test',
        promptVersion: 'memory-1',
        toolsetVersion: 'snapshot-1',
    };
}

function makeSnapshot(snapshotId: string, repositoryId: string): SnapshotIdentity {
    return {
        id: snapshotId,
        repositoryId,
        worktreeId: 'b'.repeat(64),
        head: 'c'.repeat(40),
        beforeTree: 'd'.repeat(40),
        afterTree: 'e'.repeat(40),
        indexFingerprint: 'f'.repeat(64),
        autoStaged: false,
    };
}

function makeSource(snapshot: SnapshotIdentity, sourcePath: string, excerpt: string): SourceObservation {
    return {
        snapshotId: snapshot.id,
        path: sourcePath,
        side: 'after',
        blobOid: '1'.repeat(40),
        startLine: 1,
        endLine: 1,
        excerpt,
        contentHash: hashContent(excerpt),
        truncated: false,
        sourceType: 'text',
    };
}

function sourceIdsFor(projection: ReturnType<typeof projectConsolidation>, group: ConsolidationGroup): string[] {
    return [...projection.sources.entries()]
        .filter(([, source]) => source.groupId === group.id)
        .map(([id]) => id);
}

function finding(group: ConsolidationGroup, sourceIds: string[], text: string): Record<string, unknown> {
    return {
        groupId: group.id,
        outcome: 'findings',
        rationale: 'The selected direct evidence supports a stable concern.',
        concerns: [{ text, sourceIds }],
    };
}

function makeHandbookEntry(episodes: InvestigationEpisode[], sourcePath = 'src/parser.ts'): HandbookEntry {
    return {
        id: randomUUID(),
        triggers: [sourcePath],
        targetPaths: [sourcePath],
        concerns: ['An older concern for this path.'],
        supports: episodes.map(episode => ({ episodeId: episode.id, evidenceId: 'E1' })),
        kind: 'navigation',
    };
}

function uuidFor(index: number): string {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function digestFor(index: number): string {
    return index.toString(16).padStart(2, '0').repeat(32);
}

function makeSettings(overrides: Partial<MemorySettings> = {}): MemorySettings {
    return Object.freeze({ ...MEMORY_DEFAULTS, ...overrides });
}

function makeExecution(
    structuredResponses: unknown[],
    maxRetries: number,
    requests: AIRunRequest[],
    accounted: unknown[],
    stopReason: 'completed' | 'max_output_tokens' = 'completed',
    responseText = '',
    responseRaw: unknown = {},
): LLMExecution {
    let responseIndex = 0;
    const tokenBudget = {
        configuredContextTokens: 128_000,
        effectiveContextTokens: 128_000,
        maxOutputTokens: 32_000,
        estimatedThinkingTokens: 0,
        safetyTokens: 512,
        hardInputTokens: 16_000,
        compressionTriggerTokens: 16_000,
        compressionTargetTokens: 14_400,
        outputAccounting: 'shared' as const,
    };
    return {
        model: 'consolidation-test',
        temperature: 0,
        maxOutputTokens: 4_000,
        maxRetries,
        thinking: { reasoning: false, level: 'off' },
        tokenBudget,
        createSession: () => ({
            provider: 'custom',
            model: 'consolidation-test',
            run: async (request: AIRunRequest) => {
                requests.push(request);
                const structured = structuredResponses[Math.min(responseIndex++, structuredResponses.length - 1)];
                return {
                    text: responseText,
                    structured,
                    toolCalls: [],
                    usage: { inputTokens: 1, outputTokens: 1 },
                    stopReason,
                    continuation: { serverManaged: false },
                    raw: responseRaw,
                };
            },
            snapshot: () => ({
                provider: 'custom',
                model: 'consolidation-test',
                continuation: { serverManaged: false },
                transcript: [],
            }),
        }) as any,
        run: async () => { throw new Error('not used'); },
        accountCall: async usage => { accounted.push(usage); return { status: 'usage-not-reported' as const }; },
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
    };
}

function loadConsolidationRunner(): typeof import('../../services/memory/service')['createConsolidationRunner'] {
    const moduleLoader = require('module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = (request, parent, isMain) => request === 'vscode' ? {} : originalLoad(request, parent, isMain);
    try {
        return (require('../../services/memory/service') as typeof import('../../services/memory/service')).createConsolidationRunner;
    } finally {
        moduleLoader._load = originalLoad;
    }
}
