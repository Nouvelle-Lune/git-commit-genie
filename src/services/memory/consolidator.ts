import { createHash, randomUUID } from 'crypto';
import { consolidationGroupProposalSchema, handbookEntrySchema, HandbookEntry, InvestigationEpisode } from './types';
import { MemoryStore, MemoryView } from './store';
import { isEligibleEpisode } from './recorder';
import { MEMORY_DEFAULTS, MemorySettings } from './settings';

const REQUIRED_INDEPENDENT_SNAPSHOTS = 2;
const MAX_GROUPS_PER_CALL = 12;

type EvidenceSupport = HandbookEntry['supports'][number];

interface GroupSource {
    support: EvidenceSupport;
    episode: InvestigationEpisode;
    evidence: InvestigationEpisode['observations'][number]['evidence'][number];
    tool: string;
}

export interface ConsolidationGroup {
    id: string;
    fingerprint: string;
    anchorPath: string;
    sources: GroupSource[];
}

export interface ConsolidationProjection {
    input: string;
    groups: ConsolidationGroup[];
    sources: Map<string, { groupId: string; value: GroupSource }>;
}

export interface ConsolidationValidation {
    entries: HandbookEntry[];
    processedGroupIds: string[];
    findingGroupIds: string[];
    noFindingGroupIds: string[];
    issues: string[];
}

export interface ConsolidationRunner {
    (input: string, signal: AbortSignal,
        validate: (raw: unknown) => ConsolidationValidation): Promise<{ value: ConsolidationValidation; attempts: number }>;
    maxInputTokens: number;
    estimateInputTokens(input: string): number;
}

export type ConsolidationResult = {
    status: 'published' | 'partial';
    groupCount: number;
    handbookCount: number;
    noFindingCount: number;
    failedGroupCount: number;
    skippedGroups: number;
    deferredPaths: string[];
    retryCount: number;
    groupOutcomes: Array<{ path: string; status: 'published' | 'no-findings' | 'failed' }>;
} | {
    status: 'no-findings';
    groupCount: number;
    skippedGroups: number;
    deferredPaths: string[];
    retryCount: number;
    groupOutcomes: Array<{ path: string; status: 'no-findings' }>;
} | { status: 'not-ready'; pendingCount: number; threshold: number } |
    { status: 'budget-exhausted'; limit: number; resumesAt: number } |
    { status: 'memory-disabled' | 'foreground-busy' | 'already-running' | 'cancelled' | 'automatic-paused' };

/** Build one evidence group per exact source path with repeated independent observations. */
export function buildConsolidationGroups(episodes: InvestigationEpisode[], completed: string[]): ConsolidationGroup[] {
    const byPath = new Map<string, GroupSource[]>();
    for (const episode of episodes.filter(isEligibleEpisode)) {
        for (const observation of episode.observations) {
            if (!observation.ok || observation.tool === 'readMemorySources') { continue; }
            for (const evidence of observation.evidence) {
                const sources = byPath.get(evidence.source.path) ?? [];
                sources.push({ support: { episodeId: episode.id, evidenceId: evidence.id }, episode, evidence, tool: observation.tool });
                byPath.set(evidence.source.path, sources);
            }
        }
    }
    const completedIds = new Set(completed);
    const candidates = [...byPath].flatMap(([anchorPath, rawSources]) => {
        const sources = deduplicateGroupSources(rawSources);
        const snapshots = new Set(sources.map(source => source.episode.snapshot.id));
        if (snapshots.size < REQUIRED_INDEPENDENT_SNAPSHOTS) { return []; }
        const fingerprint = groupFingerprint(anchorPath, sources);
        return completedIds.has(fingerprint) ? [] : [{ id: '', fingerprint, anchorPath, sources }];
    }).sort((left, right) => {
        const snapshots = (group: ConsolidationGroup) => new Set(group.sources.map(source => source.episode.snapshot.id)).size;
        return snapshots(right) - snapshots(left) || left.anchorPath.localeCompare(right.anchorPath);
    });
    return candidates.map((group, index) => ({ ...group, id: `G${index + 1}` }));
}

/** The model sees bounded local handles and evidence, never persistent episode identifiers. */
export function projectConsolidation(groups: ConsolidationGroup[]): ConsolidationProjection {
    const sources = new Map<string, { groupId: string; value: GroupSource }>();
    const snapshotIds = [...new Set(groups.flatMap(group => group.sources.map(source => source.episode.snapshot.id)))];
    const projected = groups.map(group => ({
        id: group.id,
        anchorPath: group.anchorPath,
        independentSnapshots: new Set(group.sources.map(source => source.episode.snapshot.id)).size,
        sources: group.sources.map(source => {
            const id = `S${sources.size + 1}`;
            sources.set(id, { groupId: group.id, value: source });
            return {
                id,
                snapshot: `V${snapshotIds.indexOf(source.episode.snapshot.id) + 1}`,
                tool: source.tool,
                side: source.evidence.source.side,
                startLine: source.evidence.source.startLine,
                endLine: source.evidence.source.endLine,
                truncated: source.evidence.source.truncated,
                excerpt: source.evidence.source.excerpt,
            };
        }),
    }));
    return { input: JSON.stringify({ groups: projected }), groups, sources };
}

/** Validate every group independently so a final retry may publish unaffected groups explicitly. */
export function validateConsolidation(raw: unknown, projection: ConsolidationProjection): ConsolidationValidation {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {
            entries: [], processedGroupIds: [], findingGroupIds: [], noFindingGroupIds: [],
            issues: ['<root>: expected an object containing groups.'],
        };
    }
    const envelope = raw as Record<string, unknown>;
    const issues: string[] = Object.keys(envelope).filter(key => key !== 'groups')
        .map(key => `<root>: unrecognized key ${JSON.stringify(key)}.`);
    if (!Array.isArray(envelope.groups)) {
        return { entries: [], processedGroupIds: [], findingGroupIds: [], noFindingGroupIds: [],
            issues: [...issues, 'groups: expected an array.'] };
    }
    if (envelope.groups.length < 1) { issues.push('groups: expected at least 1 item.'); }
    if (envelope.groups.length > MAX_GROUPS_PER_CALL) { issues.push(`groups: expected at most ${MAX_GROUPS_PER_CALL} items.`); }

    const expected = new Map(projection.groups.map(group => [group.id, group]));
    const occurrences = new Map<string, number>();
    const parsedGroups: Array<{ index: number; value: ReturnType<typeof consolidationGroupProposalSchema.parse> }> = [];
    for (const [index, candidate] of envelope.groups.entries()) {
        const suppliedId = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
            && typeof (candidate as Record<string, unknown>).groupId === 'string'
            ? (candidate as Record<string, unknown>).groupId as string : undefined;
        if (suppliedId) { occurrences.set(suppliedId, (occurrences.get(suppliedId) ?? 0) + 1); }
        const parsed = consolidationGroupProposalSchema.safeParse(candidate);
        if (parsed.success) { parsedGroups.push({ index, value: parsed.data }); }
        else {
            issues.push(...parsed.error.issues.map(issue => `groups.${index}${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`));
        }
    }
    const globalIssues: string[] = [];
    for (const id of expected.keys()) {
        if (!occurrences.has(id)) { globalIssues.push(`${id}: result is missing.`); }
        else if (occurrences.get(id)! > 1) { globalIssues.push(`${id}: result appears more than once.`); }
    }
    for (const id of occurrences.keys()) { if (!expected.has(id)) { globalIssues.push(`${id}: group ID was not supplied.`); } }

    const entries: HandbookEntry[] = [];
    const processedGroupIds: string[] = [];
    const findingGroupIds: string[] = [];
    const noFindingGroupIds: string[] = [];
    issues.push(...globalIssues);
    for (const { value: result } of parsedGroups) {
        const group = expected.get(result.groupId);
        if (!group || occurrences.get(result.groupId) !== 1) { continue; }
        const groupIssues: string[] = [];
        if (result.outcome === 'findings' && !result.concerns.length) {
            groupIssues.push(`${group.id}: findings requires at least one concern.`);
        }
        if (result.outcome === 'no-findings' && result.concerns.length) {
            groupIssues.push(`${group.id}: no-findings must not contain concerns.`);
        }
        const groupEntries: HandbookEntry[] = [];
        const seenConcerns = new Set<string>();
        for (const [index, concern] of result.concerns.entries()) {
            const label = `${group.id}.concerns.${index}`;
            const normalizedText = concern.text.trim().toLocaleLowerCase();
            if (seenConcerns.has(normalizedText)) { groupIssues.push(`${label}: duplicates another concern in this group.`); continue; }
            seenConcerns.add(normalizedText);
            const sourceIds = [...new Set(concern.sourceIds)];
            const selected = sourceIds.map(id => ({ id, ref: projection.sources.get(id) }));
            for (const source of selected) {
                if (!source.ref) { groupIssues.push(`${label}: source ID ${source.id} was not supplied.`); }
                else if (source.ref.groupId !== group.id) { groupIssues.push(`${label}: source ID ${source.id} belongs to ${source.ref.groupId}.`); }
            }
            if (selected.some(source => !source.ref || source.ref.groupId !== group.id)) { continue; }
            const values = selected.map(source => source.ref!.value);
            const snapshots = new Set(values.map(source => source.episode.snapshot.id));
            if (snapshots.size < REQUIRED_INDEPENDENT_SNAPSHOTS) {
                groupIssues.push(`${label}: sources cover ${snapshots.size}/${REQUIRED_INDEPENDENT_SNAPSHOTS} independent snapshots.`);
                continue;
            }
            const supports = values.map(source => source.support);
            const targetPaths = [...new Set(values.map(source => source.evidence.source.path))];
            // Only promote symbols present in the cited excerpts. Episode-wide
            // symbol lists span the entire change and would make this path group
            // match unrelated future work.
            const triggers = [...new Set([...targetPaths, ...values.flatMap(source => source.episode.changedSymbols
                .filter(symbol => source.evidence.source.excerpt.includes(symbol)))])];
            groupEntries.push(handbookEntrySchema.parse({
                id: randomUUID(), triggers, targetPaths, concerns: [concern.text.trim()], supports, kind: 'navigation',
            }));
        }
        if (groupIssues.length) { issues.push(...groupIssues); continue; }
        processedGroupIds.push(group.fingerprint);
        if (result.outcome === 'no-findings') { noFindingGroupIds.push(group.fingerprint); }
        else { findingGroupIds.push(group.fingerprint); entries.push(...groupEntries); }
    }
    return { entries, processedGroupIds, findingGroupIds, noFindingGroupIds, issues };
}

export async function consolidatePending(store: MemoryStore, runner: ConsolidationRunner, signal: AbortSignal,
    settings: MemorySettings = MEMORY_DEFAULTS, recheckPaths?: string[]): Promise<ConsolidationResult> {
    const view: MemoryView = await store.inspect();
    signal.throwIfAborted();
    const eligible = view.episodes.filter(isEligibleEpisode);
    const requestedPaths = recheckPaths ? new Set(recheckPaths) : undefined;
    const groups = buildConsolidationGroups(eligible, requestedPaths ? [] : view.consolidated)
        .filter(group => !requestedPaths || requestedPaths.has(group.anchorPath));
    if (!groups.length) {
        return {
            status: 'not-ready',
            pendingCount: maximumIndependentSnapshots(eligible, requestedPaths ? [] : view.consolidated, requestedPaths),
            threshold: REQUIRED_INDEPENDENT_SNAPSHOTS,
        };
    }
    const batch: ConsolidationGroup[] = [];
    let skippedGroups = 0;
    const deferredPaths: string[] = [];
    for (const group of groups) {
        if (batch.length === MAX_GROUPS_PER_CALL) { skippedGroups += 1; deferredPaths.push(group.anchorPath); continue; }
        if (runner.estimateInputTokens(projectConsolidation([...batch, group]).input) > runner.maxInputTokens) {
            skippedGroups += 1; deferredPaths.push(group.anchorPath); continue;
        }
        batch.push(group);
    }
    if (!batch.length) { throw new Error(`All ${skippedGroups} pending evidence groups exceed the consolidation input budget (${runner.maxInputTokens} tokens).`); }
    const projection = projectConsolidation(batch);
    signal.throwIfAborted();
    const reservation = await store.reserveConsolidation(view, settings['consolidation.maxCallsPer24h'], settings);
    if (reservation.status !== 'reserved') { return reservation; }
    const job = reservation.id;
    try {
        const run = await runner(projection.input, signal, raw => validateConsolidation(raw, projection));
        signal.throwIfAborted();
        const validated = run.value;
        if (!validated.processedGroupIds.length) {
            throw new Error(`Consolidation failed validation after ${run.attempts} attempt(s): ${validated.issues.join(' | ')}`);
        }
        const processedPaths = new Set(batch.filter(group => validated.processedGroupIds.includes(group.fingerprint)).map(group => group.anchorPath));
        // A processed no-findings result supersedes an older finding for the
        // same exact path just as a newly published finding does.
        const retained = view.handbook.filter(entry => !entry.targetPaths.some(target => processedPaths.has(target)));
        await store.publishHandbook(view, reservation.generation, job, [...retained, ...validated.entries], validated.processedGroupIds, signal, settings);
        const retryCount = run.attempts - 1;
        const groupOutcomes = batch.map(group => ({
            path: group.anchorPath,
            status: validated.findingGroupIds.includes(group.fingerprint) ? 'published' as const
                : validated.noFindingGroupIds.includes(group.fingerprint) ? 'no-findings' as const : 'failed' as const,
        }));
        if (validated.issues.length) {
            return {
                status: 'partial', groupCount: validated.processedGroupIds.length, handbookCount: validated.entries.length,
                noFindingCount: validated.noFindingGroupIds.length,
                failedGroupCount: batch.length - validated.processedGroupIds.length,
                skippedGroups, deferredPaths, retryCount, groupOutcomes,
            };
        }
        if (!validated.entries.length) {
            return { status: 'no-findings', groupCount: validated.noFindingGroupIds.length, skippedGroups, deferredPaths, retryCount,
                groupOutcomes: groupOutcomes.map(group => ({ ...group, status: 'no-findings' as const })) };
        }
        return {
            status: 'published', groupCount: validated.processedGroupIds.length, handbookCount: validated.entries.length,
            noFindingCount: validated.noFindingGroupIds.length, failedGroupCount: 0, skippedGroups, deferredPaths, retryCount, groupOutcomes,
        };
    } finally { await store.releaseJob(job, settings); }
}

function maximumIndependentSnapshots(episodes: InvestigationEpisode[], completed: string[], requestedPaths?: Set<string>): number {
    const byPath = new Map<string, GroupSource[]>();
    for (const episode of episodes) {
        for (const observation of episode.observations) {
            if (!observation.ok || observation.tool === 'readMemorySources') { continue; }
            for (const evidence of observation.evidence) {
                const sources = byPath.get(evidence.source.path) ?? [];
                sources.push({ support: { episodeId: episode.id, evidenceId: evidence.id }, episode, evidence, tool: observation.tool });
                byPath.set(evidence.source.path, sources);
            }
        }
    }
    const completedIds = new Set(completed);
    return Math.max(0, ...[...byPath].map(([anchorPath, sources]) => [anchorPath, deduplicateGroupSources(sources)] as const)
        .filter(([anchorPath, sources]) => (!requestedPaths || requestedPaths.has(anchorPath)) && !completedIds.has(groupFingerprint(anchorPath, sources)))
        .map(([, sources]) => new Set(sources.map(source => source.episode.snapshot.id)).size));
}

function deduplicateGroupSources(sources: GroupSource[]): GroupSource[] {
    const unique = new Map<string, GroupSource>();
    for (const source of sources) {
        const identity = groupSourceIdentity(source);
        if (!unique.has(identity)) { unique.set(identity, source); }
    }
    return [...unique.values()];
}

function groupFingerprint(anchorPath: string, sources: GroupSource[]): string {
    // The fingerprint tracks repository evidence rather than storage record IDs,
    // so recording the same source twice cannot trigger a paid recheck.
    const identity = JSON.stringify([anchorPath, sources.map(groupSourceIdentity).sort()]);
    return digestUuid(identity);
}

function groupSourceIdentity(source: GroupSource): string {
    return JSON.stringify([
        source.episode.snapshot.id, source.evidence.source.side, source.evidence.source.blobOid,
        source.evidence.source.startLine, source.evidence.source.endLine, source.evidence.source.contentHash,
    ]);
}

function digestUuid(value: string): string {
    const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
    hex[12] = '5';
    hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const joined = hex.join('');
    return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
