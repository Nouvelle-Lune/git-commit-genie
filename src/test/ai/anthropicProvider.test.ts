import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { AnthropicProvider } from '../../services/llm/providers/anthropic';

describe('Anthropic provider response accounting', () => {
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
});
