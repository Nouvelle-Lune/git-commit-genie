import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { checkConventionalCommitHeader, validateAndFixCommit } from '../../services/chain/validation/commitValidation';
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

    it('asks the fact fixer for the meaning of facts that no part of the message entails', async () => {
        // Verify the retry request keeps the literal missing-id list and asks only for the unentailed meaning,
        // instead of letting the fixer pad the message until every fact becomes explicit.
        const messages: AIMessage[][] = [];
        const execution = executionFor([
            { status: 'fixed', commitMessage: 'fix(parser): normalize input', preservedFactIds: [], violations: [], notes: null },
            { status: 'fixed', commitMessage: 'fix(parser): normalize input to empty string', preservedFactIds: ['C1'], violations: [], notes: null },
        ], messages);

        await validateAndFixCommit(
            'fix(parser): normalize input',
            '',
            execution,
            undefined,
            { requiredFacts: [{ id: 'C1', text: 'empty input normalizes to an empty string' }], optionalFacts: [] },
        );

        const retry = messages[1][0].content;
        assert.match(retry, /Missing ids: C1/);
        assert.match(retry, /add only the meaning of an id that no part of the message entails/);
        assert.doesNotMatch(retry, /repair only the missing fact coverage/);
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

describe('commit header format check', () => {
    it('accepts a well-formed header longer than 72 characters without reporting a length problem', () => {
        // Verify the checker no longer enforces the 72-character limit: a shape-valid first line of 72, 73, or
        // 120 characters stays ok with an empty problems list, so length alone can no longer produce a warning
        // badge or an extra validate-fix round.
        for (const length of [72, 73, 120]) {
            const result = checkConventionalCommitHeader(headerOfLength(length));

            assert.deepEqual(result, { ok: true, problems: [] });
            assert.doesNotMatch(result.problems.join(' '), /Header length|72 characters/);
        }
    });

    it('still rejects a header that is not a Conventional Commits header', () => {
        // Verify dropping the length rule did not weaken the shape check: headers without a type prefix, without
        // a colon, or invalid AND longer than 72 characters still fail with exactly the documented problem, which
        // proves no length problem is appended any more.
        const invalid = [
            'normalize empty input',
            'feat normalize empty input',
            headerOfNonCommitLength(80),
        ];

        for (const message of invalid) {
            const result = checkConventionalCommitHeader(message);

            assert.equal(result.ok, false);
            assert.deepEqual(result.problems, ['Header must match <type>[optional scope][!]: <description>.']);
        }
    });
});

/** Builds a shape-valid header whose total length is exactly `length` characters. */
function headerOfLength(length: number): string {
    const prefix = 'fix(parser): ';
    return prefix + 'a'.repeat(length - prefix.length);
}

/** Builds a header of the requested length that fails the Conventional Commits shape check. */
function headerOfNonCommitLength(length: number): string {
    return 'a'.repeat(length);
}

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
