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
import { MemoryStore } from '../../services/memory/store';
import { HandbookEntry, InvestigationEpisode, RecordedObservation } from '../../services/memory/types';
import { MEMORY_DEFAULTS, MemorySettings } from '../../services/memory/settings';

describe('memory consolidation grouping and projection', () => {
    it('creates one G1 seed batch with at most twenty related complete episodes across files', () => {
        // Verify grouping follows an investigation seed and lexical relationships instead of one anchor file.
        const episodes = Array.from({ length: 25 }, (_, index) => makeEpisode({
            episodeId: uuidFor(index + 1), snapshotId: digestFor(index + 1),
            changedPaths: index === 0 ? ['src/ui/memoryWebviewPolicy.ts'] : [`src/services/related-${index}.ts`],
            changedSymbols: index === 0 ? ['filterMemoryLogsForWebview'] : [`filterMemoryLogsForWebview${index}`],
            questions: ['How does memory lifecycle filtering affect the investigation?'],
            summary: `Inspect memory lifecycle after filterMemoryLogsForWebview change ${index}.`,
        }));

        const groups = buildConsolidationGroups(episodes, []);
        const seedGroup = groups.find(group => group.seedId === episodes[0].id);

        assert.ok(seedGroup);
        assert.equal(seedGroup.id, 'G1');
        assert.equal(seedGroup.episodes.length, 20);
        assert.equal(seedGroup.episodes[0].id, episodes[0].id);
        assert.ok(seedGroup.episodes.some(episode => episode.changedPaths[0] !== 'src/ui/memoryWebviewPolicy.ts'));
        assert.equal(new Set(seedGroup.episodes.map(episode => episode.snapshot.id)).size, 20);
        assert.equal(groups.every(group => group.id === 'G1'), true);
    });

    it('excludes cancelled, error, and memory-only episodes while retaining degraded and unavailable investigations', () => {
        // Verify eligibility accepts complete, degraded, and unavailable episodes only when a non-memory observation exists.
        const episodes = [
            makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), status: 'complete' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), status: 'degraded' }),
            makeEpisode({ episodeId: uuidFor(3), snapshotId: digestFor(3), status: 'unavailable' }),
            makeEpisode({ episodeId: uuidFor(4), snapshotId: digestFor(4), status: 'cancelled' }),
            makeEpisode({ episodeId: uuidFor(5), snapshotId: digestFor(5), status: 'error' }),
            makeEpisode({ episodeId: uuidFor(6), snapshotId: digestFor(6), tool: 'readMemorySources' }),
            makeEpisode({ episodeId: uuidFor(7), snapshotId: digestFor(7), tool: 'searchRepositoryMemory' }),
        ];

        const groups = buildConsolidationGroups(episodes, []);
        assert.ok(groups.length > 0);
        for (const group of groups) {
            assert.equal(group.episodes.some(episode => episode.status === 'cancelled' || episode.status === 'error'), false);
            assert.equal(group.episodes.some(episode => episode.observations.every(observation =>
                ['searchRepositoryMemory', 'readMemorySources'].includes(observation.tool))), false);
        }
        assert.equal(groups.some(group => group.episodes.some(episode => episode.id === uuidFor(2))), true);
        assert.equal(groups.some(group => group.episodes.some(episode => episode.id === uuidFor(3))), true);
    });

    it('projects T, V, O, S, and H handles with questions, reasons, results, and claims', () => {
        // Verify consolidation input preserves investigation context while hiding persistent episode and snapshot identities.
        const episodes = makeRouteEpisodes();
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const existing = makeHandbook(episodes);
        const projection = projectConsolidation([{ ...group, existing: [existing] }]);
        const input = JSON.parse(projection.input) as {
            groups: Array<{
                id: string;
                seed: string;
                eligibleStepRoutes: Array<{
                    operation: string;
                    path: string;
                    findings: Array<{ observationId: string; snapshot: string; sourceIds: string[]; claimIndices: number[] }>;
                }>;
                episodes: Array<{ id: string; snapshot: string; observations: Array<{ id: string; snapshot: string }> }>;
                existing: Array<Record<string, unknown>>;
            }>;
        };

        assert.deepEqual(Object.keys(input), ['groups']);
        assert.equal(input.groups.length, 1);
        assert.deepEqual(Object.keys(input.groups[0]), ['id', 'seed', 'eligibleStepRoutes', 'episodes', 'existing']);
        assert.equal(input.groups[0].id, 'G1');
        assert.equal(input.groups[0].seed, 'T1');
        assert.equal(input.groups[0].episodes.length, 2);
        assert.equal(input.groups[0].episodes[0].id, 'T1');
        assert.equal(input.groups[0].episodes[0].snapshot, 'V1');
        assert.equal(input.groups[0].episodes[1].snapshot, 'V2');
        assert.equal(input.groups[0].episodes.every(episode => episode.observations.every(observation => observation.snapshot === episode.snapshot)), true);
        assert.equal(input.groups[0].eligibleStepRoutes.length, 2);
        assert.equal(input.groups[0].eligibleStepRoutes.every(route => route.path === 'src/ui/memoryWebviewPolicy.ts'), true);
        assert.deepEqual(input.groups[0].eligibleStepRoutes.map(route => route.operation).sort(), ['readFileContent', 'searchCode']);
        assert.equal(input.groups[0].eligibleStepRoutes.every(route => {
            return new Set(route.findings.map(finding => finding.snapshot)).size >= 2
                && route.findings.every(finding => finding.observationId.startsWith('O')
                    && finding.sourceIds.length > 0 && finding.claimIndices.length > 0
                    && finding.sourceIds.every(sourceId => projection.sources.get(sourceId)?.observationId === finding.observationId)
                    && finding.claimIndices.every(claimIndex => {
                        const item = projection.observations.get(finding.observationId);
                        const claim = item?.episode.claims[claimIndex];
                        if (!claim || claim.disposition === 'omit') { return false; }
                        return claim.evidenceRefs.some(evidenceId => finding.sourceIds.some(sourceId =>
                            projection.sources.get(sourceId)?.evidence.id === evidenceId));
                    })
                    && finding.snapshot === `V${[...new Set(group.episodes.map(episode => episode.snapshot.id))]
                        .indexOf(projection.observations.get(finding.observationId)!.episode.snapshot.id) + 1}`);
        }), true);
        assert.match(JSON.stringify(input.groups[0].episodes), /Where should a new memory lifecycle log be inspected/);
        assert.match(JSON.stringify(input.groups[0].episodes), /Read the filtering predicate/);
        assert.match(JSON.stringify(input.groups[0].episodes), /filterMemoryLogsForWebview/);
        assert.match(JSON.stringify(input.groups[0].episodes), /usedByClaims/);
        assert.equal(input.groups[0].existing[0].id, 'H1');
        assert.equal(input.groups[0].existing[0].situation, existing.situation);
        assert.equal(JSON.stringify(input).includes(episodes[0].id), false);
        assert.equal(JSON.stringify(input).includes(episodes[0].snapshot.id), false);
        assert.equal([...projection.observations.keys()].every(id => /^O\d+$/.test(id)), true);
        assert.equal([...projection.sources.keys()].every(id => /^S\d+$/.test(id)), true);
        assert.deepEqual(projection.eligibleStepRoutes, input.groups[0].eligibleStepRoutes);
    });

    it('exposes no eligible step routes when related episodes lack a shared successful claimed tool-path route', () => {
        // Verify shared changed paths alone cannot authorize a positive route when each snapshot uses a different tool or target path.
        const targetPath = 'src/services/memory/consolidator.ts';
        const episodes = [
            makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), changedPaths: [targetPath], changedSymbols: ['projectConsolidation'], sourcePath: targetPath, tool: 'readFileContent' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), changedPaths: [targetPath], changedSymbols: ['projectConsolidation'], sourcePath: 'src/services/memory/service.ts', tool: 'searchCode' }),
        ];
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id);

        assert.ok(group);
        const projection = projectConsolidation([group!]);
        const input = JSON.parse(projection.input) as { groups: Array<{ eligibleStepRoutes: unknown[] }> };
        assert.deepEqual(projection.eligibleStepRoutes, []);
        assert.deepEqual(input.groups[0].eligibleStepRoutes, []);
    });

    it('requires successful observations and retained claims that cite matching source evidence before exposing a route', () => {
        // Verify failed observations and omit or unrelated claims cannot contribute route bases even when tool and path match across snapshots.
        const baseEpisodes = makeRouteEpisodes().map(episode => ({
            ...episode,
            observations: [episode.observations[0]],
            claims: [{ claim: 'The source was inspected.', evidenceRefs: ['E1'], disposition: 'must_express' as const }],
        }));
        const failedEpisodes = baseEpisodes.map(episode => ({
            ...episode,
            observations: [{ ...episode.observations[0], ok: false, error: 'No matches', evidence: [] }],
            claims: [],
        }));
        const omittedEpisodes = baseEpisodes.map(episode => ({
            ...episode,
            claims: [{ claim: 'The source was inspected.', evidenceRefs: [], disposition: 'omit' as const }],
        }));
        const unrelatedClaimEpisodes = baseEpisodes.map(episode => ({
            ...episode,
            claims: [{ claim: 'An unrelated source was inspected.', evidenceRefs: ['E999'], disposition: 'must_express' as const }],
        }));

        for (const episodes of [failedEpisodes, omittedEpisodes, unrelatedClaimEpisodes]) {
            const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id);
            assert.ok(group);
            assert.deepEqual(projectConsolidation([group!]).eligibleStepRoutes, []);
        }
    });

    it('does not create a group when the selected seed has fewer than two snapshots', () => {
        // Verify a single snapshot cannot trigger model consolidation even when several observations are present.
        const episodes = [
            makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), observationCount: 3 }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(1), observationCount: 2 }),
        ];
        assert.deepEqual(buildConsolidationGroups(episodes, []).filter(group => group.seedId === episodes[0].id), []);
    });
});

describe('memory consolidation validation', () => {
    it('publishes a situation with an ordered step and a lesson supported by separate snapshots', () => {
        // Verify every experience item stores its own observation supports and derives paths, tools, and snapshot counts.
        const episodes = makeRouteEpisodes();
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const routeObservations = observationsFor(projection, 'searchCode');
        const failedObservationIds = [...projection.observations.entries()]
            .filter(([, item]) => !item.observation.ok).map(([id]) => id);
        const sourceId = sourceForObservation(projection, routeObservations[0]);
        const validated = validateConsolidation({ groups: [{
            groupId: group.id,
            outcome: 'findings',
            rationale: 'Repeated investigations show a useful route and a bounded failure lesson.',
            entries: [{
                existingEntryId: null,
                situation: 'When memory lifecycle visibility changes, locate filtering before reading the renderer.',
                steps: [{
                    sourceId,
                    symbol: 'filterMemoryLogsForWebview',
                    purpose: 'Find the filtering branch that decides whether the lifecycle row is visible.',
                    findings: findingsFor(projection, routeObservations),
                }],
                lessons: [{
                    observation: 'A historical search returned no matching renderer call in one investigation.',
                    implication: 'Treat an empty search as a local limitation and inspect the filtering entry directly.',
                    limitation: 'The empty result does not prove that the renderer has no caller.',
                    observationIds: failedObservationIds,
                }],
            }],
            retirements: [],
        }] }, projection);

        assert.deepEqual(validated.issues, []);
        assert.deepEqual(validated.processedGroupIds, [group.fingerprint]);
        assert.equal(validated.entries.length, 1);
        const entry = validated.entries[0];
        assert.equal(entry.situation, 'When memory lifecycle visibility changes, locate filtering before reading the renderer.');
        assert.equal(entry.steps.length, 1);
        assert.equal(entry.steps[0].path, 'src/ui/memoryWebviewPolicy.ts');
        assert.equal(entry.steps[0].symbol, 'filterMemoryLogsForWebview');
        assert.equal(entry.steps[0].operation, 'searchCode');
        assert.equal(entry.steps[0].snapshotCount, 2);
        assert.equal(entry.steps[0].supports.length, 2);
        assert.equal(entry.steps[0].supports.every(support => support.evidenceId !== undefined), true);
        assert.equal(entry.lessons.length, 1);
        assert.equal(entry.lessons[0].supports.every(support => support.evidenceId === undefined), true);
        assert.equal(entry.lessons[0].snapshotCount, 2);
        assert.deepEqual(entry.targetPaths, ['src/ui/memoryWebviewPolicy.ts']);
        assert.ok(entry.triggers.includes('filterMemoryLogsForWebview'));
    });

    it('derives target paths from cited step evidence while lessons retain all observation sources', () => {
        // Verify evidence-bound route supports avoid unrelated paths while evidence-free lessons preserve the observation context.
        const episodes = makeRouteEpisodes().map(addSecondaryTargetSource);
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const routeObservations = observationsFor(projection, 'searchCode');
        const route = validateConsolidation({ groups: [finding(group, {
            existingEntryId: null,
            situation: 'When the lifecycle source changes, inspect the cited filtering path first.',
            steps: [{ sourceId: sourceForObservation(projection, routeObservations[0]), symbol: 'filterMemoryLogsForWebview',
                purpose: 'Inspect the source evidence selected by the repeated route.', findings: findingsFor(projection, routeObservations) }],
            lessons: [],
        })] }, projection);

        assert.deepEqual(route.issues, []);
        assert.deepEqual(route.entries[0].targetPaths, ['src/ui/memoryWebviewPolicy.ts']);
        assert.equal(route.entries[0].targetPaths.includes('src/services/unrelated.ts'), false);

        const lessonObservations = observationsFor(projection, 'readFileContent');
        const lesson = validateConsolidation({ groups: [finding(group, {
            existingEntryId: null,
            situation: 'When a bounded source reading finds multiple related files, retain the full observation context.',
            steps: [],
            lessons: [{ observation: 'A source reading included an additional related file.',
                implication: 'Use all files observed by the lesson when planning a follow-up investigation.',
                limitation: 'The lesson does not identify one source as the sole target.', observationIds: lessonObservations }],
        })] }, projection);

        assert.deepEqual(lesson.issues, []);
        assert.deepEqual(lesson.entries[0].targetPaths, ['src/ui/memoryWebviewPolicy.ts', 'src/services/unrelated.ts']);
    });

    it('binds a step support to the evidence cited by its selected claim when one path has multiple excerpts', () => {
        // Verify claim provenance selects the matching cited excerpt instead of the first same-path evidence item.
        const episodes = makeClaimBoundEvidenceEpisodes();
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const observationIds = [...projection.observations.keys()];
        const findings = observationIds.map(observationId => findingForEvidence(projection, observationId, 'E2'));
        const validated = validateConsolidation({ groups: [finding(group, {
            existingEntryId: null,
            situation: 'When repeated excerpts share a path, preserve the claim-selected source.',
            steps: [{ sourceId: sourceForObservationEvidence(projection, observationIds[0], 'E1'), symbol: null,
                purpose: 'Inspect the excerpt that the final claim actually cites.', findings }],
            lessons: [],
        })] }, projection);

        assert.deepEqual(validated.issues, []);
        assert.deepEqual(validated.entries[0].steps[0].supports.map(support => support.evidenceId), ['E2', 'E2']);
        assert.deepEqual(validated.entries[0].targetPaths, ['src/ui/memoryWebviewPolicy.ts']);
    });

    it('rejects a same-path step when the selected claim cites no matching evidence instead of binding the first excerpt', () => {
        // Verify same-path evidence without claim provenance fails the step and does not produce a fallback support binding.
        const episodes = makeClaimBoundEvidenceEpisodes().map(episode => ({
            ...episode,
            claims: episode.claims.map(claim => ({ ...claim, evidenceRefs: ['E999'] })),
        }));
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const observationIds = [...projection.observations.keys()];
        const invalid = validateConsolidation({ groups: [finding(group, {
            existingEntryId: null,
            situation: 'A step cannot use an evidence item that its claim does not cite.',
            steps: [{ sourceId: sourceForObservationEvidence(projection, observationIds[0], 'E1'), symbol: null,
                purpose: 'Require explicit source provenance for the selected claim.',
                findings: observationIds.map(observationId => ({ observationId, questionIndex: 0, claimIndex: 0 })) }],
            lessons: [],
        })] }, projection);

        assert.equal(invalid.entries.length, 0);
        assert.match(invalid.issues.join('\n'), /entries\.0\.steps\.0\.findings\.0: route support O1\(V1\) requires a recorded questionIndex and a retained non-omit claimIndex citing its matching source evidence/);
        assert.equal(invalid.issues.some(issue => issue.includes('must be a successful matching tool observation')), false);
    });

    it('requires each step and lesson to cite two distinct snapshots', () => {
        // Verify repeated observations from one snapshot cannot satisfy the independent support rule.
        const episodes = [
            makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), observationCount: 2 }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2) }),
        ];
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const sameSnapshotIds = [...projection.observations.entries()]
            .filter(([, item]) => item.episode.snapshot.id === digestFor(1)).map(([id]) => id);
        const sourceId = sourceForObservation(projection, sameSnapshotIds[0]);
        const invalid = validateConsolidation({ groups: [finding(group, {
            existingEntryId: null,
            situation: 'A single snapshot must not become durable experience.',
            steps: [{ sourceId, symbol: null, purpose: 'Inspect the source only when repeated history supports it.',
                findings: findingsFor(projection, sameSnapshotIds.slice(0, 2)) }],
            lessons: [],
        })] }, projection);
        assert.equal(invalid.entries.length, 0);
        assert.match(invalid.issues.join('\n'), /entries\.0\.steps\.0\.findings: selected O1\(V1\), O2\(V1\) cover 1\/2 independent V\* snapshots/);
        assert.doesNotMatch(invalid.issues.join('\n'), /Too small: expected number to be >=2/);

        const invalidLesson = validateConsolidation({ groups: [finding(group, {
            existingEntryId: null,
            situation: 'A single snapshot must not become a durable lesson.',
            steps: [],
            lessons: [lessonFor(projection)],
        })] }, projection);
        assert.equal(invalidLesson.entries.length, 0);
        assert.match(invalidLesson.issues.join('\n'), /entries\.0\.lessons\.0\.observationIds: selected O1\(V1\), O2\(V1\) cover 1\/2 independent V\* snapshots/);
        assert.doesNotMatch(invalidLesson.issues.join('\n'), /Too small: expected number to be >=2/);
    });

    it('requires successful matching source path, symbol, and tool for every step finding', () => {
        // Verify a step cannot borrow a source from another path, symbol, or failed tool observation.
        const episodes = makeRouteEpisodes();
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const observations = observationsFor(projection, 'searchCode');
        const sourceId = sourceForObservation(projection, observations[0]);
        const mismatched = projection.observations.get(observations[1])!;
        mismatched.observation = {
            ...mismatched.observation,
            tool: 'readFileContent',
            arguments: { ...mismatched.observation.arguments, filePath: 'src/services/memory/service.ts', symbol: 'actualSymbol' },
            evidence: mismatched.observation.evidence.map(evidence => ({
                ...evidence, source: { ...evidence.source, path: 'src/services/memory/service.ts', excerpt: 'actual excerpt' },
            })),
        };
        const invalid = validateConsolidation({ groups: [finding(group, {
            existingEntryId: null,
            situation: 'Invalid source matching must fail validation.',
            steps: [{ sourceId, symbol: 'missingSymbol', purpose: 'This purpose is not supported by the cited source.',
                findings: findingsFor(projection, observations) }], lessons: [],
        })] }, projection);
        assert.equal(invalid.entries.length, 0);
        const issues = invalid.issues.join('\n');
        assert.match(issues, /entries\.0\.steps\.0\.findings\.0: O2\(V1\).*expected path "src\/ui\/memoryWebviewPolicy\.ts", symbol "missingSymbol", and tool "searchCode"; actual paths are \["src\/ui\/memoryWebviewPolicy\.ts"\], actual symbol argument is "filterMemoryLogsForWebview", and actual tool is "searchCode"/);
        assert.match(issues, /entries\.0\.steps\.0\.findings\.1: O5\(V2\).*expected path "src\/ui\/memoryWebviewPolicy\.ts", symbol "missingSymbol", and tool "searchCode"; actual paths are \["src\/services\/memory\/service\.ts"\], actual symbol argument is "actualSymbol", and actual tool is "readFileContent"/);
        assert.doesNotMatch(invalid.issues.join('\n'), /Too small: expected number to be >=2/);
    });

    it('requires the complete ordered route to occur in two independent investigations', () => {
        // Verify two individually supported steps are insufficient when their order never repeats within two snapshots.
        const episodes = makeRouteEpisodes({ reverseSecondRoute: true });
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const first = observationsFor(projection, 'readFileContent');
        const second = observationsFor(projection, 'searchCode');
        const raw = finding(group, {
            existingEntryId: null, situation: 'A route requires repeated order.',
            steps: [
                { sourceId: sourceForObservation(projection, first[0]), symbol: 'filterMemoryLogsForWebview', purpose: 'Read the filtering entry.',
                    findings: findingsFor(projection, first) },
                { sourceId: sourceForObservation(projection, second[0]), symbol: 'filterMemoryLogsForWebview', purpose: 'Search the filtering branch.',
                    findings: findingsFor(projection, second) },
            ], lessons: [],
        });
        const invalid = validateConsolidation({ groups: [raw] }, projection);
        assert.equal(invalid.entries.length, 0);
        assert.match(invalid.issues.join('\n'), /entries\.0\.steps: the complete route must occur in order within investigations from two independent snapshots; matched 1\/2/);
    });

    it('rejects non-final or unrelated claims for a positive step', () => {
        // Verify a step support must point to a non-omit final claim that references the cited source evidence.
        const episodes = makeRouteEpisodes();
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const observations = observationsFor(projection, 'searchCode');
        const findings = findingsFor(projection, observations);
        const invalidClaimIndex = findings[0].claimIndex;
        episodes[0].claims[invalidClaimIndex] = { claim: 'An unrelated claim.', evidenceRefs: [], disposition: 'must_express' };
        const invalid = validateConsolidation({ groups: [finding(group, {
            existingEntryId: null, situation: 'A source needs a final supporting claim.', steps: [{
                sourceId: sourceForObservation(projection, observations[0]), symbol: 'filterMemoryLogsForWebview', purpose: 'Inspect the cited source.',
                findings,
            }], lessons: [],
        })] }, projection);
        assert.equal(invalid.entries.length, 0);
        assert.match(invalid.issues.join('\n'), /entries\.0\.steps\.0\.findings\.0: route support O2\(V1\) requires a recorded questionIndex and a retained non-omit claimIndex citing its matching source evidence/);
    });

    it('rejects legacy concerns, oversized arrays, unknown handles, and empty experiences', () => {
        // Verify the new schema fails closed instead of repairing the removed concerns and supports fields.
        const episodes = makeRouteEpisodes();
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const baseEntry = { existingEntryId: null, situation: 'A valid situation.', steps: [], lessons: [lessonFor(projection)] };
        const base = finding(group, baseEntry);
        const legacy = validateConsolidation({ groups: [{ ...base, concerns: [{ text: 'Old shape', sourceIds: ['S1', 'S2'] }] }] }, projection);
        assert.equal(legacy.entries.length, 0);
        assert.match(legacy.issues.join('\n'), /Unrecognized key: "concerns"/);

        const tooManySteps = { ...base, entries: [{ ...baseEntry, steps: Array.from({ length: 5 }, () => stepFor(projection)) }] };
        const oversized = validateConsolidation({ groups: [tooManySteps] }, projection);
        assert.match(oversized.issues.join('\n'), /steps.*expected array to have <=4 items/);

        const unknown = validateConsolidation({ groups: [finding(group, { existingEntryId: null, situation: 'Unknown observation.', steps: [{
            sourceId: 'S999', symbol: null, purpose: 'Unknown source must fail.', findings: [
                { observationId: 'O1', questionIndex: 0, claimIndex: 0 }, { observationId: 'O999', questionIndex: 0, claimIndex: 0 },
            ],
        }], lessons: [] })] }, projection);
        assert.match(unknown.issues.join('\n'), /entries\.0\.steps\.0\.findings\.1: unknown observation O999\./);
        assert.doesNotMatch(unknown.issues.join('\n'), /Too small: expected number to be >=2/);
        assert.equal(validateConsolidation({ groups: [{ groupId: group.id, outcome: 'findings', rationale: 'No entries is invalid.', entries: [], retirements: [] }] }, projection).issues.length > 0, true);

        const empty = validateConsolidation({ groups: [finding(group, { existingEntryId: null, situation: 'No step or lesson.', steps: [], lessons: [] })] }, projection);
        assert.deepEqual(empty.issues, ['entries.0: an experience needs at least one step or lesson.']);
        assert.doesNotMatch(empty.issues.join('\n'), /Too small: expected number to be >=2/);
    });

    it('updates an existing H1 entry while preserving its persistent identifier', () => {
        // Verify an existing experience is selected by its handle and a complete update keeps its UUID.
        const episodes = makeRouteEpisodes();
        const original = makeHandbook(episodes);
        const group = buildConsolidationGroups(episodes, [], [original]).find(item => item.seedId === episodes[0].id)!;
        assert.deepEqual(group.existing.map(entry => entry.id), [original.id]);
        const projection = projectConsolidation([group]);
        const observations = observationsFor(projection, 'searchCode');
        const validated = validateConsolidation({ groups: [{
            groupId: group.id, outcome: 'findings', rationale: 'The prior entry was rechecked and updated.', entries: [{
                existingEntryId: 'H1', situation: 'Updated situation for the same investigation experience.',
                steps: [{ sourceId: sourceForObservation(projection, observations[0]), symbol: 'filterMemoryLogsForWebview',
                    purpose: 'Use the filtering function as the first investigation entry point.',
                    findings: findingsFor(projection, observations) }], lessons: [],
            }], retirements: [],
        }] }, projection);

        assert.deepEqual(validated.issues, []);
        assert.equal(validated.entries[0].id, original.id);
        assert.equal(validated.entries[0].situation, 'Updated situation for the same investigation experience.');
    });
});

describe('memory retirement validation', () => {
    it('publishes a retirement only from successful after-tree findings in two snapshots', () => {
        // Verify a retirement preserves H1 while requiring source-bound questions and claims from two independent snapshots.
        const episodes = makeRouteEpisodes();
        const original = makeHandbook(episodes);
        const group = buildConsolidationGroups(episodes, [], [original]).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const observations = observationsFor(projection, 'readFileContent');
        const findings = observations.map(observationId => ({
            ...findingsFor(projection, [observationId])[0],
            sourceId: sourceForObservation(projection, observationId),
        }));
        const validated = validateConsolidation({ groups: [{
            groupId: group.id,
            outcome: 'findings',
            rationale: 'The current after-tree evidence invalidates the historical route.',
            entries: [],
            retirements: [{ existingEntryId: 'H1', reason: 'The historical route no longer matches the current source behavior.', replacementEntryIndex: null, findings }],
        }] }, projection);

        assert.deepEqual(validated.issues, []);
        assert.equal(validated.entries.length, 1);
        assert.equal(validated.entries[0].id, original.id);
        assert.equal(validated.entries[0].retirement?.reason, 'The historical route no longer matches the current source behavior.');
        assert.equal(validated.entries[0].retirement?.supports.length, 2);
        assert.equal(validated.entries[0].retirement?.snapshotCount, 2);
        assert.equal(validated.entries[0].retirement?.supports.every(support => support.evidenceId === 'E1'
            && support.questionIndex === 0 && support.claimIndex === 0), true);
    });

    it('rejects retirement findings with an unknown source, unrelated claim, or one snapshot', () => {
        // Verify retirement counterevidence fails closed when its source or finding linkage is invalid or lacks independent snapshots.
        const episodes = makeRouteEpisodes();
        const original = makeHandbook(episodes);
        const group = buildConsolidationGroups(episodes, [], [original]).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const observations = observationsFor(projection, 'readFileContent');
        const validFindings = observations.map(observationId => ({
            ...findingsFor(projection, [observationId])[0],
            sourceId: sourceForObservation(projection, observationId),
        }));
        const unknownSource = validateConsolidation({ groups: [{
            groupId: group.id, outcome: 'findings', rationale: 'Invalid source handle must be rejected.', entries: [],
            retirements: [{ existingEntryId: 'H1', reason: 'Invalid source evidence.', replacementEntryIndex: null,
                findings: [{ ...validFindings[0], sourceId: 'S999' }, validFindings[1]] }],
        }] }, projection);
        assert.equal(unknownSource.entries.length, 0);
        assert.match(unknownSource.issues.join('\n'), /retirements\.0\.findings\.0: retirement counterevidence O1\(V1\) must bind to one of its S\* sources; S999 was not supplied\./);

        const mismatchedOwner = validateConsolidation({ groups: [{
            groupId: group.id, outcome: 'findings', rationale: 'The source owner must match the observation.', entries: [],
            retirements: [{ existingEntryId: 'H1', reason: 'A source owned by another observation is invalid.', replacementEntryIndex: null,
                findings: [{ ...validFindings[0], sourceId: validFindings[1].sourceId }, validFindings[1]] }],
        }] }, projection);
        assert.equal(mismatchedOwner.entries.length, 0);
        assert.match(mismatchedOwner.issues.join('\n'), /retirements\.0\.findings\.0: retirement counterevidence O1\(V1\) must bind to one of its S\* sources; S3 belongs to O4\(V2\) at path "src\/ui\/memoryWebviewPolicy\.ts" on side "after"/);

        const unrelatedClaim = validateConsolidation({ groups: [{
            groupId: group.id, outcome: 'findings', rationale: 'Unrelated claim must be rejected.', entries: [],
            retirements: [{ existingEntryId: 'H1', reason: 'Unrelated claim evidence.', replacementEntryIndex: null,
                findings: [{ ...validFindings[0], claimIndex: 1 }, validFindings[1]] }],
        }] }, projection);
        assert.equal(unrelatedClaim.entries.length, 0);
        assert.match(unrelatedClaim.issues.join('\n'), /retirements\.0\.findings\.0: retirement support O1\(V1\) requires successful after-tree counterevidence with a recorded question and retained claim citing S1 at path "src\/ui\/memoryWebviewPolicy\.ts"; actual side is "after" and actual tool is "readFileContent"/);

        const oneSnapshot = validateConsolidation({ groups: [{
            groupId: group.id, outcome: 'findings', rationale: 'One snapshot must be rejected.', entries: [],
            retirements: [{ existingEntryId: 'H1', reason: 'Only one historical version.', replacementEntryIndex: null,
                findings: [{ ...validFindings[0], sourceId: sourceForObservation(projection, observations[0]) },
                    { ...findingsFor(projection, [observations[0]])[0], sourceId: sourceForObservation(projection, observations[0]) }] }],
        }] }, projection);
        assert.equal(oneSnapshot.entries.length, 0);
        assert.match(oneSnapshot.issues.join('\n'), /retirements\.0\.findings: selected O1\(V1\), O1\(V1\) cover 1\/2 independent V\* snapshots/);
    });

    it('links a retirement to a replacement entry from the same proposal', () => {
        // Verify replacementEntryIndex resolves to the newly validated entry ID while H1 remains a retired record.
        const episodes = makeRouteEpisodes();
        const original = makeHandbook(episodes);
        const group = buildConsolidationGroups(episodes, [], [original]).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const positiveObservations = observationsFor(projection, 'searchCode');
        const retirementObservations = observationsFor(projection, 'readFileContent');
        const validated = validateConsolidation({ groups: [{
            groupId: group.id,
            outcome: 'findings',
            rationale: 'The replacement route supersedes the retired experience.',
            entries: [{
                existingEntryId: null,
                situation: 'When the source changes, inspect the updated filtering route.',
                steps: [{ sourceId: sourceForObservation(projection, positiveObservations[0]), symbol: 'filterMemoryLogsForWebview',
                    purpose: 'Inspect the updated filtering route before expanding callers.', findings: findingsFor(projection, positiveObservations) }],
                lessons: [],
            }],
            retirements: [{ existingEntryId: 'H1', reason: 'The old route was superseded by the updated filtering route.', replacementEntryIndex: 0,
                findings: retirementObservations.map(observationId => ({ ...findingsFor(projection, [observationId])[0], sourceId: sourceForObservation(projection, observationId) })) }],
        }] }, projection);

        assert.deepEqual(validated.issues, []);
        assert.equal(validated.entries.length, 2);
        const replacement = validated.entries.find(entry => entry.id !== original.id)!;
        const retired = validated.entries.find(entry => entry.id === original.id)!;
        assert.ok(replacement);
        assert.equal(retired.retirement?.replacementEntryId, replacement.id);
    });

    it('requires both entries and retirements arrays for every proposal group', () => {
        // Verify the version-3 proposal protocol rejects omitted retirements and requires empty arrays for no-findings.
        const episodes = makeRouteEpisodes();
        const group = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
        const projection = projectConsolidation([group]);
        const omitted = validateConsolidation({ groups: [{ groupId: group.id, outcome: 'no-findings', rationale: 'The shape is intentionally incomplete.', entries: [] }] }, projection);
        assert.equal(omitted.entries.length, 0);
        assert.match(omitted.issues.join('\n'), /retirements|required/i);
    });
});

describe('consolidatePending lifecycle', () => {
    it('publishes a finding and reports the G1 outcome with entry IDs', async () => {
        // Verify a validated seed result is atomically published and exposes a reviewable group outcome.
        await withTempStorage(async storageRoot => {
            const repositoryId = 'a'.repeat(64);
            const episodes = makeRouteEpisodes({ repositoryId });
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, episodes);
            const runner = makeRunner(async (input, _signal, validate) => {
                const projected = JSON.parse(input) as { groups: Array<{ id: string }> };
                const sourceGroup = buildConsolidationGroups(episodes, []).find(item => item.seedId === episodes[0].id)!;
                const projection = projectConsolidation([sourceGroup]);
                const observations = observationsFor(projection, 'searchCode');
                return { value: validate({ groups: [{
                    groupId: projected.groups[0].id,
                    outcome: 'findings',
                    rationale: 'Published from repeated route evidence.',
                    entries: [{
                        existingEntryId: null,
                        situation: 'When lifecycle filtering changes, inspect the filtering entry point.',
                        steps: [{
                            sourceId: sourceForObservation(projection, observations[0]),
                            symbol: 'filterMemoryLogsForWebview',
                            purpose: 'Inspect filtering conditions.',
                            findings: findingsFor(projection, observations),
                        }],
                        lessons: [],
                    }],
                    retirements: [],
                }] }), attempts: 1 };
            });

            const result = await consolidatePending(store, runner, new AbortController().signal);
            assert.equal(result.status, 'published');
            if (result.status !== 'published' && result.status !== 'partial' && result.status !== 'no-findings') { return; }
            assert.equal(result.groupOutcomes.length, 1);
            assert.equal(result.groupOutcomes[0].seedId, episodes[0].id);
            assert.equal(result.groupOutcomes[0].status, 'published');
            assert.equal(result.groupOutcomes[0].entryIds.length, 1);
            assert.equal(result.groupOutcomes[0].issues.length, 0);
            assert.equal((await store.inspect()).handbook.length, 1);
        });
    });

    it('does not remove existing handbook entries when a recheck returns no-findings', async () => {
        // Verify no-findings records completion without treating the absence of new findings as deletion.
        await withTempStorage(async storageRoot => {
            const repositoryId = 'b'.repeat(64);
            const episodes = makeRouteEpisodes({ repositoryId });
            const original = makeHandbook(episodes);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, episodes);
            const initial = await store.inspect();
            const reservation = await store.reserveConsolidation(initial, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a publication lease for the existing handbook fixture.'); }
            await store.publishHandbook(initial, reservation.generation, reservation.id, [original], [], undefined, MEMORY_DEFAULTS);
            const group = buildConsolidationGroups(episodes, [], [original]).find(item => item.seedId === episodes[0].id)!;
            const runner = makeRunner(async (input, _signal, validate) => {
                const projected = JSON.parse(input) as { groups: Array<{ id: string }> };
                return { value: validate({ groups: [{ groupId: projected.groups[0].id, outcome: 'no-findings', rationale: 'No new reusable experience was found.', entries: [], retirements: [] }] }), attempts: 1 };
            });

            const result = await consolidatePending(store, runner, new AbortController().signal);
            assert.equal(result.status, 'no-findings');
            assert.deepEqual((await store.inspect()).handbook.map(entry => entry.id), [original.id]);
            const storedGroup = buildConsolidationGroups((await store.inspect()).episodes, [], [original]).find(item => item.seedId === episodes[0].id)!;
            assert.deepEqual((await store.inspect()).consolidated, [storedGroup.fingerprint]);
        });
    });

    it('shrinks only whole episodes when the input budget is tight', async () => {
        // Verify budget fitting never sends a partial episode or source fragment to the consolidation runner.
        await withTempStorage(async storageRoot => {
            const repositoryId = 'c'.repeat(64);
            const episodes = makeRouteEpisodes({ repositoryId });
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, episodes);
            const seen: string[] = [];
            const runner = makeRunner(async (input, _signal, validate) => {
                seen.push(input);
                const projected = JSON.parse(input) as { groups: Array<{ id: string; episodes: Array<{ id: string }> }> };
                return { value: validate({ groups: [{ groupId: projected.groups[0].id, outcome: 'no-findings', rationale: 'The bounded batch is valid.', entries: [], retirements: [] }] }), attempts: 1 };
            }, 1_000_000, input => JSON.parse(input).groups[0].episodes.length > 2 ? 1_100 : 1);

            const result = await consolidatePending(store, runner, new AbortController().signal, makeSettings({ 'consolidation.maxCallsPer24h': 3 }));
            assert.equal(result.status, 'no-findings');
            assert.equal(seen.length, 1);
            const input = JSON.parse(seen[0]) as { groups: Array<{ episodes: Array<{ id: string }> }> };
            assert.ok(input.groups[0].episodes.length >= 2);
            assert.equal(input.groups[0].episodes.every(episode => /^T\d+$/.test(episode.id)), true);
        });
    });
});

function finding(group: ConsolidationGroup, entry: {
    existingEntryId: string | null;
    situation: string;
    steps: Array<{ sourceId: string; symbol: string | null; purpose: string; findings: Array<{ observationId: string; questionIndex: number; claimIndex: number }> }>;
    lessons: Array<{ observation: string; implication: string; limitation: string; observationIds: string[] }>;
}): Record<string, unknown> {
    return { groupId: group.id, outcome: 'findings', rationale: 'The selected observations support this experience.', entries: [entry], retirements: [] };
}

function stepFor(projection: ReturnType<typeof projectConsolidation>): {
    sourceId: string; symbol: string | null; purpose: string; findings: Array<{ observationId: string; questionIndex: number; claimIndex: number }>;
} {
    const observations = [...projection.observations.keys()].slice(0, 2);
    return { sourceId: sourceForObservation(projection, observations[0]), symbol: null, purpose: 'Inspect the cited entry point.',
        findings: findingsFor(projection, observations) };
}

function lessonFor(projection: ReturnType<typeof projectConsolidation>): { observation: string; implication: string; limitation: string; observationIds: string[] } {
    return { observation: 'A bounded history did not return a match.', implication: 'Inspect the entry point directly after an empty search.',
        limitation: 'An empty result is not proof that no implementation exists.', observationIds: [...projection.observations.keys()].slice(0, 2) };
}

function observationsFor(projection: ReturnType<typeof projectConsolidation>, tool: string): string[] {
    return [...projection.observations.entries()].filter(([, item]) => item.observation.tool === tool && item.observation.ok).map(([id]) => id);
}

function findingsFor(projection: ReturnType<typeof projectConsolidation>, observationIds: string[]): Array<{ observationId: string; questionIndex: number; claimIndex: number }> {
    return observationIds.map(observationId => {
        const item = projection.observations.get(observationId);
        if (!item) { throw new Error(`Missing test observation ${observationId}.`); }
        const questionIndex = item.episode.questions.findIndex(question => question.trim().length > 0);
        const evidenceId = item.observation.evidence[0]?.id;
        const claimIndex = evidenceId === undefined ? -1 : item.episode.claims.findIndex(claim =>
            claim.disposition !== 'omit' && claim.evidenceRefs.includes(evidenceId));
        if (questionIndex < 0 || claimIndex < 0) { throw new Error(`Test observation ${observationId} has no positive question/claim fixture.`); }
        return { observationId, questionIndex, claimIndex };
    });
}

function sourceForObservation(projection: ReturnType<typeof projectConsolidation>, observationId: string): string {
    return [...projection.sources.entries()].find(([, value]) => value.observationId === observationId)![0];
}

function findingForEvidence(projection: ReturnType<typeof projectConsolidation>, observationId: string, evidenceId: string): {
    observationId: string; questionIndex: number; claimIndex: number;
} {
    const item = projection.observations.get(observationId);
    if (!item) { throw new Error(`Missing test observation ${observationId}.`); }
    const claimIndex = item.episode.claims.findIndex(claim => claim.disposition !== 'omit' && claim.evidenceRefs.includes(evidenceId));
    if (claimIndex < 0) { throw new Error(`Test observation ${observationId} has no claim for ${evidenceId}.`); }
    return { observationId, questionIndex: 0, claimIndex };
}

function sourceForObservationEvidence(projection: ReturnType<typeof projectConsolidation>, observationId: string, evidenceId: string): string {
    const source = [...projection.sources.entries()].find(([, value]) => value.observationId === observationId && value.evidence.id === evidenceId);
    if (!source) { throw new Error(`Missing source for ${observationId}/${evidenceId}.`); }
    return source[0];
}

function makeClaimBoundEvidenceEpisodes(): InvestigationEpisode[] {
    const targetPath = 'src/ui/memoryWebviewPolicy.ts';
    return [1, 2].map(index => {
        const episode = makeEpisode({ episodeId: uuidFor(index), snapshotId: digestFor(index), changedPaths: [targetPath],
            changedSymbols: ['filterMemoryLogsForWebview'], sourcePath: targetPath, tool: 'readFileContent', observations: [makeObservation({
                step: 0, tool: 'readFileContent', path: targetPath, excerpt: 'first excerpt without the selected claim marker',
                summary: 'Read two excerpts from the filtering entry point.', symbol: 'filterMemoryLogsForWebview',
            })] });
        const secondEvidence = { id: 'E2', source: makeSource(episode.snapshot, targetPath, 'second excerpt cited by the selected final claim') };
        return {
            ...episode,
            observations: [{ ...episode.observations[0], evidence: [...episode.observations[0].evidence, secondEvidence] }],
            claims: [
                { claim: 'The first excerpt provides context.', evidenceRefs: ['E1'], disposition: 'must_express' as const },
                { claim: 'The second excerpt supports the selected finding.', evidenceRefs: ['E2'], disposition: 'must_express' as const },
            ],
        };
    });
}

function makeRouteEpisodes(options: {
    repositoryId?: string;
    reverseSecondRoute?: boolean;
} = {}): InvestigationEpisode[] {
    const repositoryId = options.repositoryId ?? 'd'.repeat(64);
    return [1, 2].map((index, episodeIndex) => {
        const route = options.reverseSecondRoute && episodeIndex === 1
            ? [
                makeObservation({ step: 0, tool: 'searchCode', path: 'src/ui/memoryWebviewPolicy.ts', excerpt: 'filterMemoryLogsForWebview result', summary: 'Search the filtering predicate first.', symbol: 'filterMemoryLogsForWebview' }),
                makeObservation({ step: 1, tool: 'readFileContent', path: 'src/ui/memoryWebviewPolicy.ts', excerpt: 'function filterMemoryLogsForWebview', summary: 'Read the filtering predicate second.', symbol: 'filterMemoryLogsForWebview' }),
            ]
            : [
                makeObservation({ step: 0, tool: 'readFileContent', path: 'src/ui/memoryWebviewPolicy.ts', excerpt: 'function filterMemoryLogsForWebview', summary: 'Read the filtering predicate first.', symbol: 'filterMemoryLogsForWebview' }),
                makeObservation({ step: 1, tool: 'searchCode', path: 'src/ui/memoryWebviewPolicy.ts', excerpt: 'filterMemoryLogsForWebview result', summary: 'Search the filtering predicate second.', symbol: 'filterMemoryLogsForWebview' }),
            ];
        const failed = makeObservation({ step: 2, tool: 'searchCode', path: 'src/ui/memoryWebviewPolicy.ts', excerpt: '', summary: 'No renderer caller was found in this bounded search.', symbol: 'filterMemoryLogsForWebview', ok: false, error: 'No matches', evidence: [] });
        const observations = [...route, failed];
        return makeEpisode({ episodeId: uuidFor(index), snapshotId: digestFor(index), repositoryId,
            changedPaths: ['src/ui/memoryWebviewPolicy.ts'], changedSymbols: ['filterMemoryLogsForWebview'],
            questions: ['Where should a new memory lifecycle log be inspected?'], observations });
    });
}

function addSecondaryTargetSource(episode: InvestigationEpisode): InvestigationEpisode {
    return {
        ...episode,
        observations: episode.observations.map((observation, observationIndex) => ({
            ...observation,
            evidence: [...observation.evidence, {
                id: `EXTRA-${observationIndex}`,
                source: makeSource(episode.snapshot, 'src/services/unrelated.ts', `unrelated source ${observationIndex}`),
            }],
        })),
    };
}

function makeEpisode(options: {
    episodeId?: string;
    snapshotId?: string;
    repositoryId?: string;
    changedPaths?: string[];
    changedSymbols?: string[];
    questions?: string[];
    sourcePath?: string;
    sourceExcerpt?: string;
    summary?: string;
    tool?: string;
    status?: InvestigationEpisode['status'];
    observationCount?: number;
    observations?: RecordedObservation[];
} = {}): InvestigationEpisode {
    const repositoryId = options.repositoryId ?? 'd'.repeat(64);
    const sourcePath = options.sourcePath ?? options.changedPaths?.[0] ?? 'src/ui/memoryWebviewPolicy.ts';
    const snapshot = makeSnapshot(options.snapshotId ?? digestFor(99), repositoryId);
    const observations = options.observations ?? Array.from({ length: options.observationCount ?? 1 }, (_, index) => makeObservation({
        step: index, tool: options.tool ?? 'readFileContent', path: sourcePath,
        excerpt: options.sourceExcerpt ?? `function parseMemoryLog${index}() { return true; }`,
        summary: options.summary ?? 'Read the investigation source.', symbol: options.changedSymbols?.[0] ?? 'parseMemoryLog', snapshot,
    }));
    // Route fixtures are already bound to their target snapshots; generated fixtures bind each observation here.
    const rebound = observations.map(observation => ({
        ...observation,
        evidence: observation.evidence.map(evidence => ({ ...evidence, source: { ...evidence.source, snapshotId: snapshot.id } })),
    }));
    return {
        version: 2,
        id: options.episodeId ?? randomUUID(),
        createdAt: Date.now() + Number(options.episodeId?.slice(-2) ?? 0),
        snapshot,
        changedPaths: options.changedPaths ?? [sourcePath],
        changedSymbols: options.changedSymbols ?? ['parseMemoryLog'],
        questions: options.questions ?? ['Where should the changed source be inspected?'],
        observations: rebound,
        claims: rebound.flatMap(observation => observation.evidence.map(evidence => ({
            claim: `The ${evidence.source.path} source supports the investigation.`, evidenceRefs: [evidence.id], disposition: 'must_express' as const,
        }))),
        status: options.status ?? 'complete',
        model: 'memory-experience-test',
        promptVersion: 'memory-experience-1',
        toolsetVersion: 'snapshot-memory-experience-1',
    };
}

function makeObservation(options: {
    step: number;
    tool: string;
    path: string;
    excerpt: string;
    summary: string;
    symbol?: string;
    ok?: boolean;
    error?: string;
    evidence?: RecordedObservation['evidence'];
    snapshot?: SnapshotIdentity;
}): RecordedObservation {
    const snapshot = options.snapshot ?? makeSnapshot(digestFor(1), 'd'.repeat(64));
    const evidence = options.evidence ?? [{ id: `E${options.step + 1}`, source: makeSource(snapshot, options.path, options.excerpt) }];
    return {
        step: options.step,
        tool: options.tool,
        arguments: { filePath: options.path, symbol: options.symbol ?? null, reason: options.summary },
        ok: options.ok ?? true,
        ...(options.error ? { error: options.error } : {}),
        summary: options.summary,
        evidence,
        durationMs: 1,
        truncated: false,
    };
}

function makeHandbook(episodes: InvestigationEpisode[]): HandbookEntry {
    return {
        id: '10000000-0000-4000-8000-000000000001',
        situation: 'When memory lifecycle visibility changes, inspect the filtering entry point.',
        retirement: null,
        steps: [{
            path: 'src/ui/memoryWebviewPolicy.ts', symbol: 'filterMemoryLogsForWebview',
            purpose: 'Inspect the filtering conditions before changing the renderer.', operation: 'readFileContent',
            supports: episodes.map(episode => ({ episodeId: episode.id, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 })), snapshotCount: 2,
        }],
        lessons: [],
        targetPaths: ['src/ui/memoryWebviewPolicy.ts'],
        triggers: ['src/ui/memoryWebviewPolicy.ts', 'filterMemoryLogsForWebview'],
    };
}

function makeSnapshot(snapshotId: string, repositoryId: string): SnapshotIdentity {
    return {
        id: snapshotId, repositoryId, worktreeId: 'e'.repeat(64), head: 'f'.repeat(40),
        beforeTree: '0'.repeat(40), afterTree: '1'.repeat(40), indexFingerprint: '2'.repeat(64), autoStaged: false,
    };
}

function makeSource(snapshot: SnapshotIdentity, sourcePath: string, excerpt: string): SourceObservation {
    return {
        snapshotId: snapshot.id, path: sourcePath, side: 'after', blobOid: '3'.repeat(40), startLine: 1, endLine: 1,
        excerpt, contentHash: hashContent(excerpt), truncated: false, sourceType: 'text',
    };
}

function makeRunner(
    action: (input: string, signal: AbortSignal, validate: (raw: unknown) => ConsolidationValidation) => Promise<{ value: ConsolidationValidation; attempts: number }>,
    maxInputTokens = 100_000,
    estimateInputTokens: (input: string) => number = () => 0,
): ConsolidationRunner {
    return Object.assign(async (input: string, signal: AbortSignal, validate: (raw: unknown) => ConsolidationValidation) =>
        action(input, signal, validate), { maxInputTokens, estimateInputTokens });
}

async function recordAll(store: MemoryStore, episodes: InvestigationEpisode[]): Promise<void> {
    for (const episode of episodes) { await store.recordEpisode(episode, await store.epoch()); }
}

async function withTempStorage<T>(action: (storageRoot: string) => Promise<T>): Promise<T> {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-memory-consolidator-test-'));
    try { return await action(storageRoot); }
    finally { await fs.rm(storageRoot, { recursive: true, force: true }); }
}

function makeSettings(overrides: Partial<MemorySettings> = {}): MemorySettings {
    return Object.freeze({ ...MEMORY_DEFAULTS, ...overrides });
}

function uuidFor(index: number): string {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function digestFor(index: number): string {
    return index.toString(16).padStart(2, '0').repeat(32);
}
