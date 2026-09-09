import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { hashContent, SnapshotIdentity } from '../../services/git/repositorySnapshot';
import { MEMORY_DEFAULTS } from '../../services/memory/settings';
import { MemoryStore } from '../../services/memory/store';
import { HandbookEntry, InvestigationEpisode, MemorySupport } from '../../services/memory/types';

describe('MemoryStore', function () {
    this.timeout(20_000);

    it('records v2 episodes, exposes v3 represented supports, and detects payload tampering', async () => {
        // Verify durable episodes use the new protocol and manifest while shared store instances read the same clone data.
        await withTempStorage(async storageRoot => {
            const repositoryId = '1'.repeat(64);
            const first = new MemoryStore(storageRoot, repositoryId);
            const second = new MemoryStore(storageRoot, repositoryId);
            const episode = makeEpisode(repositoryId, 1);
            await first.recordEpisode(episode, await first.epoch());

            const view = await second.inspect();
            assert.deepEqual(view.episodes, [episode]);
            assert.deepEqual(view.representedSupports, []);
            assert.deepEqual(view.organizedSeeds, []);
            const manifestPath = path.join(first.directory, 'current.json');
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version: number; organizedSeeds: string[]; episodes: Array<{ id: string; hash: string; bytes: number }> };
            assert.equal(manifest.version, 3);
            assert.deepEqual(manifest.organizedSeeds, []);
            const payloadPath = path.join(first.directory, `${episode.id}.json`);
            const bytes = await fs.readFile(payloadPath);
            const index = manifest.episodes.find(item => item.id === episode.id);
            assert.ok(index);
            assert.equal(index?.bytes, bytes.length);
            assert.equal(index?.hash, hashContent(bytes));

            await fs.writeFile(payloadPath, JSON.stringify({ ...episode, model: 'tampered' }));
            await assert.rejects(() => second.inspect(), /Memory integrity check failed/);
        });
    });

    it('rejects duplicate, oversized, and foreign episode writes', async () => {
        // Verify storage boundaries reject duplicate identities, current size limits, and another repository identity.
        await withTempStorage(async storageRoot => {
            const repositoryId = '2'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const epoch = await store.epoch();
            const episode = makeEpisode(repositoryId, 1);
            await store.recordEpisode(episode, epoch);
            await assert.rejects(() => store.recordEpisode(episode, epoch), /already been published/);

            const oversized = makeEpisode(repositoryId, 2, { summary: 'x'.repeat(256 * 1024) });
            const currentEpoch = await store.epoch();
            await assert.rejects(() => store.recordEpisode(oversized, currentEpoch), /Episode exceeds 256 KiB/);

            const foreign = makeEpisode('3'.repeat(64), 3);
            await assert.rejects(() => store.recordEpisode(foreign, currentEpoch), /different repository/);
            assert.deepEqual((await store.inspect()).episodes.map(item => item.id), [episode.id]);
        });
    });

    it('clears incompatible history, advances epoch, and preserves no old payloads', async () => {
        // Verify explicit clearing is the only reset path for an incompatible manifest and never migrates its old contents.
        await withTempStorage(async storageRoot => {
            const repositoryId = '4'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const oldEpoch = await store.epoch();
            const episode = makeEpisode(repositoryId, 1);
            await store.recordEpisode(episode, oldEpoch);
            const beforeClear = await store.inspect();
            const reservation = await store.reserveConsolidation(beforeClear, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }

            const manifestPath = path.join(store.directory, 'current.json');
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
            manifest.version = 2;
            await fs.writeFile(manifestPath, JSON.stringify(manifest));
            await assert.rejects(() => store.inspect(), /Invalid input|expected|version/i);

            await store.clear();
            const cleared = await store.inspect();
            assert.equal(cleared.epoch === oldEpoch, false);
            assert.deepEqual(cleared.episodes, []);
            assert.deepEqual(cleared.handbook, []);
            assert.deepEqual(cleared.representedSupports, []);
            assert.deepEqual(cleared.consolidated, []);
            assert.deepEqual(cleared.organizedSeeds, []);
            const clearedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version: number; job: unknown };
            assert.equal(clearedManifest.version, 3);
            assert.equal(clearedManifest.job, null);
            await assert.rejects(() => fs.access(path.join(store.directory, `${episode.id}.json`)));
            await assert.rejects(() => store.recordEpisode(makeEpisode(repositoryId, 2), oldEpoch), /Memory was cleared during generation/);
        });
    });

    it('publishes a source-validated handbook with represented supports, seed, and consumed group', async () => {
        // Verify a valid experience publication records all handbook provenance and marks the organizing seed atomically.
        await withTempStorage(async storageRoot => {
            const repositoryId = '5'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episodes = [makeEpisode(repositoryId, 1), makeEpisode(repositoryId, 2)];
            const epoch = await store.epoch();
            for (const episode of episodes) { await store.recordEpisode(episode, epoch); }
            const view = await store.inspect();
            const reservation = await store.reserveConsolidation(view, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }
            const entry = makeEntry(episodes);
            const consumed = randomUUID();
            await store.publishHandbook(view, reservation.generation, reservation.id, [entry], [consumed], undefined, MEMORY_DEFAULTS, episodes[0].id);

            const published = await store.inspect();
            assert.deepEqual(published.handbook, [entry]);
            assert.deepEqual(published.representedSupports, entry.steps[0].supports);
            assert.deepEqual(published.organizedSeeds, [episodes[0].id]);
            assert.deepEqual(published.consolidated, [consumed]);
        });
    });

    it('rejects route and retirement publication when provenance violates the v3 source rules', async () => {
        // Verify publication rejects a mismatched route operation and duplicate retirement counterevidence instead of persisting malformed history.
        await withTempStorage(async storageRoot => {
            const repositoryId = '6'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episodes = [makeEpisode(repositoryId, 1), makeEpisode(repositoryId, 2)];
            const epoch = await store.epoch();
            for (const episode of episodes) { await store.recordEpisode(episode, epoch); }

            const routeView = await store.inspect();
            const routeLease = await store.reserveConsolidation(routeView, 2);
            assert.equal(routeLease.status, 'reserved');
            if (routeLease.status !== 'reserved') { throw new Error('Expected a route publication lease.'); }
            const invalidRoute = makeEntry(episodes);
            invalidRoute.steps[0].operation = 'searchCode';
            await assert.rejects(() => store.publishHandbook(routeView, routeLease.generation, routeLease.id, [invalidRoute], []), /Route support/);
            await store.releaseJob(routeLease.id);

            const retirementView = await store.inspect();
            const retirementLease = await store.reserveConsolidation(retirementView, 2);
            assert.equal(retirementLease.status, 'reserved');
            if (retirementLease.status !== 'reserved') { throw new Error('Expected a retirement publication lease.'); }
            const invalidRetirement = makeEntry(episodes);
            const duplicateSupport = { episodeId: episodes[0].id, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 };
            invalidRetirement.retirement = { reason: 'Duplicate counterevidence must fail.', supports: [duplicateSupport, duplicateSupport], snapshotCount: 2, replacementEntryId: null };
            await assert.rejects(() => store.publishHandbook(retirementView, retirementLease.generation, retirementLease.id, [invalidRetirement], []), /Retirement repeats an observation/);
            await store.releaseJob(retirementLease.id);
            assert.deepEqual((await store.inspect()).handbook, []);
        });
    });

    it('ranks matching navigation before reading unrelated corrupted payloads', async () => {
        // Verify loadNavigation reads only selected full episodes, so unrelated corrupt history cannot poison an exact path query.
        await withTempStorage(async storageRoot => {
            const repositoryId = '7'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const epoch = await store.epoch();
            const wanted = makeEpisode(repositoryId, 1, { sourcePath: 'src/wanted.ts' });
            const unrelated = makeEpisode(repositoryId, 2, { sourcePath: 'other/unrelated.md' });
            await store.recordEpisode(wanted, epoch);
            await store.recordEpisode(unrelated, epoch);
            await fs.writeFile(path.join(store.directory, `${unrelated.id}.json`), '{corrupted payload');

            const selected = await store.loadNavigation({ paths: ['src/wanted.ts'], symbols: [], keywords: [] });
            assert.deepEqual(selected.episodes.map(item => item.id), [wanted.id]);
            assert.deepEqual(selected.representedSupports, []);
        });
    });
});

function makeEpisode(repositoryId: string, index: number, options: {
    sourcePath?: string;
    summary?: string;
    side?: 'before' | 'after';
    tool?: string;
} = {}): InvestigationEpisode {
    const sourcePath = options.sourcePath ?? 'src/parser.ts';
    const snapshot = makeSnapshot(repositoryId, index);
    const excerpt = `const value${index} = 1;`;
    const source = { snapshotId: snapshot.id, path: sourcePath, side: options.side ?? 'after' as const,
        blobOid: '1'.repeat(40), startLine: 1, endLine: 1, excerpt, contentHash: hashContent(excerpt), truncated: false, sourceType: 'text' as const };
    return {
        version: 2,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        createdAt: Date.now() + index,
        snapshot,
        changedPaths: [sourcePath],
        changedSymbols: ['parse'],
        questions: ['Which source should be inspected?'],
        observations: [{ step: 0, tool: options.tool ?? 'readFileContent', arguments: { filePath: sourcePath, reason: 'Inspect source.' }, ok: true,
            summary: options.summary ?? 'Read the source.', evidence: [{ id: 'E1', source }], durationMs: 1, truncated: false }],
        claims: [{ claim: 'The source was inspected.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        status: 'complete', model: 'store-test', promptVersion: 'memory-experience-1', toolsetVersion: 'snapshot-memory-experience-1',
    };
}

function makeEntry(episodes: InvestigationEpisode[]): HandbookEntry {
    const pathName = episodes[0].observations[0].evidence[0].source.path;
    const supports: MemorySupport[] = episodes.map(episode => ({ episodeId: episode.id, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 }));
    return {
        id: '10000000-0000-4000-8000-000000000001',
        situation: 'When source behavior changes, inspect the recorded entry point.',
        retirement: null,
        steps: [{ path: pathName, purpose: 'Inspect the source entry point before expanding the investigation.', operation: 'readFileContent', supports, snapshotCount: 2 }],
        lessons: [], targetPaths: [pathName], triggers: [pathName, 'source behavior'],
    };
}

function makeSnapshot(repositoryId: string, index: number): SnapshotIdentity {
    return { id: index.toString(16).padStart(2, '0').repeat(32), repositoryId, worktreeId: 'b'.repeat(64), head: 'c'.repeat(40),
        beforeTree: 'd'.repeat(40), afterTree: 'e'.repeat(40), indexFingerprint: 'f'.repeat(64), autoStaged: false };
}

async function withTempStorage<T>(action: (storageRoot: string) => Promise<T>): Promise<T> {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-memory-store-test-'));
    try { return await action(storageRoot); }
    finally { await fs.rm(storageRoot, { recursive: true, force: true }); }
}
