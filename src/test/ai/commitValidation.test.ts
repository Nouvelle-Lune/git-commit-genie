import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { validateAndFixCommit } from '../../services/chain/validation/commitValidation';
import { AIMessage, AISession } from '../../services/llm/providers';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';

describe('commit validation message preservation', () => {
    it('preserves the complete draft when the validator marks it valid', async () => {
        // Verify a valid verdict keeps the original body and footers even when the model echoes only the header.
        const original = 'refactor(agent): unify prompt layers\n\nKeep the stable protocol separate.\n\nRefs: #42';
        const result = await validateAndFixCommit(original, '', executionFor([{
                status: 'valid',
                // Some validators echo only the header even when they return a valid verdict.
                commitMessage: 'refactor(agent): unify prompt layers',
                violations: [],
                notes: null,
            }]));

        assert.equal(result.validMessage, original);
    });

    it('uses the validator message when it explicitly fixes the draft', async () => {
        // Verify an explicit fixed verdict replaces the draft with the validator's complete message.
        const fixed = 'fix(parser): normalize input';
        const result = await validateAndFixCommit('fix(parser): Normalize input.', '', executionFor([{
                status: 'fixed',
                commitMessage: fixed,
                violations: ['imperative mood'],
                notes: null,
            }]));

        assert.equal(result.validMessage, fixed);
    });

    it('retries until the fixer declares every required fact id preserved', async () => {
        // Verify missing preservedFactIds trigger a bounded correction request before accepting the fixed message.
        const messages: AIMessage[][] = [];
        const execution = executionFor([
            { status: 'fixed', commitMessage: 'fix(parser): normalize input', preservedFactIds: [], violations: ['missing fact'], notes: null },
            { status: 'fixed', commitMessage: 'fix(parser): normalize input to empty string', preservedFactIds: ['C1'], violations: [], notes: null },
        ], messages);

        const result = await validateAndFixCommit(
            'fix(parser): normalize input',
            '',
            execution,
            undefined,
            { requiredFacts: [{ id: 'C1', text: 'empty input normalizes to an empty string' }], optionalFacts: [] },
        );

        assert.equal(result.validMessage, 'fix(parser): normalize input to empty string');
        assert.deepEqual(result.preservedFactIds, ['C1']);
        assert.equal(messages.length, 2);
        assert.match(messages[1][0].content, /Missing ids: C1/);
    });

    it('throws after the configured fixer retries are exhausted', async () => {
        // Verify a fixer that never binds the required fact fails explicitly instead of returning an ungrounded message.
        const execution = executionFor([
            { status: 'fixed', commitMessage: 'fix(parser): normalize input', preservedFactIds: [], violations: [], notes: null },
            { status: 'fixed', commitMessage: 'fix(parser): normalize input', preservedFactIds: [], violations: [], notes: null },
        ]);

        await assert.rejects(
            validateAndFixCommit(
                'fix(parser): normalize input',
                '',
                execution,
                undefined,
                { requiredFacts: [{ id: 'C1', text: 'empty input normalizes to an empty string' }], optionalFacts: [] },
            ),
            /omitted required fact ids: C1/,
        );
    });
});

function executionFor(responses: unknown[], requests: AIMessage[][] = []): LLMExecution {
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
            requests.push(message);
            const response = responses[index];
            index += 1;
            assert.ok(response, `Unexpected fixer call ${index}.`);
            return response as T;
        },
        accountCall: async () => ({ status: 'pricing-not-configured' as const }),
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
    };
}
