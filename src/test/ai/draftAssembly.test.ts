import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { assembleCommitMessage } from '../../services/chain/generation/draft';
import { classifyAndDraftResponseSchema } from '../../services/llm/providers/schemas/common';

describe('structured draft assembly', () => {
    it('assembles header, body, and footers without a model-generated aggregate field', () => {
        const schema = z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>;
        const message = assembleCommitMessage(classifyAndDraftResponseSchema.parse({
            type: 'refactor',
            scope: 'agent',
            breaking: false,
            description: 'unify analysis runtime',
            body: 'Run change and repository analysis through shared runtime profiles.',
            footers: [{ token: 'Refs', value: '#123' }],
            notes: null,
        }));

        assert.equal(
            message,
            'refactor(agent): unify analysis runtime\n\n' +
            'Run change and repository analysis through shared runtime profiles.\n\n' +
            'Refs: #123',
        );
        assert.equal(JSON.stringify(schema).includes('commitMessage'), false);
    });

    it('uses a breaking marker when no breaking footer was provided', () => {
        const message = assembleCommitMessage(classifyAndDraftResponseSchema.parse({
            type: 'feat',
            scope: 'api',
            breaking: true,
            description: 'replace the response contract',
            body: null,
            footers: [],
            notes: null,
        }));

        assert.equal(message, 'feat(api)!: replace the response contract');
    });

    it('uses the explicit breaking footer instead of duplicating the marker', () => {
        const message = assembleCommitMessage(classifyAndDraftResponseSchema.parse({
            type: 'refactor',
            scope: null,
            breaking: true,
            description: 'replace the analysis contract',
            body: 'Move callers to the compound terminal.',
            footers: [{ token: 'BREAKING CHANGE', value: 'Consumers must read the new result shape.' }],
            notes: null,
        }));

        assert.equal(
            message,
            'refactor: replace the analysis contract\n\n' +
            'Move callers to the compound terminal.\n\n' +
            'BREAKING CHANGE: Consumers must read the new result shape.',
        );
    });

    it('rejects a breaking footer when breaking is false and internal trace scopes locally', () => {
        assert.throws(() => classifyAndDraftResponseSchema.parse({
            type: 'refactor',
            scope: null,
            breaking: false,
            description: 'change the contract',
            body: null,
            footers: [{ token: 'BREAKING CHANGE', value: 'Invalid mismatch.' }],
            notes: null,
        }), /BREAKING CHANGE footer requires breaking=true/);

        const draft = classifyAndDraftResponseSchema.parse({
            type: 'refactor',
            scope: 'C1',
            breaking: false,
            description: 'change the runtime',
            body: null,
            footers: [],
            notes: null,
        });
        assert.throws(() => assembleCommitMessage(draft), /internal trace identifier/);
    });
});
