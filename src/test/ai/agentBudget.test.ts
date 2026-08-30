import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { runAgentLoop } from '../../agent/agentLoop';
import { AISession, AIMessage } from '../../services/llm/providers';
import { resolveChainTokenBudget } from '../../services/llm/inputTokenBudget';

describe('agent loop token budgeting', () => {
    it('remeasures the complete session before a structured repair retry', async () => {
        const transcript: AIMessage[] = [];
        let calls = 0;
        const session: AISession = {
            provider: 'custom',
            model: 'test',
            run: async request => {
                calls += 1;
                transcript.push(...request.messages ?? []);
                const text = 'x'.repeat(2_000);
                transcript.push({ role: 'assistant', content: text });
                return {
                    text,
                    structured: { value: 123 },
                    toolCalls: [],
                    stopReason: 'completed',
                    continuation: { serverManaged: false },
                    raw: {},
                };
            },
            snapshot: () => ({
                provider: 'custom',
                model: 'test',
                continuation: { serverManaged: false },
                transcript: [...transcript],
            }),
        };
        const tokenBudget = resolveChainTokenBudget({
            provider: 'custom',
            model: 'test',
            contextWindowTokens: 1_200,
        });

        await assert.rejects(
            runAgentLoop(
                session,
                [{ role: 'user', content: 'Return JSON.' }],
                [],
                {
                    maxSteps: 0,
                    responseFormat: { name: 'result', schema: { type: 'object' } },
                    schema: z.object({ value: z.string() }),
                    maxRetries: 1,
                    tokenBudget,
                    requestType: 'investigation',
                },
            ),
            /exceeding its safe input capacity/,
        );
        assert.equal(calls, 1);
    });
});
