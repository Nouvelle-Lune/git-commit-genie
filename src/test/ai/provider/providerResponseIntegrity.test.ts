import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { OpenAIProvider } from '../../../services/llm/providers/openai';
import { AnthropicProvider } from '../../../services/llm/providers/anthropic';
import { GoogleProvider } from '../../../services/llm/providers/google';
import { CustomProvider } from '../../../services/llm/providers/custom';
import { commitMessageSchema } from '../../../services/llm/providers/schemas/common';
import type { AIProvider, AIRunResponse } from '../../../services/llm/providers';

/**
 * Response-side integrity contract of the provider seam.
 *
 * Every provider adapter normalizes its upstream payload into one `AIRunResponse`. This file pins the
 * *whole* normalized object (every field, including the ones a given API does not report) instead of one
 * assertion per field, so a replacement transport cannot silently drop a field the upper layers read:
 * `structured` feeds the chain's Zod validation, `toolCalls` feeds the agent runtime, `usage` feeds cost
 * accounting and the token budget, `stopReason` feeds retry/termination policy and `continuation` feeds
 * session re-entry.
 *
 * Migration note: this file constructs the concrete adapters directly. That construction is the only
 * migration touch point; the expected objects below are the contract that must survive it.
 */

const RESPONSE_FORMAT = {
    name: 'commitMessage',
    schema: z.toJSONSchema(commitMessageSchema) as Record<string, unknown>,
};
const STRUCTURED_TEXT = '{"commitMessage":"feat: keep response integrity"}';

/** Compares everything except `raw`, which is asserted separately for every provider. */
function withoutRaw(response: AIRunResponse): Omit<AIRunResponse, 'raw'> {
    const { raw, ...rest } = response;
    return rest;
}

interface OpenAIFixture {
    readonly provider: AIProvider;
    readonly requests: Array<Record<string, unknown>>;
}

function openAIProvider(response: unknown): OpenAIFixture {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new OpenAIProvider({ apiKey: 'test' }, {
        responses: {
            create: async (body: Record<string, unknown>) => {
                requests.push(body);
                return response;
            },
        },
    } as never);
    return { provider, requests };
}

function anthropicProvider(response: unknown): { provider: AIProvider; requests: Array<Record<string, unknown>> } {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new AnthropicProvider({ apiKey: 'test' }, {
        messages: {
            create: async (body: Record<string, unknown>) => {
                requests.push(body);
                return response;
            },
        },
    } as never);
    return { provider, requests };
}

function googleProvider(response: unknown): { provider: AIProvider; requests: Array<Record<string, unknown>> } {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new GoogleProvider({ apiKey: 'test' }, async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return {
            ok: true,
            status: 200,
            json: async () => response,
            text: async () => JSON.stringify(response),
        } as Response;
    });
    return { provider, requests };
}

function customProvider(response: unknown): { provider: AIProvider; requests: Array<Record<string, unknown>> } {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://127.0.0.1:9/v1' }, {
        chat: {
            completions: {
                create: async (body: Record<string, unknown>) => {
                    requests.push(body);
                    return response;
                },
            },
        },
    } as never);
    return { provider, requests };
}

const OPENAI_RESPONSE = {
    id: 'resp_1',
    status: 'completed',
    output_text: STRUCTURED_TEXT,
    output: [{ type: 'function_call', call_id: 'call_1', name: 'readFileContent', arguments: '{"filePath":"a.ts"}' }],
    usage: {
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        input_tokens_details: { cached_tokens: 30, cache_write_tokens: 12 },
        output_tokens_details: { reasoning_tokens: 10 },
    },
};

const ANTHROPIC_RESPONSE = {
    id: 'msg_1',
    stop_reason: 'end_turn',
    content: [
        { type: 'thinking', thinking: 'weigh the options' },
        { type: 'text', text: STRUCTURED_TEXT },
        { type: 'tool_use', id: 'toolu_1', name: 'readFileContent', input: { filePath: 'a.ts' } },
    ],
    usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 8,
        output_tokens_details: { thinking_tokens: 15 },
    },
};

const GOOGLE_RESPONSE = {
    id: 'interaction_1',
    status: 'completed',
    steps: [
        {
            type: 'model_output',
            finish_reason: 'completed',
            content: [{ type: 'text', text: STRUCTURED_TEXT }],
        },
        { type: 'function_call', id: 'fc_1', name: 'readFileContent', arguments: { filePath: 'a.ts' } },
    ],
    usage: {
        total_input_tokens: 300,
        total_output_tokens: 60,
        total_thought_tokens: 25,
        total_tokens: 360,
        total_cached_tokens: 40,
    },
};

const CUSTOM_RESPONSE = {
    choices: [{
        finish_reason: 'stop',
        message: {
            role: 'assistant',
            content: STRUCTURED_TEXT,
            reasoning_content: 'weigh the options',
            tool_calls: [{
                id: 'call_9',
                type: 'function',
                function: { name: 'readFileContent', arguments: '{"filePath":"a.ts"}' },
            }],
        },
    }],
    usage: {
        prompt_tokens: 400,
        completion_tokens: 70,
        total_tokens: 470,
        prompt_tokens_details: { cached_tokens: 50 },
        completion_tokens_details: { reasoning_tokens: 20 },
    },
};

const USER_MESSAGE = [{ role: 'user' as const, content: 'return commit components' }];

describe('provider response integrity', () => {
    it('normalizes every field of an OpenAI Responses payload', async () => {
        const { provider } = openAIProvider(OPENAI_RESPONSE);
        const response = await provider.createSession({ model: 'gpt-5.4' }).run({
            messages: USER_MESSAGE,
            responseFormat: RESPONSE_FORMAT,
        });

        assert.deepEqual(withoutRaw(response), {
            text: STRUCTURED_TEXT,
            structured: { commitMessage: 'feat: keep response integrity' },
            toolCalls: [{ id: 'call_1', name: 'readFileContent', arguments: { filePath: 'a.ts' } }],
            usage: {
                inputTokens: 100,
                outputTokens: 40,
                reasoningTokens: 10,
                visibleOutputTokens: 30,
                totalTokens: 140,
                cachedInputTokens: 30,
                cacheWriteInputTokens: 12,
                raw: OPENAI_RESPONSE.usage,
            },
            stopReason: 'completed',
            stopReasonRaw: 'completed',
            continuation: { nativeId: 'resp_1', serverManaged: true },
        });
        assert.equal(response.raw, OPENAI_RESPONSE);
    });

    it('normalizes every field of an Anthropic Messages payload', async () => {
        const { provider } = anthropicProvider(ANTHROPIC_RESPONSE);
        const response = await provider.createSession({ model: 'claude-sonnet-4-5' }).run({
            messages: USER_MESSAGE,
            responseFormat: RESPONSE_FORMAT,
        });

        assert.deepEqual(withoutRaw(response), {
            text: STRUCTURED_TEXT,
            reasoning: 'weigh the options',
            structured: { commitMessage: 'feat: keep response integrity' },
            toolCalls: [{ id: 'toolu_1', name: 'readFileContent', arguments: { filePath: 'a.ts' } }],
            usage: {
                inputTokens: 200,
                outputTokens: 50,
                reasoningTokens: 15,
                visibleOutputTokens: 35,
                totalTokens: 250,
                cachedInputTokens: 20,
                cacheWriteInputTokens: 8,
                raw: ANTHROPIC_RESPONSE.usage,
            },
            stopReason: 'completed',
            stopReasonRaw: 'end_turn',
            // Messages are replayed by this adapter, so the response id is reported for diagnostics only.
            continuation: { nativeId: 'msg_1', serverManaged: false },
        });
        assert.equal(response.raw, ANTHROPIC_RESPONSE);
    });

    it('normalizes every field of a Google interaction payload', async () => {
        const { provider } = googleProvider(GOOGLE_RESPONSE);
        const response = await provider.createSession({ model: 'gemini-2.5-pro' }).run({
            messages: USER_MESSAGE,
            responseFormat: RESPONSE_FORMAT,
        });

        assert.deepEqual(withoutRaw(response), {
            text: STRUCTURED_TEXT,
            structured: { commitMessage: 'feat: keep response integrity' },
            toolCalls: [{ id: 'fc_1', name: 'readFileContent', arguments: { filePath: 'a.ts' } }],
            usage: {
                inputTokens: 300,
                outputTokens: 60,
                reasoningTokens: 25,
                // Gemini reports thought tokens outside the visible output, so visible output is the full total.
                visibleOutputTokens: 60,
                totalTokens: 360,
                cachedInputTokens: 40,
                raw: GOOGLE_RESPONSE.usage,
            },
            stopReason: 'completed',
            stopReasonRaw: 'completed',
            continuation: { nativeId: 'interaction_1', serverManaged: true },
        });
        assert.equal(response.raw, GOOGLE_RESPONSE);
    });

    it('normalizes every field of a Chat Completions payload', async () => {
        const { provider } = customProvider(CUSTOM_RESPONSE);
        const response = await provider.createSession({ model: 'local-model' }).run({
            messages: USER_MESSAGE,
            responseFormat: RESPONSE_FORMAT,
        });

        assert.deepEqual(withoutRaw(response), {
            text: STRUCTURED_TEXT,
            reasoning: 'weigh the options',
            structured: { commitMessage: 'feat: keep response integrity' },
            toolCalls: [{ id: 'call_9', name: 'readFileContent', arguments: { filePath: 'a.ts' } }],
            usage: {
                inputTokens: 400,
                outputTokens: 70,
                reasoningTokens: 20,
                visibleOutputTokens: 50,
                totalTokens: 470,
                cachedInputTokens: 50,
                raw: CUSTOM_RESPONSE.usage,
            },
            stopReason: 'completed',
            stopReasonRaw: 'stop',
            continuation: { serverManaged: false },
        });
        assert.equal(response.raw, CUSTOM_RESPONSE);
    });

    it('reports structured output only for a structured request', async () => {
        // The chain decides per stage whether the response is a terminal JSON contract or free text, so a
        // non-structured request must never produce a parsed object that the caller would then treat as data.
        const cases: Array<[string, { provider: AIProvider }]> = [
            ['openai', openAIProvider(OPENAI_RESPONSE)],
            ['anthropic', anthropicProvider(ANTHROPIC_RESPONSE)],
            ['google', googleProvider(GOOGLE_RESPONSE)],
            ['custom', customProvider(CUSTOM_RESPONSE)],
        ];
        for (const [kind, { provider }] of cases) {
            const response = await provider.createSession({ model: 'm' }).run({ messages: USER_MESSAGE });
            assert.equal(response.structured, undefined, kind);
            assert.equal(response.text, STRUCTURED_TEXT, kind);
        }
    });

    it('keeps the session snapshot complete and append-only across runs', async () => {
        // `snapshot()` is what makes a session re-enterable: the provider identity, the model id, the
        // continuation handle and the transcript that the caller replays. Losing any of them breaks resume.
        const cases: Array<[ProviderKindName, { provider: AIProvider }, { serverManaged: boolean; nativeId?: string }]> = [
            ['openai', openAIProvider(OPENAI_RESPONSE), { serverManaged: true, nativeId: 'resp_1' }],
            ['anthropic', anthropicProvider(ANTHROPIC_RESPONSE), { serverManaged: false, nativeId: 'msg_1' }],
            ['google', googleProvider(GOOGLE_RESPONSE), { serverManaged: true, nativeId: 'interaction_1' }],
            ['custom', customProvider(CUSTOM_RESPONSE), { serverManaged: false }],
        ];
        for (const [kind, { provider }, continuation] of cases) {
            const session = provider.createSession({ model: 'm' });
            await session.run({ messages: USER_MESSAGE });
            await session.run({ messages: [{ role: 'user', content: 'second turn' }] });

            const snapshot = session.snapshot();
            assert.equal(snapshot.provider, kind);
            assert.equal(snapshot.model, 'm');
            assert.deepEqual(snapshot.continuation, continuation, kind);
            assert.deepEqual(
                snapshot.transcript,
                [
                    ...USER_MESSAGE,
                    { role: 'assistant', content: STRUCTURED_TEXT },
                    { role: 'user', content: 'second turn' },
                    { role: 'assistant', content: STRUCTURED_TEXT },
                ],
                kind,
            );
        }
    });
});

type ProviderKindName = 'openai' | 'anthropic' | 'google' | 'custom';
