import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { AnthropicProvider } from '../../services/llm/providers/anthropic';
import { classifyAndDraftResponseSchema } from '../../services/llm/providers/schemas/common';

describe('Anthropic provider response accounting', () => {
    it('passes the component-only draft schema to the Messages API', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const provider = new AnthropicProvider({ apiKey: 'test' }, {
            messages: {
                create: async (body: Record<string, unknown>) => {
                    requestBody = body;
                    return {
                        id: 'msg_draft',
                        stop_reason: 'end_turn',
                        content: [{ type: 'text', text: '{"type":"fix","scope":null,"breaking":false,"description":"fix parsing","body":null,"footers":[],"notes":null}' }],
                    };
                },
            },
        } as any);

        await provider.createSession({ model: 'claude-sonnet-4-5' }).run({
            messages: [{ role: 'user', content: 'return draft components' }],
            responseFormat: {
                name: 'draft',
                schema: z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>,
            },
        });

        const format = (requestBody?.output_config as { format: Record<string, unknown> }).format;
        const schema = format.schema as Record<string, unknown>;
        assert.equal(format.type, 'json_schema');
        assert.equal((schema.properties as Record<string, unknown>).commitMessage, undefined);
    });

    it('keeps max_tokens as the shared output ceiling while enabling thinking', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const client = {
            messages: {
                create: async (body: Record<string, unknown>) => {
                    requestBody = body;
                    return {
                        id: 'msg_1',
                        stop_reason: 'max_tokens',
                        content: [
                            { type: 'thinking', thinking: 'reasoning' },
                            { type: 'text', text: '{"value":"ok"}' },
                        ],
                        usage: {
                            input_tokens: 20,
                            output_tokens: 100,
                            output_tokens_details: { thinking_tokens: 97 },
                            cache_read_input_tokens: 2,
                            cache_creation_input_tokens: 3,
                        },
                    };
                },
            },
        } as any;
        const provider = new AnthropicProvider({ apiKey: 'test' }, client);
        const session = provider.createSession({
            model: 'claude-sonnet-4-5',
            thinking: { reasoning: true, level: 'low', budget: 4_096 },
        });

        const result = await session.run({
            messages: [{ role: 'user', content: 'return JSON' }],
            maxOutputTokens: 8_192,
            temperature: 0.7,
        });

        assert.equal(requestBody?.max_tokens, 8_192);
        assert.deepEqual(requestBody?.thinking, { type: 'enabled', budget_tokens: 4_096 });
        assert.equal(requestBody?.temperature, undefined);
        assert.equal(result.stopReason, 'max_output_tokens');
        assert.equal(result.reasoning, 'reasoning');
        assert.equal(result.usage?.outputTokens, 100);
        assert.equal(result.usage?.reasoningTokens, 97);
        assert.equal(result.usage?.visibleOutputTokens, 3);
    });

    it('maps an explicit transport retry policy to the SDK request options', async () => {
        const options: Array<Record<string, unknown>> = [];
        const client = {
            messages: {
                create: async (_body: Record<string, unknown>, requestOptions: Record<string, unknown> = {}) => {
                    options.push(requestOptions);
                    return { id: 'msg_retry', stop_reason: 'end_turn', content: [] };
                },
            },
        } as any;
        const session = new AnthropicProvider({ apiKey: 'test' }, client).createSession({ model: 'claude-sonnet-4-5' });

        await session.run({ messages: [{ role: 'user', content: 'one paid attempt' }], transportRetries: 0 });
        await session.run({ messages: [{ role: 'user', content: 'ordinary call' }] });

        assert.equal(options[0].maxRetries, 0);
        assert.equal(options[1].maxRetries, undefined);
    });

    it('rejects a thinking budget that consumes the entire shared output ceiling', async () => {
        const client = { messages: { create: async () => ({}) } } as any;
        const provider = new AnthropicProvider({ apiKey: 'test' }, client);
        const session = provider.createSession({
            model: 'claude-sonnet-4-5',
            thinking: { reasoning: true, level: 'medium', budget: 512 },
        });

        await assert.rejects(
            session.run({
                messages: [{ role: 'user', content: 'return JSON' }],
                maxOutputTokens: 512,
            }),
            /must be smaller than the derived output budget/,
        );
    });

    it('serializes session-bound off thinking as disabled without request overrides', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const provider = new AnthropicProvider({ apiKey: 'test' }, {
            messages: {
                create: async (body: Record<string, unknown>) => {
                    requestBody = body;
                    return { id: 'msg_off', stop_reason: 'end_turn', content: [] };
                },
            },
        } as any);

        await provider.createSession({
            model: 'claude-sonnet-4-5',
            thinking: { reasoning: true, level: 'off', mappedValue: 'disabled' },
        }).run({
            messages: [{ role: 'user', content: 'no thinking' }],
            maxOutputTokens: 1024,
        });

        assert.deepEqual(requestBody?.thinking, { type: 'disabled' });
        assert.equal(requestBody?.max_tokens, 1024);
    });
});
