import { z } from 'zod';
import {
    AIFunctionTool,
    AIMessage,
    AIResponseFormat,
    AISession,
    AIThinkingConfig,
    AIToolCall,
    AIToolResult,
} from '../services/llm/providers';
import { assertChatMessagesWithinTokenBudget, ChainTokenBudget } from '../services/llm/inputTokenBudget';
import { RequestType } from '../services/llm/llmTypes';
import { runStructuredCompletion } from '../services/llm/structuredCompletion';

export interface AgentTool extends AIFunctionTool {
    execute(argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export interface AgentLoopOptions {
    maxSteps: number;
    responseFormat?: AIResponseFormat;
    schema?: z.ZodTypeAny;
    maxRetries?: number;
    temperature?: number;
    maxOutputTokens?: number;
    thinking?: AIThinkingConfig;
    tokenBudget?: ChainTokenBudget;
    requestType?: RequestType;
    signal?: AbortSignal;
}

export interface AgentLoopResult {
    text: string;
    structured?: unknown;
    steps: number;
    session: ReturnType<AISession['snapshot']>;
}

function toSessionDelta(messages: AIMessage[]): AIMessage[] {
    return messages.filter(message => message.role !== 'system' && message.role !== 'developer');
}

/**
 * Runs one provider-neutral tool loop while the session owns all continuation
 * details. This prevents orchestration code from branching on response IDs,
 * interaction IDs, or transcript replay semantics.
 */
export async function runAgentLoop(
    session: AISession,
    openingMessages: AIMessage[],
    tools: AgentTool[],
    options: AgentLoopOptions,
): Promise<AgentLoopResult> {
    const toolsByName = new Map(tools.map(tool => [tool.name, tool]));
    let messages = openingMessages;
    let toolResults: AIToolResult[] | undefined;
    const toolResultHistory: AIMessage[] = [];

    for (let step = 0; step <= options.maxSteps; step += 1) {
        if (options.tokenBudget) {
            assertChatMessagesWithinTokenBudget(
                [...session.snapshot().transcript, ...messages, ...toolResultHistory],
                options.tokenBudget,
                options.requestType,
            );
        }
        const response = await session.run({
            messages: toSessionDelta(messages),
            toolResults,
            tools,
            responseFormat: options.responseFormat,
            toolChoice: tools.length ? 'auto' : 'none',
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
            thinking: options.thinking,
            signal: options.signal,
        });
        messages = [];
        toolResults = undefined;
        if (!response.toolCalls.length) {
            if (!options.schema) {
                return {
                    text: response.text,
                    structured: response.structured,
                    steps: step,
                    session: session.snapshot(),
                };
            }
            if (!options.responseFormat) {
                throw new Error('runAgentLoop requires responseFormat when schema is provided.');
            }
            if (options.maxRetries === undefined) {
                throw new Error('runAgentLoop requires maxRetries when schema is provided.');
            }

            const firstParsed = options.schema.safeParse(response.structured);
            if (firstParsed.success) {
                return {
                    text: response.text,
                    structured: firstParsed.data,
                    steps: step,
                    session: session.snapshot(),
                };
            }

            const maxRetries = options.maxRetries;
            const initialMessages: AIMessage[] = response.structured === undefined
                ? [{
                    role: 'user',
                    content: 'The previous response contained no final JSON object. Return exactly one complete JSON object matching the requested schema. Do not include markdown or explanation.',
                }]
                : [{
                    role: 'user',
                    content: `The previous response failed schema validation: ${firstParsed.error}. Return one corrected JSON object matching the requested schema.`,
                }];
            const { data, response: validatedResponse } = await runStructuredCompletion({
                run: async retryMessages => {
                    if (options.tokenBudget) {
                        assertChatMessagesWithinTokenBudget(
                            [...session.snapshot().transcript, ...toolResultHistory, ...retryMessages],
                            options.tokenBudget,
                            options.requestType,
                        );
                    }
                    return session.run({
                        messages: retryMessages,
                        responseFormat: options.responseFormat,
                        toolChoice: 'none',
                        temperature: options.temperature,
                        maxOutputTokens: options.maxOutputTokens,
                        thinking: options.thinking,
                        signal: options.signal,
                    });
                },
                schema: options.schema,
                initialMessages,
                maxRetries: Math.max(0, maxRetries - 1),
                label: options.responseFormat?.name ?? 'agentFinal',
            });
            return {
                text: validatedResponse.text,
                structured: data,
                steps: step,
                session: session.snapshot(),
            };
        }
        if (step === options.maxSteps) {
            throw new Error(`Agent loop exhausted its ${options.maxSteps} tool-step budget.`);
        }

        toolResultHistory.push({
            role: 'assistant',
            content: JSON.stringify(response.toolCalls),
        });
        toolResults = await Promise.all(
            response.toolCalls.map(call => executeToolCall(call, toolsByName, options.signal))
        );
        toolResultHistory.push(...toolResults.map(result => ({
            role: 'user' as const,
            content: result.output,
        })));
    }

    throw new Error('Agent loop exited without a final response.');
}

async function executeToolCall(
    call: AIToolCall,
    tools: Map<string, AgentTool>,
    signal?: AbortSignal,
): Promise<AIToolResult> {
    const tool = tools.get(call.name);
    if (!tool) {
        throw new Error(`Agent requested unknown tool '${call.name}'.`);
    }
    return {
        callId: call.id,
        name: call.name,
        output: await tool.execute(call.arguments, signal),
    };
}
