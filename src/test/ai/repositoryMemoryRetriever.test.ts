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
        assert.deepEqual(result[0].supports, [{ episodeId: parser.id, evidenceId: 'E1' }]);
        assert.equal(result.some(item => item.targetPaths.some(target => target.startsWith('generated/'))), false);
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

    it('does not treat an M navigation id as current evidence', async () => {
        const episode = makeEpisode({ changedPaths: ['src/parser.ts'], sourcePath: 'src/parser.ts' });
        const retriever = new MemoryRetriever(
            makeView([episode], [makeHandbook(episode)]),
            makeSnapshot(),
            [],
        );
        const navigation = retriever.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: [] });

        assert.match(navigation[0].id, /^M\d+$/);
        const result = await retriever.readMemorySources([{
            episodeId: episode.id,
            evidenceId: navigation[0].id,
        }]);
        assert.deepEqual(result, [{ status: 'unavailable' }]);
    });

    it('enforces the two-search and eight-source-chunk budgets', async () => {
        const episode = makeEpisode({ changedPaths: ['src/parser.ts'], sourcePath: 'src/parser.ts' });
        const support = { episodeId: episode.id, evidenceId: 'E1' };
        const retriever = new MemoryRetriever(makeView([episode], []), makeSnapshot(), []);
        const query = { paths: ['src/parser.ts'], symbols: [], keywords: ['parser'] };

        retriever.searchRepositoryMemory(query, 1500);
        retriever.searchRepositoryMemory(query, 1500);
        assert.throws(() => retriever.searchRepositoryMemory(query, 1500), /search budget exhausted/);

        await retriever.readMemorySources(Array.from({ length: 8 }, () => support));
        await assert.rejects(
            () => retriever.readMemorySources([support]),
            /source budget exhausted/,
        );
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

        const result = await new MemoryRetriever(makeView([episode], []), snapshot, []).readMemorySources([{
            episodeId: episode.id,
            evidenceId: 'E1',
        }]);

        assert.equal(result[0].status, 'source_relocated');
        assert.equal(result[0].source?.side, 'before');
        assert.equal(result[0].source?.startLine, 2);
        assert.deepEqual(calls, ['read:before', 'observe:before:2']);
    });

    it('rejects source expansion that exceeds the 250 ms validation deadline', async () => {
        const episode = makeEpisode({
            sourceOid: '0'.repeat(40),
            sourceExcerpt: 'anchor();',
        });
        const snapshot = {
            entry: () => ({ path: 'src/parser.ts', mode: '100644', oid: '2'.repeat(40) }),
            read: async () => new Promise<string>(() => {}),
            observe: async () => { throw new Error('observe should not be called'); },
        } as unknown as RepositorySnapshotReader;
        const retriever = new MemoryRetriever(makeView([episode], []), snapshot, []);

        await assert.rejects(
            () => retriever.readMemorySources([{ episodeId: episode.id, evidenceId: 'E1' }]),
            /Memory source validation exceeded 250 ms/,
        );
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
        const unchanged = await new MemoryRetriever(
            makeView([unchangedEpisode], []),
            unchangedSnapshot,
            [],
        ).readMemorySources([{ episodeId: unchangedEpisode.id, evidenceId: 'E1' }]);
        assert.equal(unchanged[0].status, 'source_unchanged');
        assert.equal(readCount, 0);

        const ambiguousEpisode = makeEpisode({
            sourcePath: 'src/ambiguous.ts',
            sourceOid: '4'.repeat(40),
            sourceExcerpt: 'same();',
        });
        const ambiguous = await new MemoryRetriever(
            makeView([ambiguousEpisode], []),
            makeSnapshot({ currentOid: '5'.repeat(40), content: 'same();\nother\nsame();\n' }),
            [],
        ).readMemorySources([{ episodeId: ambiguousEpisode.id, evidenceId: 'E1' }]);
        assert.equal(ambiguous[0].status, 'needs_revalidation');
        assert.equal('source' in ambiguous[0], false);
    });

    it('marks excluded or missing historical sources unavailable', async () => {
        const episode = makeEpisode({ changedPaths: ['src/secret.ts'], sourcePath: 'src/secret.ts' });
        const excluded = await new MemoryRetriever(
            makeView([episode], []),
            makeSnapshot(),
            ['src/secret.ts'],
        ).readMemorySources([{ episodeId: episode.id, evidenceId: 'E1' }]);
        assert.deepEqual(excluded, [{ status: 'unavailable' }]);

        const missing = await new MemoryRetriever(
            makeView([episode], []),
            makeSnapshot({ missing: true }),
            [],
        ).readMemorySources([{ episodeId: episode.id, evidenceId: 'E1' }]);
        assert.deepEqual(missing, [{ status: 'unavailable' }]);
    });
});

function makeView(episodes: InvestigationEpisode[], handbook: HandbookEntry[]): MemoryView {
    return { epoch: 'epoch', generation: 1, episodes, handbook, consolidated: [] };
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
            arguments: { supports: [{ episodeId: 'historical', evidenceId: 'E2' }] },
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
        questions: episode.questions,
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
