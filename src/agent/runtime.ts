import * as path from 'path';
import { z } from 'zod';
import {
    AIFunctionTool,
    AIMessage,
    AIResponseFormat,
    AISession,
    AIThinkingConfig,
    AIToolCall,
    AIToolResult,
    AIUsage,
} from '../services/llm/providers';
import { estimateChatMessagesTokens } from '../services/llm/inputTokenBudget';
import { LLMExecution, RequestType } from '../services/llm/llmTypes';
import { runStructuredCompletion } from '../services/llm/structuredCompletion';
import { EvidenceLedger } from './evidenceLedger';
import type { RepositoryEvidenceItem } from '../services/analysis/change/types';

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
    execute(
        context: ToolExecutionContext<Input>,
        args: Record<string, unknown>,
    ): Promise<AgentToolOutcome>;
}

export interface AgentToolOutcome {
    output: string;
    ok?: boolean;
}

export interface AgentRuntimeIssue {
    type:
        | 'schema_retry'
        | 'terminal_retry'
        | 'invalid_reference'
        | 'duplicate_tool_call'
        | 'unknown_tool'
        | 'max_steps'
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
    output: string;
    ok: boolean;
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

export type AgentRuntimeEvent =
    | { type: 'toolStart'; step: number; tool: string; args: Record<string, unknown> }
    | { type: 'toolComplete'; observation: AgentObservation }
    | { type: 'schemaRetry'; attempt: number; message: string }
    | { type: 'terminalRetry'; attempt: number; message: string }
    | { type: 'contextCompacted'; epoch: number; estimatedTokens: number; reason: string }
    | { type: 'partialResult'; message: string };

export interface AgentProfile<Input, RawFinal, Output> {
    id: string;
    promptVersion: string;
    toolsetVersion: string;
    requestType: RequestType;
    finalName: string;
    finalSchema: z.ZodType<RawFinal>;
    contextPolicy: AgentContextPolicy;
    buildPrompt(input: Input): AgentPromptLayers;
    grantTools(input: Input): ToolGrant[];
    buildToolDefinitions(input: Input, state: AgentRunState): AgentToolDefinition<Input>[];
    /** Rejects a structurally valid terminal when profile-specific work is incomplete. */
    validateTerminal?(raw: RawFinal, state: AgentRunState): string | null;
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
    schemaRetries: number;
    contextEpochs: number;
    invalidReferences: number;
    usage: AIUsage[];
    issues: AgentRuntimeIssue[];
}

export interface AgentRuntimeOptions {
    onEvent?: (event: AgentRuntimeEvent) => void;
    wrapSession?: (session: AISession) => AISession;
}

function toSessionDelta(messages: AIMessage[]): AIMessage[] {
    return messages.filter(message => message.role !== 'system' && message.role !== 'developer');
}

/**
 * Provider-neutral runtime shared by repository-oriented profiles. The runtime
 * owns continuation, immutable tool contracts, deterministic context epochs,
 * and structured terminal repair; profiles own semantics and degradation.
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
        const tools = this.resolveTools(
            definitions,
            grants,
            input,
            state,
            profile.contextPolicy.maxObservationChars,
            execution.signal,
        );
        const toolsByName = new Map(tools.map(tool => [tool.name, tool]));
        const responseFormat: AIResponseFormat = {
            name: profile.finalName,
            schema: z.toJSONSchema(profile.finalSchema) as Record<string, unknown>,
        };
        const thinking = execution.thinkingFor(profile.requestType);
        const cacheIdentity = this.cacheIdentity(profile, execution.model ?? 'configured-model');
        const stableMessages = [...prompt.stable, ...prompt.opening];
        let session = this.wrapSession(execution.createSession(stableMessages, cacheIdentity));
        let messages = stableMessages;
        let toolResults: AIToolResult[] | undefined;
        let epochOpening = prompt.opening;
        let epochObservationStart = 0;
        let terminalValidationRetries = 0;
        const seenCalls = new Set<string>();

        try {
            while (state.steps <= profile.contextPolicy.maxSteps) {
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
                    responseFormat,
                    toolChoice: tools.length ? 'auto' : 'none',
                    temperature: execution.temperature,
                    maxOutputTokens: execution.maxOutputTokens,
                    thinking,
                    signal: execution.signal,
                });
                if (response.usage) {
                    state.usages.push(response.usage);
                }
                messages = [];
                toolResults = undefined;

                if (!response.toolCalls.length) {
                    const raw = await this.parseTerminal({
                        responseStructured: response.structured,
                        session,
                        profile,
                        responseFormat,
                        thinking,
                        execution,
                        state,
                    });
                    const terminalValidationError = profile.validateTerminal?.(raw, state) ?? null;
                    if (terminalValidationError) {
                        if (terminalValidationRetries >= execution.maxRetries) {
                            const message = `Compound terminal for '${profile.id}' remained invalid after ${terminalValidationRetries} profile retry attempt(s): ${terminalValidationError}`;
                            state.issues.push({ type: 'terminal_failure', message, step: state.steps });
                            throw new Error(message);
                        }
                        terminalValidationRetries += 1;
                        const message = `Retrying compound terminal for '${profile.id}' after profile validation failed: ${terminalValidationError}`;
                        state.issues.push({ type: 'terminal_retry', message, step: state.steps });
                        this.options.onEvent?.({
                            type: 'terminalRetry',
                            attempt: terminalValidationRetries,
                            message,
                        });
                        messages = [{
                            role: 'user',
                            content: [
                                '<terminal_rejected>',
                                terminalValidationError,
                                'Continue the same run and call the granted repository tools needed to satisfy this requirement before returning the terminal again.',
                                '</terminal_rejected>',
                            ].join('\n'),
                        }];
                        toolResults = undefined;
                        continue;
                    }
                    state.stopReason = 'compound_terminal';
                    return {
                        output: profile.normalizeFinal(raw, state),
                        state,
                        status: 'complete',
                        cacheIdentity,
                        metrics: buildRunMetrics(state),
                    };
                }

                if (state.steps === profile.contextPolicy.maxSteps) {
                    const message = `Agent profile '${profile.id}' exhausted its ${profile.contextPolicy.maxSteps} tool-step budget.`;
                    state.issues.push({ type: 'max_steps', message, step: state.steps });
                    throw new Error(message);
                }

                toolResults = [];
                for (const call of response.toolCalls) {
                    if (state.steps >= profile.contextPolicy.maxSteps) {
                        const message = `Agent profile '${profile.id}' exhausted its ${profile.contextPolicy.maxSteps} tool-step budget.`;
                        state.issues.push({ type: 'max_steps', message, step: state.steps });
                        throw new Error(message);
                    }
                    state.steps += 1;
                    const callKey = canonicalToolCallKey(call);
                    if (seenCalls.has(callKey)) {
                        const message = `Duplicate tool call '${call.name}' was rejected.`;
                        state.issues.push({ type: 'duplicate_tool_call', message, step: state.steps });
                        toolResults.push({ callId: call.id, name: call.name, output: message, isError: true });
                        continue;
                    }
                    seenCalls.add(callKey);
                    this.options.onEvent?.({ type: 'toolStart', step: state.steps, tool: call.name, args: call.arguments });
                    toolResults.push(await this.executeToolCall(call, toolsByName, state));
                }
            }
            throw new Error(`Agent profile '${profile.id}' exited without a compound terminal.`);
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
    ): Array<AIFunctionTool & { execute(args: Record<string, unknown>): Promise<string> }> {
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
                description: definition.description,
                parameters: definition.parameters,
                execute: async args => {
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
                    const output = truncateObservation(outcome.output, maxObservationChars);
                    const observation: AgentObservation = {
                        step: state.steps,
                        tool: definition.name,
                        arguments: args,
                        output,
                        ok: outcome.ok !== false,
                    };
                    state.observations.push(observation);
                    this.options.onEvent?.({ type: 'toolComplete', observation });
                    return output;
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

    private async parseTerminal<Input, RawFinal, Output>(params: {
        responseStructured: unknown;
        session: AISession;
        profile: AgentProfile<Input, RawFinal, Output>;
        responseFormat: AIResponseFormat;
        thinking: AIThinkingConfig;
        execution: LLMExecution;
        state: AgentRunState;
    }): Promise<RawFinal> {
        const first = params.profile.finalSchema.safeParse(params.responseStructured);
        if (first.success) {
            return first.data;
        }
        if (params.execution.maxRetries === 0) {
            throw new Error(
                `Compound terminal for '${params.profile.id}' failed local schema validation and schema retries are disabled: ${first.error}`,
            );
        }
        const initialMessages: AIMessage[] = [{
            role: 'user',
            content: params.responseStructured === undefined
                ? 'The terminal response contained no JSON object. Return exactly one complete JSON object matching the fixed terminal schema.'
                : `The terminal response failed schema validation: ${first.error}. Return exactly one corrected JSON object matching the fixed terminal schema.`,
        }];
        const repaired = await runStructuredCompletion({
            run: async retryMessages => {
                const attempt = params.state.issues.filter(issue => issue.type === 'schema_retry').length + 1;
                const message = `Retrying compound terminal schema for '${params.profile.id}' (attempt ${attempt}).`;
                params.state.issues.push({ type: 'schema_retry', message, step: params.state.steps });
                this.options.onEvent?.({ type: 'schemaRetry', attempt, message });
                params.state.apiCalls += 1;
                const response = await params.session.run({
                    messages: retryMessages,
                    responseFormat: params.responseFormat,
                    toolChoice: 'none',
                    temperature: params.execution.temperature,
                    maxOutputTokens: params.execution.maxOutputTokens,
                    thinking: params.thinking,
                    signal: params.execution.signal,
                });
                if (response.usage) {
                    params.state.usages.push(response.usage);
                }
                return response;
            },
            schema: params.profile.finalSchema,
            initialMessages,
            maxRetries: Math.max(0, params.execution.maxRetries - 1),
            label: params.profile.finalName,
        });
        return repaired.data;
    }

    private async executeToolCall(
        call: AIToolCall,
        tools: Map<string, AIFunctionTool & { execute(args: Record<string, unknown>): Promise<string> }>,
        state: AgentRunState,
    ): Promise<AIToolResult> {
        const tool = tools.get(call.name);
        if (!tool) {
            const message = `Agent requested unknown tool '${call.name}'.`;
            state.issues.push({ type: 'unknown_tool', message, step: state.steps });
            throw new Error(message);
        }
        return { callId: call.id, name: call.name, output: await tool.execute(call.arguments) };
    }
}

function buildRunMetrics(state: AgentRunState): AgentRunMetrics {
    return {
        apiCalls: state.apiCalls,
        toolSteps: state.steps,
        schemaRetries: state.issues.filter(issue => issue.type === 'schema_retry').length,
        contextEpochs: state.epoch,
        invalidReferences: state.issues.filter(issue => issue.type === 'invalid_reference').length,
        usage: [...state.usages],
        issues: state.issues.map(issue => ({ ...issue })),
    };
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
            throw new Error(`Tool '${grant.name}' cannot access path outside '${grant.allowedRoot}': ${candidate}`);
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
        throw new Error(`Tool '${tool}' argument '${field}' exceeds its grant limit (${maximum}).`);
    }
}
