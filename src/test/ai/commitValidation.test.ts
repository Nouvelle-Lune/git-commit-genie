import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { validateAndFixCommit } from '../../services/chain/validation/commitValidation';

describe('commit validation message preservation', () => {
    it('preserves the complete draft when the validator marks it valid', async () => {
        const original = 'refactor(agent): unify prompt layers\n\nKeep the stable protocol separate.\n\nRefs: #42';
        const result = await validateAndFixCommit(original, '', {
            createSession: () => ({}) as any,
            run: async () => ({
                status: 'valid',
                // Some validators echo only the header even when they return a valid verdict.
                commitMessage: 'refactor(agent): unify prompt layers',
                violations: [],
                notes: null,
            }),
        } as any);

        assert.equal(result.validMessage, original);
    });

    it('uses the validator message when it explicitly fixes the draft', async () => {
        const fixed = 'fix(parser): normalize input';
        const result = await validateAndFixCommit('fix(parser): Normalize input.', '', {
            createSession: () => ({}) as any,
            run: async () => ({
                status: 'fixed',
                commitMessage: fixed,
                violations: ['imperative mood'],
                notes: null,
            }),
        } as any);

        assert.equal(result.validMessage, fixed);
    });
});
