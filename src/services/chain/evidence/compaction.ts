import { DiffData } from '../../git/gitTypes';
import { ChatFn, ChatMessage } from '../../llm/llmTypes';
import {
    DraftEvidence,
    EvidenceChange,
    EvidenceObservation,
    EvidenceSummaryResponse,
    FileEvidence,
    RawDiffEvidence,
} from '../../analysis/change/types';
import { buildSummarizeEvidenceMessages } from './prompts';
import { estimateChatMessagesTokens } from '../../llm/inputTokenBudget';

type EvidenceUnit = {
    id: string;
    header: string;
    content: string;
    requiresCoverage: boolean;
};

type SummaryTaskScheduler = <T>(task: () => Promise<T>) => Promise<T>;

class MissingEvidenceHunkIdsError extends Error {
    constructor(
        fileName: string,
        readonly missingHunkIds: string[]
    ) {
        super(`Evidence summary for '${fileName}' omitted hunk ids: ${missingHunkIds.join(', ')}.`);
        this.name = 'MissingEvidenceHunkIdsError';
    }
}

type RawCandidate = {
    item: RawDiffEvidence;
    index: number;
    estimatedTokens: number;
};

export type EvidenceCompactionResult = {
    evidence: DraftEvidence[];
    didSummarize: boolean;
    initialEstimatedInputTokens: number;
    estimatedInputTokens: number;
};

export function createRawDraftEvidence(diffs: DiffData[]): DraftEvidence[] {
    return diffs.map(diff => ({
        kind: 'raw',
        fileName: diff.fileName,
        status: diff.status,
        rawDiff: diff.rawDiff,
    }));
}

export async function compactEvidenceToFit(params: {
    diffs: DiffData[];
    evidence: DraftEvidence[];
    chat: ChatFn;
    maxInputTokens: number;
    maxParallel: number;
    maxRetries?: number;
    buildTargetMessages: (evidence: DraftEvidence[]) => ChatMessage[];
    onSummarizeStart?: () => void;
    onFileSummarized?: (file: FileEvidence, summarizedCount: number) => void;
}): Promise<EvidenceCompactionResult> {
    const {
        diffs,
        chat,
        maxInputTokens,
        buildTargetMessages,
        onSummarizeStart,
        onFileSummarized,
    } = params;

    if (!Number.isInteger(params.maxParallel) || params.maxParallel <= 0) {
        throw new Error(`gitCommitGenie.chain.maxParallel must be a positive integer; received ${params.maxParallel}.`);
    }
    const maxRetries = params.maxRetries ?? 2;
    assertNonNegativeRetries(maxRetries);

    const diffByFile = new Map(diffs.map(diff => [diff.fileName, diff]));
    let evidence = [...params.evidence];
    let didSummarize = false;
    let summarizedCount = 0;
    const initialEstimatedInputTokens = estimateChatMessagesTokens(buildTargetMessages(evidence));
    let estimatedInputTokens = initialEstimatedInputTokens;
    const scheduleSummaryTask = createSummaryTaskScheduler(params.maxParallel);

    // Measure the complete downstream prompt on every pass because templates,
    // repository analysis, and RAG references all consume the same input budget.
    // Each batch contains only files that are provably necessary under an
    // optimistic zero-content replacement. This preserves as many raw diffs as
    // possible while allowing independent files to use the shared concurrency.
    while (estimatedInputTokens > maxInputTokens) {
        const rawCandidates: RawCandidate[] = evidence
            .map((item, index) => ({ item, index }))
            .filter((entry): entry is { item: RawDiffEvidence; index: number } => entry.item.kind === 'raw')
            .map(entry => ({
                ...entry,
                estimatedTokens: estimateRawEvidenceTokens(entry.item),
            }))
            .sort((left, right) => right.estimatedTokens - left.estimatedTokens);

        if (rawCandidates.length === 0) {
            const required = estimateChatMessagesTokens(buildTargetMessages(evidence));
            throw new Error(
                `Thinking evidence still requires approximately ${required} input tokens after every file was summarized; ` +
                `increase gitCommitGenie.chain.maxInputTokens or reduce the staged change set.`
            );
        }

        if (!didSummarize) {
            onSummarizeStart?.();
        }
        didSummarize = true;

        const batch = selectCompactionBatch({
            candidates: rawCandidates,
            evidence,
            maxParallel: params.maxParallel,
            maxInputTokens,
            buildTargetMessages,
        });
        // Drain every request in the batch before propagating an error. Returning
        // on the first rejection would leave sibling LLM calls running while the
        // chain proceeds to its error handling or the next stage.
        const settledBatch = await Promise.allSettled(batch.map(async target => {
            const diff = diffByFile.get(target.item.fileName);
            if (!diff) {
                throw new Error(`Missing DiffData for '${target.item.fileName}' during dynamic summary routing.`);
            }
            return summarizeFileEvidenceWithScheduler(
                diff,
                chat,
                maxInputTokens,
                scheduleSummaryTask,
                maxRetries
            );
        }));
        const batchFailure = settledBatch.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (batchFailure) {
            throw batchFailure.reason;
        }
        const summarizedBatch = settledBatch
            .filter((result): result is PromiseFulfilledResult<FileEvidence> => result.status === 'fulfilled')
            .map(result => result.value);

        summarizedBatch.forEach((summarized, batchIndex) => {
            evidence[batch[batchIndex].index] = summarized;
            summarizedCount += 1;
            onFileSummarized?.(summarized, summarizedCount);
        });
        estimatedInputTokens = estimateChatMessagesTokens(buildTargetMessages(evidence));
    }

    return {
        evidence,
        didSummarize,
        initialEstimatedInputTokens,
        estimatedInputTokens,
    };
}

export async function summarizeFileEvidence(
    diff: DiffData,
    chat: ChatFn,
    maxInputTokens: number,
    maxParallel: number,
    maxRetries = 2
): Promise<FileEvidence> {
    assertPositiveParallelism(maxParallel);
    assertNonNegativeRetries(maxRetries);
    return summarizeFileEvidenceWithScheduler(
        diff,
        chat,
        maxInputTokens,
        createSummaryTaskScheduler(maxParallel),
        maxRetries
    );
}

async function summarizeFileEvidenceWithScheduler(
    diff: DiffData,
    chat: ChatFn,
    maxInputTokens: number,
    scheduleSummaryTask: SummaryTaskScheduler,
    maxRetries: number
): Promise<FileEvidence> {
    // Stable hunk ids let downstream stages trace every extracted claim back to
    // a bounded source chunk without carrying the full large diff forward.
    const units = buildEvidenceUnits(diff, maxInputTokens);
    const chunks = groupEvidenceUnits(diff, units, maxInputTokens);
    // A failed chunk must not cause the remaining queued chunks to outlive this
    // function; wait for all scheduler slots to drain before rethrowing.
    const settledResponses = await Promise.allSettled(chunks.map((chunk, index) =>
        scheduleSummaryTask(async () => {
            const value = await summarizeEvidenceChunkWithRetry(
                diff,
                chunk,
                chat,
                maxRetries
            );
            return { index, value };
        })
    ));
    const responseFailure = settledResponses.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (responseFailure) {
        throw responseFailure.reason;
    }
    const responses = settledResponses
        .filter((result): result is PromiseFulfilledResult<{ index: number; value: EvidenceSummaryResponse }> => result.status === 'fulfilled')
        .map(result => result.value);

    const changes = mergeChanges(responses.flatMap(response => response.value.changes));
    const tests = mergeObservations(responses.flatMap(response => response.value.tests));
    const breakingSignals = mergeObservations(responses.flatMap(response => response.value.breakingSignals));
    const uncertainties = mergeObservations(responses.flatMap(response => response.value.uncertainties));
    if (changes.length === 0 && tests.length === 0 && breakingSignals.length === 0 && uncertainties.length === 0) {
        throw new Error(`Evidence summary for '${diff.fileName}' did not contain any grounded observations.`);
    }

    return {
        kind: 'summary',
        fileName: diff.fileName,
        status: diff.status,
        coveredHunkIds: units.map(unit => unit.id),
        changes,
        tests,
        breakingSignals,
        uncertainties,
    };
}

function assertPositiveParallelism(maxParallel: number): void {
    if (!Number.isInteger(maxParallel) || maxParallel <= 0) {
        throw new Error(`gitCommitGenie.chain.maxParallel must be a positive integer; received ${maxParallel}.`);
    }
}

function assertNonNegativeRetries(maxRetries: number): void {
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
        throw new Error(`gitCommitGenie.llm.maxRetries must be a non-negative integer; received ${maxRetries}.`);
    }
}

async function summarizeEvidenceChunkWithRetry(
    diff: DiffData,
    chunk: EvidenceUnit[],
    chat: ChatFn,
    maxRetries: number
): Promise<EvidenceSummaryResponse> {
    const acceptedResponses: EvidenceSummaryResponse[] = [];
    let pendingUnits = chunk;
    let missingHunkIds: string[] | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const messages = buildSummaryMessages(diff, pendingUnits, missingHunkIds);
        let parsed: EvidenceSummaryResponse;
        try {
            parsed = await chat(messages, { requestType: 'summary' }) as EvidenceSummaryResponse;
        } catch {
            // Provider-level retries have already been exhausted. Preserve the
            // unresolved ids explicitly so a Summary outage cannot abort the chain.
            return mergeSummaryResponses([
                ...acceptedResponses,
                unresolvedSummaryEvidence(pendingUnits),
            ]);
        }

        try {
            validateEvidenceReferences(
                parsed,
                new Set(pendingUnits.map(unit => unit.id)),
                new Set(pendingUnits.filter(unit => unit.requiresCoverage).map(unit => unit.id)),
                diff.fileName
            );
            return mergeSummaryResponses([...acceptedResponses, parsed]);
        } catch (error) {
            if (!(error instanceof MissingEvidenceHunkIdsError)) {
                return mergeSummaryResponses([
                    ...acceptedResponses,
                    unresolvedSummaryEvidence(pendingUnits),
                ]);
            }

            acceptedResponses.push(parsed);
            missingHunkIds = error.missingHunkIds;
            pendingUnits = pendingUnits.filter(unit => error.missingHunkIds.includes(unit.id));

            if (attempt === maxRetries) {
                return mergeSummaryResponses([
                    ...acceptedResponses,
                    unresolvedSummaryEvidence(pendingUnits),
                ]);
            }
        }
    }

    throw new Error(`Summary coverage retry loop exited unexpectedly for '${diff.fileName}'.`);
}

function unresolvedSummaryEvidence(units: EvidenceUnit[]): EvidenceSummaryResponse {
    const unresolvedIds = units
        .filter(unit => unit.requiresCoverage)
        .map(unit => unit.id);
    return {
        changes: [],
        tests: [],
        breakingSignals: [],
        uncertainties: unresolvedIds.length > 0 ? [{
            detail: 'Summary could not ground these diff hunks after targeted repair.',
            evidenceHunkIds: unresolvedIds,
        }] : [],
    };
}

function mergeSummaryResponses(responses: EvidenceSummaryResponse[]): EvidenceSummaryResponse {
    return {
        changes: mergeChanges(responses.flatMap(response => response.changes)),
        tests: mergeObservations(responses.flatMap(response => response.tests)),
        breakingSignals: mergeObservations(responses.flatMap(response => response.breakingSignals)),
        uncertainties: mergeObservations(responses.flatMap(response => response.uncertainties)),
    };
}

function createSummaryTaskScheduler(maxParallel: number): SummaryTaskScheduler {
    assertPositiveParallelism(maxParallel);
    let activeTasks = 0;
    const waiters: Array<() => void> = [];

    const acquire = async (): Promise<void> => {
        if (activeTasks < maxParallel) {
            activeTasks += 1;
            return;
        }
        await new Promise<void>(resolve => waiters.push(resolve));
    };

    const release = (): void => {
        const next = waiters.shift();
        if (next) {
            // Transfer the occupied slot directly so a new caller cannot race
            // ahead of an already queued Summary request.
            next();
            return;
        }
        activeTasks -= 1;
    };

    return async <T>(task: () => Promise<T>): Promise<T> => {
        await acquire();
        try {
            return await task();
        } finally {
            release();
        }
    };
}

function selectCompactionBatch(params: {
    candidates: RawCandidate[];
    evidence: DraftEvidence[];
    maxParallel: number;
    maxInputTokens: number;
    buildTargetMessages: (evidence: DraftEvidence[]) => ChatMessage[];
}): RawCandidate[] {
    const optimisticEvidence = [...params.evidence];
    const batch: RawCandidate[] = [];

    for (const candidate of params.candidates) {
        batch.push(candidate);
        optimisticEvidence[candidate.index] = {
            ...candidate.item,
            rawDiff: '',
        };

        const optimisticTokens = estimateChatMessagesTokens(params.buildTargetMessages(optimisticEvidence));
        if (optimisticTokens <= params.maxInputTokens || batch.length >= params.maxParallel) {
            break;
        }
    }

    return batch;
}

function estimateRawEvidenceTokens(evidence: RawDiffEvidence): number {
    return estimateChatMessagesTokens([{
        role: 'user',
        content: evidence.rawDiff,
    }]);
}

function buildEvidenceUnits(diff: DiffData, maxInputTokens: number): EvidenceUnit[] {
    const preamble = extractDiffPreamble(diff.rawDiff);
    const baseUnits: EvidenceUnit[] = diff.diffHunks.length > 0
        ? [
            ...(preamble.trim() ? [{
                id: 'meta',
                header: '',
                content: preamble,
                requiresCoverage: metaContainsChangeEvidence(preamble),
            }] : []),
            ...diff.diffHunks.map((hunk, index) => ({
                id: `h${index + 1}`,
                header: hunk.header,
                content: hunk.content,
                requiresCoverage: true,
            })),
        ]
        : [{ id: 'h1', header: '', content: diff.rawDiff, requiresCoverage: true }];

    return baseUnits.flatMap(unit => splitEvidenceUnit(diff, unit, maxInputTokens));
}

function metaContainsChangeEvidence(preamble: string): boolean {
    // Plain diff/index/path headers only identify the file and should not force
    // the model to invent a semantic observation. Lifecycle, mode, copy, and
    // rename lines are actual changes and must remain coverage-checked.
    return preamble.split('\n').some(line => /^(?:old mode|new mode|new file mode|deleted file mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index)\b/.test(line));
}

function extractDiffPreamble(rawDiff: string): string {
    const lines = rawDiff.split('\n');
    const firstHunkIndex = lines.findIndex(line => line.startsWith('@@'));
    return firstHunkIndex === -1 ? rawDiff : lines.slice(0, firstHunkIndex).join('\n');
}

function splitEvidenceUnit(diff: DiffData, unit: EvidenceUnit, maxInputTokens: number): EvidenceUnit[] {
    if (messagesFitBudget(buildSummaryBudgetProbeMessages(diff, [unit]), maxInputTokens)) {
        return [unit];
    }

    const emptyProbe = { ...unit, content: '' };
    if (!messagesFitBudget(buildSummaryBudgetProbeMessages(diff, [emptyProbe]), maxInputTokens)) {
        throw new Error(
            `gitCommitGenie.chain.maxInputTokens (${maxInputTokens}) is too small for the Summary prompt overhead.`
        );
    }

    const parts: string[] = [];
    let currentLines: string[] = [];
    const lines = unit.content.split('\n');

    for (const line of lines) {
        const candidate = [...currentLines, line].join('\n');
        const probe = {
            id: `${unit.id}:p9999`,
            header: unit.header,
            content: candidate,
            requiresCoverage: unit.requiresCoverage,
        };
        if (messagesFitBudget(buildSummaryBudgetProbeMessages(diff, [probe]), maxInputTokens)) {
            currentLines.push(line);
            continue;
        }

        if (currentLines.length > 0) {
            parts.push(currentLines.join('\n'));
            currentLines = [];
        }

        const lineParts = splitOversizedLine(diff, unit, line, maxInputTokens);
        parts.push(...lineParts.slice(0, -1));
        const finalPart = lineParts[lineParts.length - 1];
        if (finalPart) {
            currentLines = [finalPart];
        }
    }

    if (currentLines.length > 0) {
        parts.push(currentLines.join('\n'));
    }

    return parts.map((content, index) => ({
        id: `${unit.id}:p${index + 1}`,
        header: unit.header,
        content,
        requiresCoverage: unit.requiresCoverage,
    }));
}

function splitOversizedLine(
    diff: DiffData,
    unit: EvidenceUnit,
    line: string,
    maxInputTokens: number
): string[] {
    const parts: string[] = [];
    let remaining = line;

    while (remaining.length > 0) {
        // Minified assets and generated files may contain a single line larger
        // than the entire prompt budget. Binary search finds the largest prefix
        // that fits without relying on a fixed character-to-token conversion.
        let low = 1;
        let high = remaining.length;
        let best = 0;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const probe = {
                id: `${unit.id}:p9999`,
                header: unit.header,
                content: remaining.slice(0, mid),
                requiresCoverage: unit.requiresCoverage,
            };
            if (messagesFitBudget(buildSummaryBudgetProbeMessages(diff, [probe]), maxInputTokens)) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        if (best === 0) {
            throw new Error(
                `gitCommitGenie.chain.maxInputTokens (${maxInputTokens}) is too small for the Summary prompt overhead.`
            );
        }

        parts.push(remaining.slice(0, best));
        remaining = remaining.slice(best);
    }

    return parts;
}

function groupEvidenceUnits(diff: DiffData, units: EvidenceUnit[], maxInputTokens: number): EvidenceUnit[][] {
    const chunks: EvidenceUnit[][] = [];
    let current: EvidenceUnit[] = [];

    for (const unit of units) {
        const candidate = [...current, unit];
        if (messagesFitBudget(buildSummaryBudgetProbeMessages(diff, candidate), maxInputTokens)) {
            current = candidate;
            continue;
        }

        if (current.length === 0) {
            throw new Error(`Evidence unit '${unit.id}' for '${diff.fileName}' exceeds the Summary input budget.`);
        }
        chunks.push(current);
        current = [unit];
    }

    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
}

function buildSummaryMessages(
    diff: DiffData,
    units: EvidenceUnit[],
    missingHunkIds?: string[]
): ChatMessage[] {
    return buildSummarizeEvidenceMessages({
        fileName: diff.fileName,
        status: diff.status,
        missingHunkIds,
        hunks: units.map(unit => ({
            id: unit.id,
            diff: [unit.header, unit.content].filter(Boolean).join('\n'),
        })),
    });
}

function buildSummaryBudgetProbeMessages(diff: DiffData, units: EvidenceUnit[]): ChatMessage[] {
    // Reserve enough input budget for the largest possible correction request,
    // where every coverage-required id from this chunk was omitted.
    return buildSummaryMessages(
        diff,
        units,
        units.filter(unit => unit.requiresCoverage).map(unit => unit.id)
    );
}

function messagesFitBudget(messages: ChatMessage[], maxInputTokens: number): boolean {
    return estimateChatMessagesTokens(messages) <= maxInputTokens;
}

function validateEvidenceReferences(
    response: EvidenceSummaryResponse,
    allowedIds: Set<string>,
    requiredIds: Set<string>,
    fileName: string
): void {
    const references = [
        ...response.changes.flatMap(change => change.evidenceHunkIds),
        ...response.tests.flatMap(test => test.evidenceHunkIds),
        ...response.breakingSignals.flatMap(signal => signal.evidenceHunkIds),
        ...response.uncertainties.flatMap(uncertainty => uncertainty.evidenceHunkIds),
    ];
    const invalid = Array.from(new Set(references.filter(id => !allowedIds.has(id))));
    if (invalid.length > 0) {
        throw new Error(`Evidence summary for '${fileName}' referenced unknown hunk ids: ${invalid.join(', ')}.`);
    }

    const referencedIds = new Set(references);
    const missing = Array.from(requiredIds).filter(id => !referencedIds.has(id));
    if (missing.length > 0) {
        throw new MissingEvidenceHunkIdsError(fileName, missing);
    }
}

function mergeChanges(items: EvidenceChange[]): EvidenceChange[] {
    const merged = new Map<string, EvidenceChange>();
    for (const item of items) {
        const key = JSON.stringify({
            action: item.action,
            target: item.target,
            behavior: item.behavior,
            exactSymbols: item.exactSymbols,
        });
        const existing = merged.get(key);
        if (existing) {
            existing.evidenceHunkIds = Array.from(new Set([...existing.evidenceHunkIds, ...item.evidenceHunkIds]));
        } else {
            merged.set(key, { ...item, evidenceHunkIds: [...item.evidenceHunkIds] });
        }
    }
    return Array.from(merged.values());
}

function mergeObservations(items: EvidenceObservation[]): EvidenceObservation[] {
    const merged = new Map<string, EvidenceObservation>();
    for (const item of items) {
        const existing = merged.get(item.detail);
        if (existing) {
            existing.evidenceHunkIds = Array.from(new Set([...existing.evidenceHunkIds, ...item.evidenceHunkIds]));
        } else {
            merged.set(item.detail, { ...item, evidenceHunkIds: [...item.evidenceHunkIds] });
        }
    }
    return Array.from(merged.values());
}
