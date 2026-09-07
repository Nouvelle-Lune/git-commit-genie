import * as path from 'path';
import { z } from 'zod';
import {
    AIFunctionTool,
    AIMessage,
    AIResponseFormat,
    AIRunResponse,
    AISession,
    AIToolCall,
    AIToolResult,
    AIUsage,
} from '../services/llm/providers';
import { estimateChatMessagesTokens } from '../services/llm/inputTokenBudget';
import { LLMExecution, RequestType } from '../services/llm/llmTypes';
import {
    classifyStructuredTermination,
    StructuredOutputTerminatedError,
} from '../services/llm/structuredCompletion';
import { buildStructuredFieldIssues } from '../services/llm/structuredFieldIssues';
import type { StructuredFailureKind, StructuredFieldIssue } from '../ui/pipelineDisplay';
import { EvidenceLedger } from './evidenceLedger';
import type { RepositoryEvidenceItem } from '../services/analysis/change/types';

/**
 * The two request shapes a run can be in.
 *
 * `investigation` turns carry the repository tools and no terminal format, so a
 * model is never asked to explore and to emit a large fixed JSON object in the
 * same breath. `finalization` turns close the tools and carry the response
 * format, so the terminal contract is the only thing left to satisfy.
 */
export type AgentStage = 'investigation' | 'finalization';

/** Reuses the presentation categories so diagnostics never need a lossy remap. */
export type AgentFailureCategory = StructuredFailureKind;

/** Runtime-owned control action that ends the investigation phase. */
export const FINISH_INVESTIGATION_TOOL = 'finishInvestigation';

const FINISH_INVESTIGATION_DEFINITION: AIFunctionTool = {
    name: FINISH_INVESTIGATION_TOOL,
    description: [
        'End repository investigation and move on to the final structured answer.',
        'Call this as soon as the planned questions are answered or are clearly unanswerable.',
        'It does not consume the repository tool budget, produces no evidence, and there is no reward for spending the remaining budget.',
    ].join(' '),
    parameters: {
        type: 'object',
        properties: {
            reason: {
                type: 'string',
                minLength: 1,
                description: 'One sentence on why the collected evidence is enough to answer.',
            },
        },
        required: ['reason'],
        additionalProperties: false,
    },
};

export interface AgentPromptLayers {
    /** Stable protocol text shared by every run of this profile version. */
    stable: AIMessage[];
    /** Immutable inputs for this run. They never change within an epoch. */
    opening: AIMessage[];
}

export interface AgentContextPolicy {
    maxSteps: number;
    maxEpochs: 0 | 1;
    maxObservationChars: number;
    buildCheckpoint(state: AgentRunState): AIMessage;
}

export interface ToolGrant {
    name: string;
    allowedRoot: string;
    excludePatterns: string[];
    maxResults?: number;
    maxLines?: number;
    maxDepth?: number;
    allocateEvidence: boolean;
}

export interface ToolExecutionContext<Input = unknown> {
    input: Input;
    grant: ToolGrant;
    ledger: EvidenceLedger;
    state: AgentRunState;
    signal?: AbortSignal;
    allocateEvidence(evidence: Omit<RepositoryEvidenceItem, 'id'>): RepositoryEvidenceItem;
}

export interface AgentToolDefinition<Input = unknown> {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** Idempotent lookups may reuse prior results while still consuming an agent step. */
    repeatable?: boolean;
    execute(
        context: ToolExecutionContext<Input>,
        args: Record<string, unknown>,
    ): Promise<AgentToolOutcome>;
}

export interface AgentToolOutcome {
    output: string;
    /** Structured results have already been bounded by the tool; slicing would corrupt their protocol. */
    preserveOutput?: boolean;
    ok?: boolean;
    summary?: string;
    evidenceCount?: number;
    sourceStatuses?: string[];
}

export interface AgentRuntimeIssue {
    type:
    | 'protocol_violation'
    | 'missing_structured_output'
    | 'schema_mismatch'
    | 'evidence_precondition'
    | 'output_exhausted'
    | 'provider_error'
    | 'invalid_reference'
    | 'duplicate_tool_call'
    | 'unknown_tool'
    | 'tool_rejected'
    | 'budget_exhausted'
    | 'context_compacted'
    | 'cancelled'
    | 'terminal_failure';
    message: string;
    step: number;
}

export interface AgentObservation {
    step: number;
    tool: string;
    arguments: Record<string, unknown>;
    rawOutput: string;
    output: string;
    outputTruncated: boolean;
    ok: boolean;
    summary?: string;
    evidenceCount?: number;
    sourceStatuses?: string[];
}

export interface AgentRunState {
    ledger: EvidenceLedger;
    observations: AgentObservation[];
    issues: AgentRuntimeIssue[];
    usages: AIUsage[];
    apiCalls: number;
    steps: number;
    epoch: number;
    stopReason: string;
}

/** Why the run left the investigation phase. */
export type FinalizationTrigger = 'finishTool' | 'budgetExhausted' | 'noBudget';

export type AgentRuntimeEvent =
    | { type: 'toolStart'; step: number; tool: string; args: Record<string, unknown> }
    | { type: 'toolComplete'; observation: AgentObservation }
    | {
        type: 'stageChanged';
        stage: AgentStage;
        profile: string;
        trigger: FinalizationTrigger;
        toolSteps: number;
        evidenceCount: number;
        reason: string | null;
    }
    | {
        type: 'retry';
        stage: AgentStage;
        profile: string;
        category: AgentFailureCategory;
        attempt: number;
        totalAttempts: number;
        finalFailure: boolean;
        message: string;
        fieldIssues: StructuredFieldIssue[];
    }
    | { type: 'contextCompacted'; epoch: number; estimatedTokens: number; reason: string }
    | { type: 'partialResult'; message: string };

/** A rejected request, described well enough for both the user and the model. */
export interface AgentTerminalFailure {
    stage: AgentStage;
    category: AgentFailureCategory;
    message: string;
    fieldIssues: StructuredFieldIssue[];
}

export interface AgentProfile<Input, RawFinal, Output> {
    id: string;
    promptVersion: string;
    toolsetVersion: string;
    requestType: RequestType;
    finalName: string;
    finalSchema: z.ZodType<RawFinal>;
    contextPolicy: AgentContextPolicy;
    /**
     * Investigation-phase layers. They describe the tool protocol only; the
     * terminal contract belongs to `buildFinalizationRequest`.
     */
    buildPrompt(input: Input): AgentPromptLayers;
    grantTools(input: Input): ToolGrant[];
    buildToolDefinitions(input: Input, state: AgentRunState): AgentToolDefinition<Input>[];
    /**
     * Refuses to leave the investigation phase while profile-required evidence
     * is missing. Checked when the control tool is called and again when the
     * tool budget runs out, because evidence cannot change afterwards.
     */
    validateFinalizationPrecondition?(state: AgentRunState): string | null;
    /** Complete terminal contract, sent once with the tools closed. */
    buildFinalizationRequest(input: Input, state: AgentRunState, reason: string | null): AIMessage[];
    /** Correction for a rejected turn, sent in the same session. */
    buildCorrectionRequest(input: Input, state: AgentRunState, failure: AgentTerminalFailure): AIMessage[];
    normalizeFinal(raw: RawFinal, state: AgentRunState): Output;
    preservePartialResult(state: AgentRunState, error: unknown): Output;
}

export interface AgentRunResult<Output> {
    output: Output;
    state: AgentRunState;
    status: 'complete' | 'partial';
    cacheIdentity: string;
    metrics: AgentRunMetrics;
}

export interface AgentRunMetrics {
    apiCalls: number;
    toolSteps: number;
    /** Investigation protocol corrections plus rejected terminal attempts. */
    terminalRetries: number;
    contextEpochs: number;
    invalidReferences: number;
    usage: AIUsage[];
    issues: AgentRuntimeIssue[];
}

export interface AgentRuntimeOptions {
    onEvent?: (event: AgentRuntimeEvent) => void;
    wrapSession?: (session: AISession) => AISession;
}

type ExecutableTool = AIFunctionTool & { repeatable?: boolean; execute(args: Record<string, unknown>): Promise<{ output: string; isError: boolean }> };

interface FinalizationTransition {
    trigger: FinalizationTrigger;
    reason: string | null;
}

function toSessionDelta(messages: AIMessage[]): AIMessage[] {
    return messages.filter(message => message.role !== 'system' && message.role !== 'developer');
}

/**
 * Provider-neutral runtime shared by repository-oriented profiles. The runtime
 * owns the investigation/finalization phase boundary, immutable tool contracts,
 * deterministic context epochs, and structured terminal repair; profiles own
 * semantics, prompts, and degradation.
 */
export class AgentRuntime {
    constructor(private readonly options: AgentRuntimeOptions = {}) { }

    async run<Input, RawFinal, Output>(
        execution: LLMExecution,
        profile: AgentProfile<Input, RawFinal, Output>,
        input: Input,
        ledger = new EvidenceLedger(),
    ): Promise<AgentRunResult<Output>> {
        const state: AgentRunState = {
            ledger,
            observations: [],
            issues: [],
            usages: [],
            apiCalls: 0,
            steps: 0,
            epoch: 0,
            stopReason: '',
        };
        validateContextPolicy(profile.contextPolicy);
        const prompt = profile.buildPrompt(input);
        const grants = profile.grantTools(input);
        const definitions = profile.buildToolDefinitions(input, state);
        const repositoryTools = this.resolveTools(
            definitions,
            grants,
            input,
            state,
            profile.contextPolicy.maxObservationChars,
            execution.signal,
        );
        const toolsByName = new Map(repositoryTools.map(tool => [tool.name, tool]));
        if (toolsByName.has(FINISH_INVESTIGATION_TOOL)) {
            throw new Error(
                `Agent profile '${profile.id}' granted the reserved control tool '${FINISH_INVESTIGATION_TOOL}'.`,
            );
        }
        // Declared once and reused verbatim on every turn so provider prompt
        // caches survive the phase change; only toolChoice narrows.
        const tools: AIFunctionTool[] = [
            ...repositoryTools.map(tool => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            })),
            FINISH_INVESTIGATION_DEFINITION,
        ];
        const responseFormat: AIResponseFormat = {
            name: profile.finalName,
            schema: z.toJSONSchema(profile.finalSchema) as Record<string, unknown>,
        };
        const cacheIdentity = this.cacheIdentity(profile, execution.model ?? 'configured-model');
        const stableMessages = [...prompt.stable, ...prompt.opening];
        let session = this.wrapSession(execution.createSession(stableMessages, cacheIdentity));
        let messages = stableMessages;
        let toolResults: AIToolResult[] | undefined;
        let epochOpening = prompt.opening;
        let epochObservationStart = 0;
        const seenCalls = new Set<string>();
        const maxSteps = profile.contextPolicy.maxSteps;
        const totalAttempts = execution.maxRetries + 1;
        const budgetExhaustedOutput = buildBudgetExhaustedToolOutput(profile.id, maxSteps);
        // Counted separately rather than as one shared budget: answering without
        // a tool call and ending before the evidence exists are different
        // mistakes, and a model that made one of each should still get a chance
        // to correct the second. Both are individually bounded, so the
        // investigation phase stays finite either way.
        let protocolAttempts = 0;
        let preconditionRejections = 0;

        try {
            // A zero budget has no investigation phase at all: there is nothing
            // the model could look up, so the precondition decides immediately.
            let transition: FinalizationTransition | undefined = maxSteps === 0
                ? { trigger: 'noBudget', reason: null }
                : undefined;

            while (!transition) {
                const prepared = this.prepareEpoch({
                    execution,
                    profile,
                    state,
                    prompt,
                    messages,
                    toolResults,
                    session,
                    cacheIdentity,
                    epochOpening,
                    epochObservationStart,
                });
                session = prepared.session;
                messages = prepared.messages;
                toolResults = prepared.toolResults;
                epochOpening = prepared.epochOpening;
                epochObservationStart = prepared.epochObservationStart;

                state.apiCalls += 1;
                const response = await session.run({
                    messages: toSessionDelta(messages),
                    toolResults,
                    tools,
                    toolChoice: 'auto',
                    temperature: execution.temperature,
                    maxOutputTokens: execution.maxOutputTokens,
                    signal: execution.signal,
                });
                if (response.usage) {
                    state.usages.push(response.usage);
                }
                messages = [];
                toolResults = undefined;

                if (!response.toolCalls.length) {
                    // Free-text or an early JSON object is no longer a terminal.
                    // Accepting one would skip the finalization contract that
                    // makes the compound answer verifiable.
                    protocolAttempts += 1;
                    const failure: AgentTerminalFailure = {
                        stage: 'investigation',
                        category: 'protocolViolation',
                        message: `Agent profile '${profile.id}' ended an investigation turn without calling a tool.`
                            + ` The investigation phase accepts only repository tool calls or '${FINISH_INVESTIGATION_TOOL}'.`,
                        fieldIssues: [],
                    };
                    this.reportFailure(state, profile, failure, protocolAttempts, totalAttempts);
                    if (protocolAttempts >= totalAttempts) {
                        throw new Error(failure.message);
                    }
                    messages = profile.buildCorrectionRequest(input, state, failure);
                    continue;
                }

                toolResults = [];
                let finished: FinalizationTransition | undefined;
                for (const call of response.toolCalls) {
                    if (finished) {
                        const message = `Investigation already ended through '${FINISH_INVESTIGATION_TOOL}'; '${call.name}' was not executed.`;
                        state.issues.push({ type: 'tool_rejected', message, step: state.steps });
                        toolResults.push({ callId: call.id, name: call.name, output: message, isError: true });
                        continue;
                    }
                    if (call.name === FINISH_INVESTIGATION_TOOL) {
                        const blocked = profile.validateFinalizationPrecondition?.(state) ?? null;
                        if (blocked) {
                            // Soft rejection: the control action costs no budget,
                            // so the model can gather the missing evidence and try
                            // again. It is counted separately because a model that
                            // keeps ending without evidence would otherwise loop
                            // forever, spending one paid turn per attempt.
                            preconditionRejections += 1;
                            this.reportFailure(
                                state,
                                profile,
                                { stage: 'investigation', category: 'evidencePrecondition', message: blocked, fieldIssues: [] },
                                preconditionRejections,
                                totalAttempts,
                            );
                            if (preconditionRejections >= totalAttempts) {
                                throw new Error(blocked);
                            }
                            toolResults.push({
                                callId: call.id,
                                name: call.name,
                                output: buildPreconditionRejectionOutput(blocked),
                                isError: true,
                            });
                            continue;
                        }
                        finished = { trigger: 'finishTool', reason: readFinishReason(call) };
                        toolResults.push({
                            callId: call.id,
                            name: call.name,
                            output: FINISH_ACCEPTED_OUTPUT,
                        });
                        continue;
                    }
                    if (state.steps >= maxSteps) {
                        // Providers require one tool_result per pending tool_use,
                        // so overflow calls are refused in-band instead of run.
                        recordBudgetExhausted(state, profile.id, maxSteps);
                        toolResults.push({
                            callId: call.id,
                            name: call.name,
                            output: budgetExhaustedOutput,
                            isError: true,
                        });
                        continue;
                    }
                    // Charged before the duplicate check on purpose: a repeated
                    // call is refused without running, but it still costs a step.
                    // That is what bounds the investigation loop when a model
                    // keeps re-issuing the same lookup instead of progressing.
                    state.steps += 1;
                    const callKey = canonicalToolCallKey(call);
                    if (seenCalls.has(callKey) && !toolsByName.get(call.name)?.repeatable) {
                        const message = `Duplicate tool call '${call.name}' was rejected.`;
                        state.issues.push({ type: 'duplicate_tool_call', message, step: state.steps });
                        toolResults.push({ callId: call.id, name: call.name, output: message, isError: true });
                        continue;
                    }
                    seenCalls.add(callKey);
                    this.options.onEvent?.({ type: 'toolStart', step: state.steps, tool: call.name, args: call.arguments });
                    toolResults.push(await this.executeToolCall(call, toolsByName, state));
                }

                if (finished) {
                    transition = finished;
                    break;
                }
                if (state.steps >= maxSteps) {
                    // The last permitted lookup has run. Finalize now rather than
                    // spending another paid turn waiting for an over-budget call.
                    recordBudgetExhausted(state, profile.id, maxSteps);
                    transition = { trigger: 'budgetExhausted', reason: null };
                }
            }

            if (transition.trigger !== 'finishTool') {
                const blocked = profile.validateFinalizationPrecondition?.(state) ?? null;
                if (blocked) {
                    this.reportFailure(
                        state,
                        profile,
                        { stage: 'investigation', category: 'evidencePrecondition', message: blocked, fieldIssues: [] },
                        1,
                        1,
                    );
                    throw new Error(blocked);
                }
            }

            this.options.onEvent?.({
                type: 'stageChanged',
                stage: 'finalization',
                profile: profile.id,
                trigger: transition.trigger,
                toolSteps: state.steps,
                evidenceCount: countRepositoryEvidence(state),
                reason: transition.reason,
            });

            // Last chance to compact: the finalization request is the largest of
            // the run because it carries every observation plus the contract.
            const prepared = this.prepareEpoch({
                execution,
                profile,
                state,
                prompt,
                messages,
                toolResults,
                session,
                cacheIdentity,
                epochOpening,
                epochObservationStart,
            });
            const raw = await this.finalize({
                execution,
                profile,
                input,
                state,
                session: prepared.session,
                tools,
                responseFormat,
                transition,
                pendingMessages: prepared.messages,
                pendingToolResults: prepared.toolResults,
            });
            state.stopReason = 'compound_terminal';
            return {
                output: profile.normalizeFinal(raw, state),
                state,
                status: 'complete',
                cacheIdentity,
                metrics: buildRunMetrics(state),
            };
        } catch (error) {
            const message = String((error as { message?: unknown })?.message ?? error);
            state.stopReason = message;
            if (execution.signal?.aborted || isAbortError(error)) {
                state.issues.push({ type: 'cancelled', message, step: state.steps });
                throw error;
            }
            if (!state.issues.some(issue => issue.message === message)) {
                state.issues.push({ type: 'terminal_failure', message, step: state.steps });
            }
            this.options.onEvent?.({ type: 'partialResult', message });
            return {
                output: profile.preservePartialResult(state, error),
                state,
                status: 'partial',
                cacheIdentity,
                metrics: buildRunMetrics(state),
            };
        }
    }

    /**
     * Runs the finalization phase. The first generation and every repair share
     * this loop, so termination reasons, tool-protocol violations, and schema
     * mismatches are classified identically on the first response and the last.
     */
    private async finalize<Input, RawFinal, Output>(params: {
        execution: LLMExecution;
        profile: AgentProfile<Input, RawFinal, Output>;
        input: Input;
        state: AgentRunState;
        session: AISession;
        tools: AIFunctionTool[];
        responseFormat: AIResponseFormat;
        transition: FinalizationTransition;
        pendingMessages: AIMessage[];
        pendingToolResults?: AIToolResult[];
    }): Promise<RawFinal> {
        const { execution, profile, input, state } = params;
        const totalAttempts = execution.maxRetries + 1;
        let delta = [
            ...params.pendingMessages,
            ...profile.buildFinalizationRequest(input, state, params.transition.reason),
        ];
        let pendingToolResults = params.pendingToolResults;

        for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
            state.apiCalls += 1;
            let response: AIRunResponse;
            try {
                response = await params.session.run({
                    messages: toSessionDelta(delta),
                    toolResults: pendingToolResults,
                    tools: params.tools,
                    responseFormat: params.responseFormat,
                    toolChoice: 'none',
                    temperature: execution.temperature,
                    maxOutputTokens: execution.maxOutputTokens,
                    signal: execution.signal,
                });
            } catch (error) {
                if (execution.signal?.aborted || isAbortError(error)) {
                    throw error;
                }
                this.reportFailure(state, profile, {
                    stage: 'finalization',
                    category: 'providerError',
                    message: String((error as { message?: unknown })?.message ?? error),
                    fieldIssues: [],
                }, attempt, totalAttempts, true);
                throw error;
            }
            pendingToolResults = undefined;
            if (response.usage) {
                state.usages.push(response.usage);
            }

            let failure: AgentTerminalFailure;
            if (response.toolCalls.length) {
                failure = {
                    stage: 'finalization',
                    category: 'protocolViolation',
                    message: `Agent profile '${profile.id}' requested ${response.toolCalls.length} tool call(s) after the tools were closed.`
                        + ' Repository investigation has already ended and cannot be reopened.',
                    fieldIssues: [],
                };
            } else if (response.structured === undefined) {
                const termination = classifyStructuredTermination(response);
                if (termination !== undefined) {
                    const terminated = new StructuredOutputTerminatedError(termination, response, profile.finalName);
                    this.reportFailure(state, profile, {
                        stage: 'finalization',
                        category: 'outputExhausted',
                        message: terminated.message,
                        fieldIssues: [],
                    }, attempt, totalAttempts, true);
                    throw terminated;
                }
                failure = {
                    stage: 'finalization',
                    category: 'missingOutput',
                    message: `Agent profile '${profile.id}' returned no JSON object for '${profile.finalName}'.`,
                    fieldIssues: [],
                };
            } else {
                const parsed = profile.finalSchema.safeParse(response.structured);
                if (parsed.success) {
                    return parsed.data;
                }
                failure = {
                    stage: 'finalization',
                    category: 'schemaMismatch',
                    message: `Terminal '${profile.finalName}' did not satisfy its schema.`,
                    fieldIssues: buildStructuredFieldIssues(parsed.error, response.structured),
                };
            }

            this.reportFailure(state, profile, failure, attempt, totalAttempts);
            if (attempt >= totalAttempts) {
                throw new Error(
                    `${failure.message} No attempt remained after ${totalAttempts} finalization attempt(s).`,
                );
            }
            delta = profile.buildCorrectionRequest(input, state, failure);
        }

        throw new Error(`Agent profile '${profile.id}' left the finalization loop without a terminal.`);
    }

    /** Records one rejected request in the run state and in the user-visible log stream. */
    private reportFailure<Input, RawFinal, Output>(
        state: AgentRunState,
        profile: AgentProfile<Input, RawFinal, Output>,
        failure: AgentTerminalFailure,
        attempt: number,
        totalAttempts: number,
        terminal = false,
    ): void {
        const finalFailure = terminal || attempt >= totalAttempts;
        state.issues.push({
            type: issueTypeForCategory(failure.category),
            message: failure.message,
            step: state.steps,
        });
        this.options.onEvent?.({
            type: 'retry',
            stage: failure.stage,
            profile: profile.id,
            category: failure.category,
            attempt,
            totalAttempts,
            finalFailure,
            message: failure.message,
            fieldIssues: failure.fieldIssues,
        });
    }

    private cacheIdentity<Input, RawFinal, Output>(
        profile: AgentProfile<Input, RawFinal, Output>,
        model: string,
    ): string {
        return `agent:${profile.id}:${profile.promptVersion}:${profile.toolsetVersion}:${model}`;
    }

    private resolveTools<Input>(
        definitions: AgentToolDefinition<Input>[],
        grants: ToolGrant[],
        input: Input,
        state: AgentRunState,
        maxObservationChars: number,
        signal?: AbortSignal,
    ): ExecutableTool[] {
        const definitionByName = new Map(definitions.map(definition => [definition.name, definition]));
        if (definitionByName.size !== definitions.length) {
            throw new Error('Agent profile registered duplicate tool names.');
        }
        return grants.map(grant => {
            const definition = definitionByName.get(grant.name);
            if (!definition) {
                throw new Error(`Agent profile granted unregistered tool '${grant.name}'.`);
            }
            return {
                name: definition.name,
                repeatable: definition.repeatable,
                description: definition.description,
                parameters: definition.parameters,
                execute: async (args: Record<string, unknown>) => {
                    validateToolGrant(grant, args);
                    const outcome = await definition.execute({
                        input,
                        grant,
                        ledger: state.ledger,
                        state,
                        signal,
                        allocateEvidence: evidence => {
                            if (!grant.allocateEvidence) {
                                throw new Error(`Tool '${grant.name}' is not allowed to allocate evidence.`);
                            }
                            return state.ledger.allocateRepositoryEvidence(evidence);
                        },
                    }, args);
                    const rawOutput = outcome.output;
                    const output = outcome.preserveOutput ? rawOutput : truncateObservation(rawOutput, maxObservationChars);
                    const observation: AgentObservation = {
                        step: state.steps,
                        tool: definition.name,
                        arguments: args,
                        rawOutput,
                        output,
                        outputTruncated: output !== rawOutput,
                        ok: outcome.ok !== false,
                        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
                        ...(outcome.evidenceCount !== undefined ? { evidenceCount: outcome.evidenceCount } : {}),
                        ...(outcome.sourceStatuses !== undefined ? { sourceStatuses: outcome.sourceStatuses } : {}),
                    };
                    state.observations.push(observation);
                    this.options.onEvent?.({ type: 'toolComplete', observation });
                    return { output, isError: outcome.ok === false };
                },
            };
        });
    }

    private prepareEpoch<Input, RawFinal, Output>(params: {
        execution: LLMExecution;
        profile: AgentProfile<Input, RawFinal, Output>;
        state: AgentRunState;
        prompt: AgentPromptLayers;
        messages: AIMessage[];
        toolResults?: AIToolResult[];
        session: AISession;
        cacheIdentity: string;
        epochOpening: AIMessage[];
        epochObservationStart: number;
    }): {
        session: AISession;
        messages: AIMessage[];
        toolResults?: AIToolResult[];
        epochOpening: AIMessage[];
        epochObservationStart: number;
    } {
        const budgetMessages: AIMessage[] = [
            ...params.prompt.stable,
            ...params.epochOpening,
            ...params.state.observations.slice(params.epochObservationStart).flatMap(observation => ([
                {
                    role: 'assistant' as const,
                    content: JSON.stringify({
                        tool: observation.tool,
                        arguments: observation.arguments,
                    }),
                },
                { role: 'user' as const, content: observation.output },
            ])),
        ];
        const estimatedTokens = estimateChatMessagesTokens(budgetMessages);
        if (estimatedTokens <= params.execution.tokenBudget.compressionTriggerTokens) {
            return {
                session: params.session,
                messages: params.messages,
                toolResults: params.toolResults,
                epochOpening: params.epochOpening,
                epochObservationStart: params.epochObservationStart,
            };
        }
        if (params.state.epoch >= params.profile.contextPolicy.maxEpochs) {
            throw new Error(
                `Agent profile '${params.profile.id}' exceeded its context budget after ${params.state.epoch} compaction epoch(s).`,
            );
        }

        params.state.epoch += 1;
        const reason = `Estimated input ${estimatedTokens} exceeded compression trigger ${params.execution.tokenBudget.compressionTriggerTokens}.`;
        params.state.issues.push({ type: 'context_compacted', message: reason, step: params.state.steps });
        this.options.onEvent?.({ type: 'contextCompacted', epoch: params.state.epoch, estimatedTokens, reason });
        const checkpoint = params.profile.contextPolicy.buildCheckpoint(params.state);
        const epochMessages = [...params.prompt.stable, checkpoint];
        return {
            session: this.wrapSession(params.execution.createSession(epochMessages, params.cacheIdentity)),
            messages: epochMessages,
            toolResults: undefined,
            epochOpening: [checkpoint],
            epochObservationStart: params.state.observations.length,
        };
    }

    private wrapSession(session: AISession): AISession {
        return this.options.wrapSession?.(session) ?? session;
    }

    private async executeToolCall(
        call: AIToolCall,
        tools: Map<string, ExecutableTool>,
        state: AgentRunState,
    ): Promise<AIToolResult> {
        const tool = tools.get(call.name);
        if (!tool) {
            const message = `Agent requested unknown tool '${call.name}'.`;
            state.issues.push({ type: 'unknown_tool', message, step: state.steps });
            throw new Error(message);
        }
        try {
            return { callId: call.id, name: call.name, ...await tool.execute(call.arguments) };
        } catch (error) {
            if (!(error instanceof ToolGrantViolationError)) {
                throw error;
            }
            const message = error.message;
            state.issues.push({ type: 'tool_rejected', message, step: state.steps });
            const observation: AgentObservation = {
                step: state.steps,
                tool: call.name,
                arguments: call.arguments,
                rawOutput: message,
                output: message,
                outputTruncated: false,
                ok: false,
                summary: message,
                evidenceCount: 0,
            };
            state.observations.push(observation);
            this.options.onEvent?.({ type: 'toolComplete', observation });
            return { callId: call.id, name: call.name, output: message, isError: true };
        }
    }
}

const TERMINAL_RETRY_ISSUES = new Set<AgentRuntimeIssue['type']>([
    'protocol_violation',
    'missing_structured_output',
    'schema_mismatch',
    'evidence_precondition',
]);

function issueTypeForCategory(category: AgentFailureCategory): AgentRuntimeIssue['type'] {
    switch (category) {
        case 'protocolViolation':
            return 'protocol_violation';
        case 'missingOutput':
            return 'missing_structured_output';
        case 'schemaMismatch':
            return 'schema_mismatch';
        case 'evidencePrecondition':
            return 'evidence_precondition';
        case 'outputExhausted':
            return 'output_exhausted';
        case 'providerError':
            return 'provider_error';
    }
}

function buildRunMetrics(state: AgentRunState): AgentRunMetrics {
    return {
        apiCalls: state.apiCalls,
        toolSteps: state.steps,
        terminalRetries: state.issues.filter(issue => TERMINAL_RETRY_ISSUES.has(issue.type)).length,
        contextEpochs: state.epoch,
        invalidReferences: state.issues.filter(issue => issue.type === 'invalid_reference').length,
        usage: [...state.usages],
        issues: state.issues.map(issue => ({ ...issue })),
    };
}

const FINISH_ACCEPTED_OUTPUT = [
    '<investigation_closed>',
    'Repository investigation is closed and every tool is now unavailable.',
    'The next message states the required terminal contract. Answer it with exactly one JSON object.',
    '</investigation_closed>',
].join('\n');

/** Stable tool_result body used when the control tool is refused. */
function buildPreconditionRejectionOutput(reason: string): string {
    return [
        '<finish_rejected>',
        reason,
        'The investigation is still open and this control call consumed none of the tool budget.',
        'Call the evidence-producing repository tools needed to satisfy this requirement, then end the investigation again.',
        '</finish_rejected>',
    ].join('\n');
}

/** Stable tool_result body used when a call is refused after the step budget is spent. */
function buildBudgetExhaustedToolOutput(profileId: string, maxSteps: number): string {
    return [
        '<budget_exhausted>',
        `Agent profile '${profileId}' exhausted its ${maxSteps} tool-step budget.`,
        'This call was not executed and no further tool call is possible.',
        'Repository investigation is closed; answer the terminal contract with the evidence already collected.',
        '</budget_exhausted>',
    ].join('\n');
}

function recordBudgetExhausted(state: AgentRunState, profileId: string, maxSteps: number): void {
    if (state.issues.some(issue => issue.type === 'budget_exhausted')) {
        return;
    }
    state.issues.push({
        type: 'budget_exhausted',
        message: `Agent profile '${profileId}' exhausted its ${maxSteps} tool-step budget.`,
        step: state.steps,
    });
}

function countRepositoryEvidence(state: AgentRunState): number {
    return state.ledger.snapshot().filter(entry => entry.source === 'repository').length;
}

function readFinishReason(call: AIToolCall): string | null {
    const reason = call.arguments.reason;
    return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}

function canonicalToolCallKey(call: AIToolCall): string {
    const semanticArguments = Object.fromEntries(
        Object.entries(call.arguments)
            .filter(([key]) => key !== 'reason')
            .sort(([left], [right]) => left.localeCompare(right)),
    );
    return JSON.stringify([call.name, semanticArguments]);
}

function validateContextPolicy(policy: AgentContextPolicy): void {
    if (!Number.isInteger(policy.maxSteps) || policy.maxSteps < 0) {
        throw new Error(`Agent maxSteps must be a non-negative integer; received ${policy.maxSteps}.`);
    }
    if (!Number.isInteger(policy.maxObservationChars) || policy.maxObservationChars <= 0) {
        throw new Error(
            `Agent maxObservationChars must be a positive integer; received ${policy.maxObservationChars}.`,
        );
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'Canceled');
}

function truncateObservation(output: string, maxChars: number): string {
    return output.length <= maxChars
        ? output
        : `${output.slice(0, Math.max(1, maxChars - 43))}\n[tool output truncated by runtime policy]`;
}

function validateToolGrant(grant: ToolGrant, args: Record<string, unknown>): void {
    for (const key of ['filePath', 'dirPath', 'searchPath']) {
        const candidate = args[key];
        if (typeof candidate !== 'string' || !candidate.trim()) {
            continue;
        }
        const root = path.resolve(grant.allowedRoot);
        const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
        const relative = path.relative(root, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new ToolGrantViolationError(
                `Tool '${grant.name}' cannot access path outside '${grant.allowedRoot}': ${candidate}`,
            );
        }
    }
    enforceMaximum(grant.name, 'maxResults', args.maxResults, grant.maxResults);
    enforceMaximum(grant.name, 'maxLines', args.maxLines, grant.maxLines);
    enforceMaximum(grant.name, 'depth', args.depth, grant.maxDepth);
}

function enforceMaximum(tool: string, field: string, value: unknown, maximum: number | undefined): void {
    if (maximum === undefined || value === null || value === undefined) {
        return;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) {
        throw new ToolGrantViolationError(
            `Tool '${tool}' argument '${field}' exceeds its grant limit (${maximum}).`,
        );
    }
}

/** Identifies a denied tool call that the model may correct without ending the run. */
class ToolGrantViolationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolGrantViolationError';
    }
}
