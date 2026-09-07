import * as path from 'path';
import { RepositorySnapshotReader } from '../git/repositorySnapshot';
import { shouldExclude } from '../analysis/tools/pathFilters';
import { isEligibleEpisode } from './recorder';
import { MemoryView } from './store';
import { HandbookEntry, MemoryNavigation, MemoryQuery, MemoryUsage } from './types';
import { bm25Scores } from './ranking';
import { SourceObservation } from '../git/repositorySnapshot';
import { estimateTokens } from '../analysis/tools/modelContext';
import { MEMORY_DEFAULTS, MemoryRequestError, MemorySettings } from './settings';

export interface MemorySourceResult {
    key: string;
    status: 'source_unchanged' | 'source_relocated' | 'needs_revalidation' | 'unavailable';
    source?: SourceObservation;
}

export function memorySourceKey(source: SourceObservation): string {
    return JSON.stringify([source.path, source.side, source.blobOid, source.startLine, source.endLine, source.contentHash]);
}

/** Memory IDs identify navigation, never current-run evidence or facts. */
export class MemoryRetriever {
    readonly usage: MemoryUsage = { recalled: 0, expanded: 0, adopted: 0, unavailable: 0, retrievalMs: 0,
        sourceAttempts: 0, invalidReferences: 0, budgetRejections: 0 };
    private searches = 0;
    private reads = 0;
    private readonly expandedSources = new Set<string>();
    private readonly navigation = new Map<string, { value: MemoryNavigation; sources: SourceObservation[] }>();
    private readonly identities = new Map<string, string>();
    private readonly cache = new Map<string, MemorySourceResult>();
    private navigationTokens: number;
    constructor(readonly view: MemoryView, private readonly snapshot: RepositorySnapshotReader, private readonly excludes: string[],
        private readonly currentExcludes: () => string[] = () => [], readonly settings: MemorySettings = MEMORY_DEFAULTS) {
        this.navigationTokens = settings['navigation.maxTokens'];
    }

    setInputBudget(hardInputTokens: number): void {
        this.navigationTokens = Math.min(this.settings['navigation.maxTokens'], Math.floor(hardInputTokens * this.settings['navigation.maxInputPercent'] / 100));
    }

    get publishedNavigation(): MemoryNavigation[] { return [...this.navigation.values()].map(item => structuredClone(item.value)); }
    get budget() { return { used: this.reads, remaining: this.settings['sources.maxChunks'] - this.reads, limit: this.settings['sources.maxChunks'],
        searchesUsed: this.searches, searchesRemaining: this.settings['search.maxCalls'] - this.searches,
        navigationTokens: this.navigationTokens, resultTokens: this.settings['sources.maxResultTokens'] }; }

    reject(code: MemoryRequestError['code'], message: string, details: Record<string, unknown> = {}): never {
        if (code === 'invalid_arguments' || code === 'unknown_memory_id') { this.usage.invalidReferences += 1; }
        else { this.usage.budgetRejections += 1; }
        throw new MemoryRequestError(code, message, { ...this.budget, ...details });
    }

    assertResultBudget(output: string): void {
        const requested = Math.ceil(estimateTokens(output));
        if (requested > this.settings['sources.maxResultTokens']) {
            this.reject('result_budget_exceeded', 'Memory result exceeds its token budget; request fewer memoryIds.',
                { requested, limit: this.settings['sources.maxResultTokens'] });
        }
    }

    private excluded(file: string): boolean { return shouldExclude(file, [...this.excludes, ...this.currentExcludes()]); }

    retrieveNavigation(query: MemoryQuery, maxTokens = this.navigationTokens): MemoryNavigation[] {
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
        const tokenLimit = Math.min(this.navigationTokens, maxTokens);
        for (const { entry, targets } of candidates) {
            const filtered = targets.filter(target => !seen.has(target)).slice(0, 8);
            if (!filtered.length) { continue; }
            const area = path.posix.dirname(filtered[0]);
            if ((areaCounts.get(area) ?? 0) >= 2) { continue; }
            const sources = [...new Map(entry.supports.map(support => this.sourceFor(support))
                .filter((source): source is SourceObservation => !!source && filtered.includes(source.path))
                .map(source => [memorySourceKey(source), source])).values()].slice(0, 4);
            if (!sources.length) { continue; }
            const identity = JSON.stringify([filtered, entry.questions.slice(0, 2), sources.map(memorySourceKey)]);
            const id = this.identities.get(identity) ?? `M${this.navigation.size + 1}`;
            const navigation: MemoryNavigation = { id, targetPaths: filtered, questions: entry.questions.slice(0, 2), sourceCount: sources.length };
            if (estimateTokens(JSON.stringify([...result, navigation])) > tokenLimit) { continue; }
            this.identities.set(identity, id);
            this.navigation.set(id, { value: structuredClone(navigation), sources: structuredClone(sources) });
            result.push(navigation); filtered.forEach(target => seen.add(target)); areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
            if (result.length === 6) { break; }
        }
        this.usage.recalled += result.length;
        this.usage.retrievalMs += performance.now() - started;
        return result;
    }

    searchRepositoryMemory(query: MemoryQuery, maxTokens = this.navigationTokens): MemoryNavigation[] {
        if (this.searches >= this.settings['search.maxCalls']) { this.reject('search_budget_exceeded', 'Memory search budget exhausted.'); }
        this.searches += 1;
        return this.retrieveNavigation(query, maxTokens);
    }

    private sourceFor(support: HandbookEntry['supports'][number]) {
        return this.view.episodes.find(episode => episode.id === support.episodeId)?.observations
            .flatMap(observation => observation.evidence).find(evidence => evidence.id === support.evidenceId)?.source;
    }

    async readMemorySources(memoryIds: string[], signal?: AbortSignal): Promise<MemorySourceResult[]> {
        if (!Array.isArray(memoryIds) || !memoryIds.length || memoryIds.some(id => typeof id !== 'string' || !/^M\d+$/.test(id))) {
            this.reject('invalid_arguments', 'Provide a non-empty memoryIds array containing published M* navigation IDs.');
        }
        const sources = new Map<string, SourceObservation>();
        for (const id of memoryIds) {
            const navigation = this.navigation.get(id);
            if (!navigation) { this.reject('unknown_memory_id', `Unknown Memory navigation ID: ${id}.`, { memoryId: id }); }
            for (const source of navigation.sources) { sources.set(memorySourceKey(source), source); }
        }
        const pending = [...sources.entries()].filter(([key]) => !this.cache.has(key));
        if (this.reads + pending.length > this.settings['sources.maxChunks']) {
            this.reject('source_budget_exceeded', 'Memory source request exceeds the remaining budget; request fewer memoryIds.', { requested: pending.length });
        }
        signal?.throwIfAborted();
        const started = performance.now();
        const controller = new AbortController();
        let rejectAbort: (reason: unknown) => void;
        const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
        const abort = () => { controller.abort(signal?.reason); rejectAbort(controller.signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutMs = this.settings['sources.timeoutMs'];
        try {
            const expanded = await Promise.race([this.expandSources(pending, controller.signal, () => {
                this.reads += 1; this.usage.sourceAttempts += 1;
            }), new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { const error = new Error(`Memory source validation exceeded ${timeoutMs} ms.`); controller.abort(error); reject(error); }, timeoutMs);
            }), aborted]);
            controller.signal.throwIfAborted();
            if (performance.now() - started > timeoutMs) { throw new Error(`Memory source validation exceeded ${timeoutMs} ms.`); }
            const merged = new Map([...this.cache, ...expanded.map(item => [item.key, item] as const)]);
            const result = [...sources].map(([key, source]) => this.excluded(source.path)
                ? { key, status: 'unavailable' as const } : merged.get(key)!);
            this.assertResultBudget(JSON.stringify(result));
            for (const item of expanded) {
                this.cache.set(item.key, item);
                if (item.source) { this.usage.expanded += 1; this.expandedSources.add(memorySourceKey(item.source)); }
                if (item.status === 'unavailable') { this.usage.unavailable += 1; }
            }
            return result;
        } finally { controller.abort(); signal?.removeEventListener('abort', abort); if (timer) { clearTimeout(timer); } }
    }

    private async expandSources(sources: Array<[string, SourceObservation]>, signal: AbortSignal, onAttempt: () => void): Promise<MemorySourceResult[]> {
        const result: MemorySourceResult[] = [];
        for (const [key, old] of sources) {
            signal.throwIfAborted(); onAttempt();
            if (this.excluded(old.path) || !this.snapshot.entry(old.path, old.side)) {
                result.push({ key, status: 'unavailable' }); continue;
            }
            const entry = this.snapshot.entry(old.path, old.side)!;
            if (!['100644', '100755'].includes(entry.mode)) { result.push({ key, status: 'unavailable' }); continue; }
            let start = old.startLine;
            const unchanged = entry.oid === old.blobOid;
            if (!unchanged) {
                const current = await this.snapshot.read(old.path, old.side, this.excludes);
                signal.throwIfAborted();
                const index = current.indexOf(old.excerpt);
                if (!old.excerpt || index < 0 || current.indexOf(old.excerpt, index + 1) >= 0 || (index > 0 && current[index - 1] !== '\n')) {
                    result.push({ key, status: 'needs_revalidation' }); continue;
                }
                start = current.slice(0, index).split('\n').length;
            }
            const source = await this.snapshot.observe(old.path, start, old.endLine - old.startLine + 1, this.excludes, old.side, old.excerpt.length);
            signal.throwIfAborted();
            result.push(this.excluded(old.path) ? { key, status: 'unavailable' } : { key, status: unchanged ? 'source_unchanged' : 'source_relocated', source });
        }
        return result;
    }

    recordAdoption(sources: Array<import('../git/repositorySnapshot').SourceObservation>): void {
        this.usage.adopted = sources.filter(source => this.expandedSources.has(memorySourceKey(source))).length;
    }
}
