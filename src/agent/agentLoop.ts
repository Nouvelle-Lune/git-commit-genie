import {
    AIFunctionTool,
    AIMessage,
    AIResponseFormat,
    AISession,
    AIToolCall,
    AIToolResult,
} from '../services/llm/providers';

export interface AgentTool extends AIFunctionTool {
    execute(argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export interface AgentLoopOptions {
    maxSteps: number;
    responseFormat?: AIResponseFormat;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
}

export interface AgentLoopResult {
    text: string;
    structured?: unknown;
    steps: number;
    session: ReturnType<AISession['snapshot']>;
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

    for (let step = 0; step <= options.maxSteps; step += 1) {
        const response = await session.run({
            messages,
            toolResults,
            tools,
            responseFormat: options.responseFormat,
            toolChoice: tools.length ? 'auto' : 'none',
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
            signal: options.signal,
        });
        messages = [];
        toolResults = undefined;
        if (!response.toolCalls.length) {
            return {
                text: response.text,
                structured: response.structured,
                steps: step,
                session: session.snapshot(),
            };
        }
        if (step === options.maxSteps) {
            throw new Error(`Agent loop exhausted its ${options.maxSteps} tool-step budget.`);
        }

        toolResults = await Promise.all(
            response.toolCalls.map(call => executeToolCall(call, toolsByName, options.signal))
        );
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
