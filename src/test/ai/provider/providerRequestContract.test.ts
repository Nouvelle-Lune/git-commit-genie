import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { OpenAIProvider } from '../../../services/llm/providers/openai';
import { AnthropicProvider } from '../../../services/llm/providers/anthropic';
import { GoogleProvider } from '../../../services/llm/providers/google';
import { CustomProvider } from '../../../services/llm/providers/custom';
import { commitMessageSchema } from '../../../services/llm/providers/schemas/common';
import type { AIFunctionTool, AIProvider, AIRunRequest } from '../../../services/llm/providers';

/**
 * Request-side contract of the provider seam.
 *
 * Each provider speaks a different wire format, so every assertion below is written against the *parsed
 * request object* as a whole (structural search, ordered string walk, value search) instead of a field
 * path. That keeps the invariants format-independent: they state what the model must receive — the tool
 * schema verbatim, the tool result linked to its call, the system instruction kept out of the user turn,
 * the output ceiling, the caller's abort signal, the previous turn, and the response schema — not how a
 * particular API spells it.
 *
 * Migration note: only the harness at the top of this file (fake SDK clients) is provider-specific and
 * therefore the single migration touch point. The invariants must keep holding.
 */

type ProviderKindName = 'openai' | 'anthropic' | 'google' | 'custom';

const TURN_ID = 'turn-1-id';
const TOOL: AIFunctionTool = {
    name: 'readFileContent',
    description: 'Read a repository file.',
    parameters: {
        type: 'object',
        properties: { filePath: { type: 'string', description: 'Repository-relative path.' } },
        required: ['filePath'],
        additionalProperties: false,
    },
};

const SCHEMA = z.toJSONSchema(commitMessageSchema) as Record<string, unknown>;

interface ScriptedTurn {
    text?: string;
    toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}

/** Builds one upstream payload in the shape the adapter under test expects. */
function upstreamPayload(kind: ProviderKindName, turn: ScriptedTurn): unknown {
    const text = turn.text ?? '';
    const tool = turn.toolCall;
    switch (kind) {
        case 'openai':
            return {
                id: TURN_ID,
                status: 'completed',
                output_text: text,
                output: tool
                    ? [{ type: 'function_call', call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.arguments) }]
                    : [],
            };
        case 'anthropic':
            return {
                id: TURN_ID,
                stop_reason: tool ? 'tool_use' : 'end_turn',
                content: [
                    ...(text ? [{ type: 'text', text }] : []),
                    ...(tool ? [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.arguments }] : []),
                ],
            };
        case 'google':
            return {
                id: TURN_ID,
                status: 'completed',
                steps: [
                    ...(text ? [{ type: 'model_output', finish_reason: 'completed', content: [{ type: 'text', text }] }] : []),
                    ...(tool ? [{ type: 'function_call', id: tool.id, name: tool.name, arguments: tool.arguments }] : []),
                ],
            };
        case 'custom':
            return {
                choices: [{
                    finish_reason: tool ? 'tool_calls' : 'stop',
                    message: {
                        role: 'assistant',
                        content: text,
                        tool_calls: tool
                            ? [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }]
                            : undefined,
                    },
                }],
            };
    }
}

interface SeamHarness {
    readonly kind: ProviderKindName;
    readonly provider: AIProvider;
    /** Parsed request bodies in call order. */
    readonly requests: Array<Record<string, unknown>>;
    /** Transport options the adapter handed to its SDK/fetch call, in call order. */
    readonly transports: Array<{ signal?: AbortSignal }>;
}

function harness(kind: ProviderKindName, turns: ScriptedTurn[]): SeamHarness {
    const requests: Array<Record<string, unknown>> = [];
    const transports: Array<{ signal?: AbortSignal }> = [];
    let next = 0;
    const take = () => upstreamPayload(kind, turns[Math.min(next++, turns.length - 1)]);

    if (kind === 'openai') {
        return {
            kind,
            provider: new OpenAIProvider({ apiKey: 'test' }, {
                responses: {
                    create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
                        requests.push(body);
                        transports.push(options);
                        return take();
                    },
                },
            } as never),
            requests,
            transports,
        };
    }
    if (kind === 'anthropic') {
        return {
            kind,
            provider: new AnthropicProvider({ apiKey: 'test' }, {
                messages: {
                    create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
                        requests.push(body);
                        transports.push(options);
                        return take();
                    },
                },
            } as never),
            requests,
            transports,
        };
    }
    if (kind === 'google') {
        return {
            kind,
            provider: new GoogleProvider({ apiKey: 'test' }, async (_input, init) => {
                requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                transports.push({ signal: init?.signal ?? undefined });
                const payload = take();
                return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as Response;
            }),
            requests,
            transports,
        };
    }
    return {
        kind,
        provider: new CustomProvider({ apiKey: 'test', baseUrl: 'http://127.0.0.1:9/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
                        requests.push(body);
                        transports.push(options);
                        return take();
                    },
                },
            },
        } as never),
        requests,
        transports,
    };
}

const ALL_KINDS: readonly ProviderKindName[] = ['openai', 'anthropic', 'google', 'custom'];

/** Depth-first walk over the parsed request, so ordering assertions follow the serialized structure. */
function walk(value: unknown, visit: (current: unknown) => void): void {
    visit(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            walk(item, visit);
        }
        return;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
            walk(item, visit);
        }
    }
}

/** Every string reachable from the request, in depth-first order. */
function strings(request: unknown): string[] {
    const found: string[] = [];
    walk(request, value => {
        if (typeof value === 'string') {
            found.push(value);
        }
    });
    return found;
}

function containsValue(request: unknown, marker: unknown): boolean {
    let found = false;
    walk(request, value => {
        if (isDeepStrictEqual(value, marker)) {
            found = true;
        }
    });
    return found;
}

function firstStringIndex(request: unknown, marker: string): number {
    return strings(request).findIndex(value => value.includes(marker));
}

const USER_TURN: AIRunRequest['messages'] = [{ role: 'user', content: 'USER-MARKER' }];

function runRequest(harnessed: SeamHarness, request: AIRunRequest): Promise<unknown> {
    return harnessed.provider.createSession({ model: 'seam-contract' }).run(request);
}

describe('provider request contract', () => {
    it('delivers every tool definition to the model unchanged', async () => {
        // The agent runtime's tools carry a JSON Schema the model must see verbatim; a transport that
        // re-encodes or drops any part of it changes what the model can call.
        for (const kind of ALL_KINDS) {
            const harnessed = harness(kind, [{ text: 'ok' }]);
            await runRequest(harnessed, { messages: USER_TURN, tools: [TOOL], toolChoice: 'auto' });

            const request = harnessed.requests[0];
            assert.ok(containsValue(request, TOOL.parameters), `${kind}: tool parameter schema missing`);
            assert.ok(containsValue(request, TOOL.name), `${kind}: tool name missing`);
            assert.ok(containsValue(request, TOOL.description), `${kind}: tool description missing`);
        }
    });

    it('delivers a tool result with the call id it answers and its full output', async () => {
        // Tool results are the only channel back into the model's turn, so the call linkage and payload must
        // both survive the transport even though every provider spells the block differently.
        for (const kind of ALL_KINDS) {
            const callId = `call-${kind}-abc`;
            const harnessed = harness(kind, [
                { toolCall: { id: callId, name: TOOL.name, arguments: { filePath: 'a.ts' } } },
                { text: 'done' },
            ]);
            await runRequest(harnessed, { messages: USER_TURN, tools: [TOOL], toolChoice: 'auto' });
            await runRequest(harnessed, {
                messages: [{ role: 'user', content: 'NEXT-TURN-MARKER' }],
                toolResults: [{ callId, name: TOOL.name, output: 'TOOL-OUTPUT-MARKER' }],
            });

            const request = harnessed.requests[1];
            assert.ok(containsValue(request, callId), `${kind}: tool call id missing from the follow-up`);
            assert.ok(containsValue(request, 'TOOL-OUTPUT-MARKER'), `${kind}: tool output missing from the follow-up`);
        }
    });

    it('carries the session system instruction outside the user turn and never replays a later system message', async () => {
        // The service folds every leading system/developer message into one session instruction, so a
        // provider must (a) send it as system context and (b) not re-inject or replay system turns that
        // arrive with a request — otherwise the prompt cache prefix and the transcript both drift.
        for (const kind of ALL_KINDS) {
            const harnessed = harness(kind, [{ text: 'ok' }]);
            const session = harnessed.provider.createSession({
                model: 'seam-contract',
                systemInstruction: 'SYSTEM-INSTRUCTION-MARKER',
            });
            await session.run({
                messages: [
                    { role: 'user', content: 'USER-MARKER' },
                    { role: 'system', content: 'LATE-SYSTEM-MARKER' },
                ],
            });

            const request = harnessed.requests[0];
            assert.ok(containsValue(request, 'SYSTEM-INSTRUCTION-MARKER'), `${kind}: system instruction missing`);
            assert.equal(containsValue(request, 'LATE-SYSTEM-MARKER'), false, `${kind}: later system message replayed`);
            for (const value of strings(request)) {
                if (value.includes('USER-MARKER')) {
                    assert.equal(
                        value.includes('SYSTEM-INSTRUCTION-MARKER'),
                        false,
                        `${kind}: system instruction mixed into the user turn`,
                    );
                }
            }
        }
    });

    it('forwards the output ceiling and the caller abort signal to the transport', async () => {
        // The budget is derived from the model's context window, and cancellation is the user's cancel
        // button: both are per-request wiring the chain and the agent runtime rely on.
        for (const kind of ALL_KINDS) {
            const harnessed = harness(kind, [{ text: 'ok' }]);
            const controller = new AbortController();
            controller.abort();
            await runRequest(harnessed, { messages: USER_TURN, maxOutputTokens: 4242, signal: controller.signal });

            assert.ok(containsValue(harnessed.requests[0], 4242), `${kind}: output ceiling missing`);
            assert.equal(harnessed.transports[0]?.signal, controller.signal, `${kind}: abort signal not forwarded`);
        }
    });

    it('keeps the previous turn reachable for the next request of the same session', async () => {
        // Server-managed providers continue by response id; transcript providers replay the assistant turn.
        // Either way the second request must be anchored in the first one, or multi-turn work loses context.
        for (const kind of ALL_KINDS) {
            const harnessed = harness(kind, [{ text: 'FIRST-ASSISTANT-MARKER' }, { text: 'second' }]);
            const session = harnessed.provider.createSession({ model: 'seam-contract' });
            await session.run({ messages: USER_TURN });
            await session.run({ messages: [{ role: 'user', content: 'SECOND-TURN-MARKER' }] });

            const request = harnessed.requests[1];
            assert.ok(
                containsValue(request, 'FIRST-ASSISTANT-MARKER') || containsValue(request, TURN_ID),
                `${kind}: second request is not anchored in the first turn`,
            );
        }
    });

    it('delivers the response schema to the model for a structured request', async () => {
        // Structured requests are how the chain reads a stage's result; the schema must reach the model so
        // the answer can be constrained, and the property names must survive into the request as written.
        for (const kind of ALL_KINDS) {
            const harnessed = harness(kind, [{ text: '{}' }]);
            await runRequest(harnessed, {
                messages: USER_TURN,
                responseFormat: { name: 'commitMessage', schema: SCHEMA },
            });

            const request = harnessed.requests[0];
            assert.ok(containsValue(request, SCHEMA), `${kind}: response schema missing`);
            assert.ok(firstStringIndex(request, 'commitMessage') >= 0, `${kind}: schema property missing`);
        }
    });
});
