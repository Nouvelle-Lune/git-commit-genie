// Stages 2 and 3: Investigation Planning and Repository Investigation.
//
// The planner turns "what changed" into "what must still be known". The agent
// then answers those questions with real repository lookups and stops as soon
// as the primary behavioral change is explainable — the stop condition is what
// keeps this from drifting back into a repository summary.

import { LLMExecution } from '../../../llm/llmTypes';
import { AIMessage } from '../../../llm/providers';
import { z } from 'zod';
import { estimateChatMessagesTokens } from '../../../llm/inputTokenBudget';
import { AgentTool, runAgentLoop } from '../../../../agent';
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
import { investigationFinalResponseSchema } from '../../../llm/providers/schemas/common';

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
    execution: LLMExecution,
    repositoryTerminology?: RepositoryAnalysisContext
): Promise<InvestigationPlan> {
    const messages = buildInvestigationPlanMessages({ changeExtraction: extraction, repositoryTerminology });
    const session = execution.createSession(messages);
    const parsed = await execution.run<InvestigationPlan>(session, messages, { requestType: 'investigationPlan' });

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

function normalizeToolCall(tool: InvestigationToolCall['tool'], args: Record<string, unknown>): InvestigationToolCall {
    return {
        tool,
        symbol: typeof args.symbol === 'string' ? args.symbol : null,
        filePath: typeof args.filePath === 'string' ? args.filePath : null,
        dirPath: typeof args.dirPath === 'string' ? args.dirPath : null,
        query: typeof args.query === 'string' ? args.query : null,
        searchType: args.searchType === 'name' || args.searchType === 'content' ? args.searchType : null,
        useRegex: typeof args.useRegex === 'boolean' ? args.useRegex : null,
        startLine: typeof args.startLine === 'number' ? args.startLine : null,
        maxLines: typeof args.maxLines === 'number' ? args.maxLines : null,
        maxResults: typeof args.maxResults === 'number' ? args.maxResults : null,
    };
}

const INVESTIGATION_TOOL_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        reason: { type: 'string' },
        symbol: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        filePath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        dirPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        query: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        searchType: { anyOf: [{ enum: ['name', 'content'] }, { type: 'null' }] },
        useRegex: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        startLine: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        maxLines: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        maxResults: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    },
    required: ['reason', 'symbol', 'filePath', 'dirPath', 'query', 'searchType', 'useRegex', 'startLine', 'maxLines', 'maxResults'],
    additionalProperties: false,
};

export interface ChangeAnalysisAgentParams {
    extraction: ChangeExtraction;
    plan: InvestigationPlan;
    repositoryPath: string;
    excludePatterns: string[];
    execution: LLMExecution;
    maxSteps: number;
    maxInputTokens: number;
    onStep?: (event: InvestigationStepEvent) => void;
}

export async function runChangeAnalysisAgent(params: ChangeAnalysisAgentParams): Promise<RepositoryEvidence> {
    const {
        extraction, plan, repositoryPath, excludePatterns,
        execution, maxSteps, maxInputTokens, onStep,
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

    const messages: AIMessage[] = [
        buildInvestigationSystemMessage(),
        buildInvestigationOpeningMessage({ changeExtraction: extraction, plan, stepBudget: maxSteps }),
    ];
    const openingTokens = estimateChatMessagesTokens(messages);
    if (openingTokens > maxInputTokens) {
        throw new Error(`Investigation opening context requires approximately ${openingTokens} tokens, exceeding ${maxInputTokens}.`);
    }

    let toolSteps = 0;
    const seenCalls = new Set<string>();
    const sessionId = `change-investigation:${repositoryPath}:${Date.now()}`;
    const tools: AgentTool[] = CHANGE_ANALYSIS_TOOL_NAMES.map(toolName => ({
        name: toolName,
        description: `Investigate the changed repository using ${toolName}. Set unused arguments to null.`,
        parameters: INVESTIGATION_TOOL_PARAMETERS,
        execute: async argumentsValue => {
            const call = normalizeToolCall(toolName, argumentsValue);
            const callKey = JSON.stringify(call);
            if (seenCalls.has(callKey)) {
                return 'This exact tool call already ran. Use different arguments or finish the investigation.';
            }
            seenCalls.add(callKey);
            toolSteps += 1;
            const outcome = await runInvestigationTool(context, call);
            evidenceItems.push(...outcome.evidence);
            onStep?.({
                step: toolSteps,
                tool: call.tool,
                reason: String(argumentsValue.reason || '').trim(),
                summary: outcome.summary,
                ok: outcome.ok,
                evidenceCount: outcome.evidence.length,
            });
            return buildInvestigationToolResultMessage({
                tool: call.tool,
                summary: outcome.summary,
                evidence: outcome.evidence,
                remainingSteps: maxSteps - toolSteps,
                openQuestions,
            }).content;
        },
    }));
    const session = execution.createSession(messages, sessionId);
    const result = await runAgentLoop(session, messages, tools, {
        maxSteps,
        responseFormat: {
            name: 'investigationFinal',
            schema: z.toJSONSchema(investigationFinalResponseSchema) as Record<string, unknown>,
        },
        schema: investigationFinalResponseSchema,
        maxRetries: execution.maxRetries,
        temperature: execution.temperature,
        maxOutputTokens: execution.maxOutputTokens,
        signal: execution.signal,
    });
    const final = investigationFinalResponseSchema.parse(result.structured);
    const findings: InvestigationFinding[] = final.findings.map(finding => ({
        target: finding.target,
        question: finding.question,
        answer: finding.answer,
        evidenceRefs: dedupeStrings(finding.evidenceRefs),
    }));
    return {
        items: evidenceItems,
        findings,
        unresolvedQuestions: dedupeStrings(final.unresolvedQuestions),
        stopReason: final.stopReason.trim(),
        steps: toolSteps,
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
