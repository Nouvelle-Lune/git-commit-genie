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

    it('retries schema mismatches with field-level path, expected, and actual feedback', async () => {
        // A rejected structured object must produce actionable field diagnostics instead of a serialized ZodError dump.
        const requests: string[] = [];
        let calls = 0;
        const contract = z.object({
            kind: z.enum(['valid', 'other']),
            items: z.array(z.string()).max(1),
        });

        const result = await runStructuredCompletion({
            run: async messages => {
                requests.push(messages.map(message => message.content).join('\n'));
                calls += 1;
                return calls === 1
                    ? response({ structured: { kind: 'unsupported', items: ['one', 'two'] } })
                    : response({ structured: { kind: 'valid', items: ['one'] } });
            },
            schema: contract,
            initialMessages: [{ role: 'user', content: 'return JSON' }],
            maxRetries: 1,
            label: 'planner',
        });

        assert.deepEqual(result.data, { kind: 'valid', items: ['one'] });
        assert.equal(requests.length, 2);
        assert.match(requests[1], /kind/);
        assert.match(requests[1], /unsupported/);
        assert.match(requests[1], /items/);
        assert.match(requests[1], /contains 2 items but at most 1 are allowed\. Narrow or split the containing item while preserving every required coverage or evidence reference/);
        assert.doesNotMatch(requests[1], /Keep only the 1 most directly supporting entries/);
        assert.doesNotMatch(requests[1], /ZodError|invalid_value|too_big/);
    });

    it('reports field-level diagnostics in the final schema error after retries are exhausted', async () => {
        // The final failure must retain exact field feedback while avoiding the raw provider-specific validation dump.
        const contract = z.object({ items: z.array(z.string()).max(1) });

        await assert.rejects(
            runStructuredCompletion({
                run: async () => response({ structured: { items: ['x', 'y'] } }),
                schema: contract,
                initialMessages: [{ role: 'user', content: 'return JSON' }],
                maxRetries: 1,
                label: 'terminal',
            }),
            (error: unknown) => error instanceof Error
                && /items/.test(error.message)
                && /contains 2 items but at most 1 are allowed\. Narrow or split the containing item while preserving every required coverage or evidence reference/.test(error.message)
                && !/ZodError|too_small/.test(error.message),
        );
    });
});
