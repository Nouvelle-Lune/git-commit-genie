import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { GoogleProvider } from '../../services/llm/providers/google';

function jsonResponse(payload: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    } as Response;
}

describe('Google provider response accounting', () => {
    it('preserves Gemini output accounting and normalizes finish reasons', async () => {
        const requests: RequestInit[] = [];
        const provider = new GoogleProvider({ apiKey: 'test' }, async (_input, init) => {
            requests.push(init ?? {});
            return jsonResponse({
                id: 'interaction_1',
                status: 'completed',
                steps: [{
                    type: 'model_output',
                    finish_reason: 'MAX_OUTPUT_TOKENS',
                    content: [{ type: 'text', text: '{"value":"ok"}' }],
                }],
                usage: {
                    total_input_tokens: 200,
                    total_output_tokens: 100,
                    total_thought_tokens: 60,
                    total_tokens: 300,
                    total_cached_tokens: 10,
                },
            });
        });
        const session = provider.createSession({ model: 'gemini-2.5-pro' });

        const result = await session.run({
            messages: [{ role: 'user', content: 'return JSON' }],
            maxOutputTokens: 512,
        });

        const body = JSON.parse(String(requests[0].body));
        assert.equal(body.generation_config.max_output_tokens, 512);
        assert.equal(result.stopReason, 'max_output_tokens');
        assert.equal(result.stopReasonRaw, 'MAX_OUTPUT_TOKENS');
        assert.equal(result.usage?.reasoningTokens, 60);
        // Interactions reports total_output_tokens and total_thought_tokens as
        // separate fields; the adapter preserves total_output_tokens as its
        // provider-level output count.
        assert.equal(result.usage?.visibleOutputTokens, 100);
    });

    it('normalizes context and safety termination reasons', async () => {
        const provider = new GoogleProvider({ apiKey: 'test' }, async () => jsonResponse({
            id: 'interaction_2',
            finish_reason: 'context_length',
            steps: [],
        }));
        const session = provider.createSession({ model: 'gemini-2.5-pro' });

        const result = await session.run({ messages: [{ role: 'user', content: 'x' }] });
        assert.equal(result.stopReason, 'context_window');
        assert.equal(result.stopReasonRaw, 'context_length');
    });
});
