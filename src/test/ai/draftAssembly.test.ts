import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { assembleCommitMessage, generateDraft } from '../../services/chain/generation/draft';
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

        assert.throws(() => classifyAndDraftResponseSchema.parse({
            type: 'refactor',
            scope: 'C1',
            breaking: false,
            description: 'change the runtime',
            body: null,
            footers: [],
            notes: null,
        }), /Scope cannot be an internal claim or evidence identifier/);
    });

    it('rejects bracketed internal scopes and duplicate breaking footers', () => {
        assert.throws(() => classifyAndDraftResponseSchema.parse({
            type: 'refactor',
            scope: '[E4/P1]',
            breaking: false,
            description: 'tighten the runtime contract',
            body: null,
            footers: [],
            notes: null,
        }), /Scope cannot be an internal claim or evidence identifier/);

        assert.throws(() => classifyAndDraftResponseSchema.parse({
            type: 'refactor',
            scope: null,
            breaking: true,
            description: 'tighten the runtime contract',
            body: null,
            footers: [
                { token: 'BREAKING CHANGE', value: 'Consumers must update.' },
                { token: 'BREAKING CHANGE', value: 'The old shape is removed.' },
            ],
            notes: null,
        }), /Only one BREAKING CHANGE footer is allowed/);
    });

    it('preserves multiline body and footer values in conventional format', () => {
        const message = assembleCommitMessage(classifyAndDraftResponseSchema.parse({
            type: 'docs',
            scope: null,
            breaking: false,
            description: 'document the response contract',
            body: 'Explain the new fields.\nKeep the examples concise.',
            footers: [{ token: 'Refs', value: '#123\n#456' }],
            notes: null,
        }));

        assert.equal(
            message,
            'docs: document the response contract\n\n' +
            'Explain the new fields.\nKeep the examples concise.\n\n' +
            'Refs: #123\n #456',
        );
    });

    it('returns the assembled message from generateDraft so validation receives the body', async () => {
        const parsed = classifyAndDraftResponseSchema.parse({
            type: 'refactor',
            scope: 'agent',
            breaking: false,
            description: 'unify prompt layers',
            body: 'Keep the stable protocol separate from run-specific context.',
            footers: [{ token: 'Refs', value: '#42' }],
            notes: 'assembled locally',
        });
        const result = await generateDraft([], {
            createSession: () => ({}) as any,
            run: async () => parsed,
        } as any);

        assert.equal(
            result.draft,
            'refactor(agent): unify prompt layers\n\n' +
            'Keep the stable protocol separate from run-specific context.\n\n' +
            'Refs: #42',
        );
        assert.equal(result.notes, 'assembled locally');
    });
});
