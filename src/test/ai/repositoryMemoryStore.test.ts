import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { hashContent, SnapshotIdentity } from '../../services/git/repositorySnapshot';
import { MemoryStore } from '../../services/memory/store';
import { HandbookEntry, InvestigationEpisode } from '../../services/memory/types';

describe('MemoryStore', function () {
    this.timeout(20_000);

    it('records and inspects real payload files, then detects payload tampering', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '1'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episode = makeEpisode(repositoryId);
            await store.recordEpisode(episode, await store.epoch());

            const view = await store.inspect();
            assert.deepEqual(view.episodes, [episode]);
            const payloadPath = path.join(store.directory, `${episode.id}.json`);
            const bytes = await fs.readFile(payloadPath);
            const manifest = JSON.parse(await fs.readFile(path.join(store.directory, 'current.json'), 'utf8')) as {
                episodes: Array<{ id: string; hash: string; bytes: number }>;
            };
            const manifestEntry = manifest.episodes.find(entry => entry.id === episode.id);
            assert.ok(manifestEntry);
            assert.equal(manifestEntry.bytes, bytes.length);
            assert.equal(manifestEntry.hash, hashContent(bytes));

            await fs.writeFile(payloadPath, JSON.stringify({ ...episode, model: 'tampered' }));
            await assert.rejects(() => store.inspect(), /Memory integrity check failed/);
        });
    });

    it('rejects duplicates, oversized episodes, and episodes from another repository', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '2'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const epoch = await store.epoch();
            const episode = makeEpisode(repositoryId);
            await store.recordEpisode(episode, epoch);

            await assert.rejects(
                () => store.recordEpisode(episode, epoch),
                /Episode has already been published/,
            );

            const oversized = makeEpisode(repositoryId, { summary: 'x'.repeat(256 * 1024) });
            await assert.rejects(
                async () => store.recordEpisode(oversized, await store.epoch()),
                /Episode exceeds 256 KiB/,
            );

            const foreign = makeEpisode('3'.repeat(64));
            await assert.rejects(
                async () => store.recordEpisode(foreign, await store.epoch()),
                /different repository/,
            );
            assert.equal((await store.inspect()).episodes.length, 1);
        });
    });

    it('shares memory through independent store instances for the same clone identity', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '4'.repeat(64);
            const first = new MemoryStore(storageRoot, repositoryId);
            const second = new MemoryStore(storageRoot, repositoryId);
            const episode = makeEpisode(repositoryId);

            await first.recordEpisode(episode, await first.epoch());

            assert.equal(first.directory, second.directory);
            assert.deepEqual((await second.inspect()).episodes, [episode]);
            assert.equal(await second.epoch(), await first.epoch());
        });
    });

    it('changes epoch on clear, rejects late writes, and preserves the call budget', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '5'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const initialEpoch = await store.epoch();
            const episode = makeEpisode(repositoryId);
            await store.recordEpisode(episode, initialEpoch);
            const beforeReserve = await store.inspect();
            const reservation = await store.reserveConsolidation(beforeReserve, 1);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }
            assert.match(reservation.id, /^[0-9a-f-]{36}$/);

            await store.clear();
            const afterClear = await store.inspect();
            assert.notEqual(afterClear.epoch, initialEpoch);
            assert.deepEqual(afterClear.episodes, []);
            assert.deepEqual(afterClear.handbook, []);

            await assert.rejects(
                () => store.recordEpisode(makeEpisode(repositoryId), initialEpoch),
                /Memory was cleared during generation/,
            );
            const afterClearReservation = await store.reserveConsolidation(afterClear, 1);
            assert.equal(afterClearReservation.status, 'budget-exhausted');
            if (afterClearReservation.status === 'budget-exhausted') {
                assert.equal(afterClearReservation.limit, 1);
                assert.ok(afterClearReservation.resumesAt > Date.now());
            }
        });
    });

    it('strictly rejects a legacy questions handbook while clear preserves accounting and deletes payloads', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'd'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episode = makeEpisode(repositoryId);
            await store.recordEpisode(episode, await store.epoch());
            const expected = await store.inspect();
            const reservation = await store.reserveConsolidation(expected, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }

            const manifestPath = path.join(store.directory, 'current.json');
            const payloadPath = path.join(store.directory, `${episode.id}.json`);
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
                epoch: string;
                generation: number;
                attempts: unknown[];
                episodes: unknown[];
                handbook: unknown[];
                consolidated: unknown[];
                job: unknown;
            };
            const legacyEntry: Record<string, unknown> = { ...makeHandbookEntry(episode.id) };
            delete legacyEntry.concerns;
            legacyEntry.questions = ['Legacy task question'];
            manifest.handbook = [legacyEntry];
            await fs.writeFile(manifestPath, JSON.stringify(manifest));

            await assert.rejects(
                () => store.inspect(),
                /Invalid input|Unrecognized key|expected/i,
                'normal inspection must not migrate a questions field into concerns',
            );
            const beforeClear = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
                generation: number;
                attempts: unknown[];
            };

            await store.clear();

            const cleared = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
                generation: number;
                epoch: string;
                attempts: unknown[];
                episodes: unknown[];
                handbook: unknown[];
                consolidated: unknown[];
                job: unknown;
            };
            assert.equal(cleared.generation, beforeClear.generation + 1);
            assert.notEqual(cleared.epoch, manifest.epoch);
            assert.deepEqual(cleared.attempts, beforeClear.attempts);
            assert.deepEqual(cleared.episodes, []);
            assert.deepEqual(cleared.handbook, []);
            assert.deepEqual(cleared.consolidated, []);
            assert.equal(cleared.job, null);
            await assert.rejects(() => fs.access(payloadPath));

            const view = await store.inspect();
            assert.deepEqual(view.episodes, []);
            assert.deepEqual(view.handbook, []);
            assert.deepEqual(view.consolidated, []);
        });
    });

    it('fails clear on corrupted attempts without changing the manifest or episode payload', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'e'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episode = makeEpisode(repositoryId);
            await store.recordEpisode(episode, await store.epoch());
            const expected = await store.inspect();
            const reservation = await store.reserveConsolidation(expected, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }

            const manifestPath = path.join(store.directory, 'current.json');
            const payloadPath = path.join(store.directory, `${episode.id}.json`);
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
                attempts: Array<Record<string, unknown>>;
            };
            manifest.attempts[0].id = 'not-a-uuid';
            await fs.writeFile(manifestPath, JSON.stringify(manifest));
            const manifestBeforeClear = await fs.readFile(manifestPath);
            const payloadBeforeClear = await fs.readFile(payloadPath);

            await assert.rejects(
                () => store.clear(),
                /Invalid UUID|invalid_format|Invalid input|Unrecognized key|expected/i,
            );
            assert.deepEqual(await fs.readFile(manifestPath), manifestBeforeClear);
            assert.deepEqual(await fs.readFile(payloadPath), payloadBeforeClear);
            await fs.access(payloadPath);
        });
    });

    it('enforces reservation generation and publication lease, then records consumed episodes', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '6'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episode = makeEpisode(repositoryId);
            await store.recordEpisode(episode, await store.epoch());
            const expected = await store.inspect();
            const reservation = await store.reserveConsolidation(expected, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }
            const jobId = reservation.id;
            const reserved = await store.inspect();
            assert.equal(reserved.generation, expected.generation + 1);

            const staleWhileRunning = await store.reserveConsolidation(expected, 2);
            assert.equal(staleWhileRunning.status, 'already-running');
            const duplicateReservation = await store.reserveConsolidation(reserved, 2);
            assert.equal(duplicateReservation.status, 'already-running');
            await store.releaseJob(jobId);
            await assert.rejects(
                () => store.reserveConsolidation(expected, 2),
                /Memory changed before consolidation reservation/,
            );
            const released = await store.inspect();
            const secondReservation = await store.reserveConsolidation(released, 2);
            assert.equal(secondReservation.status, 'reserved');
            if (secondReservation.status !== 'reserved') { throw new Error('Expected a second consolidation reservation.'); }

            const entry = makeHandbookEntry(episode.id);
            await assert.rejects(
                () => store.publishHandbook(released, randomUUID(), [entry], []),
                /lost its publication lease/,
            );
            await store.publishHandbook(released, secondReservation.id, [entry], [episode.id, episode.id]);

            const published = await store.inspect();
            assert.equal(published.generation, released.generation + 2);
            assert.deepEqual(published.handbook, [entry]);
            assert.deepEqual(published.consolidated, [episode.id]);
            await assert.rejects(
                () => store.publishHandbook(released, secondReservation.id, [entry], []),
                /lost its publication lease/,
            );
        });
    });

    it('propagates schema failures instead of silently publishing malformed state', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '7'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const epoch = await store.epoch();
            await assert.rejects(
                () => store.recordEpisode({} as InvestigationEpisode, epoch),
                /Invalid input|expected/i,
            );

            const episode = makeEpisode(repositoryId);
            await store.recordEpisode(episode, epoch);
            const view = await store.inspect();
            const reservation = await store.reserveConsolidation(view, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }
            const jobId = reservation.id;
            const invalidEntry = { ...makeHandbookEntry(episode.id), id: 'not-a-uuid' } as HandbookEntry;
            await assert.rejects(
                () => store.publishHandbook(view, jobId, [invalidEntry], []),
                /Invalid UUID|Invalid input/i,
            );

            await fs.writeFile(path.join(store.directory, 'current.json'), JSON.stringify({ version: 1 }));
            await assert.rejects(() => store.inspect(), /Invalid input|expected/i);
        });
    });

    it('deletes episode payloads and removes handbook entries that support them', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '8'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episode = makeEpisode(repositoryId);
            await store.recordEpisode(episode, await store.epoch());
            const expected = await store.inspect();
            const reservation = await store.reserveConsolidation(expected, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }
            const jobId = reservation.id;
            await store.publishHandbook(expected, jobId, [makeHandbookEntry(episode.id)], [episode.id]);
            const payloadPath = path.join(store.directory, `${episode.id}.json`);
            await fs.access(payloadPath);

            await store.deleteEpisodes([episode.id]);

            const view = await store.inspect();
            assert.deepEqual(view.episodes, []);
            assert.deepEqual(view.handbook, []);
            assert.deepEqual(view.consolidated, []);
            await assert.rejects(() => fs.access(payloadPath));
        });
    });

    it('loads at most twenty navigation episodes under a four MiB payload cap, exact matches first, and skips unrelated corruption', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '9'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const epoch = await store.epoch();
            const now = Date.now();
            const exact = makeEpisode(repositoryId, {
                path: 'src/target.ts', sourcePath: 'src/target.ts', createdAt: now - 1_000,
            });
            await store.recordEpisode(exact, epoch);
            for (let index = 0; index < 21; index += 1) {
                await store.recordEpisode(makeEpisode(repositoryId, {
                    path: `src/broad-${index}.ts`, sourcePath: `src/broad-${index}.ts`,
                    symbol: `broad${index}`, summary: 'x'.repeat(240_000), createdAt: now + index,
                }), epoch);
            }

            const view = await store.loadNavigation({ paths: ['src/target.ts'], symbols: [], keywords: [] });
            assert.equal(view.episodes[0]?.id, exact.id, 'the exact path outranks newer same-directory candidates');
            assert.ok(view.episodes.length <= 20);
            assert.ok(view.episodes.length < 20, 'the four MiB bound, not only the count bound, limits results');
            const loadedBytes = view.episodes.reduce((sum, episode) => sum + Buffer.byteLength(JSON.stringify(episode)), 0);
            assert.ok(loadedBytes <= 4 * 1024 * 1024);

            const isolated = new MemoryStore(storageRoot, 'a'.repeat(64));
            const isolatedEpoch = await isolated.epoch();
            const wanted = makeEpisode('a'.repeat(64), { path: 'src/wanted.ts', sourcePath: 'src/wanted.ts' });
            const unrelated = makeEpisode('a'.repeat(64), { path: 'other/unrelated.md', sourcePath: 'other/unrelated.md' });
            await isolated.recordEpisode(wanted, isolatedEpoch);
            await isolated.recordEpisode(unrelated, isolatedEpoch);
            await fs.writeFile(path.join(isolated.directory, `${unrelated.id}.json`), '{corrupted payload');

            const selected = await isolated.loadNavigation({ paths: ['src/wanted.ts'], symbols: [], keywords: [] });
            assert.deepEqual(selected.episodes.map(episode => episode.id), [wanted.id],
                'an unselected corrupt payload is never opened');
        });
    });

    it('rebuilds the manifest index from committed payloads and ignores an orphan payload', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'b'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episode = makeEpisode(repositoryId, { path: 'src/rebuilt.ts', sourcePath: 'src/rebuilt.ts' });
            await store.recordEpisode(episode, await store.epoch());
            const orphan = makeEpisode(repositoryId, { path: 'src/orphan.ts', sourcePath: 'src/orphan.ts' });
            await fs.writeFile(path.join(store.directory, `${orphan.id}.json`), JSON.stringify(orphan));

            const manifestPath = path.join(store.directory, 'current.json');
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
                episodes: Array<{ id: string; hash: string; bytes: number; createdAt: number; paths: string[]; symbols: string[]; targets: string[]; eligible: boolean }>;
            };
            manifest.episodes[0].paths = ['src/no-longer-indexed.ts'];
            manifest.episodes[0].symbols = [];
            manifest.episodes[0].targets = [];
            await fs.writeFile(manifestPath, JSON.stringify(manifest));

            await store.rebuildIndex();

            const rebuilt = await store.loadNavigation({ paths: ['src/rebuilt.ts'], symbols: [], keywords: [] });
            assert.deepEqual(rebuilt.episodes.map(item => item.id), [episode.id]);
            const rebuiltManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { episodes: Array<{ id: string }> };
            assert.deepEqual(rebuiltManifest.episodes.map(item => item.id), [episode.id],
                'the orphan payload is not imported into the committed manifest index');
        });
    });

    it('purges excluded episodes, handbook dependencies, payload files, jobs, and advances the epoch', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'c'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const epoch = await store.epoch();
            const secret = makeEpisode(repositoryId, { path: 'secrets/token.ts', sourcePath: 'secrets/token.ts' });
            const safe = makeEpisode(repositoryId, { path: 'src/safe.ts', sourcePath: 'src/safe.ts' });
            await store.recordEpisode(secret, epoch);
            await store.recordEpisode(safe, epoch);
            const expected = await store.inspect();
            const reservation = await store.reserveConsolidation(expected, 2);
            assert.equal(reservation.status, 'reserved');
            if (reservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }
            const jobId = reservation.id;
            await store.publishHandbook(expected, jobId, [
                makeHandbookEntry(secret.id, 'secrets/token.ts'),
                makeHandbookEntry(safe.id, 'src/safe.ts'),
            ], [secret.id, safe.id]);
            const secretPayload = path.join(store.directory, `${secret.id}.json`);
            await fs.access(secretPayload);

            await store.purgeExcluded(['secrets/**']);

            const view = await store.inspect();
            assert.notEqual(view.epoch, epoch);
            assert.deepEqual(view.episodes.map(item => item.id), [safe.id]);
            assert.deepEqual(view.handbook.map(item => item.supports[0].episodeId), [safe.id]);
            assert.deepEqual(view.consolidated, [safe.id]);
            await assert.rejects(() => fs.access(secretPayload));
            const current = JSON.parse(await fs.readFile(path.join(store.directory, 'current.json'), 'utf8')) as { job: unknown };
            assert.equal(current.job, null);
        });
    });
});

async function withTempStorage<T>(action: (storageRoot: string) => Promise<T>): Promise<T> {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-memory-test-'));
    try {
        return await action(storageRoot);
    } finally {
        await fs.rm(storageRoot, { recursive: true, force: true });
    }
}

function makeSnapshot(repositoryId: string): SnapshotIdentity {
    return {
        id: 'a'.repeat(64),
        repositoryId,
        worktreeId: 'b'.repeat(64),
        head: 'c'.repeat(40),
        beforeTree: 'd'.repeat(40),
        afterTree: 'e'.repeat(40),
        indexFingerprint: 'f'.repeat(64),
        autoStaged: false,
    };
}

function makeEpisode(
    repositoryId: string,
    options: { id?: string; summary?: string; snapshot?: SnapshotIdentity; tool?: string; createdAt?: number; path?: string; sourcePath?: string; symbol?: string } = {},
): InvestigationEpisode {
    const snapshot = options.snapshot ?? makeSnapshot(repositoryId);
    const excerpt = 'const value = 1;';
    const changedPath = options.path ?? 'src/parser.ts';
    const sourcePath = options.sourcePath ?? changedPath;
    return {
        version: 1,
        id: options.id ?? randomUUID(),
        createdAt: options.createdAt ?? Date.now(),
        snapshot,
        changedPaths: [changedPath],
        changedSymbols: [options.symbol ?? 'parse'],
        questions: ['How does parsing change?'],
        observations: [{
            step: 0,
            tool: options.tool ?? 'readFileContent',
            arguments: { filePath: sourcePath, startLine: 1, maxLines: 1 },
            ok: true,
            summary: options.summary ?? 'read source',
            evidence: [{
                id: 'E1',
                source: {
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
                },
            }],
            durationMs: 1,
            truncated: false,
        }],
        claims: [{
            claim: 'Parsing uses the updated value.',
            evidenceRefs: ['E1'],
            disposition: 'must_express',
        }],
        status: 'complete',
        model: 'test-model',
        promptVersion: 'memory-1',
        toolsetVersion: 'snapshot-1',
    };
}

function makeHandbookEntry(episodeId: string, targetPath = 'src/parser.ts'): HandbookEntry {
    return {
        id: randomUUID(),
        triggers: ['parser'],
        targetPaths: [targetPath],
        concerns: [],
        supports: [{ episodeId, evidenceId: 'E1' }],
        kind: 'navigation',
    };
}
