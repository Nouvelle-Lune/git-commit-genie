// Stages 2 and 3: Investigation Planning and Repository Investigation.
//
// The planner turns "what changed" into "what must still be known". The agent
// then answers those questions with real repository lookups and stops as soon
// as the primary behavioral change is explainable — the stop condition is what
// keeps this from drifting back into a repository summary.

import { ChatFn, ChatMessage } from '../../../llm/llmTypes';
import { z } from 'zod';
import { estimateChatMessagesTokens } from '../../../llm/inputTokenBudget';
import {
    buildInvestigationOpeningMessage,
    buildInvestigationPlanMessages,
    buildInvestigationSystemMessage,
    buildInvestigationToolResultMessage,
} from '../prompts';
import {
    CHANGE_ANALYSIS_TOOL_NAMES,
    InvestigationToolCall,
    InvestigationToolContext,
    InvestigationToolName,
    runInvestigationTool,
} from './tools';
import {
    ChangeExtraction,
    InvestigationFinding,
    InvestigationPlan,
    InvestigationTarget,
    RepositoryEvidence,
    RepositoryEvidenceItem,
    RepositoryAnalysisContext,
} from '../types';
import { investigationActionSchema } from '../../../llm/providers/schemas/common';

const MAX_TARGETS = 3;
const MAX_QUESTIONS_PER_TARGET = 2;

export interface InvestigationStepEvent {
    step: number;
    tool: string;
    reason: string;
    summary: string;
    ok: boolean;
    evidenceCount: number;
}

function dedupeStrings(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return Array.from(new Set(
        values
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map(value => value.trim())
    ));
}

/**
 * Names the change actually touched. Planner targets are intersected with this
 * set so the investigation cannot be redirected onto an unrelated part of the
 * repository that merely sounds relevant.
 */
function collectGroundedNames(extraction: ChangeExtraction): Set<string> {
    return new Set([
        ...extraction.changedSymbols.map(symbol => symbol.name),
        ...extraction.introducedSymbols,
        ...extraction.removedSymbols,
        ...extraction.changedCalls,
        ...extraction.changedConfigs,
        ...extraction.changedTypes,
        ...extraction.changedDependencies,
    ]);
}

/**
 * Returns true when the diff alone already determines the change's meaning, so
 * repository investigation would only add cost. Documentation, lockfile, and
 * pure-formatting changes have no code path to trace.
 */
export function isInvestigationWorthwhile(extraction: ChangeExtraction): boolean {
    const hasCodeTarget = extraction.changedSymbols.length > 0
        || extraction.changedConfigs.length > 0
        || extraction.changedTypes.length > 0
        || extraction.changedDependencies.length > 0
        || extraction.changedCalls.length > 0;
    return hasCodeTarget;
}

export async function planInvestigation(
    extraction: ChangeExtraction,
    chat: ChatFn,
    repositoryTerminology?: RepositoryAnalysisContext
): Promise<InvestigationPlan> {
    const messages = buildInvestigationPlanMessages({ changeExtraction: extraction, repositoryTerminology });
    const parsed = await chat(messages, { requestType: 'investigationPlan' }) as InvestigationPlan;

    const grounded = collectGroundedNames(extraction);
    const targets: InvestigationTarget[] = [];
    for (const candidate of parsed.targets) {
        const name = candidate.target.trim();
        if (!name || !grounded.has(name)) {
            continue;
        }
        if (targets.some(existing => existing.target === name)) {
            continue;
        }
        const kind = candidate.kind;
        const questions = dedupeStrings(candidate.questions).slice(0, MAX_QUESTIONS_PER_TARGET);
        targets.push({
            target: name,
            kind,
            file: candidate.file,
            questions,
        });
        if (targets.length >= MAX_TARGETS) {
            break;
        }
    }

    return { targets, notes: parsed.notes };
}

type InvestigationAction = z.infer<typeof investigationActionSchema>;

function normalizeToolCall(action: InvestigationAction): InvestigationToolCall {
    const tool = action.tool as InvestigationToolName | null;
    if (tool === null || !CHANGE_ANALYSIS_TOOL_NAMES.includes(tool)) {
        throw new Error('Investigation tool action did not include a valid tool.');
    }
    return {
        tool,
        symbol: action.symbol,
        filePath: action.filePath,
        dirPath: action.dirPath,
        query: action.query,
        searchType: action.searchType,
        useRegex: action.useRegex,
        startLine: action.startLine,
        maxLines: action.maxLines,
        maxResults: action.maxResults,
    };
}

/**
 * Keeps the agent conversation inside the configured input budget by dropping
 * the oldest tool exchanges. The system prompt, the change extraction, and the
 * plan are pinned: losing them would let the agent forget what it is
 * investigating, which is worse than losing an old tool result that has already
 * been recorded as evidence.
 */
function trimConversation(messages: ChatMessage[], maxInputTokens: number): ChatMessage[] {
    const pinnedCount = 2; // system + opening
    let trimmed = messages;
    while (
        estimateChatMessagesTokens(trimmed) > maxInputTokens
        && trimmed.length > pinnedCount + 1
    ) {
        trimmed = [...trimmed.slice(0, pinnedCount), ...trimmed.slice(pinnedCount + 1)];
    }
    return trimmed;
}

export interface ChangeAnalysisAgentParams {
    extraction: ChangeExtraction;
    plan: InvestigationPlan;
    repositoryPath: string;
    excludePatterns: string[];
    chat: ChatFn;
    maxSteps: number;
    maxInputTokens: number;
    onStep?: (event: InvestigationStepEvent) => void;
}

export async function runChangeAnalysisAgent(params: ChangeAnalysisAgentParams): Promise<RepositoryEvidence> {
    const {
        extraction, plan, repositoryPath, excludePatterns,
        chat, maxSteps, maxInputTokens, onStep,
    } = params;

    const evidenceItems: RepositoryEvidenceItem[] = [];
    let evidenceCounter = 0;
    const context: InvestigationToolContext = {
        repositoryPath,
        excludePatterns,
        changedSymbols: extraction.changedSymbols.map(symbol => ({
            name: symbol.name,
            file: symbol.file,
            symbolType: symbol.symbolType,
            changeKind: symbol.changeKind,
        })),
        nextEvidenceId: () => {
            evidenceCounter += 1;
            return `E${evidenceCounter}`;
        },
    };

    const openQuestions = plan.targets.flatMap(target =>
        target.questions.map(question => `${target.target}: ${question}`)
    );

    let messages: ChatMessage[] = [
        buildInvestigationSystemMessage(),
        buildInvestigationOpeningMessage({ changeExtraction: extraction, plan, stepBudget: maxSteps }),
    ];

    let steps = 0;
    // Repeated identical calls indicate the agent is stuck rather than
    // converging; the loop stops instead of burning the remaining budget.
    const seenCalls = new Set<string>();
    const sessionId = `change-investigation:${repositoryPath}:${Date.now()}`;

    while (steps < maxSteps) {
        messages = trimConversation(messages, maxInputTokens);
        const action = await chat(messages, { requestType: 'investigationAction', sessionId }) as InvestigationAction;

        if (action.action === 'final') {
            if (!action.final) {
                throw new Error('Investigation final action did not include final findings.');
            }
            const findings: InvestigationFinding[] = action.final.findings
                .map(finding => ({
                    target: finding.target,
                    question: finding.question,
                    answer: finding.answer,
                    evidenceRefs: dedupeStrings(finding.evidenceRefs),
                }));
            return {
                items: evidenceItems,
                findings,
                unresolvedQuestions: dedupeStrings(action.final.unresolvedQuestions),
                stopReason: action.final.stopReason.trim(),
                steps,
                degraded: false,
            };
        }

        const call = normalizeToolCall(action);

        const callKey = JSON.stringify(call);
        if (seenCalls.has(callKey)) {
            messages.push({
                role: 'user',
                content: [
                    '<tool_result>',
                    'That call was already made and returned the result above. Ask a different',
                    'question or finalize with the evidence you already hold.',
                    '</tool_result>',
                ].join('\n'),
            });
            steps += 1;
            continue;
        }
        seenCalls.add(callKey);

        steps += 1;
        const outcome = await runInvestigationTool(context, call);
        evidenceItems.push(...outcome.evidence);
        onStep?.({
            step: steps,
            tool: call.tool,
            reason: action.reason!.trim(),
            summary: outcome.summary,
            ok: outcome.ok,
            evidenceCount: outcome.evidence.length,
        });

        messages.push(buildInvestigationToolResultMessage({
            tool: call.tool,
            summary: outcome.ok ? outcome.summary : `${outcome.summary}`,
            evidence: outcome.evidence,
            remainingSteps: maxSteps - steps,
            openQuestions,
        }));
    }

    // The budget ran out before the agent declared completion. Whatever was
    // retrieved is still valid evidence, so the run is reported as complete with
    // an honest stop reason rather than discarded.
    return {
        items: evidenceItems,
        findings: [],
        unresolvedQuestions: openQuestions,
        stopReason: `The investigation step budget (${maxSteps}) was exhausted before the agent finalized.`,
        steps,
        degraded: false,
    };
}

export function emptyRepositoryEvidence(reason: string): RepositoryEvidence {
    return {
        items: [],
        findings: [],
        unresolvedQuestions: [],
        stopReason: reason,
        steps: 0,
        degraded: true,
    };
}
