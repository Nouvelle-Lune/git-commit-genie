import { randomUUID } from 'crypto';
import { hashContent, SnapshotIdentity } from '../git/repositorySnapshot';
import { InvestigationEpisode, investigationEpisodeSchema, RecordedObservation } from './types';

/** Records only observations already returned by the foreground investigation. */
export class EpisodeRecorder {
    private readonly observations: RecordedObservation[] = [];
    constructor(private readonly snapshot: SnapshotIdentity, private readonly model: string) {}

    record(observation: RecordedObservation): void {
        // Detach from mutable tool state. No file reads, model calls, or full API logs.
        this.observations.push(structuredClone(observation));
    }

    seal(input: Pick<InvestigationEpisode, 'changedPaths' | 'changedSymbols' | 'questions' | 'claims' | 'status'>): InvestigationEpisode {
        const episode = investigationEpisodeSchema.parse({
            ...input, version: 1, id: randomUUID(), createdAt: Date.now(), snapshot: this.snapshot,
            model: this.model, promptVersion: 'memory-1', toolsetVersion: 'snapshot-1', observations: this.observations,
        });
        validateEpisodeSources(episode);
        return episode;
    }
}

export function validateEpisodeSources(episode: InvestigationEpisode): void {
    const evidenceIds = new Set<string>();
    for (const observation of episode.observations) {
        for (const evidence of observation.evidence) {
            if (evidenceIds.has(evidence.id)) { throw new Error(`Duplicate episode evidence: ${evidence.id}`); }
            evidenceIds.add(evidence.id);
            if (evidence.source.snapshotId !== episode.snapshot.id || hashContent(evidence.source.excerpt) !== evidence.source.contentHash) {
                throw new Error('Episode source is not bound to its recorded snapshot and excerpt.');
            }
        }
    }
    for (const claim of episode.claims) {
        if (claim.evidenceRefs.some(ref => ref.startsWith('E') && !evidenceIds.has(ref))) {
            throw new Error('Episode claim references an unobserved source.');
        }
    }
}

export function isEligibleEpisode(episode: InvestigationEpisode): boolean {
    return episode.status === 'complete' && episode.observations.some(observation =>
        observation.ok && observation.tool !== 'readMemorySources' && observation.evidence.length > 0);
}
