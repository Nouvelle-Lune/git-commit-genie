import { consolidationProposalSchema, HandbookEntry, InvestigationEpisode } from './types';
import { MemoryStore, MemoryView } from './store';
import { isEligibleEpisode } from './recorder';
import * as path from 'path';

export interface ConsolidationRunner {
    (input: string, signal: AbortSignal): Promise<unknown>;
}

/** Proposals can reorganize observed navigation; they cannot invent source support. */
export function validateConsolidation(raw: unknown, episodes: InvestigationEpisode[]): HandbookEntry[] {
    const { entries } = consolidationProposalSchema.parse(raw);
    for (const entry of entries) {
        const supporting = entry.supports.map(ref => {
            const episode = episodes.find(item => item.id === ref.episodeId);
            const observation = episode?.observations.find(item => item.ok && item.evidence.some(evidence => evidence.id === ref.evidenceId));
            const evidence = observation?.evidence.find(item => item.id === ref.evidenceId);
            if (!episode || !evidence || !isEligibleEpisode(episode)) { throw new Error('Consolidation invented or used ineligible evidence support.'); }
            return { episode, evidence, independent: observation!.tool !== 'readMemorySources' };
        });
        const paths = new Set(supporting.map(item => item.evidence.source.path));
        if (entry.targetPaths.some(target => !paths.has(target))) { throw new Error('Consolidation invented a target path.'); }
        const triggers = new Set(supporting.flatMap(item => [...item.episode.changedPaths, ...item.episode.changedSymbols]));
        if (entry.triggers.some(trigger => !triggers.has(trigger))) { throw new Error('Consolidation invented a trigger.'); }
        if (entry.kind === 'procedure' && new Set(supporting.filter(item => item.independent).map(item => item.episode.snapshot.id)).size < 3) {
            throw new Error('Procedural memory requires three independently investigated snapshots.');
        }
    }
    return entries;
}

export async function consolidatePending(store: MemoryStore, runner: ConsolidationRunner, signal: AbortSignal, maxCalls = 2): Promise<'published' | 'not-ready' | 'budget-exhausted'> {
    const view: MemoryView = await store.inspect();
    const pending = view.episodes.filter(episode => isEligibleEpisode(episode) && !view.consolidated.includes(episode.id));
    const areas = new Map<string, Set<string>>();
    for (const episode of pending) {
        for (const file of episode.changedPaths) {
            const area = path.posix.dirname(file);
            if (!areas.has(area)) { areas.set(area, new Set()); }
            areas.get(area)!.add(episode.id);
        }
    }
    if (![...areas.values()].some(ids => ids.size >= 5)) { return 'not-ready'; }
    const batch: InvestigationEpisode[] = [];
    const projected = pending.map(episode => ({ ...episode,
        // Recording retains failures; consolidation needs only bounded source-bearing
        // observations and questions, not raw arguments, timing, or unused conclusions.
        observations: episode.observations.filter(item => item.ok && item.evidence.length > 0).map(item => ({ ...item, arguments: {}, summary: '' })),
        claims: [],
    }));
    for (const episode of projected) {
        if (batch.length === 20) { break; }
        if (Buffer.byteLength(JSON.stringify([...batch, episode])) > 12000) { continue; }
        batch.push(episode);
    }
    if (!batch.length) { throw new Error('Pending episode exceeds the consolidation input budget.'); }
    const batchIds = new Set(batch.map(episode => episode.id));
    const existingHandbook = view.handbook.filter(entry => entry.supports.every(ref => batchIds.has(ref.episodeId)));
    const input = JSON.stringify({ episodes: batch, existingHandbook });
    if (Buffer.byteLength(input) > 14000) { throw new Error('Consolidation data exceeds its bounded input budget.'); }
    signal.throwIfAborted();
    const job = await store.reserveConsolidation(view, maxCalls);
    if (!job) { return 'budget-exhausted'; }
    try {
        const raw = await runner(input, signal);
        signal.throwIfAborted();
        const entries = validateConsolidation(raw, batch);
        // Preserve untouched areas; the model can only replace entries supported by this batch.
        const ids = new Set(batch.map(episode => episode.id));
        const retained = view.handbook.filter(entry => !entry.supports.some(ref => ids.has(ref.episodeId)));
        await store.publishHandbook(view, job, [...retained, ...entries], [...ids], signal);
        return 'published';
    } finally { await store.releaseJob(job); }
}
