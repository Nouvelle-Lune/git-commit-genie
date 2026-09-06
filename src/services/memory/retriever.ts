import * as path from 'path';
import { RepositorySnapshotReader } from '../git/repositorySnapshot';
import { shouldExclude } from '../analysis/tools/pathFilters';
import { isEligibleEpisode } from './recorder';
import { MemoryView } from './store';
import { HandbookEntry, MemoryNavigation, MemoryQuery, MemoryUsage } from './types';
import { bm25Scores } from './ranking';

/** Memory IDs identify navigation, never current-run evidence or facts. */
export class MemoryRetriever {
    readonly usage: MemoryUsage = { recalled: 0, expanded: 0, adopted: 0, unavailable: 0, retrievalMs: 0 };
    private searches = 0;
    private reads = 0;
    private readonly expandedSources = new Set<string>();
    constructor(readonly view: MemoryView, private readonly snapshot: RepositorySnapshotReader, private readonly excludes: string[],
        private readonly currentExcludes: () => string[] = () => []) {}

    private excluded(file: string): boolean { return shouldExclude(file, [...this.excludes, ...this.currentExcludes()]); }

    retrieveNavigation(query: MemoryQuery, maxTokens = 1500): MemoryNavigation[] {
        const started = performance.now();
        const entries: Array<Pick<HandbookEntry, 'triggers' | 'targetPaths' | 'questions' | 'supports'>> = [
            ...this.view.handbook,
            ...this.view.episodes.filter(isEligibleEpisode).map(episode => ({
                triggers: [...episode.changedPaths, ...episode.changedSymbols],
                targetPaths: [...new Set(episode.observations.flatMap(observation => observation.evidence.map(evidence => evidence.source.path)))],
                questions: episode.questions,
                supports: episode.observations.flatMap(observation => observation.evidence.map(evidence => ({ episodeId: episode.id, evidenceId: evidence.id }))),
            })),
        ];
        const exact = new Set([...query.paths, ...query.symbols]);
        const words = new Set([...query.keywords, ...query.symbols].flatMap(value => value.toLowerCase().split(/[^\p{L}\p{N}_]+/u)).filter(Boolean));
        const lexical = bm25Scores(entries.map(entry => [...entry.triggers, ...entry.targetPaths]), [...query.paths, ...query.symbols, ...query.keywords]);
        const candidates = entries.map((entry, index) => {
            const targets = entry.targetPaths.filter(target => !this.excluded(target));
            const score = entry.triggers.reduce((total, trigger) => total + (exact.has(trigger) ? 100 : 0), 0)
                + targets.reduce((total, target) => total + (query.paths.includes(target) ? 30 : 0), 0)
                + entry.triggers.reduce((total, trigger) => total + (query.paths.some(file => path.posix.dirname(file) !== '.' && path.posix.dirname(file) === path.posix.dirname(trigger)) ? 5 : 0), 0)
                + [...words].filter(word => entry.triggers.join(' ').toLowerCase().includes(word)).length;
            return { entry, targets, score: score + lexical[index] };
        }).filter(candidate => candidate.score > 0 && candidate.targets.length).sort((a, b) => b.score - a.score);
        const result: MemoryNavigation[] = [];
        const seen = new Set<string>();
        const areaCounts = new Map<string, number>();
        // UTF-8 bytes are a conservative token upper bound, including non-Latin text.
        const maxBytes = Math.min(1500, Math.max(0, maxTokens));
        for (const { entry, targets } of candidates) {
            const filtered = targets.filter(target => !seen.has(target)).slice(0, 8);
            if (!filtered.length) { continue; }
            const area = path.posix.dirname(filtered[0]);
            if ((areaCounts.get(area) ?? 0) >= 2) { continue; }
            const navigation: MemoryNavigation = { id: `M${result.length + 1}`, targetPaths: filtered,
                questions: entry.questions.slice(0, 2), supports: entry.supports.filter(support => {
                    const source = this.sourceFor(support);
                    return source && filtered.includes(source.path);
                }).slice(0, 4) };
            if (!navigation.supports.length) { continue; }
            if (Buffer.byteLength(JSON.stringify([...result, navigation])) > maxBytes) { continue; }
            result.push(navigation); filtered.forEach(target => seen.add(target)); areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
            if (result.length === 6) { break; }
        }
        this.usage.recalled += result.length;
        this.usage.retrievalMs += performance.now() - started;
        return result;
    }

    searchRepositoryMemory(query: MemoryQuery, maxTokens: number): MemoryNavigation[] {
        this.searches += 1;
        if (this.searches > 2) { throw new Error('Memory search budget exhausted (2 calls).'); }
        return this.retrieveNavigation(query, maxTokens);
    }

    private sourceFor(support: HandbookEntry['supports'][number]) {
        return this.view.episodes.find(episode => episode.id === support.episodeId)?.observations
            .flatMap(observation => observation.evidence).find(evidence => evidence.id === support.evidenceId)?.source;
    }

    async readMemorySources(supports: HandbookEntry['supports']): Promise<Array<{ status: 'source_unchanged' | 'source_relocated' | 'needs_revalidation' | 'unavailable'; source?: Awaited<ReturnType<RepositorySnapshotReader['observe']>> }>> {
        if (this.reads + supports.length > 8) { throw new Error('Memory source budget exhausted (8 chunks).'); }
        this.reads += supports.length;
        const started = performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([this.expandSources(supports), new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Memory source validation exceeded 250 ms.')), 250);
            })]);
            if (performance.now() - started > 250) { throw new Error('Memory source validation exceeded 250 ms.'); }
            return result;
        } finally { if (timer) { clearTimeout(timer); } }
    }

    private async expandSources(supports: HandbookEntry['supports']): Promise<Array<{ status: 'source_unchanged' | 'source_relocated' | 'needs_revalidation' | 'unavailable'; source?: Awaited<ReturnType<RepositorySnapshotReader['observe']>> }>> {
        const result: Array<{ status: 'source_unchanged' | 'source_relocated' | 'needs_revalidation' | 'unavailable'; source?: Awaited<ReturnType<RepositorySnapshotReader['observe']>> }> = [];
        for (const support of supports) {
            const old = this.sourceFor(support);
            if (!old || this.excluded(old.path) || !this.snapshot.entry(old.path, old.side)) {
                this.usage.unavailable += 1; result.push({ status: 'unavailable' }); continue;
            }
            const entry = this.snapshot.entry(old.path, old.side)!;
            if (!['100644', '100755'].includes(entry.mode)) { result.push({ status: 'unavailable' }); continue; }
            let start = old.startLine;
            const unchanged = entry.oid === old.blobOid;
            if (!unchanged) {
                const current = await this.snapshot.read(old.path, old.side, this.excludes);
                const index = current.indexOf(old.excerpt);
                if (!old.excerpt || index < 0 || current.indexOf(old.excerpt, index + 1) >= 0 || (index > 0 && current[index - 1] !== '\n')) {
                    result.push({ status: 'needs_revalidation' }); continue;
                }
                start = current.slice(0, index).split('\n').length;
            }
            const source = await this.snapshot.observe(old.path, start, old.endLine - old.startLine + 1, this.excludes, old.side, old.excerpt.length);
            this.usage.expanded += 1;
            this.expandedSources.add(`${source.path}\0${source.blobOid}\0${source.startLine}\0${source.contentHash}`);
            result.push({ status: unchanged ? 'source_unchanged' : 'source_relocated', source });
        }
        return result;
    }

    recordAdoption(sources: Array<import('../git/repositorySnapshot').SourceObservation>): void {
        this.usage.adopted = sources.filter(source => this.expandedSources.has(`${source.path}\0${source.blobOid}\0${source.startLine}\0${source.contentHash}`)).length;
    }
}
