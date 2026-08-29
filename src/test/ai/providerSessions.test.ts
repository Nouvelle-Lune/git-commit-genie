import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { AnthropicProvider } from '../../services/llm/providers/anthropic';
import { CustomProvider } from '../../services/llm/providers/custom';
import { GoogleProvider } from '../../services/llm/providers/google';
import { OpenAIProvider } from '../../services/llm/providers/openai';

const tool = {
    name: 'lookup',
    description: 'Look up a symbol.',
    parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
        additionalProperties: false,
    },
};

describe('native provider sessions', () => {
    it('continues OpenAI Responses with response id and a stable cache key', async () => {
        const bodies: any[] = [];
        const responses = [
            {
                id: 'resp_1',
                output_text: '',
                output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"symbol":"x"}' }],
            },
            { id: 'resp_2', output_text: '{"ok":true}', output: [] },
        ];
        const client = {
            responses: { create: async (body: any) => { bodies.push(body); return responses.shift(); } },
        } as any;
        const session = new OpenAIProvider({ apiKey: 'test' }, client).createSession({
            id: 'agent-1',
            model: 'gpt-test',
            systemInstruction: 'Follow the workflow.',
        });

        const first = await session.run({ messages: [{ role: 'user', content: 'Inspect x.' }], tools: [tool] });
        await session.run({
            toolResults: [{ callId: first.toolCalls[0].id, name: 'lookup', output: 'value' }],
            tools: [tool],
        });

        assert.equal(bodies[0].previous_response_id, undefined);
        assert.equal(bodies[0].prompt_cache_key, 'agent-1');
        assert.equal(bodies[0].instructions, 'Follow the workflow.');
        assert.equal(bodies[1].previous_response_id, 'resp_1');
        assert.deepEqual(bodies[1].input, [{ type: 'function_call_output', call_id: 'call_1', output: 'value' }]);
        assert.equal(session.snapshot().continuation.nativeId, 'resp_2');
    });

    it('replays the Anthropic transcript and enables automatic prompt caching', async () => {
        const bodies: any[] = [];
        const responses = [
            { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { symbol: 'x' } }], usage: {} },
            { id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: {} },
        ];
        const client = {
            messages: { create: async (body: any) => { bodies.push(body); return responses.shift(); } },
        } as any;
        const session = new AnthropicProvider({ apiKey: 'test' }, client).createSession({
            model: 'claude-test',
            systemInstruction: 'Follow the workflow.',
        });

        const first = await session.run({ messages: [{ role: 'user', content: 'Inspect x.' }], tools: [tool] });
        await session.run({ toolResults: [{ callId: first.toolCalls[0].id, name: 'lookup', output: 'value' }], tools: [tool] });

        assert.deepEqual(bodies[0].cache_control, { type: 'ephemeral' });
        assert.equal(bodies[1].messages[1].role, 'assistant');
        assert.equal(bodies[1].messages[2].content[0].type, 'tool_result');
        assert.equal(bodies[1].messages[2].content[0].tool_use_id, 'toolu_1');
        assert.deepEqual(session.snapshot().continuation, { nativeId: 'msg_2', serverManaged: false });
    });

    it('continues Gemini Interactions with the previous interaction id', async () => {
        const requests: any[] = [];
        const payloads = [
            {
                id: 'int_1',
                steps: [{ type: 'function_call', id: 'fc_1', name: 'lookup', arguments: { symbol: 'x' } }],
                usage: { total_input_tokens: 10, total_output_tokens: 2, total_cached_tokens: 4, total_tokens: 12 },
            },
            {
                id: 'int_2',
                steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }],
                usage: { total_input_tokens: 3, total_output_tokens: 2, total_cached_tokens: 10, total_tokens: 15 },
            },
        ];
        const fetchFn = async (_url: unknown, init?: RequestInit) => {
            requests.push(JSON.parse(String(init?.body)));
            return { ok: true, json: async () => payloads.shift() } as Response;
        };
        const session = new GoogleProvider({ apiKey: 'test' }, fetchFn as typeof fetch).createSession({
            model: 'gemini-test',
            systemInstruction: 'Follow the workflow.',
        });

        const first = await session.run({ messages: [{ role: 'user', content: 'Inspect x.' }], tools: [tool], toolChoice: 'required' });
        const second = await session.run({
            toolResults: [{ callId: first.toolCalls[0].id, name: 'lookup', output: 'value' }],
            tools: [tool],
            responseFormat: { name: 'result', schema: { type: 'object' } },
        });

        assert.equal(requests[0].tool_choice, 'any');
        assert.equal(requests[0].generation_config.tool_choice, undefined);
        assert.equal(requests[1].previous_interaction_id, 'int_1');
        assert.equal(requests[1].input[0].type, 'function_result');
        assert.deepEqual(requests[1].response_format, {
            type: 'text',
            mime_type: 'application/json',
            schema: { type: 'object' },
        });
        assert.equal(second.usage?.cachedInputTokens, 10);
    });

    it('replays OpenAI-compatible assistant tool calls before tool results', async () => {
        const bodies: any[] = [];
        const responses = [
            {
                choices: [{ message: {
                    content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"symbol":"x"}' } }],
                } }],
            },
            { choices: [{ message: { content: 'done' } }] },
        ];
        const client = {
            chat: { completions: { create: async (body: any) => { bodies.push(body); return responses.shift(); } } },
        } as any;
        const session = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8000/v1' }, client)
            .createSession({ model: 'custom-test' });

        const first = await session.run({ messages: [{ role: 'user', content: 'Inspect x.' }], tools: [tool] });
        await session.run({ toolResults: [{ callId: first.toolCalls[0].id, name: 'lookup', output: 'value' }], tools: [tool] });

        assert.equal(bodies[1].messages[1].role, 'assistant');
        assert.equal(bodies[1].messages[1].tool_calls[0].id, 'call_1');
        assert.deepEqual(bodies[1].messages[2], { role: 'tool', content: 'value', tool_call_id: 'call_1' });
    });
});
