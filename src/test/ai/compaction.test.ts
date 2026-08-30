import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { compactEvidenceToFit, createRawDraftEvidence } from '../../services/chain/evidence/compaction';
import { DiffData } from '../../services/git/gitTypes';
import { LLMExecution } from '../../services/llm/llmTypes';

function diff(fileName: string, content: string): DiffData {
    return {
        fileName,
        status: 'modified',
        rawDiff: content,
        diffHunks: [{
            header: '@@ -1 +1 @@',
            content,
            additions: [content],
            deletions: [],
        }],
    };
}

function fakeExecution(): LLMExecution {
    return {
        signal: undefined,
        temperature: 0,
        maxOutputTokens: 128,
        maxRetries: 0,
        thinkingLevel: 'off',
        tokenBudget: {} as any,
        thinkingFor: () => ({ reasoning: false, level: 'off' }),
        createSession: () => ({
            provider: 'custom',
            model: 'test',
            run: async () => { throw new Error('unused'); },
            snapshot: () => ({
                provider: 'custom',
                model: 'test',
                continuation: { serverManaged: false },
                transcript: [],
            }),
        }),
        run: async () => ({
            changes: [],
            tests: [],
            breakingSignals: [],
            uncertainties: [{ detail: 'grounded', evidenceHunkIds: ['h1'] }],
        }),
    } as unknown as LLMExecution;
}

describe('evidence compaction state machine', () => {
    it('compacts only after the trigger and converges to the target', async () => {
        const diffs = [diff('a.ts', 'a'.repeat(1_200)), diff('b.ts', 'b'.repeat(200))];
        const rawEvidence = createRawDraftEvidence(diffs);
        const events: string[] = [];
        const result = await compactEvidenceToFit({
            diffs,
            evidence: rawEvidence,
            execution: fakeExecution(),
            triggerInputTokens: 300,
            targetInputTokens: 270,
            hardInputTokens: 10_000,
            maxParallel: 1,
            maxRetries: 0,
            buildTargetMessages: evidence => [{
                role: 'user',
                content: JSON.stringify(evidence),
            }],
            onSummarizeStart: () => events.push('start'),
            onFileSummarized: file => events.push(`file:${file.fileName}`),
        });

        assert.equal(result.didSummarize, true);
        assert.ok(result.initialEstimatedInputTokens > 300);
        assert.ok(result.estimatedInputTokens <= 270);
        assert.deepEqual(events, ['start', 'file:a.ts']);
        assert.equal(result.evidence[0].kind, 'summary');
        assert.equal(result.evidence[1].kind, 'raw');
    });

    it('performs deterministic secondary tightening after every raw item is summarized', async () => {
        const diffs = [diff('a.ts', 'a'.repeat(700))];
        const result = await compactEvidenceToFit({
            diffs,
            evidence: createRawDraftEvidence(diffs),
            execution: fakeExecution(),
            triggerInputTokens: 100,
            targetInputTokens: 1,
            hardInputTokens: 10_000,
            maxParallel: 1,
            maxRetries: 0,
            buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
        }).catch(error => error as Error);

        assert.match((result as Error).message, /secondary compaction/);
    });
});
