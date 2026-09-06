import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { AgentProfile, AgentRuntime } from '../../agent';
import { LLMExecution } from '../../services/llm/llmTypes';
import { AIMessage, AISession } from '../../services/llm/providers';
import { resolveChainTokenBudget } from '../../services/llm/inputTokenBudget';

describe('AgentRuntime token budgeting', () => {
    it('returns an observable partial result when no context epoch is available', async () => {
        const transcript: AIMessage[] = [];
        let calls = 0;
        const session: AISession = {
            provider: 'custom',
            model: 'test',
            run: async () => {
                calls += 1;
                throw new Error('The request should fail before reaching the provider.');
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
        const execution: LLMExecution = {
            model: 'test',
            temperature: 0,
            maxOutputTokens: tokenBudget.maxOutputTokens,
            maxRetries: 0,
            thinking: { reasoning: false, level: 'off' },
            tokenBudget,
            createSession: () => session,
            run: async () => { throw new Error('not used'); },
            accountCall: async () => ({ status: 'pricing-not-configured' as const }),
            getRecordedQuotes: () => [],
            notifyUsageCostIfEnabled: () => undefined,
        };
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'budget-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'budgetTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 0,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({
                stable: [{ role: 'system', content: 'protocol' }],
                opening: [{ role: 'user', content: 'x'.repeat(20_000) }],
            }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            normalizeFinal: raw => raw.value,
            preservePartialResult: (_state, error) => String((error as Error).message),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.match(result.output, /context budget/);
        assert.equal(calls, 0);
    });
});
