import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import { describe, it } from 'mocha';
import {
    hashContent,
    RepositorySnapshotReader,
    SnapshotEntry,
    SnapshotIdentity,
    SnapshotSide,
    SourceObservation,
} from '../../services/git/repositorySnapshot';
import { MemoryRetriever } from '../../services/memory/retriever';
import { MemoryView } from '../../services/memory/store';
import { HandbookEntry, InvestigationEpisode } from '../../services/memory/types';
import { MEMORY_DEFAULTS, MemoryRequestError, MemorySettings } from '../../services/memory/settings';

describe('MemoryRetriever', () => {
    it('recalls path and symbol matches while excluding navigation targets', () => {
        const parser = makeEpisode({
            changedPaths: ['src/parser.ts'],
            changedSymbols: ['parse'],
            sourcePath: 'src/parser.ts',
        });
        const generated = makeEpisode({
            changedPaths: ['generated/parser.ts'],
            changedSymbols: ['generatedParse'],
            sourcePath: 'generated/parser.ts',
        });
        const handbook = makeHandbook(parser, ['src/parser.ts', 'generated/parser.ts']);
        const retriever = new MemoryRetriever(
            makeView([parser, generated], [handbook]),
            makeSnapshot(),
            ['generated'],
        );

        const result = retriever.retrieveNavigation({
            paths: ['src/parser.ts'],
            symbols: ['parse'],
            keywords: ['parser'],
        });

        assert.equal(result.length, 1);
        assert.equal(result[0].id, 'M1');
        assert.deepEqual(result[0].targetPaths, ['src/parser.ts']);
        assert.equal(result[0].sourceCount, 1);
        assert.deepEqual(Object.keys(result[0]).sort(), ['concerns', 'id', 'sourceCount', 'targetPaths']);
        assert.equal(result.some(item => item.targetPaths.some(target => target.startsWith('generated/'))), false);
    });

    it('keeps raw episode concerns empty and exposes only handbook concerns', () => {
        const episode = makeEpisode({
            changedPaths: ['src/alpha.ts'],
            changedSymbols: ['alpha'],
            sourcePath: 'src/alpha.ts',
            snapshotId: '1'.repeat(64),
        });
        const supported = makeEpisode({
            changedPaths: ['src/alpha.ts'],
            changedSymbols: ['alphaHistory'],
            sourcePath: 'src/alpha.ts',
            snapshotId: '2'.repeat(64),
        });
        const distilled = ['Caching may delay result publication.', 'Invalidation may race with reads.', 'Third stable concern.'];
        const handbook = { ...makeHandbook(supported, ['src/alpha.ts']), concerns: distilled };
        const retriever = new MemoryRetriever(
            makeView([episode, supported], [handbook]),
            makeSnapshot(),
            [],
        );

        const result = retriever.retrieveNavigation({ paths: ['src/alpha.ts'], symbols: [], keywords: [] });

        assert.equal(result.length, 2);
        for (const item of result) {
            assert.equal('questions' in item, false, 'M* navigation must not expose a questions key');
            assert.deepEqual(Object.keys(item).sort(), ['concerns', 'id', 'sourceCount', 'targetPaths']);
            assert.ok(Array.isArray(item.concerns) && item.concerns.every(concern => typeof concern === 'string'));
        }
        const rawEpisodeNavigation = result.filter(item => item.concerns.length === 0);
        assert.equal(rawEpisodeNavigation.length, 1);
        assert.deepEqual(rawEpisodeNavigation[0].concerns, []);
        const handbookNavigation = result.filter(item => item.concerns.length > 0);
        assert.equal(handbookNavigation.length, 1);
        assert.deepEqual(handbookNavigation[0].concerns, distilled.slice(0, 2));
    });

    it('retains same-path distinct concerns, ranks concern matches, and deduplicates identical identities', () => {
        const episode = makeEpisode({ changedPaths: ['src/shared.ts'], sourcePath: 'src/shared.ts' });
        const alpha = makeHandbook(episode, ['src/shared.ts']);
        alpha.triggers = ['shared'];
        alpha.concerns = ['Alpha cache invariant.'];
        const beta = makeHandbook(episode, ['src/shared.ts']);
        beta.triggers = ['shared'];
        beta.concerns = ['Beta cache invariant.'];
        const duplicateAlpha = makeHandbook(episode, ['src/shared.ts']);
        duplicateAlpha.triggers = ['shared'];
        duplicateAlpha.concerns = ['Alpha cache invariant.'];

        const retriever = new MemoryRetriever(
            makeView([episode], [alpha, beta, duplicateAlpha]),
            makeSnapshot(),
            [],
        );
        const query = { paths: ['src/shared.ts'], symbols: [], keywords: ['beta'] };
        const result = retriever.retrieveNavigation(query);

        assert.equal(result.length, 2, 'distinct concerns survive same-area navigation limits while identical identity is removed');
        assert.equal(result.some(item => item.concerns.length === 0), false,
            'an episode represented by Handbook supports must not consume a raw navigation slot');
        assert.deepEqual(result[0].targetPaths, ['src/shared.ts']);
        assert.deepEqual(result[0].concerns, ['Beta cache invariant.'], 'a concern keyword ranks its navigation first');
        assert.deepEqual(result[1].concerns, ['Alpha cache invariant.']);

        const repeated = retriever.retrieveNavigation(query);
        assert.deepEqual(repeated, result, 'the same full identity keeps its published M* ID');
    });

    it('omits represented raw episodes while retaining an unrepresented episode in another area', () => {
        const represented = makeEpisode({
            changedPaths: ['src/shared.ts'],
            sourcePath: 'src/shared.ts',
            snapshotId: '3'.repeat(64),
        });
        const unrepresented = makeEpisode({
            changedPaths: ['lib/other.ts'],
            sourcePath: 'lib/other.ts',
            snapshotId: '4'.repeat(64),
        });
        const first = makeHandbook(represented, ['src/shared.ts']);
        first.triggers = ['shared'];
        first.concerns = ['Shared cache invariant.'];
        const second = makeHandbook(represented, ['src/shared.ts']);
        second.triggers = ['shared'];
        second.concerns = ['Shared invalidation invariant.'];

        const result = new MemoryRetriever(
            makeView([represented, unrepresented], [first, second]),
            makeSnapshot(),
            [],
        ).retrieveNavigation({
            paths: ['src/shared.ts', 'lib/other.ts'],
            symbols: [],
            keywords: [],
        });

        const shared = result.filter(item => item.targetPaths.includes('src/shared.ts'));
        const other = result.filter(item => item.targetPaths.includes('lib/other.ts'));
        assert.equal(shared.length, 2, 'both distinct Handbook concerns remain visible');
        assert.equal(shared.some(item => item.concerns.length === 0), false);
        assert.equal(other.length, 1, 'the unrepresented eligible episode still has a navigation');
        assert.deepEqual(other[0].concerns, []);
    });

    it('retains raw navigation for evidence not represented by a Handbook support', () => {
        const episode = makeEpisode({
            changedPaths: ['src/parser.ts'],
            sourcePath: 'src/parser.ts',
        });
        episode.observations[0].evidence.push({
            id: 'E2',
            source: makeSource(episode.snapshot, { path: 'lib/helper.md', excerpt: 'helper();' }),
        });
        const retriever = new MemoryRetriever(
            makeView([episode], [makeHandbook(episode, ['src/parser.ts'])]),
            makeSnapshot(),
            [],
        );

        const result = retriever.retrieveNavigation({ paths: ['lib/helper.md'], symbols: [], keywords: [] });

        assert.equal(result.length, 1);
        assert.deepEqual(result[0].targetPaths, ['lib/helper.md']);
        assert.deepEqual(result[0].concerns, []);
        assert.equal(result[0].sourceCount, 1);
    });

    it('orders keyword-only navigation by lexical relevance', () => {
        const partial = makeEpisode({
            changedPaths: ['src/partial.ts'],
            changedSymbols: ['repository'],
            sourcePath: 'src/partial.ts',
        });
        const full = makeEpisode({
            changedPaths: ['src/full.ts'],
            changedSymbols: ['repositoryMemory'],
            sourcePath: 'src/full.ts',
        });
        const result = new MemoryRetriever(
            makeView([partial, full], []),
            makeSnapshot(),
            [],
        ).retrieveNavigation({ paths: [], symbols: [], keywords: ['repository memory'] });

        assert.deepEqual(result.map(item => item.targetPaths[0]), ['src/full.ts', 'src/partial.ts']);
    });

    it('expands a published M navigation id without exposing UUID source handles', async () => {
        const episode = makeEpisode({ changedPaths: ['src/parser.ts'], sourcePath: 'src/parser.ts' });
        const retriever = new MemoryRetriever(
            makeView([episode], [makeHandbook(episode)]),
            makeSnapshot(),
            [],
        );
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });

        assert.match(navigation[0].id, /^M\d+$/);
        const result = await retriever.readMemorySources([navigation[0].id]);
        assert.equal(result.length, 1);
        assert.notEqual(result[0].status, 'unavailable');
        assert.equal(result[0].source?.path, 'src/parser.ts');
        assert.equal(retriever.budget.used, 1);
    });

    it('rejects UUID, evidence, and unknown navigation references without reading sources', async () => {
        const episode = makeEpisode({ changedPaths: ['src/parser.ts'], sourcePath: 'src/parser.ts' });
        const retriever = new MemoryRetriever(makeView([episode], []), makeSnapshot(), []);
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });

        await assert.rejects(
            () => retriever.readMemorySources(['E1']),
            (error: unknown) => error instanceof MemoryRequestError && error.code === 'invalid_arguments',
        );
        await assert.rejects(
            () => retriever.readMemorySources([episode.id]),
            (error: unknown) => error instanceof MemoryRequestError && error.code === 'invalid_arguments',
        );
        await assert.rejects(
            () => retriever.readMemorySources(['M999']),
            (error: unknown) => error instanceof MemoryRequestError && error.code === 'unknown_memory_id',
        );
        assert.equal(retriever.budget.used, 0);
        assert.equal(retriever.usage.invalidReferences, 3);
        assert.equal(navigation[0].id, 'M1');
    });

    it('enforces the configured search and source budgets atomically', async () => {
        const firstEpisode = makeEpisode({ changedPaths: ['src/parser.ts'], sourcePath: 'src/parser.ts' });
        const secondEpisode = makeEpisode({ changedPaths: ['src/other.ts'], sourcePath: 'src/other.ts' });
        const settings = makeSettings({ 'search.maxCalls': 2, 'sources.maxChunks': 1 });
        const retriever = new MemoryRetriever(makeView([firstEpisode, secondEpisode], []), makeSnapshot(), [], () => [], settings);
        const query = { paths: ['src/parser.ts'], symbols: [], keywords: ['parser'] };

        retriever.searchRepositoryMemory(query, 1500);
        retriever.searchRepositoryMemory(query, 1500);
        assert.throws(
            () => retriever.searchRepositoryMemory(query, 1500),
            (error: unknown) => error instanceof MemoryRequestError && error.code === 'search_budget_exceeded',
        );

        const firstNavigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });
        const secondNavigation = retriever.retrieveNavigation({ paths: ['src/other.ts'], symbols: [], keywords: [] });
        assert.equal(firstNavigation[0].id, 'M1');
        assert.equal(secondNavigation[0].id, 'M2');
        await retriever.readMemorySources(['M1']);
        await assert.rejects(
            () => retriever.readMemorySources(['M2']),
            (error: unknown) => error instanceof MemoryRequestError
                && error.code === 'source_budget_exceeded'
                && error.details.requested === 1
                && error.details.used === 1
                && error.details.remaining === 0
                && error.details.limit === 1,
        );
        assert.equal(retriever.budget.used, 1);
        assert.equal(retriever.usage.budgetRejections, 2, 'search and source budget rejections are counted separately');
    });

    it('re-reads a changed source from the current A/B snapshot when its anchor is unique', async () => {
        const episode = makeEpisode({
            snapshotId: '1'.repeat(64),
            sourcePath: 'src/parser.ts',
            sourceOid: '0'.repeat(40),
            sourceExcerpt: 'anchor();',
            sourceStartLine: 2,
            sourceSide: 'before',
        });
        const calls: string[] = [];
        const snapshot = makeSnapshot({
            currentOid: '2'.repeat(40),
            content: 'branch B header\nanchor();\nbranch B footer\n',
            snapshotId: 'b'.repeat(64),
            onRead: (_candidate, side) => calls.push(`read:${side}`),
            onObserve: (_candidate, startLine, side) => calls.push(`observe:${side}:${startLine}`),
        });

        const retriever = new MemoryRetriever(makeView([episode], []), snapshot, []);
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });
        const result = await retriever.readMemorySources([navigation[0].id]);

        assert.equal(result[0].status, 'source_relocated');
        assert.equal(result[0].source?.side, 'before');
        assert.equal(result[0].source?.startLine, 2);
        assert.deepEqual(calls, ['read:before', 'observe:before:2']);
    });

    it('rejects source expansion that exceeds the configured validation deadline', async () => {
        const episode = makeEpisode({
            sourceOid: '0'.repeat(40),
            sourceExcerpt: 'anchor();',
        });
        const snapshot = {
            entry: () => ({ path: 'src/parser.ts', mode: '100644', oid: '2'.repeat(40) }),
            read: async () => new Promise<string>(() => {}),
            observe: async () => { throw new Error('observe should not be called'); },
        } as unknown as RepositorySnapshotReader;
        const retriever = new MemoryRetriever(makeView([episode], []), snapshot, [], () => [], makeSettings({ 'sources.timeoutMs': 250 }));
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });

        await assert.rejects(
            () => retriever.readMemorySources([navigation[0].id]),
            (error: unknown) => error instanceof Error && /Memory source validation exceeded 250 ms/.test(error.message),
        );
        assert.equal(retriever.budget.used, 1, 'an already started validation attempt remains charged');
        assert.equal(retriever.usage.sourceAttempts, 1);
    });

    it('returns unchanged sources without rereading and suppresses ambiguous anchors', async () => {
        const unchangedEpisode = makeEpisode({
            sourcePath: 'src/unchanged.ts',
            sourceOid: '3'.repeat(40),
            sourceExcerpt: 'same();',
        });
        let readCount = 0;
        const unchangedSnapshot = makeSnapshot({
            currentOid: '3'.repeat(40),
            onRead: () => { readCount += 1; },
        });
        const unchangedRetriever = new MemoryRetriever(
            makeView([unchangedEpisode], []),
            unchangedSnapshot,
            [],
        );
        const unchangedNavigation = unchangedRetriever.retrieveNavigation({ paths: ['src/unchanged.ts'], symbols: [], keywords: [] });
        const unchanged = await unchangedRetriever.readMemorySources([unchangedNavigation[0].id]);
        assert.equal(unchanged[0].status, 'source_unchanged');
        assert.equal(readCount, 0);

        const ambiguousEpisode = makeEpisode({
            sourcePath: 'src/ambiguous.ts',
            sourceOid: '4'.repeat(40),
            sourceExcerpt: 'same();',
        });
        const ambiguousRetriever = new MemoryRetriever(
            makeView([ambiguousEpisode], []),
            makeSnapshot({ currentOid: '5'.repeat(40), content: 'same();\nother\nsame();\n' }),
            [],
        );
        const ambiguousNavigation = ambiguousRetriever.retrieveNavigation({ paths: ['src/ambiguous.ts'], symbols: [], keywords: [] });
        const ambiguous = await ambiguousRetriever.readMemorySources([ambiguousNavigation[0].id]);
        assert.equal(ambiguous[0].status, 'needs_revalidation');
        assert.equal('source' in ambiguous[0], false);
    });

    it('marks excluded or missing historical sources unavailable', async () => {
        const episode = makeEpisode({ changedPaths: ['src/secret.ts'], sourcePath: 'src/secret.ts' });
        let currentExcludes: string[] = [];
        const excludedRetriever = new MemoryRetriever(
            makeView([episode], []),
            makeSnapshot(),
            [],
            () => currentExcludes,
        );
        const excludedNavigation = excludedRetriever.retrieveNavigation({ paths: ['src/secret.ts'], symbols: [], keywords: [] });
        currentExcludes = ['src/secret.ts'];
        const excluded = await excludedRetriever.readMemorySources([excludedNavigation[0].id]);
        assert.equal(excluded[0].status, 'unavailable');
        assert.equal(excluded[0].key.length > 0, true);

        const missingRetriever = new MemoryRetriever(
            makeView([episode], []),
            makeSnapshot({ missing: true }),
            [],
        );
        const missingNavigation = missingRetriever.retrieveNavigation({ paths: ['src/secret.ts'], symbols: [], keywords: [] });
        const missing = await missingRetriever.readMemorySources([missingNavigation[0].id]);
        assert.equal(missing[0].status, 'unavailable');
        assert.equal(missing[0].key.length > 0, true);
        assert.equal(missingRetriever.budget.used, 1);
    });

    it('reuses cached source results and keeps navigation IDs stable across repeated searches', async () => {
        const episode = makeEpisode({ changedPaths: ['src/parser.ts'], sourcePath: 'src/parser.ts' });
        let readCount = 0;
        const retriever = new MemoryRetriever(
            makeView([episode], []),
            makeSnapshot({ onRead: () => { readCount += 1; } }),
            [],
        );
        const first = retriever.searchRepositoryMemory({ paths: ['src/parser.ts'], symbols: [], keywords: [] });
        const second = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });
        assert.deepEqual(second, first);
        await retriever.readMemorySources(['M1']);
        const used = retriever.budget.used;
        const cached = await retriever.readMemorySources(['M1']);
        assert.deepEqual(cached, await retriever.readMemorySources(['M1']));
        assert.equal(retriever.budget.used, used);
        assert.equal(readCount, 1);
        assert.equal(retriever.usage.sourceAttempts, 1);
    });

    it('deduplicates overlapping sources by the complete source fingerprint', async () => {
        const episode = makeEpisode({ changedPaths: ['src/shared.ts'], sourcePath: 'src/shared.ts' });
        const first = makeHandbook(episode);
        first.triggers = ['alpha'];
        first.concerns = ['Alpha establishes stable parser caching.'];
        const second = makeHandbook(episode);
        second.triggers = ['beta'];
        second.concerns = ['Beta establishes stable cache invalidation.'];
        let observeCount = 0;
        const retriever = new MemoryRetriever(
            makeView([episode], [first, second]),
            makeSnapshot({ onObserve: () => { observeCount += 1; } }),
            [],
        );

        const firstNavigation = retriever.retrieveNavigation({ paths: [], symbols: [], keywords: ['alpha'] });
        const secondNavigation = retriever.retrieveNavigation({ paths: [], symbols: [], keywords: ['beta'] });
        assert.deepEqual(firstNavigation.map(item => item.id), ['M1']);
        assert.deepEqual(secondNavigation.map(item => item.id), ['M2']);

        const result = await retriever.readMemorySources(['M1', 'M2']);

        assert.equal(result.length, 1);
        assert.equal(result[0].status, 'source_relocated');
        assert.equal(observeCount, 1);
        assert.equal(retriever.usage.sourceAttempts, 1);
        assert.equal(retriever.budget.used, 1);
    });

    it('resolves every navigation ID before reading any mixed valid and unknown request', async () => {
        const episode = makeEpisode({ changedPaths: ['src/parser.ts'], sourcePath: 'src/parser.ts' });
        let observeCount = 0;
        const retriever = new MemoryRetriever(
            makeView([episode], []),
            makeSnapshot({ onObserve: () => { observeCount += 1; } }),
            [],
        );
        retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });

        await assert.rejects(
            () => retriever.readMemorySources(['M1', 'M404']),
            (error: unknown) => error instanceof MemoryRequestError
                && error.code === 'unknown_memory_id'
                && error.details.memoryId === 'M404',
        );
        assert.equal(observeCount, 0);
        assert.equal(retriever.usage.sourceAttempts, 0);
        assert.equal(retriever.budget.used, 0);
    });

    it('rejects an over-budget batch before partially expanding any source', async () => {
        const first = makeEpisode({ changedPaths: ['src/first.ts'], sourcePath: 'src/first.ts' });
        const second = makeEpisode({ changedPaths: ['src/second.ts'], sourcePath: 'src/second.ts' });
        let observeCount = 0;
        const retriever = new MemoryRetriever(
            makeView([first, second], []),
            makeSnapshot({ onObserve: () => { observeCount += 1; } }),
            [],
            () => [],
            makeSettings({ 'sources.maxChunks': 1 }),
        );
        retriever.retrieveNavigation({ paths: ['src/first.ts'], symbols: [], keywords: [] });
        retriever.retrieveNavigation({ paths: ['src/second.ts'], symbols: [], keywords: [] });

        await assert.rejects(
            () => retriever.readMemorySources(['M1', 'M2']),
            (error: unknown) => error instanceof MemoryRequestError
                && error.code === 'source_budget_exceeded'
                && error.details.requested === 2
                && error.details.used === 0
                && error.details.remaining === 1
                && error.details.limit === 1,
        );
        assert.equal(observeCount, 0);
        assert.equal(retriever.usage.sourceAttempts, 0);
        assert.equal(retriever.budget.used, 0);
    });

    it('rejects an oversized serialized result before caching the expanded source', async () => {
        const episode = makeEpisode({ changedPaths: ['src/parser.ts'], sourcePath: 'src/parser.ts' });
        const retriever = new MemoryRetriever(
            makeView([episode], []),
            makeSnapshot(),
            [],
            () => [],
            makeSettings({ 'sources.maxResultTokens': 1 }),
        );
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });

        await assert.rejects(
            () => retriever.readMemorySources([navigation[0].id]),
            (error: unknown) => error instanceof MemoryRequestError
                && error.code === 'result_budget_exceeded'
                && error.details.limit === 1
                && Number(error.details.requested) > 1,
        );
        assert.equal(retriever.usage.sourceAttempts, 1);
        assert.equal(retriever.usage.expanded, 0);
        assert.equal(retriever.budget.used, 1);

        await assert.rejects(
            () => retriever.readMemorySources([navigation[0].id]),
            (error: unknown) => error instanceof MemoryRequestError && error.code === 'result_budget_exceeded',
        );
        assert.equal(retriever.usage.sourceAttempts, 2, 'a result rejected before cache publication must be attempted again');
        assert.equal(retriever.budget.used, 2);
    });

    it('does not publish a timed-out expansion or mutate its cache after the timeout', async () => {
        const episode = makeEpisode({
            sourceOid: '0'.repeat(40),
            sourceExcerpt: 'parse();',
        });
        let readCount = 0;
        let releaseFirstRead: (() => void) | undefined;
        const snapshot = makeSnapshot({
            onObserve: () => undefined,
        });
        const blockingRead = async (_candidate: string, _side: SnapshotSide = 'after'): Promise<string> => {
            readCount += 1;
            if (readCount === 1) {
                await new Promise<void>(resolve => { releaseFirstRead = resolve; });
            }
            return 'parse();\n';
        };
        const retriever = new MemoryRetriever(
            makeView([episode], []),
            { ...snapshot, read: blockingRead } as unknown as RepositorySnapshotReader,
            [],
            () => [],
            makeSettings({ 'sources.timeoutMs': 30 }),
        );
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });

        await assert.rejects(
            () => retriever.readMemorySources([navigation[0].id]),
            (error: unknown) => error instanceof Error && error.message === 'Memory source validation exceeded 30 ms.',
        );
        assert.equal(retriever.usage.sourceAttempts, 1);
        assert.equal(retriever.usage.expanded, 0);
        assert.equal(retriever.budget.used, 1);

        const second = await retriever.readMemorySources([navigation[0].id]);
        assert.equal(second[0].status, 'source_relocated');
        assert.equal(readCount, 2);
        assert.equal(retriever.usage.sourceAttempts, 2);
        assert.equal(retriever.usage.expanded, 1);
        assert.equal(retriever.budget.used, 2);

        releaseFirstRead?.();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(retriever.usage.expanded, 1);
        assert.equal(retriever.budget.used, 2);
        const cached = await retriever.readMemorySources([navigation[0].id]);
        assert.deepEqual(cached, second);
        assert.equal(retriever.budget.used, 2);
    });

    it('rejects immediately on an external abort without late cache or usage mutation', async () => {
        const episode = makeEpisode({ sourceOid: '0'.repeat(40), sourceExcerpt: 'parse();' });
        let readStartedResolve!: () => void;
        let releaseRead!: () => void;
        const readStarted = new Promise<void>(resolve => { readStartedResolve = resolve; });
        const snapshot = makeSnapshot();
        const blockingRead = async (_candidate: string, _side: SnapshotSide = 'after'): Promise<string> => {
            readStartedResolve();
            await new Promise<void>(resolve => { releaseRead = resolve; });
            return 'parse();\n';
        };
        const retriever = new MemoryRetriever(
            makeView([episode], []),
            { ...snapshot, read: blockingRead } as unknown as RepositorySnapshotReader,
            [],
            () => [],
            makeSettings({ 'sources.timeoutMs': 5_000 }),
        );
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });
        const controller = new AbortController();
        const reason = new Error('caller aborted');
        const pending = retriever.readMemorySources([navigation[0].id], controller.signal);
        await readStarted;
        const started = Date.now();
        controller.abort(reason);

        await assert.rejects(pending, (error: unknown) => error === reason);
        assert.ok(Date.now() - started < 500, 'external cancellation should not wait for the source timeout');
        assert.equal(retriever.usage.sourceAttempts, 1);
        assert.equal(retriever.usage.expanded, 0);
        assert.equal(retriever.budget.used, 1);

        releaseRead();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(retriever.usage.expanded, 0);
        assert.equal(retriever.budget.used, 1);
    });
});

function makeView(episodes: InvestigationEpisode[], handbook: HandbookEntry[]): MemoryView {
    return { epoch: 'epoch', generation: 1, episodes, handbook, consolidated: [] };
}

function makeSettings(overrides: Partial<MemorySettings> = {}): MemorySettings {
    return Object.freeze({ ...MEMORY_DEFAULTS, ...overrides });
}

function makeIdentity(snapshotId: string): SnapshotIdentity {
    return {
        id: snapshotId,
        repositoryId: 'a'.repeat(64),
        worktreeId: 'b'.repeat(64),
        head: 'c'.repeat(40),
        beforeTree: 'd'.repeat(40),
        afterTree: 'e'.repeat(40),
        indexFingerprint: 'f'.repeat(64),
        autoStaged: false,
    };
}

function makeEpisode(options: {
    episodeId?: string;
    snapshotId?: string;
    changedPaths?: string[];
    changedSymbols?: string[];
    sourcePath?: string;
    sourceOid?: string;
    sourceExcerpt?: string;
    sourceStartLine?: number;
    sourceSide?: SnapshotSide;
    tool?: string;
    includeMemoryObservation?: boolean;
} = {}): InvestigationEpisode {
    const snapshot = makeIdentity(options.snapshotId ?? '0'.repeat(64));
    const sourcePath = options.sourcePath ?? 'src/parser.ts';
    const sourceExcerpt = options.sourceExcerpt ?? 'parse();';
    const source = makeSource(snapshot, {
        path: sourcePath,
        blobOid: options.sourceOid ?? '1'.repeat(40),
        excerpt: sourceExcerpt,
        startLine: options.sourceStartLine ?? 1,
        endLine: options.sourceStartLine ?? 1,
        side: options.sourceSide ?? 'after',
    });
    const observations: InvestigationEpisode['observations'] = [{
        step: 0,
        tool: options.tool ?? 'readFileContent',
        arguments: { filePath: sourcePath, startLine: source.startLine, maxLines: 1 },
        ok: true,
        summary: 'read current source',
        evidence: [{ id: 'E1', source }],
        durationMs: 1,
        truncated: false,
    }];
    if (options.includeMemoryObservation) {
        observations.push({
            step: 1,
            tool: 'readMemorySources',
            arguments: { memoryIds: ['M1'] },
            ok: true,
            summary: 'read historical navigation',
            evidence: [{ id: 'E2', source: makeSource(snapshot, { ...source, contentHash: hashContent(source.excerpt) }) }],
            durationMs: 1,
            truncated: false,
        });
    }
    return {
        version: 1,
        id: options.episodeId ?? randomUUID(),
        createdAt: Date.now(),
        snapshot,
        changedPaths: options.changedPaths ?? [sourcePath],
        changedSymbols: options.changedSymbols ?? ['parse'],
        questions: ['Where is the parser used?'],
        observations,
        claims: [{ claim: 'Parser evidence is available.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        status: 'complete',
        model: 'retriever-test',
        promptVersion: 'memory-1',
        toolsetVersion: 'snapshot-1',
    };
}

function makeSource(snapshot: SnapshotIdentity, overrides: Partial<SourceObservation> = {}): SourceObservation {
    const source: SourceObservation = {
        snapshotId: snapshot.id,
        path: 'src/parser.ts',
        side: 'after',
        blobOid: '1'.repeat(40),
        startLine: 1,
        endLine: 1,
        excerpt: 'parse();',
        contentHash: hashContent('parse();'),
        truncated: false,
        sourceType: 'text',
        ...overrides,
    };
    source.contentHash = hashContent(source.excerpt);
    return source;
}

function makeHandbook(episode: InvestigationEpisode, targetPaths = [episode.changedPaths[0]]): HandbookEntry {
    return {
        id: randomUUID(),
        triggers: [...episode.changedPaths, ...episode.changedSymbols],
        targetPaths,
        // Raw episodes never promote task-specific questions into navigation concerns.
        concerns: [],
        supports: [{ episodeId: episode.id, evidenceId: 'E1' }],
        kind: 'navigation',
    };
}

function makeSnapshot(options: {
    currentOid?: string;
    content?: string;
    snapshotId?: string;
    missing?: boolean;
    onRead?: (candidate: string, side: SnapshotSide) => void;
    onObserve?: (candidate: string, startLine: number, side: SnapshotSide) => void;
} = {}): RepositorySnapshotReader {
    const entry = (_candidate: string, _side: SnapshotSide = 'after'): SnapshotEntry | undefined => options.missing
        ? undefined
        : { path: _candidate, mode: '100644', oid: options.currentOid ?? '2'.repeat(40) };
    const read = async (candidate: string, side: SnapshotSide = 'after'): Promise<string> => {
        options.onRead?.(candidate, side);
        return options.content ?? 'parse();\n';
    };
    const observe = async (
        candidate: string,
        startLine: number,
        _maxLines: number,
        _excludes: string[] = [],
        side: SnapshotSide = 'after',
        maxChars = 2000,
    ): Promise<SourceObservation> => {
        options.onObserve?.(candidate, startLine, side);
        const excerpt = (options.content ?? 'parse();\n').split('\n').slice(startLine - 1, startLine).join('\n').slice(0, maxChars);
        return {
            snapshotId: options.snapshotId ?? '9'.repeat(64),
            path: candidate,
            side,
            blobOid: options.currentOid ?? '2'.repeat(40),
            startLine,
            endLine: startLine,
            excerpt,
            contentHash: hashContent(excerpt),
            truncated: false,
            sourceType: 'text',
        };
    };
    return { entry, read, observe } as unknown as RepositorySnapshotReader;
}
