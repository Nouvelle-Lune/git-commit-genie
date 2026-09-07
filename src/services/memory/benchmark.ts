import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import writeFileAtomic = require('write-file-atomic');
import * as lockfile from 'proper-lockfile';
import { z } from 'zod';
import { RepositorySnapshotReader, snapshotGit } from '../git/repositorySnapshot';
import type { LLMExecution } from '../llm/llmTypes';
import type { DiffService } from '../git/diff';
import type { Repository } from '../git/git';
import type { ChainOutputs } from '../chain/types';
import type { CostQuote } from '../cost/costTypes';
import { MemoryStore } from './store';
import { EpisodeRecorder } from './recorder';
import { MemoryRetriever } from './retriever';
import { MemorySettings } from './settings';
import { consolidatePending, ConsolidationRunner } from './consolidator';

export const replayManifestSchema = z.object({
    version: z.literal(1), models: z.array(z.string().min(1)).min(1), repetitions: z.number().int().min(1).max(10),
    repositories: z.array(z.object({ path: z.string().min(1), commits: z.array(z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)).min(1) }).strict()).min(1),
    configurationFingerprint: z.string().min(1),
}).strict();
export type ReplayManifest = z.infer<typeof replayManifestSchema>;
export type ReplayGroup = 'A' | 'B' | 'C';
export interface ReplayCase { id: string; repository: string; commit: string; model: string; repetition: number; group: ReplayGroup; ordinal: number }
export interface ReplayResult {
    case: ReplayCase; status: 'complete' | 'error'; startedAt: number; durationMs: number;
    output?: ChainOutputs; costs: CostQuote[]; maintenanceCosts: CostQuote[]; error?: string;
}
export interface ReplayAdapter {
    run(input: ReplayCase, storageRoot: string, signal: AbortSignal): Promise<Omit<ReplayResult, 'case' | 'startedAt' | 'durationMs'>>;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Frozen sequential replay. Every case, including failures, is an atomic checkpoint.
 * Existing cases are never rerun; changing inputs creates a different experiment.
 * An interrupted unknown-outcome case is recorded as error instead of billed twice.
 */
export async function runSequentialReplay(params: {
    manifest: ReplayManifest; outputRoot: string; adapter: ReplayAdapter; signal: AbortSignal;
    onProgress: (done: number, total: number, input: ReplayCase) => void;
    assertEnvironment?: () => void;
}): Promise<string> {
    const manifest = replayManifestSchema.parse(params.manifest);
    if (new Set(manifest.models).size !== manifest.models.length || new Set(manifest.repositories.map(repo => repo.path)).size !== manifest.repositories.length) {
        throw new Error('Replay manifest contains duplicate models or repositories.');
    }
    const serialized = JSON.stringify(manifest);
    const directory = path.join(params.outputRoot, digest(serialized));
    await fs.mkdir(directory, { recursive: true });
    let compromised: Error | undefined;
    const release = await lockfile.lock(directory, { stale: 30000, update: 5000, retries: 0, onCompromised: error => { compromised = error; } });
    const assertOwned = () => { if (compromised) { throw compromised; } };
    try {
        const manifestPath = path.join(directory, 'manifest.json');
        try {
            if (await fs.readFile(manifestPath, 'utf8') !== serialized) { throw new Error('Frozen replay manifest mismatch.'); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            await writeFileAtomic(manifestPath, serialized, { fsync: true });
        }
        const cases: ReplayCase[] = [];
        for (const repository of manifest.repositories) {
            if (new Set(repository.commits).size !== repository.commits.length) { throw new Error('Replay manifest contains duplicate commits.'); }
            for (const model of manifest.models) {
                for (let repetition = 0; repetition < manifest.repetitions; repetition++) {
                    for (const group of ['A', 'B', 'C'] as const) {
                        repository.commits.forEach((commit, ordinal) => {
                            const input = { repository: repository.path, commit, model, repetition, group, ordinal };
                            cases.push({ ...input, id: digest(JSON.stringify(input)) });
                        });
                    }
                }
            }
        }
        let done = 0;
        for (const input of cases) {
            assertOwned();
            params.signal.throwIfAborted();
            params.assertEnvironment?.();
            const target = path.join(directory, `${input.id}.json`);
            let exists = false;
            try {
                const recorded = JSON.parse(await fs.readFile(target, 'utf8')) as ReplayResult;
                if (recorded.case.id !== input.id || !['complete', 'error'].includes(recorded.status)) { throw new Error('Invalid replay checkpoint.'); }
                exists = true;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            if (!exists) {
                const startedAt = Date.now();
                const checkpoint: ReplayResult = { case: input, status: 'error', startedAt, durationMs: 0, costs: [], maintenanceCosts: [], error: 'Interrupted or unknown outcome; this case must not be automatically retried.' };
                await writeFileAtomic(target, JSON.stringify(checkpoint), { fsync: true });
                const storageRoot = path.join(directory, 'memory', digest(`${input.repository}\0${input.model}\0${input.repetition}\0${input.group}`));
                try {
                    const result = await params.adapter.run(input, storageRoot, params.signal);
                    Object.assign(checkpoint, result, { durationMs: Date.now() - startedAt });
                    if (result.status === 'complete') { delete checkpoint.error; }
                } catch (error) { checkpoint.error = String(error); checkpoint.durationMs = Date.now() - startedAt; }
                assertOwned();
                await writeFileAtomic(target, JSON.stringify(checkpoint), { fsync: true });
            }
            done += 1; params.onProgress(done, cases.length, input);
        }
        return directory;
    } finally { if (!compromised) { await release(); } }
}

export async function validateReplayHistory(manifest: ReplayManifest, gitPath: string, signal: AbortSignal): Promise<void> {
    for (const repository of manifest.repositories) {
        let previous: string | undefined;
        for (const commit of repository.commits) {
            const parents = (await snapshotGit(gitPath, repository.path, ['rev-list', '--parents', '-n', '1', commit], { signal })).toString().trim().split(' ');
            if (parents[0] !== commit || parents.length > 2) { throw new Error(`Replay case is not a non-merge commit: ${commit}`); }
            if (previous) {
                if (!parents[1]) { throw new Error('Replay history is not chronological.'); }
                // A gap is allowed for excluded merge/invalid changes, never a reversal.
                await snapshotGit(gitPath, repository.path, ['merge-base', '--is-ancestor', previous, parents[1]], { signal });
            }
            previous = commit;
        }
    }
}

/** Concrete adapter invokes the production chain, not a simulated memory score. */
export function createPipelineReplayAdapter(params: {
    gitPath: string; diffs: DiffService; repository: (root: string) => Repository;
    execution: (model: string, root: string, signal: AbortSignal) => LLMExecution;
    runChain: typeof import('../chain/commitMessageChain').generateCommitMessageChain;
    consolidation: (execution: LLMExecution, settings: MemorySettings) => ConsolidationRunner;
    settings: MemorySettings;
    excludes: string[];
}): ReplayAdapter {
    return { run: async (input, storageRoot, signal) => {
        const execution = params.execution(input.model, input.repository, signal);
        const maintenance = params.execution(input.model, input.repository, signal);
        try {
            const snapshot = await RepositorySnapshotReader.fromCommit(input.repository, params.gitPath, input.commit, signal);
            const diffs = await params.diffs.getDiff(params.repository(input.repository), snapshot);
            // Only the date is read; the target message is deliberately hidden from the chain.
            const currentTime = (await snapshotGit(params.gitPath, input.repository, ['show', '-s', '--format=%cI', input.commit], { signal })).toString().trim();
            const store = new MemoryStore(storageRoot, snapshot.identity.repositoryId, () => params.settings);
            const recorder = input.group === 'A' ? undefined : new EpisodeRecorder(snapshot.identity, input.model);
            const output = await params.runChain({ diffs, currentTime, repositoryPath: input.repository, snapshot, recorder,
                loadMemory: input.group === 'A' ? undefined : async query => {
                    const view = await store.loadNavigation(query);
                    if (input.group === 'B') { view.handbook = []; }
                    return new MemoryRetriever(view, snapshot, params.excludes, () => [], params.settings);
                },
            }, execution, { investigation: { excludePatterns: params.excludes } });
            if (recorder) {
                const trace = output.changeAnalysis;
                const episode = recorder.seal({ changedPaths: trace.changeExtraction.changedFiles.map(file => file.path),
                    changedSymbols: trace.changeExtraction.changedSymbols.map(symbol => symbol.name),
                    questions: trace.investigationPlan?.targets.flatMap(target => target.questions) ?? [], status: trace.analysisStatus,
                    claims: trace.agentClaims.map(claim => ({ claim: claim.claim, evidenceRefs: claim.evidenceRefs, disposition: claim.disposition })) });
                await store.recordEpisode(episode, await store.epoch());
                if (input.group === 'C') { await consolidatePending(store, params.consolidation(maintenance, params.settings), signal, params.settings); }
            }
            return { status: 'complete', output, costs: [...execution.getRecordedQuotes()], maintenanceCosts: [...maintenance.getRecordedQuotes()] };
        } catch (error) {
            return { status: 'error', error: String(error), costs: [...execution.getRecordedQuotes()], maintenanceCosts: [...maintenance.getRecordedQuotes()] };
        }
    } };
}
