import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { enforceCommitLanguage } from '../../services/chain/validation/languageValidation';
import { AIMessage, AISession } from '../../services/llm/providers';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';

describe('commit language fixer fact preservation', () => {
    it('returns a clearly matching message without invoking the language model', async () => {
        // Verify an already-English message takes the deterministic fast path and preserves its required fact.
        let calls = 0;
        const result = await enforceCommitLanguage(
            'fix(parser): normalize input',
            'en',
            executionFor([], () => { calls += 1; }),
            undefined,
            { requiredFacts: [{ id: 'C1', text: 'normalizes input' }], optionalFacts: [] },
        );

        assert.equal(result, 'fix(parser): normalize input');
        assert.equal(calls, 0);
    });

    it('retries when the language fixer omits a required fact id', async () => {
        // Verify language rewriting is accepted only after preservedFactIds covers every required fact.
        const messages: AIMessage[][] = [];
        const execution = executionFor([
            { commitMessage: 'fix(parser): 输入规范化', preservedFactIds: [] },
            { commitMessage: 'fix(parser): 将输入规范化', preservedFactIds: ['C1'] },
        ], undefined, messages);

        const result = await enforceCommitLanguage(
            'fix(parser): normalize input',
            'zh',
            execution,
            undefined,
            { requiredFacts: [{ id: 'C1', text: 'normalizes input' }], optionalFacts: [] },
        );

        assert.equal(result, 'fix(parser): 将输入规范化');
        assert.equal(messages.length, 2);
        assert.match(messages[1][0].content, /Missing required fact ids: C1/);
    });

    it('throws when language-fixer retries are exhausted without preserved ids', async () => {
        // Verify an unbound required fact is an explicit language-stage failure rather than a silent rewrite.
        const execution = executionFor([
            { commitMessage: 'fix(parser): 输入规范化', preservedFactIds: [] },
            { commitMessage: 'fix(parser): 输入规范化', preservedFactIds: [] },
        ]);

        await assert.rejects(
            enforceCommitLanguage(
                'fix(parser): normalize input',
                'zh',
                execution,
                undefined,
                { requiredFacts: [{ id: 'C1', text: 'normalizes input' }], optionalFacts: [] },
            ),
            /omitted required fact ids: C1/,
        );
    });
});

function executionFor(
    responses: unknown[],
    onCall?: () => void,
    requests: AIMessage[][] = [],
): LLMExecution {
    let index = 0;
    const session: AISession = {
        provider: 'custom',
        model: 'test',
        run: async () => { throw new Error('Direct session execution is not expected.'); },
        snapshot: () => ({
            provider: 'custom',
            model: 'test',
            continuation: { serverManaged: false },
            transcript: [],
        }),
    };
    return {
        model: 'test',
        temperature: 0,
        maxOutputTokens: 128,
        maxRetries: 1,
        thinking: { reasoning: false, level: 'off' },
        tokenBudget: {} as LLMExecution['tokenBudget'],
        signal: undefined,
        createSession: () => session,
        run: async <T>(_session: AISession, message: AIMessage[], _options: LLMRunOptions): Promise<T> => {
            onCall?.();
            requests.push(message);
            const response = responses[index];
            index += 1;
            assert.ok(response, `Unexpected language fixer call ${index}.`);
            return response as T;
        },
        accountCall: async () => ({ status: 'pricing-not-configured' as const }),
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
    };
}
