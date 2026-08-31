import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { OpenAIProvider } from '../../services/llm/providers/openai';
import { classifyAndDraftResponseSchema } from '../../services/llm/providers/schemas/common';

function createClient(response: unknown, seen: Array<Record<string, unknown>>) {
    return {
        responses: {
            create: async (body: Record<string, unknown>) => {
                seen.push(body);
                return response;
            },
        },
    } as any;
}

describe('OpenAI provider response accounting', () => {
    it('passes the component-only draft schema to the Responses API', async () => {
        const requests: Array<Record<string, unknown>> = [];
        const provider = new OpenAIProvider({ apiKey: 'test' }, createClient({
            id: 'resp_draft',
            status: 'completed',
            output_text: '{"type":"fix","scope":null,"breaking":false,"description":"fix parsing","body":null,"footers":[],"notes":null}',
            output: [],
        }, requests));
        const session = provider.createSession({ model: 'gpt-5.4' });

        await session.run({
            messages: [{ role: 'user', content: 'return draft components' }],
            responseFormat: {
                name: 'draft',
                schema: z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>,
            },
        });

        const format = (requests[0].text as { format: Record<string, unknown> }).format;
        const schema = format.schema as Record<string, unknown>;
        assert.equal(format.type, 'json_schema');
        assert.equal((schema.properties as Record<string, unknown>).commitMessage, undefined);
    });

    it('normalizes reasoning and visible output tokens and max-output termination', async () => {
        const requests: Array<Record<string, unknown>> = [];
        const provider = new OpenAIProvider({ apiKey: 'test' }, createClient({
            id: 'resp_1',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output_text: '{"value":',
            output: [],
            usage: {
                input_tokens: 100,
                output_tokens: 200,
                total_tokens: 300,
                output_tokens_details: { reasoning_tokens: 150 },
            },
        }, requests));
        const session = provider.createSession({ model: 'gpt-5.4' });

        const result = await session.run({
            messages: [{ role: 'user', content: 'return JSON' }],
            maxOutputTokens: 512,
        });

        assert.equal(requests[0].max_output_tokens, 512);
        assert.equal(result.stopReason, 'max_output_tokens');
        assert.equal(result.stopReasonRaw, 'max_output_tokens');
        assert.equal(result.usage?.reasoningTokens, 150);
        assert.equal(result.usage?.visibleOutputTokens, 50);
    });

    it('recognizes a completed response and preserves the continuation id', async () => {
        const provider = new OpenAIProvider({ apiKey: 'test' }, createClient({
            id: 'resp_2',
            status: 'completed',
            output_text: '{"value":"ok"}',
            output: [],
            usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
        }, []));
        const session = provider.createSession({ model: 'gpt-5.4' });

        const result = await session.run({
            messages: [{ role: 'user', content: 'return JSON' }],
        });

        assert.equal(result.stopReason, 'completed');
        assert.deepEqual(result.continuation, { nativeId: 'resp_2', serverManaged: true });
        assert.deepEqual(session.snapshot().continuation, result.continuation);
    });
});
