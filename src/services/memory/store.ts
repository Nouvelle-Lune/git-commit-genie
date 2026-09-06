import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as lockfile from 'proper-lockfile';
import writeFileAtomic = require('write-file-atomic');
import { z } from 'zod';
import { hashContent } from '../git/repositorySnapshot';
import { HandbookEntry, handbookEntrySchema, InvestigationEpisode, investigationEpisodeSchema, MemoryQuery } from './types';
import { isEligibleEpisode, validateEpisodeSources } from './recorder';
import { shouldExclude } from '../analysis/tools/pathFilters';
import { bm25Scores } from './ranking';

const manifestSchema = z.object({
    version: z.literal(1), epoch: z.uuid(), generation: z.number().int().nonnegative(),
    episodes: z.array(z.object({ id: z.uuid(), hash: z.string(), bytes: z.number().int().positive().max(256 * 1024), createdAt: z.number(),
        paths: z.array(z.string()), symbols: z.array(z.string()), targets: z.array(z.string()), eligible: z.boolean() }).strict()),
    handbook: z.array(handbookEntrySchema),
    attempts: z.array(z.object({ id: z.uuid(), at: z.number(), epoch: z.uuid() }).strict()),
    consolidated: z.array(z.uuid()),
    job: z.object({ id: z.uuid(), expiresAt: z.number() }).strict().nullable(),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
export interface MemoryView { epoch: string; generation: number; episodes: InvestigationEpisode[]; handbook: HandbookEntry[]; consolidated: string[] }

/**
 * One local extension host filesystem per store; no network filesystem support.
 * Readers and writers use the same short lock, so deletion cannot race pinned
 * readers. No lock is held over a provider call. The manifest is the commit point.
 */
export class MemoryStore {
    readonly directory: string;
    private queue: Promise<void> = Promise.resolve();
    constructor(storageRoot: string, readonly repositoryId: string, private readonly maxBytes = 256 * 1024 * 1024) {
        if (!/^[a-f0-9]{64}$/.test(repositoryId)) { throw new Error('Invalid memory repository identity.'); }
        this.directory = path.join(storageRoot, 'repository-memory', repositoryId);
    }

    private locked<T>(action: (state: Manifest, assertOwned: () => void) => Promise<T>): Promise<T> {
        const result = this.queue.then(() => this.withFileLock(action));
        // Keep the queue usable after a rejected operation; its returned promise
        // still propagates the original error to the caller's visible handler.
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async withFileLock<T>(action: (state: Manifest, assertOwned: () => void) => Promise<T>): Promise<T> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        let compromised: Error | undefined;
        const release = await lockfile.lock(this.directory, { stale: 30000, update: 5000,
            retries: { retries: 3, minTimeout: 10, maxTimeout: 40 }, onCompromised: error => { compromised = error; } });
        const assertOwned = () => { if (compromised) { throw compromised; } };
        try {
            const manifestPath = path.join(this.directory, 'current.json');
            let state: Manifest;
            try {
                if ((await fs.stat(manifestPath)).size > 8 * 1024 * 1024) { throw new Error('Memory manifest exceeds 8 MiB.'); }
                state = manifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
                state = { version: 1, epoch: randomUUID(), generation: 0, episodes: [], handbook: [], attempts: [], consolidated: [], job: null };
                assertOwned();
                await writeFileAtomic(manifestPath, JSON.stringify(state), { fsync: true });
            }
            assertOwned();
            return await action(state, assertOwned);
        } finally { if (!compromised) { await release(); } }
    }

    private async publish(state: Manifest, assertOwned: () => void): Promise<void> {
        state.generation += 1;
        const data = JSON.stringify(manifestSchema.parse(state));
        if (Buffer.byteLength(data) > 8 * 1024 * 1024) { throw new Error('Memory manifest exceeds 8 MiB; publication cancelled.'); }
        assertOwned();
        await writeFileAtomic(path.join(this.directory, 'current.json'), data, { fsync: true });
        assertOwned();
    }

    private async readEpisodes(state: Manifest): Promise<InvestigationEpisode[]> {
        const result: InvestigationEpisode[] = [];
        for (const entry of state.episodes) {
            if ((await fs.stat(path.join(this.directory, `${entry.id}.json`))).size !== entry.bytes) { throw new Error(`Memory integrity check failed: ${entry.id}`); }
            const bytes = await fs.readFile(path.join(this.directory, `${entry.id}.json`));
            if (bytes.length !== entry.bytes || hashContent(bytes) !== entry.hash) { throw new Error(`Memory integrity check failed: ${entry.id}`); }
            const episode = investigationEpisodeSchema.parse(JSON.parse(bytes.toString('utf8')));
            if (episode.id !== entry.id || episode.snapshot.repositoryId !== this.repositoryId) { throw new Error('Memory episode identity mismatch.'); }
            validateEpisodeSources(episode);
            result.push(episode);
        }
        return result;
    }

    async inspect(): Promise<MemoryView> {
        return this.locked(async state => ({ epoch: state.epoch, generation: state.generation,
            episodes: await this.readEpisodes(state), handbook: structuredClone(state.handbook), consolidated: [...state.consolidated] }));
    }

    /** Read only a bounded, exact-match-first candidate set, not the entire archive. */
    async loadNavigation(query: MemoryQuery): Promise<MemoryView> {
        return this.locked(async state => {
            const lexical = bm25Scores(state.episodes.map(entry => [...entry.paths, ...entry.symbols, ...entry.targets]), [...query.paths, ...query.symbols, ...query.keywords]);
            const rank = (entry: Manifest['episodes'][number]) =>
                entry.paths.filter(file => query.paths.includes(file)).length * 100 +
                entry.symbols.filter(symbol => query.symbols.includes(symbol)).length * 100 +
                entry.targets.filter(file => query.paths.includes(file)).length * 30 +
                entry.paths.filter(file => query.paths.some(target => path.posix.dirname(file) !== '.' && path.posix.dirname(target) === path.posix.dirname(file))).length * 5 +
                query.keywords.filter(word => word.length > 1 && [...entry.paths, ...entry.symbols].some(value => value.toLowerCase().includes(word.toLowerCase()))).length;
            const candidates = state.episodes.map((entry, index) => ({ entry, score: entry.eligible ? rank(entry) + lexical[index] : 0 }))
                .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt);
            let bytes = 0;
            const selected: Manifest['episodes'] = [];
            for (const { entry } of candidates) {
                if (selected.length >= 20) { break; }
                if (bytes + entry.bytes > 4 * 1024 * 1024) { continue; }
                selected.push(entry); bytes += entry.bytes;
            }
            const ids = new Set(selected.map(entry => entry.id));
            return { epoch: state.epoch, generation: state.generation, episodes: await this.readEpisodes({ ...state, episodes: selected }),
                handbook: state.handbook.filter(entry => entry.supports.every(ref => ids.has(ref.episodeId))), consolidated: [] };
        });
    }

    async epoch(): Promise<string> { return this.locked(async state => state.epoch); }

    async recordEpisode(input: InvestigationEpisode, expectedEpoch: string): Promise<void> {
        const episode = investigationEpisodeSchema.parse(input);
        validateEpisodeSources(episode);
        if (episode.snapshot.repositoryId !== this.repositoryId) { throw new Error('Episode belongs to a different repository.'); }
        const bytes = Buffer.from(JSON.stringify(episode));
        if (bytes.length > 256 * 1024) { throw new Error('Episode exceeds 256 KiB; it was not persisted.'); }
        await this.locked(async (state, assertOwned) => {
            if (state.epoch !== expectedEpoch) { throw new Error('Memory was cleared during generation; episode publication cancelled.'); }
            if (state.episodes.some(entry => entry.id === episode.id)) { throw new Error('Episode has already been published.'); }
            // Publish the immutable payload before exposing it through the manifest.
            assertOwned();
            await writeFileAtomic(path.join(this.directory, `${episode.id}.json`), bytes, { fsync: true });
            state.episodes.push(this.indexEpisode(episode, bytes));
            const cutoff = Date.now();
            const removed = new Set(state.episodes.filter(item => cutoff - item.createdAt > (item.eligible ? 180 : 7) * 86400000).map(item => item.id));
            let retained = state.episodes.filter(entry => !removed.has(entry.id));
            let total = retained.reduce((sum, entry) => sum + entry.bytes, 0);
            for (const entry of [...retained].sort((a, b) => a.createdAt - b.createdAt)) {
                if (retained.length <= 2000 && total <= this.maxBytes) { break; }
                removed.add(entry.id); total -= entry.bytes; retained = retained.filter(item => item.id !== entry.id);
            }
            state.episodes = retained;
            state.handbook = state.handbook.filter(entry => entry.supports.every(support => !removed.has(support.episodeId)));
            state.consolidated = state.consolidated.filter(id => !removed.has(id));
            await this.publish(state, assertOwned);
            for (const id of removed) { assertOwned(); await fs.unlink(path.join(this.directory, `${id}.json`)); }
        });
    }

    private indexEpisode(episode: InvestigationEpisode, bytes: Buffer): Manifest['episodes'][number] {
        return { id: episode.id, hash: hashContent(bytes), bytes: bytes.length, createdAt: episode.createdAt,
            paths: episode.changedPaths, symbols: episode.changedSymbols,
            targets: [...new Set(episode.observations.flatMap(item => item.evidence.map(evidence => evidence.source.path)))], eligible: isEligibleEpisode(episode) };
    }

    async rebuildIndex(): Promise<void> {
        await this.locked(async (state, assertOwned) => {
            // Only manifest-committed payloads are authoritative; orphans are never imported.
            const episodes = await this.readEpisodes(state);
            state.episodes = episodes.map(episode => this.indexEpisode(episode, Buffer.from(JSON.stringify(episode))));
            await this.publish(state, assertOwned);
        });
    }

    async purgeExcluded(excludes: string[]): Promise<void> {
        const ids = await this.locked(async state => state.episodes.filter(entry => [...entry.paths, ...entry.targets].some(file => shouldExclude(file, excludes))).map(entry => entry.id));
        if (ids.length) { await this.deleteEpisodes(ids); }
    }

    async deleteEpisodes(ids: string[]): Promise<void> {
        await this.locked(async (state, assertOwned) => {
            const removed = state.episodes.filter(entry => ids.includes(entry.id));
            state.episodes = state.episodes.filter(entry => !ids.includes(entry.id));
            state.handbook = state.handbook.filter(entry => entry.supports.every(ref => !ids.includes(ref.episodeId)));
            state.consolidated = state.consolidated.filter(id => !ids.includes(id));
            state.epoch = randomUUID(); state.job = null;
            await this.publish(state, assertOwned);
            for (const entry of removed) { assertOwned(); await fs.unlink(path.join(this.directory, `${entry.id}.json`)); }
        });
    }

    async clear(): Promise<void> {
        await this.locked(async (state, assertOwned) => {
            const removed = state.episodes;
            state.epoch = randomUUID(); state.episodes = []; state.handbook = []; state.consolidated = []; state.job = null;
            // Preserve attempts: clearing memory must not reset paid-call limits.
            await this.publish(state, assertOwned);
            for (const entry of removed) { assertOwned(); await fs.unlink(path.join(this.directory, `${entry.id}.json`)); }
        });
    }

    async reserveConsolidation(expected: MemoryView, maxCalls: number): Promise<string | null> {
        if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 2) { throw new Error('Invalid consolidation call budget (0–2).'); }
        return this.locked(async (state, assertOwned) => {
            const now = Date.now();
            if (state.epoch !== expected.epoch || state.generation !== expected.generation) { throw new Error('Memory changed before consolidation reservation.'); }
            state.attempts = state.attempts.filter(attempt => now - attempt.at < 86400000);
            if (state.attempts.length >= maxCalls || (state.job && state.job.expiresAt > now)) { return null; }
            const id = randomUUID();
            state.attempts.push({ id, at: now, epoch: state.epoch });
            state.job = { id, expiresAt: now + 10 * 60000 };
            await this.publish(state, assertOwned);
            return id;
        });
    }

    async publishHandbook(expected: MemoryView, jobId: string, entries: HandbookEntry[], consumed: string[], signal?: AbortSignal): Promise<void> {
        await this.locked(async (state, assertOwned) => {
            signal?.throwIfAborted();
            if (state.epoch !== expected.epoch || state.generation !== expected.generation + 1 || state.job?.id !== jobId || state.job.expiresAt <= Date.now()) {
                throw new Error('Consolidation lost its publication lease or source generation.');
            }
            const ids = new Set(state.episodes.map(entry => entry.id));
            if (consumed.some(id => !ids.has(id)) || entries.some(entry => entry.supports.some(ref => !ids.has(ref.episodeId)))) {
                throw new Error('Handbook references an unpublished episode.');
            }
            if (new Set(entries.map(entry => entry.id)).size !== entries.length) { throw new Error('Handbook contains duplicate entry identifiers.'); }
            state.handbook = entries.map(entry => handbookEntrySchema.parse(entry));
            state.consolidated = [...new Set([...state.consolidated, ...consumed])]; state.job = null;
            signal?.throwIfAborted();
            await this.publish(state, assertOwned);
        });
    }

    async releaseJob(jobId: string): Promise<void> {
        await this.locked(async (state, assertOwned) => {
            if (state.job?.id !== jobId) { return; }
            state.job = null; await this.publish(state, assertOwned);
        });
    }
}
