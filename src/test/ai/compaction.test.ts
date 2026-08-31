import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    compactEvidenceToFit,
    createRawDraftEvidence,
    createSummaryTaskScheduler,
} from '../../services/chain/evidence/compaction';
import { EvidenceLedger } from '../../agent';
import { DiffData } from '../../services/git/gitTypes';
import { LLMExecution } from '../../services/llm/llmTypes';
import { DraftEvidence } from '../../services/analysis/change/types';

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
            uncertainties: [{ detail: 'grounded', evidenceHunkIds: ['D1'] }],
        }),
    } as unknown as LLMExecution;
}

describe('evidence compaction state machine', () => {
    it('compacts only after the trigger and converges to the target', async () => {
        const diffs = [diff('a.ts', 'a'.repeat(1_200)), diff('b.ts', 'b'.repeat(200))];
        const ledger = EvidenceLedger.fromDiffs(diffs);
        const rawEvidence = createRawDraftEvidence(diffs, ledger);
        const events: string[] = [];
        const result = await compactEvidenceToFit({
            diffs,
            evidence: rawEvidence,
            ledger,
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
        const ledger = EvidenceLedger.fromDiffs(diffs);
        const result = await compactEvidenceToFit({
            diffs,
            evidence: createRawDraftEvidence(diffs, ledger),
            ledger,
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

    it('deduplicates concurrent summaries across the agent and RAG evidence branches', async () => {
        const diffs = [diff('a.ts', 'a'.repeat(1_200))];
        const ledger = EvidenceLedger.fromDiffs(diffs);
        const summaryStore = new Map<string, Promise<Extract<DraftEvidence, { kind: 'summary' }>>>();
        const scheduler = createSummaryTaskScheduler(2);
        const execution = fakeExecution();
        let summaryCalls = 0;
        execution.run = async <T>() => {
            summaryCalls += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            return {
                changes: [{
                    action: 'update',
                    target: 'parser',
                    behavior: 'changes branch',
                    exactSymbols: [],
                    evidenceHunkIds: ['D1'],
                }],
                tests: [],
                breakingSignals: [],
                uncertainties: [],
            } as T;
        };
        const buildTargetMessages = (evidence: DraftEvidence[]) => [{
            role: 'user' as const,
            content: JSON.stringify(evidence),
        }];
        const run = () => compactEvidenceToFit({
            diffs,
            evidence: createRawDraftEvidence(diffs, ledger),
            execution,
            ledger,
            summaryStore,
            summaryScheduler: scheduler,
            triggerInputTokens: 100,
            targetInputTokens: 90,
            hardInputTokens: 10_000,
            maxParallel: 2,
            maxRetries: 0,
            buildTargetMessages,
        });

        const [agentBranch, ragBranch] = await Promise.all([run(), run()]);

        assert.equal(summaryCalls, 1);
        assert.deepEqual(agentBranch.evidence[0].kind, 'summary');
        assert.deepEqual(ragBranch.evidence[0].kind, 'summary');
    });
});
