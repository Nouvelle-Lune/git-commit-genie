import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import { hashContent } from '../git/repositorySnapshot';
import { HandbookEntry, handbookEntrySchema, InvestigationEpisode, investigationEpisodeSchema, MemoryQuery, entrySupports, entryTerms } from './types';
import { isEligibleEpisode, validateEpisodeSources, validateHandbookSources } from './recorder';
import { shouldExclude } from '../analysis/tools/pathFilters';
import { bm25Scores } from './ranking';
import { MEMORY_DEFAULTS, MemorySettings } from './settings';

const consolidationAttemptSchema = z.object({ id: z.uuid(), at: z.number(), epoch: z.uuid() }).strict();

const manifestSchema = z.object({
    version: z.literal(2), epoch: z.uuid(), generation: z.number().int().nonnegative(),
    episodes: z.array(z.object({ id: z.uuid(), hash: z.string(), bytes: z.number().int().positive(), createdAt: z.number(),
        paths: z.array(z.string()), symbols: z.array(z.string()), targets: z.array(z.string()), terms: z.array(z.string()), eligible: z.boolean() }).strict()),
    handbook: z.array(handbookEntrySchema),
    attempts: z.array(consolidationAttemptSchema),
    // Deterministic evidence-group fingerprints prevent identical source sets
    // from incurring another model call until new evidence changes the group.
    consolidated: z.array(z.uuid()),
    organizedSeeds: z.array(z.uuid()),
    job: z.object({ id: z.uuid(), expiresAt: z.number() }).strict().nullable(),
}).strict();
const clearStateSchema = z.object({
    generation: z.number().int().nonnegative(),
    attempts: z.array(consolidationAttemptSchema),
}).passthrough();
const episodePayloadName = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
type Manifest = z.infer<typeof manifestSchema>;
export interface MemoryView { epoch: string; generation: number; episodes: InvestigationEpisode[]; handbook: HandbookEntry[]; consolidated: string[]; organizedSeeds: string[] }
export type ConsolidationReservation = { status: 'reserved'; id: string; generation: number } | { status: 'already-running' } |
    { status: 'budget-exhausted'; limit: number; resumesAt: number };

/**
 * One local extension host filesystem per store; no network filesystem support.
 * Readers and writers use the same short lock, so deletion cannot race pinned
 * readers. No lock is held over a provider call. The manifest is the commit point.
 */
export class MemoryStore {
    readonly directory: string;
    private queue: Promise<void> = Promise.resolve();
    constructor(storageRoot: string, readonly repositoryId: string, private readonly settings: () => MemorySettings = () => MEMORY_DEFAULTS) {
        if (!/^[a-f0-9]{64}$/.test(repositoryId)) { throw new Error('Invalid memory repository identity.'); }
        this.directory = path.join(storageRoot, 'repository-memory', repositoryId);
    }

    private locked<T>(action: (state: Manifest, assertOwned: () => void) => Promise<T>): Promise<T> {
        return this.queued(() => this.withFileLock(action));
    }

    private queued<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        // Keep the queue usable after a rejected operation; its returned promise
        // still propagates the original error to the caller's visible handler.
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async withDirectoryLock<T>(action: (assertOwned: () => void) => Promise<T>): Promise<T> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        let compromised: Error | undefined;
        const release = await lockfile.lock(this.directory, { stale: 30000, update: 5000,
            retries: { retries: 3, minTimeout: 10, maxTimeout: 40 }, onCompromised: error => { compromised = error; } });
        const assertOwned = () => { if (compromised) { throw compromised; } };
        try {
            return await action(assertOwned);
        } finally { if (!compromised) { await release(); } }
    }

    private async withFileLock<T>(action: (state: Manifest, assertOwned: () => void) => Promise<T>): Promise<T> {
        return this.withDirectoryLock(async assertOwned => {
            const manifestPath = path.join(this.directory, 'current.json');
            let state: Manifest;
            try {
                state = manifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
                state = { version: 2, epoch: randomUUID(), generation: 0, episodes: [], handbook: [], attempts: [], consolidated: [], organizedSeeds: [], job: null };
                assertOwned();
                await writeFileAtomic(manifestPath, JSON.stringify(state), { fsync: true });
            }
            assertOwned();
            return await action(state, assertOwned);
        });
    }

    private async publish(state: Manifest, assertOwned: () => void, settings: MemorySettings): Promise<void> {
        state.generation += 1;
        const data = JSON.stringify(manifestSchema.parse(state));
        if (Buffer.byteLength(data) > settings['storage.maxManifestMiB'] * 1048576) { throw new Error(`Memory manifest exceeds ${settings['storage.maxManifestMiB']} MiB; publication cancelled.`); }
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
            episodes: await this.readEpisodes(state), handbook: structuredClone(state.handbook), consolidated: [...state.consolidated], organizedSeeds: [...state.organizedSeeds] }));
    }

    /** Rank experiences before loading payloads so semantic hits cannot be lost to an episode prefilter. */
    async loadNavigation(query: MemoryQuery): Promise<MemoryView> {
        return this.locked(async state => {
            const words = [...query.paths, ...query.symbols, ...query.keywords];
            const handbookScores = bm25Scores(state.handbook.map(entryTerms), words);
            const episodeScores = bm25Scores(state.episodes.map(entry => [...entry.paths, ...entry.symbols, ...entry.targets, ...entry.terms]), words);
            const exact = (paths: string[], symbols: string[]) => paths.filter(value => query.paths.includes(value)).length * 100
                + symbols.filter(value => query.symbols.includes(value)).length * 100;
            const candidates = [
                ...state.handbook.map((entry, index) => ({ kind: 'handbook' as const, id: entry.id,
                    episodeIds: [...new Set(entrySupports(entry).map(support => support.episodeId))],
                    score: handbookScores[index] + exact(entry.targetPaths, entry.triggers) })),
                ...state.episodes.filter(entry => entry.eligible).map(entry => ({ kind: 'episode' as const, id: entry.id,
                    episodeIds: [entry.id], score: episodeScores[state.episodes.indexOf(entry)] + exact([...entry.paths, ...entry.targets], entry.symbols) })),
            ].filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
            const selected = new Map<string, Manifest['episodes'][number]>();
            const handbook: HandbookEntry[] = [];
            let bytes = 0;
            for (const candidate of candidates) {
                const missing = candidate.episodeIds.filter(id => !selected.has(id)).map(id => {
                    const episode = state.episodes.find(entry => entry.id === id);
                    if (!episode) { throw new Error('Experience references an unpublished investigation.'); }
                    return episode;
                });
                const extra = missing.reduce((total, item) => total + item.bytes, 0);
                if (selected.size + missing.length > 20 || bytes + extra > 4 * 1024 * 1024) { continue; }
                for (const item of missing) { selected.set(item.id, item); }
                bytes += extra;
                if (candidate.kind === 'handbook') { handbook.push(state.handbook.find(entry => entry.id === candidate.id)!); }
            }
            return { epoch: state.epoch, generation: state.generation,
                episodes: await this.readEpisodes({ ...state, episodes: [...selected.values()] }), handbook, consolidated: [], organizedSeeds: [] };
        });
    }

    async epoch(): Promise<string> { return this.locked(async state => state.epoch); }

    async recordEpisode(input: InvestigationEpisode, expectedEpoch: string, settings = this.settings()): Promise<void> {
        const episode = investigationEpisodeSchema.parse(input);
        validateEpisodeSources(episode);
        if (episode.snapshot.repositoryId !== this.repositoryId) { throw new Error('Episode belongs to a different repository.'); }
        const bytes = Buffer.from(JSON.stringify(episode));
        if (bytes.length > settings['storage.maxEpisodeKiB'] * 1024) { throw new Error(`Episode exceeds ${settings['storage.maxEpisodeKiB']} KiB; it was not persisted.`); }
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
                if (retained.length <= settings['storage.maxEpisodes'] && total <= settings.maxStorageMiB * 1048576) { break; }
                removed.add(entry.id); total -= entry.bytes; retained = retained.filter(item => item.id !== entry.id);
            }
            state.episodes = retained;
            state.handbook = state.handbook.filter(entry => entrySupports(entry).every(support => !removed.has(support.episodeId)));
            state.organizedSeeds = state.organizedSeeds.filter(id => !removed.has(id));
            if (removed.size > 0) { state.consolidated = []; }
            await this.publish(state, assertOwned, settings);
            for (const id of removed) { assertOwned(); await fs.unlink(path.join(this.directory, `${id}.json`)); }
        });
    }

    private indexEpisode(episode: InvestigationEpisode, bytes: Buffer): Manifest['episodes'][number] {
        return { id: episode.id, hash: hashContent(bytes), bytes: bytes.length, createdAt: episode.createdAt,
            paths: episode.changedPaths, symbols: episode.changedSymbols,
            targets: [...new Set(episode.observations.flatMap(item => item.evidence.map(evidence => evidence.source.path)))],
            terms: [...episode.questions, ...episode.observations.filter(item => !['searchRepositoryMemory', 'readMemorySources'].includes(item.tool))
                .flatMap(item => [item.summary, ...Object.values(item.arguments).filter((value): value is string => typeof value === 'string')])], eligible: isEligibleEpisode(episode) };
    }

    async rebuildIndex(settings = this.settings()): Promise<number> {
        return this.locked(async (state, assertOwned) => {
            // Only manifest-committed payloads are authoritative; orphans are never imported.
            const episodes = await this.readEpisodes(state);
            state.episodes = episodes.map(episode => this.indexEpisode(episode, Buffer.from(JSON.stringify(episode))));
            await this.publish(state, assertOwned, settings);
            return episodes.length;
        });
    }

    async purgeExcluded(excludes: string[], settings = this.settings()): Promise<void> {
        const ids = await this.locked(async state => state.episodes.filter(entry => [...entry.paths, ...entry.targets].some(file => shouldExclude(file, excludes))).map(entry => entry.id));
        if (ids.length) { await this.deleteEpisodes(ids, settings); }
    }

    async deleteEpisodes(ids: string[], settings = this.settings()): Promise<number> {
        return this.locked(async (state, assertOwned) => {
            const removed = state.episodes.filter(entry => ids.includes(entry.id));
            state.episodes = state.episodes.filter(entry => !ids.includes(entry.id));
            state.handbook = state.handbook.filter(entry => entrySupports(entry).every(ref => !ids.includes(ref.episodeId)));
            state.organizedSeeds = state.organizedSeeds.filter(id => !ids.includes(id));
            state.consolidated = [];
            state.epoch = randomUUID(); state.job = null;
            await this.publish(state, assertOwned, settings);
            for (const entry of removed) { assertOwned(); await fs.unlink(path.join(this.directory, `${entry.id}.json`)); }
            return removed.length;
        });
    }

    async clear(settings = this.settings()): Promise<void> {
        await this.queued(() => this.withDirectoryLock(async assertOwned => {
            const manifestPath = path.join(this.directory, 'current.json');
            let preserved: z.infer<typeof clearStateSchema> = { generation: 0, attempts: [] };
            try {
                // Clear is the recovery operation for incompatible Handbook schemas.
                // Parse only the accounting fields that must survive the reset.
                preserved = clearStateSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            }
            const state: Manifest = {
                version: 2, epoch: randomUUID(), generation: preserved.generation,
                episodes: [], handbook: [], attempts: preserved.attempts,
                consolidated: [], organizedSeeds: [], job: null,
            };
            await this.publish(state, assertOwned, settings);
            const payloads = (await fs.readdir(this.directory)).filter(name => episodePayloadName.test(name));
            for (const name of payloads) { assertOwned(); await fs.unlink(path.join(this.directory, name)); }
        }));
    }

    async reserveConsolidation(expected: MemoryView, maxCalls: number, settings = this.settings()): Promise<ConsolidationReservation> {
        if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) { throw new Error('Invalid consolidation call budget; expected a positive integer.'); }
        return this.locked(async (state, assertOwned) => {
            const now = Date.now();
            if (state.job && state.job.expiresAt > now) { return { status: 'already-running' }; }
            if (state.epoch !== expected.epoch || state.generation !== expected.generation) { throw new Error('Memory changed before consolidation reservation.'); }
            state.attempts = state.attempts.filter(attempt => now - attempt.at < 86400000);
            if (state.attempts.length >= maxCalls) {
                const attempts = state.attempts.map(item => item.at).sort((a, b) => a - b);
                return { status: 'budget-exhausted', limit: maxCalls, resumesAt: attempts[attempts.length - maxCalls] + 86400000 };
            }
            const id = randomUUID();
            state.attempts.push({ id, at: now, epoch: state.epoch });
            state.job = { id, expiresAt: now + 10 * 60000 };
            await this.publish(state, assertOwned, settings);
            return { status: 'reserved', id, generation: state.generation };
        });
    }

    async publishHandbook(expected: MemoryView, expectedGeneration: number, jobId: string, entries: HandbookEntry[], consumed: string[], signal?: AbortSignal, settings = this.settings(), seedId?: string): Promise<void> {
        await this.locked(async (state, assertOwned) => {
            signal?.throwIfAborted();
            if (state.epoch !== expected.epoch || state.generation !== expectedGeneration || state.job?.id !== jobId || state.job.expiresAt <= Date.now()) {
                throw new Error('Consolidation lost its publication lease or source generation.');
            }
            const ids = new Set(state.episodes.map(entry => entry.id));
            if (entries.some(entry => entrySupports(entry).some(ref => !ids.has(ref.episodeId)))) {
                throw new Error('Handbook references an unpublished episode.');
            }
            if (new Set(entries.map(entry => entry.id)).size !== entries.length) { throw new Error('Handbook contains duplicate entry identifiers.'); }
            if (seedId && !ids.has(seedId)) { throw new Error('Consolidation seed is no longer published.'); }
            if (seedId) { state.organizedSeeds = [...new Set([...state.organizedSeeds, seedId])]; }
            validateHandbookSources(entries, await this.readEpisodes(state));
            state.handbook = entries.map(entry => handbookEntrySchema.parse(entry));
            state.consolidated = [...new Set([...state.consolidated, ...consumed])]; state.job = null;
            signal?.throwIfAborted();
            await this.publish(state, assertOwned, settings);
        });
    }

    async releaseJob(jobId: string, settings = this.settings()): Promise<void> {
        await this.locked(async (state, assertOwned) => {
            if (state.job?.id !== jobId) { return; }
            state.job = null; await this.publish(state, assertOwned, settings);
        });
    }
}
