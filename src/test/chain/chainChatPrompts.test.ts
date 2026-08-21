import { describe, it } from 'mocha';
import * as assert from 'assert';
import {
    buildClassifyAndDraftMessages,
    buildRagPreparationMessages,
} from '../../services/chain/chainChatPrompts';
import { DraftEvidence } from '../../services/chain/chainTypes';

const mixedEvidence: DraftEvidence[] = [
    {
        kind: 'raw',
        fileName: 'src/raw.ts',
        status: 'modified',
        rawDiff: 'diff --git a/src/raw.ts b/src/raw.ts\n+export const rawEvidence = true;',
    },
    {
        kind: 'summary',
        fileName: 'src/summary.ts',
        status: 'modified',
        coveredHunkIds: ['h1'],
        changes: [{
            action: 'update',
            target: 'summaryEvidence',
            behavior: 'preserves hunk-grounded observations',
            exactSymbols: ['summaryEvidence'],
            evidenceHunkIds: ['h1'],
        }],
        tests: [],
        breakingSignals: [],
        uncertainties: [],
    },
];

describe('Thinking mixed evidence prompts', () => {
    it('uses the same raw and structured evidence payload for draft and RAG preparation', () => {
        const inputs = {
            diffs: [],
            targetLanguage: 'en',
        };
        const draftPrompt = buildClassifyAndDraftMessages(mixedEvidence, inputs)[1].content;
        const ragPrompt = buildRagPreparationMessages(mixedEvidence)[1].content;

        for (const prompt of [draftPrompt, ragPrompt]) {
            assert.match(prompt, /src\/raw\.ts/);
            assert.match(prompt, /rawEvidence/);
            assert.match(prompt, /src\/summary\.ts/);
            assert.match(prompt, /summaryEvidence/);
            assert.match(prompt, /"kind": "raw"/);
            assert.match(prompt, /"kind": "summary"/);
        }

        assert.doesNotMatch(draftPrompt, /file_summaries/);
        assert.doesNotMatch(ragPrompt, /file_summaries/);
    });

    it('keeps hunk references in the structured evidence sent to the model', () => {
        const ragPrompt = buildRagPreparationMessages(mixedEvidence)[1].content;

        assert.match(ragPrompt, /"coveredHunkIds": \[\s*"h1"\s*\]/);
        assert.match(ragPrompt, /"evidenceHunkIds": \[\s*"h1"\s*\]/);
    });
});
