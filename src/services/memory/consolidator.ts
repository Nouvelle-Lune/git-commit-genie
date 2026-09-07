import { consolidationProposalSchema, handbookEntrySchema, HandbookEntry, InvestigationEpisode } from './types';
import { MemoryStore, MemoryView } from './store';
import { isEligibleEpisode } from './recorder';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MEMORY_DEFAULTS, MemorySettings } from './settings';

export interface ConsolidationRunner {
    (input: string, signal: AbortSignal): Promise<unknown>;
    maxInputTokens: number;
    estimateInputTokens(input: string): number;
}

export type ConsolidationResult = { status: 'published'; episodeCount: number; handbookCount: number; skippedEpisodes: number } |
    { status: 'not-ready'; pendingCount: number; threshold: number } |
    { status: 'budget-exhausted'; limit: number; resumesAt: number } |
    { status: 'memory-disabled' | 'foreground-busy' | 'already-running' | 'cancelled' | 'automatic-paused' };

/** UUIDs and verbatim catalog values remain program-owned; the model selects task-local handles. */
export function projectConsolidation(episodes: InvestigationEpisode[]) {
    const refs = new Map<string, HandbookEntry['supports'][number]>();
    const triggers = new Map<string, string>();
    const triggerIds = new Map<string, string>();
    const targetPaths = new Map<string, string>();
    const targetPathIds = new Map<string, string>();
    const intern = (prefix: 'T' | 'F', value: string, ids: Map<string, string>, values: Map<string, string>): string => {
        const existing = ids.get(value);
        if (existing) { return existing; }
        const id = `${prefix}${ids.size + 1}`;
        ids.set(value, id); values.set(id, value);
        return id;
    };
    const projectedEpisodes = episodes.map((episode, index) => ({ id: `P${index + 1}`,
        changedPathTriggerIds: episode.changedPaths.map(value => intern('T', value, triggerIds, triggers)),
        changedSymbolTriggerIds: episode.changedSymbols.map(value => intern('T', value, triggerIds, triggers)),
        questions: episode.questions,
        sources: episode.observations.filter(item => item.ok).flatMap(item => item.evidence.map(evidence => {
            const id = `S${refs.size + 1}`;
            refs.set(id, { episodeId: episode.id, evidenceId: evidence.id });
            return { id, targetPathId: intern('F', evidence.source.path, targetPathIds, targetPaths),
                side: evidence.source.side, startLine: evidence.source.startLine,
                endLine: evidence.source.endLine, excerpt: evidence.source.excerpt, independent: item.tool !== 'readMemorySources',
                snapshot: `V${[...new Set(episodes.map(value => value.snapshot.id))].indexOf(episode.snapshot.id) + 1}` };
        })),
    }));
    const input = JSON.stringify({
        triggerCatalog: [...triggers].map(([id, value]) => ({ id, value })),
        targetPathCatalog: [...targetPaths].map(([id, value]) => ({ id, value })),
        episodes: projectedEpisodes,
    });
    return { input, refs, triggers, targetPaths };
}

/** Proposals can reorganize observed navigation; they cannot invent source support. */
export function validateConsolidation(raw: unknown, episodes: InvestigationEpisode[]): HandbookEntry[] {
    const proposal = consolidationProposalSchema.parse(raw);
    const { refs, triggers, targetPaths } = projectConsolidation(episodes);
    const resolveCatalog = (ids: string[], catalog: Map<string, string>, label: string): string[] => [...new Set(ids)].map(id => {
        const value = catalog.get(id);
        if (!value) { throw new Error(`Consolidation invented ${label} ID: ${id}`); }
        return value;
    });
    const entries = proposal.entries.map(({ sourceIds, triggerIds, targetPathIds, ...entry }) => handbookEntrySchema.parse({
        ...entry, id: randomUUID(), triggers: resolveCatalog(triggerIds, triggers, 'trigger'),
        targetPaths: resolveCatalog(targetPathIds, targetPaths, 'target path'),
        supports: [...new Set(sourceIds)].map(id => {
            const ref = refs.get(id);
            if (!ref) { throw new Error(`Consolidation invented source ID: ${id}`); }
            return ref;
        })
    }));
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
        const independentSnapshots = new Set(supporting.filter(item => item.independent).map(item => item.episode.snapshot.id));
        if (entry.concerns.length && independentSnapshots.size < 2) {
            throw new Error('Historical concerns require two independently investigated snapshots.');
        }
        if (entry.kind === 'procedure' && independentSnapshots.size < 3) {
            throw new Error('Procedural memory requires three independently investigated snapshots.');
        }
    }
    return entries;
}

export async function consolidatePending(store: MemoryStore, runner: ConsolidationRunner, signal: AbortSignal,
    settings: MemorySettings = MEMORY_DEFAULTS): Promise<ConsolidationResult> {
    const view: MemoryView = await store.inspect();
    signal.throwIfAborted();
    const pending = view.episodes.filter(episode => isEligibleEpisode(episode) && !view.consolidated.includes(episode.id));
    const areas = new Map<string, Set<string>>();
    for (const episode of pending) {
        for (const file of episode.changedPaths) {
            const area = path.posix.dirname(file);
            if (!areas.has(area)) { areas.set(area, new Set()); }
            areas.get(area)!.add(episode.id);
        }
    }
    const pendingCount = Math.max(0, ...[...areas.values()].map(ids => ids.size));
    if (pendingCount < 5) { return { status: 'not-ready', pendingCount, threshold: 5 }; }
    const batch: InvestigationEpisode[] = [];
    let skippedEpisodes = 0;
    for (const episode of pending) {
        if (batch.length === 20) { break; }
        if (runner.estimateInputTokens(projectConsolidation([...batch, episode]).input) > runner.maxInputTokens) { skippedEpisodes += 1; continue; }
        batch.push(episode);
    }
    if (!batch.length) { throw new Error(`All ${skippedEpisodes} pending episodes exceed the consolidation input budget (${runner.maxInputTokens} tokens).`); }
    const { input } = projectConsolidation(batch);
    signal.throwIfAborted();
    const reservation = await store.reserveConsolidation(view, settings['consolidation.maxCallsPer24h'], settings);
    if (reservation.status !== 'reserved') { return reservation; }
    const job = reservation.id;
    try {
        const raw = await runner(input, signal);
        signal.throwIfAborted();
        const entries = validateConsolidation(raw, batch);
        if (!entries.length) { throw new Error('Consolidation returned no handbook entries; pending episodes were preserved.'); }
        // Preserve untouched areas; the model can only replace entries supported by this batch.
        const ids = new Set(entries.flatMap(entry => entry.supports.map(ref => ref.episodeId)));
        const retained = view.handbook.filter(entry => !entry.supports.some(ref => ids.has(ref.episodeId)));
        await store.publishHandbook(view, job, [...retained, ...entries], [...ids], signal, settings);
        return { status: 'published', episodeCount: ids.size, handbookCount: entries.length, skippedEpisodes };
    } finally { await store.releaseJob(job, settings); }
}
