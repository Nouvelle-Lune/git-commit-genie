import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { describe, it } from 'mocha';
import { hashContent, RepositorySnapshotReader, SnapshotEntry, SnapshotIdentity, SourceObservation } from '../../services/git/repositorySnapshot';
import { MemoryRetriever } from '../../services/memory/retriever';
import { MemoryView } from '../../services/memory/store';
import { MEMORY_DEFAULTS, MemoryRequestError, MemorySettings } from '../../services/memory/settings';
import { HandbookEntry, InvestigationEpisode, MemoryNavigation, RecordedObservation, entrySupports } from '../../services/memory/types';

describe('memory navigation retrieval', () => {
    it('returns structured handbook navigation with situation, steps, lessons, and all provenance counts', () => {
        // Verify a handbook entry exposes its navigation structure while counting observations and snapshots independently.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/ui/memoryWebviewPolicy.ts' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/ui/memoryWebviewPolicy.ts' })];
        const handbook = makeHandbook(episodes);
        const retriever = new MemoryRetriever(makeView(episodes, [handbook]), makeSnapshotReader(), []);

        const result = retriever.retrieveNavigation({ paths: ['src/ui/memoryWebviewPolicy.ts'], symbols: ['filterMemoryLogsForWebview'], keywords: ['visibility'] });

        assert.equal(result.length, 1);
        assert.deepEqual(Object.keys(result[0]).sort(), ['availability', 'id', 'lessons', 'observationCount', 'origin', 'situation', 'snapshotCount', 'sourceCount', 'steps', 'targetPaths']);
        assert.equal(result[0].id, 'M1');
        assert.equal(result[0].origin, 'handbook');
        assert.equal(result[0].availability.location, 'needs_revalidation');
        assert.equal(result[0].availability.experience, 'unverified');
        assert.deepEqual(result[0].availability.targets, [{ path: 'src/ui/memoryWebviewPolicy.ts', state: 'needs_revalidation' }]);
        assert.equal(result[0].situation, handbook.situation);
        assert.deepEqual(result[0].targetPaths, ['src/ui/memoryWebviewPolicy.ts']);
        assert.equal(result[0].steps[0].path, 'src/ui/memoryWebviewPolicy.ts');
        assert.equal(result[0].steps[0].symbol, 'filterMemoryLogsForWebview');
        assert.equal(result[0].lessons[0].limitation, handbook.lessons[0].limitation);
        assert.equal(result[0].sourceCount, 1);
        assert.equal(result[0].observationCount, 2);
        assert.equal(result[0].snapshotCount, 2);
    });

    it('indexes BM25 terms from situation, step purpose, and lesson text', () => {
        // Verify a semantic query can recall an experience even when it does not repeat the target path or symbol.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/memory.ts' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/memory.ts' })];
        const handbook = makeHandbook(episodes);
        handbook.situation = 'When restored session rows appear stale, inspect persistence boundaries.';
        handbook.steps[0].purpose = 'Trace restored lifecycle records before changing rendering.';
        handbook.lessons[0].observation = 'A persisted row is inert after a reload.';
        const retriever = new MemoryRetriever(makeView(episodes, [handbook]), makeSnapshotReader(), []);

        const result = retriever.retrieveNavigation({ paths: [], symbols: [], keywords: ['stale', 'persistence', 'inert'] });

        assert.deepEqual(result.map(item => item.id), ['M1']);
        assert.equal(result[0].situation, handbook.situation);
    });

    it('returns raw eligible episode navigation separately from handbook navigation', () => {
        // Verify an unorganized episode remains a clearly marked historical navigation source with its task context.
        const episode = makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/episode-only.ts', questions: ['Where should this event be traced?'] });
        const retriever = new MemoryRetriever(makeView([episode], []), makeSnapshotReader(), []);

        const result = retriever.retrieveNavigation({ paths: ['src/episode-only.ts'], symbols: [], keywords: [] });

        assert.equal(result.length, 1);
        assert.equal(result[0].origin, 'episode');
        assert.equal(result[0].situation, 'Where should this event be traced?');
        assert.deepEqual(result[0].steps, []);
        assert.deepEqual(result[0].lessons, []);
        assert.equal(result[0].observationCount, 1);
        assert.equal(result[0].snapshotCount, 1);
    });

    it('suppresses represented evidence at evidence granularity while preserving remaining raw clues', () => {
        // Verify a handbook source support hides only its E1 evidence, whereas a lesson support without evidenceId hides the whole observation.
        const episodes = [makeEpisodeWithTwoEvidence(1), makeEpisodeWithTwoEvidence(2)];
        const route: HandbookEntry = {
            ...makeHandbook(episodes),
            lessons: [],
            targetPaths: ['src/primary.ts'],
            triggers: ['src/primary.ts', 'primary source'],
        };
        const rawRetriever = new MemoryRetriever(makeView(episodes, [route]), makeSnapshotReader(), []);
        const raw = rawRetriever.retrieveNavigation({ paths: ['history/secondary.xyz'], symbols: [], keywords: [] });

        assert.equal(raw.length, 1);
        assert.equal(raw.every(item => item.origin === 'episode'), true);
        assert.equal(raw.every(item => JSON.stringify(item.targetPaths) === JSON.stringify(['history/secondary.xyz'])), true);
        assert.equal(raw.every(item => item.sourceCount === 1 && item.observationCount === 1), true);

        const lesson: HandbookEntry = {
            ...route,
            id: randomUUID(),
            situation: 'When the secondary source search fails, inspect the recorded limitation.',
            steps: [],
            lessons: [{ observation: 'The historical search was bounded.', implication: 'Use the saved limitation to plan the next check.',
                limitation: 'The observation is historical context only.', supports: episodes.map(episode => ({ episodeId: episode.id, observationIndex: 0 })), snapshotCount: 2 }],
            targetPaths: ['history/secondary.xyz'],
            triggers: ['secondary source search'],
        };
        const lessonRetriever = new MemoryRetriever(makeView(episodes, [lesson]), makeSnapshotReader(), []);
        const lessonResult = lessonRetriever.retrieveNavigation({ paths: ['history/secondary.xyz'], symbols: [], keywords: [] });

        assert.equal(lessonResult.length, 1);
        assert.equal(lessonResult[0].origin, 'handbook');
        assert.equal(lessonResult.some(item => item.origin === 'episode'), false);
    });

    it('recalls a lesson with no source evidence and returns no source rows on expansion', async () => {
        // Verify a historical failure lesson remains useful for planning even when its supporting observation has no source code.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/memory.ts', failed: true }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/memory.ts', failed: true })];
        const handbook: HandbookEntry = {
            id: randomUUID(), situation: 'When a repository search returns no renderer caller, inspect the filtering entry directly.', retirement: null, steps: [],
            lessons: [{ observation: 'The bounded search returned no caller.', implication: 'Use the filtering function as the next investigation entry point.', limitation: 'An empty result does not prove that the caller is absent.',
                supports: episodes.map((episode, index) => ({ episodeId: episode.id, observationIndex: 0 })), snapshotCount: 2 }],
            targetPaths: ['src/memory.ts'], triggers: ['renderer caller', 'filtering function'],
        };
        const retriever = new MemoryRetriever(makeView(episodes, [handbook]), makeSnapshotReader(), []);

        const navigation = retriever.retrieveNavigation({ paths: [], symbols: [], keywords: ['renderer caller'] });
        assert.equal(navigation.length, 1);
        assert.equal(navigation[0].origin, 'handbook');
        assert.equal(navigation[0].sourceCount, 0);
        assert.equal(navigation[0].observationCount, 2);
        assert.equal(navigation[0].snapshotCount, 2);
        assert.deepEqual(await retriever.readMemorySources([navigation[0].id]), []);
    });

    it('keeps distinct handbook experiences and deduplicates only identical navigation identities', () => {
        // Verify same-area experiences remain distinct when their situations or lessons differ.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/memory.ts' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/memory.ts' })];
        const alpha = makeHandbook(episodes);
        const beta = makeHandbook(episodes);
        beta.id = randomUUID();
        beta.situation = 'When a retry row reappears, inspect lifecycle state transitions.';
        beta.lessons[0].implication = 'Compare the retry transition before changing the UI.';
        const duplicate = structuredClone(alpha);
        duplicate.id = randomUUID();
        const retriever = new MemoryRetriever(makeView(episodes, [alpha, beta, duplicate]), makeSnapshotReader(), []);

        const result = retriever.retrieveNavigation({ paths: ['src/memory.ts'], symbols: [], keywords: [] });

        assert.equal(result.length, 2);
        assert.deepEqual(new Set(result.map(item => item.situation)), new Set([alpha.situation, beta.situation]));
    });
});

describe('live repository memory search', () => {
    it('reloads the store on every async search and keeps M IDs stable for unchanged results', async () => {
        // Verify searchRepositoryMemory bypasses the initial candidate snapshot and queries the live loader each time.
        const episode = makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/initial.ts' });
        const initial = makeView([episode], []);
        const added = makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/newly-indexed.ts' });
        let loads = 0;
        const access = {
            load: async (query: { paths: string[]; symbols: string[]; keywords: string[] }) => {
                loads += 1;
                return query.paths.includes('src/newly-indexed.ts') ? makeView([added], []) : initial;
            },
            epoch: async () => initial.epoch,
        };
        const retriever = new MemoryRetriever(initial, makeSnapshotReader(), [], () => [], MEMORY_DEFAULTS, access);

        const first = await retriever.searchRepositoryMemory({ paths: ['src/initial.ts'], symbols: [], keywords: [] });
        const second = await retriever.searchRepositoryMemory({ paths: ['src/newly-indexed.ts'], symbols: [], keywords: [] });
        const repeat = await retriever.searchRepositoryMemory({ paths: ['src/newly-indexed.ts'], symbols: [], keywords: [] });

        assert.equal(loads, 3);
        assert.deepEqual(first.map(item => item.id), ['M1']);
        assert.deepEqual(second.map(item => item.id), ['M2']);
        assert.deepEqual(repeat.map(item => item.id), ['M2']);
        assert.equal(retriever.budget.searchesUsed, 3);
    });

    it('fails explicitly when async search is requested without a live store accessor', async () => {
        // Verify the live search contract cannot silently fall back to stale in-memory candidates.
        const retriever = new MemoryRetriever(makeView([], []), makeSnapshotReader(), []);
        await assert.rejects(() => retriever.searchRepositoryMemory({ paths: [], symbols: [], keywords: ['anything'] }), /requires a live store/);
    });

    it('rejects a cleared epoch before replacing the current navigation view', async () => {
        // Verify a memory clear invalidates an in-flight search and prevents stale M IDs from being expanded.
        const episode = makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/parser.ts' });
        let currentEpoch = 'different-epoch';
        const access = {
            load: async () => makeView([episode], []),
            epoch: async () => currentEpoch,
        };
        const retriever = new MemoryRetriever(makeView([], []), makeSnapshotReader(), [], () => [], MEMORY_DEFAULTS, access);

        await assert.rejects(() => retriever.searchRepositoryMemory({ paths: ['src/parser.ts'], symbols: [], keywords: [] }), /cleared during investigation/);
        assert.deepEqual(retriever.publishedNavigation, []);
        currentEpoch = 'epoch';
    });

    it('enforces search and whole-navigation token budgets before exposing a partial result', async () => {
        // Verify repeated live searches stop at the configured call budget and oversized entries are skipped whole.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/large.ts', summary: 'large ' + 'x'.repeat(2_000) }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/large.ts', summary: 'large ' + 'x'.repeat(2_000) })];
        const settings = makeSettings({ 'search.maxCalls': 1, 'navigation.maxTokens': 1 });
        const view = makeView(episodes, []);
        const access = { load: async () => view, epoch: async () => view.epoch };
        const retriever = new MemoryRetriever(view, makeSnapshotReader(), [], () => [], settings, access);

        const first = await retriever.searchRepositoryMemory({ paths: ['src/large.ts'], symbols: [], keywords: [] });
        assert.deepEqual(first, []);
        await assert.rejects(() => retriever.searchRepositoryMemory({ paths: ['src/large.ts'], symbols: [], keywords: [] }), (error: unknown) =>
            error instanceof MemoryRequestError && error.code === 'search_budget_exceeded');
    });
});

describe('memory source expansion', () => {
    it('expands M navigation into current E source and preserves the M to E boundary', async () => {
        // Verify reading a published M ID returns current source status while navigation itself never becomes current evidence.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/parser.ts' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/parser.ts' })];
        const retriever = new MemoryRetriever(makeView(episodes, []), makeSnapshotReader({ currentOid: '3'.repeat(40) }), []);
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });

        const result = await retriever.readMemorySources([navigation[0].id]);

        assert.equal(result.length, 1);
        assert.equal(result.every(item => item.status === 'source_relocated'), true);
        assert.equal(result.every(item => item.source?.path === 'src/parser.ts'), true);
        assert.deepEqual(retriever.publishedNavigation[0], navigation[0]);
        assert.equal(retriever.usage.expanded, 1);
    });

    it('returns unavailable for a no-source lesson and rejects unknown M IDs before reading', async () => {
        // Verify source expansion has no fabricated E evidence for lessons without source support and fails closed for unknown IDs.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/parser.ts', failed: true }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/parser.ts', failed: true })];
        const lesson: HandbookEntry = {
            id: randomUUID(), situation: 'An empty search needs a direct source inspection.', retirement: null, steps: [],
            lessons: [{ observation: 'The search returned no matches.', implication: 'Inspect the known filtering entry.', limitation: 'The empty search does not prove absence.',
                supports: episodes.map(episode => ({ episodeId: episode.id, observationIndex: 0 })), snapshotCount: 2 }],
            targetPaths: [], triggers: ['empty search'],
        };
        const retriever = new MemoryRetriever(makeView(episodes, [lesson]), makeSnapshotReader(), []);
        const navigation = retriever.retrieveNavigation({ paths: [], symbols: [], keywords: ['empty search'] });
        assert.equal(navigation.length, 1);
        assert.equal(navigation[0].sourceCount, 0);
        assert.deepEqual(await retriever.readMemorySources([navigation[0].id]), []);
        await assert.rejects(() => retriever.readMemorySources(['M404']), (error: unknown) =>
            error instanceof MemoryRequestError && error.code === 'unknown_memory_id');
    });

    it('rejects a cleared epoch before source validation and does not consume a source attempt', async () => {
        // Verify source expansion observes live epoch invalidation before reading current files.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/parser.ts' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/parser.ts' })];
        let currentEpoch = 'epoch';
        const access = { load: async () => makeView(episodes, []), epoch: async () => currentEpoch };
        const retriever = new MemoryRetriever(makeView(episodes, []), makeSnapshotReader(), [], () => [], MEMORY_DEFAULTS, access);
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });
        currentEpoch = 'cleared';

        await assert.rejects(() => retriever.readMemorySources([navigation[0].id]), /cleared during investigation/);
        assert.equal(retriever.usage.sourceAttempts, 0);
    });

    it('deduplicates identical source fingerprints and reuses cached results', async () => {
        // Verify overlapping M IDs consume one current source attempt and retain the first expansion result.
        const episodes = [makeEpisode({ episodeId: uuidFor(1), snapshotId: digestFor(1), sourcePath: 'src/shared.ts' }),
            makeEpisode({ episodeId: uuidFor(2), snapshotId: digestFor(2), sourcePath: 'src/shared.ts' })];
        const alpha = makeHandbook(episodes);
        const beta = structuredClone(alpha);
        beta.id = randomUUID();
        beta.situation = 'A second historical route for the same source.';
        let observes = 0;
        const retriever = new MemoryRetriever(makeView(episodes, [alpha, beta]), makeSnapshotReader({ onObserve: () => { observes += 1; } }), []);
        const first = retriever.retrieveNavigation({ paths: ['src/shared.ts'], symbols: [], keywords: [] });
        assert.equal(first.length, 2);

        const result = await retriever.readMemorySources(first.map(item => item.id));
        const cached = await retriever.readMemorySources([first[0].id]);

        assert.equal(result.length, 1);
        assert.equal(observes, 1);
        assert.deepEqual(cached, result.slice(0, 1));
        assert.equal(retriever.usage.sourceAttempts, 1);
    });
});

function makeView(episodes: InvestigationEpisode[], handbook: HandbookEntry[]): MemoryView {
    return { epoch: 'epoch', generation: 1, episodes, handbook,
        representedSupports: handbook.flatMap(entrySupports), consolidated: [], organizedSeeds: [] };
}

function makeSettings(overrides: Partial<MemorySettings> = {}): MemorySettings {
    return Object.freeze({ ...MEMORY_DEFAULTS, ...overrides });
}

function makeHandbook(episodes: InvestigationEpisode[]): HandbookEntry {
    return {
        id: randomUUID(), situation: 'When memory lifecycle visibility changes, inspect the filtering entry point.', retirement: null,
        steps: [{ path: 'src/ui/memoryWebviewPolicy.ts', symbol: 'filterMemoryLogsForWebview', purpose: 'Find the filtering branch before changing the renderer.', operation: 'readFileContent',
            supports: episodes.map(episode => ({ episodeId: episode.id, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 })), snapshotCount: 2 }],
        lessons: [{ observation: 'Historical rows can be inert after a reload.', implication: 'Check restoration state before changing lifecycle rendering.', limitation: 'This historical behavior does not establish current source truth.',
            supports: episodes.map(episode => ({ episodeId: episode.id, observationIndex: 0 })), snapshotCount: 2 }],
        targetPaths: ['src/ui/memoryWebviewPolicy.ts'], triggers: ['src/ui/memoryWebviewPolicy.ts', 'filterMemoryLogsForWebview', 'visibility'],
    };
}

function makeEpisode(options: {
    episodeId: string;
    snapshotId: string;
    sourcePath: string;
    questions?: string[];
    summary?: string;
    failed?: boolean;
}): InvestigationEpisode {
    const snapshot = makeIdentity(options.snapshotId);
    const observation: RecordedObservation = {
        step: 0, tool: options.failed ? 'searchCode' : 'readFileContent', arguments: { filePath: options.sourcePath, reason: options.summary ?? 'Inspect the source.' },
        ok: !options.failed, summary: options.summary ?? 'Read the source.', ...(options.failed ? { error: 'No matches' } : {}), evidence: options.failed ? [] : [{ id: 'E1', source: makeSource(snapshot, options.sourcePath) }], durationMs: 1, truncated: false,
    };
    return { version: 2, id: options.episodeId, createdAt: Number(options.episodeId.slice(-2)), snapshot,
        changedPaths: [options.sourcePath], changedSymbols: ['filterMemoryLogsForWebview'], questions: options.questions ?? ['Where should the changed source be inspected?'], observations: [observation],
        claims: observation.evidence.length ? [{ claim: 'The source was inspected.', evidenceRefs: ['E1'], disposition: 'must_express' }] : [], status: 'complete', model: 'retriever-test', promptVersion: 'memory-experience-1', toolsetVersion: 'snapshot-memory-experience-1' };
}

function makeEpisodeWithTwoEvidence(index: number): InvestigationEpisode {
    const episode = makeEpisode({ episodeId: uuidFor(index), snapshotId: digestFor(index), sourcePath: 'src/primary.ts' });
    const snapshot = episode.snapshot;
    const excerpt = 'function filterMemoryLogsForWebview() { return true; }';
    const secondary = { id: 'E2', source: {
        snapshotId: snapshot.id, path: 'history/secondary.xyz', side: 'after' as const, blobOid: '1'.repeat(40), startLine: 1, endLine: 1,
        excerpt, contentHash: hashContent(excerpt), truncated: false, sourceType: 'text' as const,
    } };
    episode.observations[0].evidence.push(secondary);
    episode.claims.push({ claim: 'The secondary source was inspected.', evidenceRefs: ['E2'], disposition: 'must_express' });
    return episode;
}

function makeIdentity(snapshotId: string): SnapshotIdentity {
    return { id: snapshotId, repositoryId: 'a'.repeat(64), worktreeId: 'b'.repeat(64), head: 'c'.repeat(40), beforeTree: 'd'.repeat(40), afterTree: 'e'.repeat(40), indexFingerprint: 'f'.repeat(64), autoStaged: false };
}

function makeSource(snapshot: SnapshotIdentity, sourcePath: string): SourceObservation {
    const excerpt = 'function filterMemoryLogsForWebview() { return true; }';
    return { snapshotId: snapshot.id, path: sourcePath, side: 'after', blobOid: '1'.repeat(40), startLine: 1, endLine: 1, excerpt, contentHash: hashContent(excerpt), truncated: false, sourceType: 'text' };
}

function makeSnapshotReader(options: {
    currentOid?: string;
    missing?: boolean;
    onObserve?: () => void;
} = {}): RepositorySnapshotReader {
    const entry = (candidate: string): SnapshotEntry | undefined => options.missing ? undefined : { path: candidate, mode: '100644', oid: options.currentOid ?? '2'.repeat(40) };
    const read = async (): Promise<string> => 'function filterMemoryLogsForWebview() { return true; }\n';
    const observe = async (candidate: string, startLine: number, _maxLines: number, _excludes: string[] = [], side: 'before' | 'after' = 'after'): Promise<SourceObservation> => {
        options.onObserve?.();
        const excerpt = 'function filterMemoryLogsForWebview() { return true; }';
        return { snapshotId: '9'.repeat(64), path: candidate, side, blobOid: options.currentOid ?? '2'.repeat(40), startLine, endLine: startLine, excerpt, contentHash: hashContent(excerpt), truncated: false, sourceType: 'text' };
    };
    return { identity: makeIdentity('9'.repeat(64)), entry, read, observe } as unknown as RepositorySnapshotReader;
}

function uuidFor(index: number): string {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function digestFor(index: number): string {
    return index.toString(16).padStart(2, '0').repeat(32);
}
