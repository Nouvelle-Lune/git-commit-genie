import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { CustomProvider } from '../../services/llm/providers/custom';
import { classifyAndDraftResponseSchema } from '../../services/llm/providers/schemas/common';

describe('Custom provider response accounting', () => {
    it('passes the component-only draft schema to compatible chat endpoints', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return {
                            choices: [{
                                finish_reason: 'stop',
                                message: {
                                    role: 'assistant',
                                    content: '{"type":"fix","scope":null,"breaking":false,"description":"fix parsing","body":null,"footers":[],"notes":null}',
                                },
                            }],
                        };
                    },
                },
            },
        } as any);

        await provider.createSession({ model: 'local-model' }).run({
            messages: [{ role: 'user', content: 'return draft components' }],
            responseFormat: {
                name: 'draft',
                schema: z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>,
            },
        });

        const format = requestBody?.response_format as {
            json_schema: { schema: { properties?: Record<string, unknown> } };
        };
        assert.equal(format.json_schema.schema.properties?.commitMessage, undefined);
    });

    it('normalizes reasoning token details and known length termination', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const client = {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return {
                            choices: [{
                                finish_reason: 'length',
                                message: {
                                    role: 'assistant',
                                    content: '{"value":',
                                    reasoning_content: 'thinking',
                                },
                            }],
                            usage: {
                                prompt_tokens: 30,
                                completion_tokens: 100,
                                total_tokens: 130,
                                completion_tokens_details: { reasoning_tokens: 70 },
                            },
                        };
                    },
                },
            },
        } as any;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, client);
        const session = provider.createSession({ model: 'local-model' });

        const result = await session.run({
            messages: [{ role: 'user', content: 'return JSON' }],
            maxOutputTokens: 256,
        });

        assert.equal(requestBody?.max_tokens, 256);
        assert.equal(result.stopReason, 'max_output_tokens');
        assert.equal(result.stopReasonRaw, 'length');
        assert.equal(result.reasoning, 'thinking');
        assert.equal(result.usage?.reasoningTokens, 70);
        assert.equal(result.usage?.visibleOutputTokens, 30);
    });

    it('does not guess the exhausted budget when Custom only reports length', async () => {
        const client = {
            chat: { completions: { create: async () => ({
                choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
            }) } },
        } as any;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, client);
        const result = await provider.createSession({ model: 'local-model' }).run({
            messages: [{ role: 'user', content: 'return JSON' }],
        });

        assert.equal(result.stopReason, 'unknown_length');
    });
});
