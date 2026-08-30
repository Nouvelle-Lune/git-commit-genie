import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { AIRunResponse } from '../../services/llm/providers';
import {
    StructuredOutputTerminatedError,
    runStructuredCompletion,
} from '../../services/llm/structuredCompletion';

const schema = z.object({ value: z.string() });

function response(overrides: Partial<AIRunResponse>): AIRunResponse {
    return {
        text: '',
        toolCalls: [],
        stopReason: 'completed',
        continuation: { serverManaged: false },
        raw: {},
        ...overrides,
    };
}

describe('structured completion termination policy', () => {
    it('does not retry when reasoning consumed the output budget', async () => {
        let calls = 0;
        await assert.rejects(
            runStructuredCompletion({
                run: async () => {
                    calls += 1;
                    return response({
                        stopReason: 'max_output_tokens',
                        usage: {
                            outputTokens: 4_096,
                            reasoningTokens: 4_096,
                            visibleOutputTokens: 0,
                        },
                    });
                },
                schema,
                initialMessages: [{ role: 'user', content: 'return JSON' }],
                maxRetries: 2,
                label: 'draft',
            }),
            (error: unknown) => error instanceof StructuredOutputTerminatedError
                && error.kind === 'reasoning_exhausted',
        );
        assert.equal(calls, 1);
    });

    it('does not retry ambiguous Custom length failures', async () => {
        let calls = 0;
        await assert.rejects(
            runStructuredCompletion({
                run: async () => {
                    calls += 1;
                    return response({ stopReason: 'unknown_length', stopReasonRaw: 'length' });
                },
                schema,
                initialMessages: [{ role: 'user', content: 'return JSON' }],
                maxRetries: 2,
                label: 'draft',
            }),
            (error: unknown) => error instanceof StructuredOutputTerminatedError
                && error.kind === 'ambiguous_length',
        );
        assert.equal(calls, 1);
    });

    it('does not retry visible output exhaustion for a single response', async () => {
        let calls = 0;
        await assert.rejects(
            runStructuredCompletion({
                run: async () => {
                    calls += 1;
                    return response({
                        text: '{"value":"incomplete',
                        stopReason: 'max_output_tokens',
                        usage: { outputTokens: 128, visibleOutputTokens: 128 },
                    });
                },
                schema,
                initialMessages: [{ role: 'user', content: 'return JSON' }],
                maxRetries: 2,
                label: 'draft',
            }),
            (error: unknown) => error instanceof StructuredOutputTerminatedError
                && error.kind === 'visible_output_exhausted',
        );
        assert.equal(calls, 1);
    });

    it('classifies explicit provider context exhaustion before considering output retries', async () => {
        let calls = 0;
        await assert.rejects(
            runStructuredCompletion({
                run: async () => {
                    calls += 1;
                    return response({ stopReason: 'context_window' });
                },
                schema,
                initialMessages: [{ role: 'user', content: 'return JSON' }],
                maxRetries: 2,
            }),
            (error: unknown) => error instanceof StructuredOutputTerminatedError
                && error.kind === 'context_exhausted',
        );
        assert.equal(calls, 1);
    });

    it('retries a completed response that merely failed to return structured JSON', async () => {
        let calls = 0;
        const result = await runStructuredCompletion({
            run: async () => {
                calls += 1;
                return calls === 1
                    ? response({ text: 'not JSON' })
                    : response({ text: '{"value":"ok"}', structured: { value: 'ok' } });
            },
            schema,
            initialMessages: [{ role: 'user', content: 'return JSON' }],
            maxRetries: 1,
        });

        assert.deepEqual(result.data, { value: 'ok' });
        assert.equal(calls, 2);
    });
});
