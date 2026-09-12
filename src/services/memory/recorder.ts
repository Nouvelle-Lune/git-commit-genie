import { randomUUID } from 'crypto';
import { hashContent, SnapshotIdentity } from '../git/repositorySnapshot';
import { InvestigationEpisode, investigationEpisodeSchema, RecordedObservation, HandbookEntry } from './types';

/** Records only observations already returned by the foreground investigation. */
export class EpisodeRecorder {
    private readonly observations: RecordedObservation[] = [];
    constructor(private readonly snapshot: SnapshotIdentity, private readonly model: string) {}

    record(observation: RecordedObservation): void {
        // Detach from mutable tool state. No file reads, model calls, or full API logs.
        this.observations.push(structuredClone(observation));
    }

    seal(input: Pick<InvestigationEpisode, 'changedPaths' | 'questions' | 'claims' | 'status'>): InvestigationEpisode {
        const episode = investigationEpisodeSchema.parse({
            ...input, version: 3, id: randomUUID(), createdAt: Date.now(), snapshot: this.snapshot,
            // This unreleased format replaces old episodes; reset storage instead of migrating records.
            model: this.model, promptVersion: 'memory-experience-1', toolsetVersion: 'snapshot-memory-experience-1', observations: this.observations,
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

/** Completed local observations remain useful even when another analysis phase degraded. */
export function isEligibleEpisode(episode: InvestigationEpisode): boolean {
    return ['complete', 'degraded', 'unavailable', 'complete_diff_only'].includes(episode.status)
        && episode.observations.some(isInvestigationObservation);
}

export function isInvestigationObservation(observation: RecordedObservation): boolean {
    return !['searchRepositoryMemory', 'readMemorySources'].includes(observation.tool);
}

/** Persist only reproducible item provenance; references are not a correctness score. */
export function validateHandbookSources(entries: HandbookEntry[], episodes: InvestigationEpisode[]): void {
    for (const entry of entries) {
        for (const item of [...entry.steps, ...entry.lessons]) {
            const snapshots = new Set<string>();
            const seen = new Set<string>();
            for (const support of item.supports) {
                const key = `${support.episodeId}:${support.observationIndex}`;
                if (seen.has(key)) { throw new Error('Experience repeats an observation support.'); }
                seen.add(key);
                const episode = episodes.find(value => value.id === support.episodeId);
                const observation = episode?.observations[support.observationIndex];
                if (!episode || !isEligibleEpisode(episode) || !observation || !isInvestigationObservation(observation)) {
                    throw new Error('Experience references an ineligible or missing investigation observation.');
                }
                snapshots.add(episode.snapshot.id);
                if (support.evidenceId && !observation.evidence.some(evidence => evidence.id === support.evidenceId)) {
                    throw new Error('Experience source does not belong to its observation.');
                }
                if ('path' in item) {
                    const source = observation.evidence.find(evidence => evidence.id === support.evidenceId);
                    const claim = support.claimIndex === undefined ? undefined : episode.claims[support.claimIndex];
                    const question = support.questionIndex === undefined ? undefined : episode.questions[support.questionIndex];
                    if (!observation.ok || observation.tool !== item.operation || source?.source.path !== item.path
                        || !question?.trim() || !claim?.claim.trim() || claim.disposition === 'omit'
                        || !support.evidenceId || !claim.evidenceRefs.includes(support.evidenceId)
                        || (item.symbol && !source.source.excerpt.includes(item.symbol) && !Object.values(observation.arguments).includes(item.symbol))) {
                        throw new Error('Route support is missing its question, matching source, or retained finding.');
                    }
                }
            }
            if (snapshots.size < 2 || item.snapshotCount !== snapshots.size) { throw new Error('Experience snapshot count does not match independent supports.'); }
        }
        if (entry.retirement) {
            const snapshots = new Set<string>();
            const seen = new Set<string>();
            for (const support of entry.retirement.supports) {
                const key = `${support.episodeId}:${support.observationIndex}`;
                if (seen.has(key)) { throw new Error('Retirement repeats an observation support.'); }
                seen.add(key);
                const episode = episodes.find(value => value.id === support.episodeId);
                const observation = episode?.observations[support.observationIndex];
                const evidence = observation?.evidence.find(item => item.id === support.evidenceId);
                const question = support.questionIndex === undefined ? undefined : episode?.questions[support.questionIndex];
                const claim = support.claimIndex === undefined ? undefined : episode?.claims[support.claimIndex];
                if (!episode || !isEligibleEpisode(episode) || !observation || !isInvestigationObservation(observation)
                    || !observation.ok || evidence?.source.side !== 'after' || !question?.trim() || !claim?.claim.trim()
                    || claim.disposition === 'omit' || !support.evidenceId || !claim.evidenceRefs.includes(support.evidenceId)) {
                    throw new Error('Retirement support is missing after-tree counterevidence, its question, or its retained finding.');
                }
                snapshots.add(episode.snapshot.id);
            }
            if (snapshots.size < 2 || entry.retirement.snapshotCount !== snapshots.size) {
                throw new Error('Retirement snapshot count does not match independent counterevidence.');
            }
        }
    }
}
