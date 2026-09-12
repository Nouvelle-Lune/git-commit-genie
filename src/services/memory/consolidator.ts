import { createHash, randomUUID } from 'crypto';
import { consolidationProposalSchema, handbookEntrySchema, HandbookEntry, InvestigationEpisode, MemorySupport, RecordedObservation, entrySupports, entryTerms } from './types';
import { MemoryStore, MemoryView } from './store';
import { isEligibleEpisode, isInvestigationObservation } from './recorder';
import { MEMORY_DEFAULTS, MemorySettings } from './settings';
import { bm25Scores } from './ranking';

const REQUIRED_INDEPENDENT_SNAPSHOTS = 2;

export interface GroupObservation {
    support: MemorySupport;
    episode: InvestigationEpisode;
    observation: RecordedObservation;
}
export interface ConsolidationGroup {
    id: string;
    fingerprint: string;
    seedId: string;
    title: string;
    episodes: InvestigationEpisode[];
    existing: HandbookEntry[];
    observations: GroupObservation[];
}
export interface ConsolidationProjection {
    input: string;
    groups: ConsolidationGroup[];
    observations: Map<string, GroupObservation>;
    sources: Map<string, { observationId: string; evidence: RecordedObservation['evidence'][number] }>;
    existing: Map<string, HandbookEntry>;
    eligibleStepRoutes: Array<{
        operation: string;
        path: string;
        findings: Array<{ observationId: string; snapshot: string; sourceIds: string[]; claimIndices: number[] }>;
    }>;
}
export interface ConsolidationValidation {
    entries: HandbookEntry[];
    processedGroupIds: string[];
    findingGroupIds: string[];
    noFindingGroupIds: string[];
    issues: string[];
}
export interface ConsolidationRunner {
    (input: string, signal: AbortSignal, validate: (raw: unknown) => ConsolidationValidation): Promise<{ value: ConsolidationValidation; attempts: number }>;
    maxInputTokens: number;
    estimateInputTokens(input: string): number;
}
export interface GroupOutcome {
    seedId: string;
    status: 'published' | 'no-findings' | 'failed';
    entryIds: string[];
    issues: string[];
}
export type ConsolidationResult = {
    status: 'published' | 'partial' | 'no-findings';
    groupCount: number; handbookCount: number; noFindingCount: number; failedGroupCount: number;
    skippedGroups: number; deferredPaths: string[]; retryCount: number; groupOutcomes: GroupOutcome[];
} | { status: 'not-ready'; pendingCount: number; threshold: number }
  | { status: 'budget-exhausted'; limit: number; resumesAt: number }
  | { status: 'memory-disabled' | 'foreground-busy' | 'already-running' | 'cancelled' | 'automatic-paused' };

export function episodeTerms(episode: InvestigationEpisode): string[] {
    return [...episode.changedPaths, ...episode.changedSymbols, ...episode.questions,
        ...episode.observations.filter(isInvestigationObservation).flatMap(observation => [observation.summary,
            ...Object.values(observation.arguments).filter((value): value is string => typeof value === 'string'),
            ...observation.evidence.map(evidence => evidence.source.path)])];
}

function digestUuid(value: string): string {
    const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
    hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
    const text = hex.join('');
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function makeGroup(seed: InvestigationEpisode, episodes: InvestigationEpisode[], existing: HandbookEntry[]): ConsolidationGroup {
    const observations = episodes.flatMap(episode => episode.observations.flatMap((observation, observationIndex) =>
        isInvestigationObservation(observation) ? [{ episode, observation, support: { episodeId: episode.id, observationIndex } }] : []));
    // IDs and recording timestamps do not make an identical investigation new evidence.
    const fingerprint = digestUuid(JSON.stringify([seed.snapshot.id, episodes.map(episode => ({
        snapshot: episode.snapshot.id, questions: episode.questions, paths: episode.changedPaths, symbols: episode.changedSymbols,
        observations: episode.observations.filter(isInvestigationObservation).map(({ durationMs, ...observation }) => observation), claims: episode.claims, status: episode.status,
    }))]));
    return { id: 'G1', seedId: seed.id, title: seed.questions[0] || seed.changedPaths.join(', ') || seed.id,
        episodes, existing, observations, fingerprint };
}

/** Each batch belongs to an investigation, not a file; paths only retrieve related history. */
export function buildConsolidationGroups(episodes: InvestigationEpisode[], completed: string[], handbook: HandbookEntry[] = []): ConsolidationGroup[] {
    const eligible = episodes.filter(isEligibleEpisode).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const completedIds = new Set(completed);
    return eligible.flatMap(seed => {
        const words = episodeTerms(seed);
        const scores = bm25Scores(eligible.map(episodeTerms), words);
        const related = eligible.map((episode, index) => ({ episode, score: scores[index]
            + episode.changedPaths.filter(file => seed.changedPaths.includes(file)).length * 100
            + episode.changedSymbols.filter(symbol => seed.changedSymbols.includes(symbol)).length * 100 }))
            .filter(item => item.episode.id !== seed.id && item.score > 0)
            .sort((a, b) => b.score - a.score || a.episode.createdAt - b.episode.createdAt || a.episode.id.localeCompare(b.episode.id));
        const entryScores = bm25Scores(handbook.map(entryTerms), words);
        const rankedEntries = handbook.map((entry, index) => ({ entry, score: entryScores[index] }))
            .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
        const selected = [seed];
        const selectedIds = new Set([seed.id]);
        // Reserve room for complete existing provenance before filling with loose episode hits.
        // Otherwise a relevant experience outside the initial episode window becomes an accidental duplicate.
        for (const { entry } of rankedEntries) {
            const supportIds = [...new Set(entrySupports(entry).map(support => support.episodeId))];
            const missing = supportIds.filter(id => !selectedIds.has(id));
            if (selected.length + missing.length > 20 || missing.some(id => !eligible.some(episode => episode.id === id))) { continue; }
            for (const id of missing) { selected.push(eligible.find(episode => episode.id === id)!); selectedIds.add(id); }
        }
        for (const { episode } of related) {
            if (selected.length === 20) { break; }
            if (!selectedIds.has(episode.id)) { selected.push(episode); selectedIds.add(episode.id); }
        }
        if (new Set(selected.map(episode => episode.snapshot.id)).size < 2) { return []; }
        const existing = rankedEntries.map(item => item.entry).filter(entry => entrySupports(entry).every(support => selectedIds.has(support.episodeId)));
        const group = makeGroup(seed, selected, existing);
        return completedIds.has(group.fingerprint) ? [] : [group];
    });
}

/** Observation and source handles preserve why/how/result without exporting storage IDs. */
export function projectConsolidation(groups: ConsolidationGroup[]): ConsolidationProjection {
    if (groups.length !== 1) { throw new Error('A consolidation call requires exactly one seed group.'); }
    const observations = new Map<string, GroupObservation>();
    const sources: ConsolidationProjection['sources'] = new Map();
    const existing = new Map<string, HandbookEntry>();
    const group = groups[0];
    const snapshotIds = [...new Set(group.episodes.map(episode => episode.snapshot.id))];
    const projectedEpisodes = group.episodes.map((episode, episodeIndex) => ({
        id: `T${episodeIndex + 1}`, snapshot: `V${snapshotIds.indexOf(episode.snapshot.id) + 1}`,
        status: episode.status, questions: episode.questions,
        claims: episode.claims.map((claim, index) => ({ index, text: claim.claim, disposition: claim.disposition })), changedPaths: episode.changedPaths, changedSymbols: episode.changedSymbols,
        observations: group.observations.filter(item => item.episode.id === episode.id).map(item => {
            const id = `O${observations.size + 1}`; observations.set(id, item);
            const evidence = item.observation.evidence.map(evidence => {
                const sourceId = `S${sources.size + 1}`; sources.set(sourceId, { observationId: id, evidence });
                return { id: sourceId, path: evidence.source.path, side: evidence.source.side,
                    startLine: evidence.source.startLine, endLine: evidence.source.endLine,
                    excerpt: evidence.source.excerpt, truncated: evidence.source.truncated,
                    usedByClaims: episode.claims.flatMap((claim, index) => claim.evidenceRefs.includes(evidence.id)
                        ? [{ index, text: claim.claim, disposition: claim.disposition }] : []) };
            });
            return { id, snapshot: `V${snapshotIds.indexOf(episode.snapshot.id) + 1}`,
                step: item.observation.step, tool: item.observation.tool, arguments: item.observation.arguments,
                ok: item.observation.ok, summary: item.observation.summary, error: item.observation.error,
                truncated: item.observation.truncated, evidence };
        }),
    }));
    // Expose only route bases that already have source-backed retained claims in
    // two snapshots. The model still decides question relevance and any symbol,
    // but it no longer has to infer whether a same-tool/same-path route exists.
    const routeCandidates = new Map<string, Map<string, {
        observationId: string; snapshot: string; sourceIds: Set<string>; claimIndices: Set<number>;
    }>>();
    for (const [sourceId, source] of sources) {
        const item = observations.get(source.observationId)!;
        if (!item.observation.ok) { continue; }
        const claimIndices = item.episode.claims.flatMap((claim, index) =>
            claim.disposition !== 'omit' && claim.evidenceRefs.includes(source.evidence.id) ? [index] : []);
        if (!claimIndices.length) { continue; }
        const key = JSON.stringify([item.observation.tool, source.evidence.source.path]);
        const findings = routeCandidates.get(key) ?? new Map();
        const snapshot = `V${snapshotIds.indexOf(item.episode.snapshot.id) + 1}`;
        const finding = findings.get(source.observationId) ?? {
            observationId: source.observationId, snapshot, sourceIds: new Set<string>(), claimIndices: new Set<number>(),
        };
        finding.sourceIds.add(sourceId);
        for (const claimIndex of claimIndices) { finding.claimIndices.add(claimIndex); }
        findings.set(source.observationId, finding);
        routeCandidates.set(key, findings);
    }
    const eligibleStepRoutes = [...routeCandidates].flatMap(([key, findings]) => {
        const [operation, targetPath] = JSON.parse(key) as [string, string];
        const values = [...findings.values()];
        if (new Set(values.map(value => value.snapshot)).size < REQUIRED_INDEPENDENT_SNAPSHOTS) { return []; }
        return [{ operation, path: targetPath, findings: values.map(value => ({
            observationId: value.observationId, snapshot: value.snapshot,
            sourceIds: [...value.sourceIds], claimIndices: [...value.claimIndices],
        })) }];
    });
    const oldEntries = group.existing.map(entry => {
        const id = `H${existing.size + 1}`; existing.set(id, entry);
        const supportHandles = (supports: MemorySupport[]) => supports.map(support => {
            const handle = [...observations].find(([, value]) => value.support.episodeId === support.episodeId
                && value.support.observationIndex === support.observationIndex);
            if (!handle) { throw new Error('Existing experience support is missing from the batch.'); }
            return handle[0];
        });
        return { id, situation: entry.situation,
            steps: entry.steps.map(({ supports, ...step }) => ({ ...step, observationIds: supportHandles(supports) })),
            lessons: entry.lessons.map(({ supports, ...lesson }) => ({ ...lesson, observationIds: supportHandles(supports) })),
            retirement: entry.retirement ? {
                reason: entry.retirement.reason,
                observationIds: supportHandles(entry.retirement.supports),
                replacementEntryId: entry.retirement.replacementEntryId,
            } : null };
    });
    return { input: JSON.stringify({ groups: [{ id: group.id, seed: 'T1',
        eligibleStepRoutes, episodes: projectedEpisodes, existing: oldEntries }] }),
        groups, observations, sources, existing, eligibleStepRoutes };
}

export function validateConsolidation(raw: unknown, projection: ConsolidationProjection): ConsolidationValidation {
    const result: ConsolidationValidation = { entries: [], processedGroupIds: [], findingGroupIds: [], noFindingGroupIds: [], issues: [] };
    const parsed = consolidationProposalSchema.safeParse(raw);
    if (!parsed.success) { result.issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`); return result; }
    const group = projection.groups[0];
    const snapshotIds = [...new Set(group.episodes.map(episode => episode.snapshot.id))];
    const snapshotFor = (item: GroupObservation): string => `V${snapshotIds.indexOf(item.episode.snapshot.id) + 1}`;
    const describeObservation = (id: string, item: GroupObservation): string => `${id}(${snapshotFor(item)})`;
    const proposal = parsed.data.groups[0];
    if (proposal.groupId !== group.id) { result.issues.push('The supplied seed group ID must be returned.'); return result; }
    if ((proposal.outcome === 'findings') !== (proposal.entries.length + proposal.retirements.length > 0)) {
        result.issues.push('findings requires an entry or retirement; no-findings requires both arrays to be empty.'); return result;
    }
    const updated = new Set<string>();
    const duplicate = new Set<string>();
    const validatedByProposalIndex = new Map<number, HandbookEntry>();
    for (const [index, entry] of proposal.entries.entries()) {
        const entryLabel = `entries.${index}`;
        const issues: string[] = [];
        const resolve = (label: string, handles: string[]): Array<{
            observationId: string; item: GroupObservation; selectionIndex: number;
        }> => {
            if (new Set(handles).size !== handles.length) {
                issues.push(`${label}: repeated observation handles are not independent support.`);
            }
            const selected = handles.flatMap((id, selectionIndex) => {
                const item = projection.observations.get(id);
                if (!item) { issues.push(`${label}.${selectionIndex}: unknown observation ${id}.`); return []; }
                return [{ observationId: id, item, selectionIndex }];
            });
            const snapshots = new Set(selected.map(value => value.item.episode.snapshot.id));
            if (snapshots.size < REQUIRED_INDEPENDENT_SNAPSHOTS) {
                const handlesBySnapshot = selected.map(value => describeObservation(value.observationId, value.item)).join(', ') || 'none';
                issues.push(`${label}: selected ${handlesBySnapshot} cover ${snapshots.size}/${REQUIRED_INDEPENDENT_SNAPSHOTS} independent V* snapshots; each item requires at least two independent V* snapshots.`);
            }
            return selected;
        };
        const routeObservations: GroupObservation[][] = [];
        const steps = entry.steps.map((step, stepIndex) => {
            const stepLabel = `${entryLabel}.steps.${stepIndex}`;
            const handles = step.findings.map(finding => finding.observationId);
            const selected = resolve(`${stepLabel}.findings`, handles);
            routeObservations.push(selected.map(value => value.item));
            const source = projection.sources.get(step.sourceId);
            if (!source || !handles.includes(source.observationId)) {
                issues.push(`${stepLabel}.sourceId: step source ${step.sourceId} must belong to its supporting observations.`);
            }
            const target = source?.evidence.source.path ?? '';
            const tool = source ? projection.observations.get(source.observationId)!.observation.tool : '';
            const supports = selected.map(({ observationId, item, selectionIndex }) => {
                const findingLabel = `${stepLabel}.findings.${selectionIndex}`;
                const finding = step.findings[selectionIndex];
                const question = item.episode.questions[finding.questionIndex];
                const claim = item.episode.claims[finding.claimIndex];
                const matchingEvidence = item.observation.evidence.filter(evidence => evidence.source.path === target
                    && (!step.symbol || evidence.source.excerpt.includes(step.symbol)
                        || Object.values(item.observation.arguments).includes(step.symbol)));
                const matching = matchingEvidence.find(evidence => claim?.evidenceRefs.includes(evidence.id));
                if (!item.observation.ok || !matchingEvidence.length || item.observation.tool !== tool) {
                    const actualPaths = [...new Set(item.observation.evidence.map(evidence => evidence.source.path))];
                    const actualSymbol = typeof item.observation.arguments.symbol === 'string'
                        ? item.observation.arguments.symbol : null;
                    issues.push(`${findingLabel}: ${describeObservation(observationId, item)} must be a successful matching tool observation with expected path ${JSON.stringify(target)}, symbol ${JSON.stringify(step.symbol)}, and tool ${JSON.stringify(tool)}; actual paths are ${JSON.stringify(actualPaths)}, actual symbol argument is ${JSON.stringify(actualSymbol)}, and actual tool is ${JSON.stringify(item.observation.tool)}.`);
                }
                // This proves a recorded question/source/finding association, not semantic correctness.
                if (!question?.trim() || !claim?.claim.trim() || claim.disposition === 'omit'
                    || !matching || !claim.evidenceRefs.includes(matching.id)) {
                    issues.push(`${findingLabel}: route support ${describeObservation(observationId, item)} requires a recorded questionIndex and a retained non-omit claimIndex citing its matching source evidence.`);
                }
                return { ...item.support, ...(matching ? { evidenceId: matching.id } : {}),
                    questionIndex: finding.questionIndex, claimIndex: finding.claimIndex };
            });
            return { path: target, ...(step.symbol ? { symbol: step.symbol } : {}), purpose: step.purpose, operation: tool,
                supports, snapshotCount: new Set(selected.map(value => value.item.episode.snapshot.id)).size };
        });
        if (steps.length > 1) {
            const routeSnapshots = new Set<string>();
            for (const episode of group.episodes) {
                let previous = -1;
                const ordered = routeObservations.every(selected => {
                    const candidates = selected.filter(item => item.episode.id === episode.id && item.observation.step > previous)
                        .sort((a, b) => a.observation.step - b.observation.step);
                    if (!candidates.length) { return false; }
                    previous = candidates[0].observation.step; return true;
                });
                if (ordered) { routeSnapshots.add(episode.snapshot.id); }
            }
            if (routeSnapshots.size < 2) {
                issues.push(`${entryLabel}.steps: the complete route must occur in order within investigations from two independent snapshots; matched ${routeSnapshots.size}/${REQUIRED_INDEPENDENT_SNAPSHOTS}.`);
            }
        }
        const lessons = entry.lessons.map((lesson, lessonIndex) => {
            const selected = resolve(`${entryLabel}.lessons.${lessonIndex}.observationIds`, lesson.observationIds);
            return { observation: lesson.observation, implication: lesson.implication, limitation: lesson.limitation,
                supports: selected.map(value => value.item.support),
                snapshotCount: new Set(selected.map(value => value.item.episode.snapshot.id)).size };
        });
        if (!steps.length && !lessons.length) {
            issues.push(`${entryLabel}: an experience needs at least one step or lesson.`);
        }
        const old = entry.existingEntryId === null ? undefined : projection.existing.get(entry.existingEntryId);
        if (entry.existingEntryId && (!old || updated.has(old.id))) {
            issues.push(`${entryLabel}.existingEntryId: an update requires a supplied, uniquely selected H* entry.`);
        }
        if (old) { updated.add(old.id); }
        const all = [...steps, ...lessons].flatMap(item => item.supports);
        if (all.length && !all.some(support => support.episodeId === group.seedId)) {
            issues.push(`${entryLabel}: an experience must be grounded in the seed investigation T1.`);
        }
        const referenced = all.map(support => ({ support, item: group.observations.find(item =>
            item.support.episodeId === support.episodeId && item.support.observationIndex === support.observationIndex)! }));
        const targetPaths = [...new Set(referenced.flatMap(({ support, item }) => item.observation.evidence
            .filter(evidence => !support.evidenceId || support.evidenceId === evidence.id)
            .map(evidence => evidence.source.path)))];
        const triggers = [...new Set([...targetPaths, ...referenced.flatMap(({ item }) => ['symbol', 'query', 'filePath', 'dirPath']
            .flatMap(key => typeof item.observation.arguments[key] === 'string' && item.observation.arguments[key]
                ? [item.observation.arguments[key] as string] : []))])];
        const identity = JSON.stringify([entry.situation.toLowerCase(), entry.steps, entry.lessons]);
        if (duplicate.has(identity)) { issues.push(`${entryLabel}: duplicate experience in the same result.`); }
        duplicate.add(identity);
        const checked = issues.length ? undefined : handbookEntrySchema.safeParse({
            id: old?.id ?? randomUUID(), situation: entry.situation,
            retirement: null, steps, lessons, targetPaths, triggers,
        });
        if (checked && !checked.success) {
            issues.push(...checked.error.issues.map(issue => `${entryLabel}${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`));
        }
        if (issues.length) { result.issues.push(...issues); }
        else if (checked?.success) { result.entries.push(checked.data); validatedByProposalIndex.set(index, checked.data); }
    }
    for (const [index, retirement] of proposal.retirements.entries()) {
        const retirementLabel = `retirements.${index}`;
        const issues: string[] = [];
        const old = projection.existing.get(retirement.existingEntryId);
        if (!old || updated.has(old.id)) {
            issues.push(`${retirementLabel}.existingEntryId: a retirement requires a supplied H* entry that is not updated or retired elsewhere in the result.`);
        }
        const seen = new Set<string>();
        const selected = retirement.findings.flatMap((finding, findingIndex) => {
            const findingLabel = `${retirementLabel}.findings.${findingIndex}`;
            if (seen.has(finding.observationId)) {
                issues.push(`${findingLabel}.observationId: repeated observation handles are not independent retirement support.`);
            }
            seen.add(finding.observationId);
            const item = projection.observations.get(finding.observationId);
            const source = projection.sources.get(finding.sourceId);
            if (!item || !source || source.observationId !== finding.observationId) {
                const observation = item ? describeObservation(finding.observationId, item) : `${finding.observationId}(unknown snapshot)`;
                const sourceOwner = source ? projection.observations.get(source.observationId) : undefined;
                const sourceContext = source
                    ? `${finding.sourceId} belongs to ${sourceOwner ? describeObservation(source.observationId, sourceOwner) : source.observationId} at path ${JSON.stringify(source.evidence.source.path)} on side ${JSON.stringify(source.evidence.source.side)}`
                    : `${finding.sourceId} was not supplied`;
                issues.push(`${findingLabel}: retirement counterevidence ${observation} must bind to one of its S* sources; ${sourceContext}.`); return [];
            }
            const evidence = source.evidence;
            const question = item.episode.questions[finding.questionIndex];
            const claim = item.episode.claims[finding.claimIndex];
            if (!item.observation.ok || evidence.source.side !== 'after' || !question?.trim() || !claim?.claim.trim()
                || claim.disposition === 'omit' || !claim.evidenceRefs.includes(evidence.id)) {
                issues.push(`${findingLabel}: retirement support ${describeObservation(finding.observationId, item)} requires successful after-tree counterevidence with a recorded question and retained claim citing ${finding.sourceId} at path ${JSON.stringify(evidence.source.path)}; actual side is ${JSON.stringify(evidence.source.side)} and actual tool is ${JSON.stringify(item.observation.tool)}.`);
            }
            return [{ observationId: finding.observationId, item, support: { ...item.support, evidenceId: evidence.id,
                questionIndex: finding.questionIndex, claimIndex: finding.claimIndex } }];
        });
        const snapshotCount = new Set(selected.map(value => value.item.episode.snapshot.id)).size;
        if (snapshotCount < REQUIRED_INDEPENDENT_SNAPSHOTS) {
            const handlesBySnapshot = selected.map(value => describeObservation(value.observationId, value.item)).join(', ') || 'none';
            issues.push(`${retirementLabel}.findings: selected ${handlesBySnapshot} cover ${snapshotCount}/${REQUIRED_INDEPENDENT_SNAPSHOTS} independent V* snapshots; retirement requires two independent V* snapshots.`);
        }
        if (!selected.some(value => value.item.episode.id === group.seedId)) {
            issues.push(`${retirementLabel}: retirement must be grounded in the seed investigation T1.`);
        }
        const replacement = retirement.replacementEntryIndex === null ? undefined
            : validatedByProposalIndex.get(retirement.replacementEntryIndex);
        if (retirement.replacementEntryIndex !== null && !replacement) {
            issues.push(`${retirementLabel}.replacementEntryIndex: must select a valid entry from this result.`);
        }
        if (old && replacement?.id === old.id) { issues.push(`${retirementLabel}: a retired experience cannot replace itself.`); }
        const checked = old && !issues.length ? handbookEntrySchema.safeParse({ ...old, retirement: {
            reason: retirement.reason, supports: selected.map(value => value.support), snapshotCount,
            replacementEntryId: replacement?.id ?? null,
        } }) : undefined;
        if (checked && !checked.success) {
            issues.push(...checked.error.issues.map(issue => `${retirementLabel}${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`));
        }
        if (issues.length) { result.issues.push(...issues); }
        else if (checked?.success) { updated.add(checked.data.id); result.entries.push(checked.data); }
    }
    // Independent entries may publish after the final retry; invalid entries never replace history.
    if (proposal.outcome === 'no-findings' || result.entries.length > 0) {
        if (!result.issues.length) { result.processedGroupIds.push(group.fingerprint); }
        if (proposal.outcome === 'no-findings') { result.noFindingGroupIds.push(group.fingerprint); }
        else { result.findingGroupIds.push(group.fingerprint); }
    }
    return result;
}

export async function consolidatePending(store: MemoryStore, runner: ConsolidationRunner, signal: AbortSignal,
    settings: MemorySettings = MEMORY_DEFAULTS, recheckSeeds?: string[]): Promise<ConsolidationResult> {
    const view: MemoryView = await store.inspect(); signal.throwIfAborted();
    const groups = buildConsolidationGroups(view.episodes, recheckSeeds ? [] : view.consolidated, view.handbook)
        .filter(group => !recheckSeeds || recheckSeeds.includes(group.seedId));
    if (!groups.length) { return { status: 'not-ready', pendingCount: Math.min(1, new Set(view.episodes.filter(isEligibleEpisode).map(episode => episode.snapshot.id)).size), threshold: 2 }; }
    let group: ConsolidationGroup | undefined;
    for (const candidate of groups) {
        const seed = candidate.episodes[0];
        let bounded = candidate;
        // Only complete observations/episodes are admitted; never silently cut a route in half.
        if (runner.estimateInputTokens(projectConsolidation([makeGroup(seed, [seed], [])]).input) > runner.maxInputTokens) {
            throw new Error(`Seed investigation ${seed.id} exceeds consolidation input budget (${runner.maxInputTokens}).`);
        }
        while (runner.estimateInputTokens(projectConsolidation([bounded]).input) > runner.maxInputTokens && bounded.episodes.length > 1) {
            const episodes = bounded.episodes.slice(0, -1); const ids = new Set(episodes.map(episode => episode.id));
            bounded = makeGroup(seed, episodes, bounded.existing.filter(entry => entrySupports(entry).every(support => ids.has(support.episodeId))));
        }
        if (new Set(bounded.episodes.map(episode => episode.snapshot.id)).size < 2) { throw new Error('Two complete independent investigations do not fit the consolidation input budget.'); }
        if (!recheckSeeds && view.consolidated.includes(bounded.fingerprint)) { continue; }
        group = bounded; break;
    }
    if (!group) { return { status: 'not-ready', pendingCount: 0, threshold: 2 }; }
    const projection = projectConsolidation([group]);
    const reservation = await store.reserveConsolidation(view, settings['consolidation.maxCallsPer24h'], settings);
    if (reservation.status !== 'reserved') { return reservation; }
    try {
        const run = await runner(projection.input, signal, raw => validateConsolidation(raw, projection));
        const validated = run.value; signal.throwIfAborted();
        if (!validated.entries.length && !validated.noFindingGroupIds.length) { throw new Error(`Consolidation failed validation after ${run.attempts} attempt(s): ${validated.issues.join(' | ')}`); }
        const replaced = new Set(validated.entries.map(entry => entry.id));
        await store.publishHandbook(view, reservation.generation, reservation.id,
            [...view.handbook.filter(entry => !replaced.has(entry.id)), ...validated.entries], validated.processedGroupIds, signal, settings, group.seedId);
        return { status: validated.issues.length ? 'partial' : validated.entries.length ? 'published' : 'no-findings',
            groupCount: 1, handbookCount: validated.entries.length, noFindingCount: validated.noFindingGroupIds.length,
            failedGroupCount: validated.issues.length ? 1 : 0, skippedGroups: groups.length - 1,
            deferredPaths: groups.slice(1).map(item => item.title), retryCount: run.attempts - 1,
            groupOutcomes: [{ seedId: group.seedId, status: validated.entries.length ? 'published' : 'no-findings',
                entryIds: validated.entries.map(entry => entry.id), issues: validated.issues }] };
    } finally { await store.releaseJob(reservation.id, settings); }
}
