import type { RepositorySnapshotReader } from '../git/repositorySnapshot';
import type { HandbookEntry, InvestigationEpisode, MemoryAvailability, MemorySupport } from './types';

/** Retirement is a contextual historical decision, not a repository-wide tombstone. */
export function assessMemoryAvailability(
    input: { targetPaths: string[]; supports: MemorySupport[]; retirement: HandbookEntry['retirement'] },
    episodes: readonly InvestigationEpisode[], snapshot: RepositorySnapshotReader,
): MemoryAvailability {
    const evidenceFor = (support: MemorySupport) => {
        const observation = episodes.find(episode => episode.id === support.episodeId)?.observations[support.observationIndex];
        if (!observation) { throw new Error('Availability check references a missing historical observation.'); }
        return observation.evidence.filter(evidence => !support.evidenceId || support.evidenceId === evidence.id);
    };
    const sources = input.supports.flatMap(evidenceFor).map(evidence => evidence.source);
    const targets = input.targetPaths.map(path => {
        // Navigation enters the after tree. Before-tree evidence can still explain a removal,
        // but it must not make a deleted current entry look usable.
        const current = snapshot.entry(path, 'after');
        const state = !current || !['100644', '100755'].includes(current.mode) ? 'unavailable' as const
            : sources.some(source => source.path === path && source.blobOid === current.oid) ? 'available' as const : 'needs_revalidation' as const;
        return { path, state };
    });
    let experience: MemoryAvailability['experience'] = 'unverified';
    if (input.retirement) {
        const byEpisode = new Map<string, MemorySupport[]>();
        for (const support of input.retirement.supports) {
            byEpisode.set(support.episodeId, [...(byEpisode.get(support.episodeId) ?? []), support]);
        }
        // All counterevidence of at least one coherent investigation must still match.
        // Mixing matching files from different snapshots could activate a false scope.
        const applies = [...byEpisode.values()].some(supports => supports.every(support => {
            const evidence = evidenceFor(support);
            return evidence.length > 0 && evidence.every(({ source }) => source.side === 'after'
                && snapshot.entry(source.path, 'after')?.oid === source.blobOid);
        }));
        experience = applies ? 'retired' : 'retirement_unmatched';
    }
    return {
        snapshotId: snapshot.identity.id,
        location: !targets.length ? 'historical_only' : targets.some(target => target.state === 'unavailable') ? 'unavailable'
            : targets.some(target => target.state === 'needs_revalidation') ? 'needs_revalidation' : 'available',
        experience, targets,
        retirement: input.retirement ? { reason: input.retirement.reason, replacementEntryId: input.retirement.replacementEntryId } : null,
    };
}
