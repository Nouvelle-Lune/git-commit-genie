import { describe, it } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ChatFn, ChatMessage } from '../../services/llm/llmTypes';
import { DiffData } from '../../services/git/gitTypes';
import {
    compactEvidenceToFit,
    createRawDraftEvidence,
    summarizeFileEvidence,
} from '../../services/chain/dynamicSummary';
import { estimateChatMessagesTokens } from '../../services/chain/tokenBudget';
import { generateCommitMessageChain } from '../../services/chain/chainThinking';
import { StageEvent } from '../../ui/StageNotificationManager';

function makeDiff(fileName: string, content: string): DiffData {
    return {
        fileName,
        status: 'modified',
        rawDiff: `diff --git a/${fileName} b/${fileName}\n@@ -1 +1 @@\n${content}`,
        diffHunks: [{
            header: '@@ -1 +1 @@',
            content,
            additions: content.split('\n').filter(line => line.startsWith('+')),
            deletions: content.split('\n').filter(line => line.startsWith('-')),
        }],
    };
}

function summaryResponseFor(messages: ChatMessage[]) {
    const hunkIds = Array.from(messages[1].content.matchAll(/"id": "([^"]+)"/g), match => match[1]);
    return {
        changes: hunkIds.map(id => ({
            action: 'update',
            target: 'largeFile',
            behavior: `captures ${id}`,
            exactSymbols: [],
            evidenceHunkIds: [id],
        })),
        tests: [],
        breakingSignals: [],
        uncertainties: [],
    };
}

describe('dynamic Thinking evidence compaction', () => {
    it('keeps Summary failures separate from RAG preparation failures', async () => {
        const configStub = sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => ({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (section === 'gitCommitGenie.rag' && key === 'enabled') {
                    return true as T;
                }
                return defaultValue;
            },
        } as vscode.WorkspaceConfiguration));
        const events: StageEvent[] = [];
        const diff = makeDiff('src/large.ts', `-${'a'.repeat(8_000)}\n+${'b'.repeat(8_000)}`);
        const chat: ChatFn = async (_messages, options) => {
            if (options?.requestType === 'summary') {
                throw new Error('summary context limit exceeded');
            }
            throw new Error(`Unexpected request type '${options?.requestType}'.`);
        };

        try {
            await assert.rejects(
                () => generateCommitMessageChain(
                    { diffs: [diff] },
                    chat,
                    {
                        maxInputTokens: 1_200,
                        maxParallel: 2,
                        onStage: event => events.push(event),
                    }
                ),
                /summary context limit exceeded/
            );
        } finally {
            configStub.restore();
        }

        assert.deepStrictEqual(
            events.filter(event => event.type === 'summarizeFailed').map(event => event.data?.target),
            ['ragPreparation', 'draft']
        );
        assert.strictEqual(events.some(event => event.type === 'ragPreparationStart'), false);
        assert.strictEqual(events.some(event => event.type === 'ragPreparationSkipped'), false);
    });

    it('keeps genuine RAG preparation failures on the RAG stage', async () => {
        const configStub = sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => ({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (section === 'gitCommitGenie.rag' && key === 'enabled') {
                    return true as T;
                }
                return defaultValue;
            },
        } as vscode.WorkspaceConfiguration));
        const events: StageEvent[] = [];
        const chat: ChatFn = async (_messages, options) => {
            if (options?.requestType === 'ragPreparation') {
                throw new Error('RAG query construction failed');
            }
            if (options?.requestType === 'draft') {
                return { commitMessage: 'chore: update parser' };
            }
            return {};
        };

        try {
            const result = await generateCommitMessageChain(
                { diffs: [makeDiff('src/parser.ts', '-old\n+new')] },
                chat,
                {
                    maxInputTokens: 10_000,
                    maxParallel: 2,
                    onStage: event => events.push(event),
                }
            );

            assert.strictEqual(result.commitMessage, 'chore: update parser');
        } finally {
            configStub.restore();
        }

        assert.strictEqual(events.some(event => event.type === 'summarizeFailed'), false);
        assert.deepStrictEqual(
            events.filter(event => event.type === 'ragPreparationSkipped').map(event => event.data?.error),
            ['RAG query construction failed']
        );
    });

    it('keeps complete raw diffs when the target request already fits', async () => {
        const diffs = [makeDiff('src/small.ts', '-old\n+new')];
        let chatCalls = 0;
        const chat: ChatFn = async () => {
            chatCalls += 1;
            throw new Error('summary should not be requested');
        };

        const result = await compactEvidenceToFit({
            diffs,
            evidence: createRawDraftEvidence(diffs),
            chat,
            maxInputTokens: 10_000,
            maxParallel: 2,
            buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
        });

        assert.strictEqual(result.didSummarize, false);
        assert.strictEqual(result.initialEstimatedInputTokens, result.estimatedInputTokens);
        assert.ok(result.estimatedInputTokens < 10_000);
        assert.strictEqual(result.evidence[0].kind, 'raw');
        assert.strictEqual((result.evidence[0] as { kind: 'raw'; rawDiff: string }).rawDiff, diffs[0].rawDiff);
        assert.strictEqual(chatCalls, 0);
    });

    it('rejects a non-positive parallelism setting before inspecting evidence', async () => {
        const diffs = [makeDiff('src/small.ts', '-old\n+new')];
        const chat: ChatFn = async () => {
            throw new Error('summary should not be requested');
        };

        await assert.rejects(
            () => compactEvidenceToFit({
                diffs,
                evidence: createRawDraftEvidence(diffs),
                chat,
                maxInputTokens: 10_000,
                maxParallel: 0,
                buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
            }),
            /maxParallel must be a positive integer/
        );
    });

    it('summarizes the largest raw file by budget-sized hunk chunks', async () => {
        const diffs = [
            makeDiff('src/small.ts', '-old\n+new'),
            makeDiff('src/large.ts', `-${'a'.repeat(8_000)}\n+${'b'.repeat(8_000)}`),
        ];
        const maxInputTokens = 1_200;
        const summaryPromptSizes: number[] = [];
        const chat: ChatFn = async messages => {
            summaryPromptSizes.push(estimateChatMessagesTokens(messages));
            return summaryResponseFor(messages);
        };

        const result = await compactEvidenceToFit({
            diffs,
            evidence: createRawDraftEvidence(diffs),
            chat,
            maxInputTokens,
            maxParallel: 3,
            buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
        });

        assert.strictEqual(result.didSummarize, true);
        assert.ok(result.initialEstimatedInputTokens > maxInputTokens);
        assert.ok(result.estimatedInputTokens <= maxInputTokens);
        assert.strictEqual(result.evidence[0].kind, 'raw');
        assert.strictEqual(result.evidence[1].kind, 'summary');
        assert.ok(summaryPromptSizes.length > 1, 'the oversized hunk should be split into multiple requests');
        assert.ok(summaryPromptSizes.every(tokens => tokens <= maxInputTokens));
    });

    it('summarizes multiple necessary files concurrently within one global limit', async () => {
        const diffs = Array.from({ length: 6 }, (_, index) => makeDiff(
            `src/file-${index + 1}.ts`,
            `-${String.fromCharCode(97 + index).repeat(1_400)}\n+${String.fromCharCode(65 + index).repeat(1_400)}`
        ));
        let activeCalls = 0;
        let peakCalls = 0;
        const chat: ChatFn = async messages => {
            activeCalls += 1;
            peakCalls = Math.max(peakCalls, activeCalls);
            await new Promise(resolve => setTimeout(resolve, 10));
            activeCalls -= 1;
            return summaryResponseFor(messages);
        };

        const result = await compactEvidenceToFit({
            diffs,
            evidence: createRawDraftEvidence(diffs),
            chat,
            maxInputTokens: 1_800,
            maxParallel: 3,
            buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
        });

        const summarizedFiles = result.evidence.filter(item => item.kind === 'summary').length;
        assert.ok(summarizedFiles > 1, 'the budget should require more than one file summary');
        assert.ok(peakCalls > 1, 'independent file summaries should overlap');
        assert.ok(peakCalls <= 3, 'file and chunk requests must share maxParallel');
        assert.ok(result.estimatedInputTokens <= 1_800);
    });

    it('selects only the necessary files when one summary is enough to fit the budget', async () => {
        const diffs = [
            makeDiff('src/small-a.ts', '-old\n+new'),
            makeDiff('src/large.ts', `-${'a'.repeat(3_000)}\n+${'b'.repeat(3_000)}`),
            makeDiff('src/small-b.ts', '-before\n+after'),
        ];
        const summarizedFiles: string[] = [];
        const chat: ChatFn = async messages => summaryResponseFor(messages);

        const result = await compactEvidenceToFit({
            diffs,
            evidence: createRawDraftEvidence(diffs),
            chat,
            maxInputTokens: 1_200,
            maxParallel: 3,
            buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
            onFileSummarized: file => summarizedFiles.push(file.fileName),
        });

        assert.deepStrictEqual(summarizedFiles, ['src/large.ts']);
        assert.deepStrictEqual(result.evidence.map(item => item.kind), ['raw', 'summary', 'raw']);
        assert.ok(result.estimatedInputTokens <= 1_200);
    });

    it('keeps evidence in original file order when concurrent summaries finish out of order', async () => {
        const diffs = [
            makeDiff('src/first.ts', `-${'a'.repeat(1_600)}\n+${'A'.repeat(1_600)}`),
            makeDiff('src/second.ts', `-${'b'.repeat(2_400)}\n+${'B'.repeat(2_400)}`),
            makeDiff('src/third.ts', `-${'c'.repeat(1_800)}\n+${'C'.repeat(1_800)}`),
        ];
        const chat: ChatFn = async messages => {
            const fileName = messages[1].content.match(/"file": "([^"]+)"/)?.[1] || '';
            await new Promise(resolve => setTimeout(resolve, fileName.includes('second') ? 20 : 0));
            return summaryResponseFor(messages);
        };

        const result = await compactEvidenceToFit({
            diffs,
            evidence: createRawDraftEvidence(diffs),
            chat,
            maxInputTokens: 1_600,
            maxParallel: 3,
            buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
        });

        assert.deepStrictEqual(
            result.evidence.map(item => item.fileName),
            diffs.map(diff => diff.fileName)
        );
        assert.deepStrictEqual(
            result.evidence.map(item => item.kind),
            ['raw', 'summary', 'summary']
        );
    });

    it('keeps rename and mode metadata as evidence when a file has parsed hunks', async () => {
        const diff: DiffData = {
            fileName: 'src/renamed.ts',
            status: 'renamed',
            rawDiff: [
                'diff --git a/src/old.ts b/src/renamed.ts',
                'old mode 100644',
                'new mode 100755',
                'similarity index 92%',
                'rename from src/old.ts',
                'rename to src/renamed.ts',
                '@@ -1 +1 @@',
                '-old',
                '+new',
            ].join('\n'),
            diffHunks: [{
                header: '@@ -1 +1 @@',
                content: '-old\n+new',
                additions: ['+new'],
                deletions: ['-old'],
            }],
        };
        let summaryPrompt = '';
        const chat: ChatFn = async messages => {
            summaryPrompt += messages[1].content;
            return summaryResponseFor(messages);
        };

        const result = await summarizeFileEvidence(diff, chat, 10_000, 1);

        assert.match(summaryPrompt, /old mode 100644/);
        assert.match(summaryPrompt, /rename from src\/old\.ts/);
        assert.deepStrictEqual(result.coveredHunkIds, ['meta', 'h1']);
    });

    it('does not require a reference to structural-only diff metadata', async () => {
        const diff = makeDiff('src/ordinary.ts', '-old\n+new');
        const chat: ChatFn = async () => ({
            changes: [{
                action: 'update',
                target: 'ordinary',
                behavior: 'updates the content hunk',
                exactSymbols: [],
                evidenceHunkIds: ['h1'],
            }],
            tests: [],
            breakingSignals: [],
            uncertainties: [],
        });

        const result = await summarizeFileEvidence(diff, chat, 10_000, 1);

        assert.deepStrictEqual(result.coveredHunkIds, ['meta', 'h1']);
        assert.deepStrictEqual(result.changes[0].evidenceHunkIds, ['h1']);
    });

    it('still requires a reference to rename and mode metadata', async () => {
        const diff: DiffData = {
            fileName: 'src/renamed.ts',
            status: 'renamed',
            rawDiff: [
                'diff --git a/src/old.ts b/src/renamed.ts',
                'old mode 100644',
                'new mode 100755',
                'rename from src/old.ts',
                'rename to src/renamed.ts',
                '@@ -1 +1 @@',
                '-old',
                '+new',
            ].join('\n'),
            diffHunks: [{
                header: '@@ -1 +1 @@',
                content: '-old\n+new',
                additions: ['+new'],
                deletions: ['-old'],
            }],
        };
        const chat: ChatFn = async () => ({
            changes: [{
                action: 'update',
                target: 'renamed',
                behavior: 'updates the content hunk',
                exactSymbols: [],
                evidenceHunkIds: ['h1'],
            }],
            tests: [],
            breakingSignals: [],
            uncertainties: [],
        });

        await assert.rejects(
            () => summarizeFileEvidence(diff, chat, 10_000, 1),
            /omitted hunk ids: meta/
        );
    });

    it('preserves optional structural metadata coverage across split meta chunks', async () => {
        const fileName = 'src/large-meta.ts';
        const rawDiff = [
            `diff --git a/${fileName} b/${fileName}`,
            ...Array.from({ length: 12 }, (_, index) => `index ${index.toString(16).padStart(2, '0')}${'a'.repeat(360)} ${'b'.repeat(360)}`),
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n');
        const diff: DiffData = {
            fileName,
            status: 'modified',
            rawDiff,
            diffHunks: [{
                header: '@@ -1 +1 @@',
                content: '-old\n+new',
                additions: ['+new'],
                deletions: ['-old'],
            }],
        };
        const observedIds: string[] = [];
        const chat: ChatFn = async messages => {
            const ids = Array.from(messages[1].content.matchAll(/"id": "([^"]+)"/g), match => match[1]);
            observedIds.push(...ids);
            const contentIds = ids.filter(id => !id.startsWith('meta'));
            return {
                changes: contentIds.map(id => ({
                    action: 'update',
                    target: 'largeMeta',
                    behavior: `captures ${id}`,
                    exactSymbols: [],
                    evidenceHunkIds: [id],
                })),
                tests: [],
                breakingSignals: [],
                uncertainties: [],
            };
        };

        const result = await summarizeFileEvidence(diff, chat, 1_200, 1);

        assert.ok(observedIds.filter(id => id.startsWith('meta:p')).length > 1,
            'structural metadata should be split into multiple chunks');
        assert.ok(result.coveredHunkIds.every(id => observedIds.includes(id)));
        assert.deepStrictEqual(result.changes.map(change => change.evidenceHunkIds), [['h1']]);
    });

    it('preserves source chunk order when summary calls finish out of order', async () => {
        const diff = makeDiff('src/ordered.ts', `-${'a'.repeat(10_000)}\n+${'b'.repeat(10_000)}`);
        const observedIds: string[] = [];
        const chat: ChatFn = async messages => {
            const ids = Array.from(messages[1].content.matchAll(/"id": "([^"]+)"/g), match => match[1]);
            const id = ids[0];
            observedIds.push(id);
            // Force later chunks to complete first so the worker completion order differs.
            await new Promise(resolve => setTimeout(resolve, id.endsWith('p1') ? 10 : 0));
            return summaryResponseFor(messages);
        };

        const result = await summarizeFileEvidence(diff, chat, 1_200, 3);
        const returnedIds = result.changes.flatMap(change => change.evidenceHunkIds);

        assert.ok(observedIds.length > 2, 'the oversized hunk should produce several chunks');
        assert.deepStrictEqual(returnedIds, observedIds.slice().sort((left, right) => {
            const leftIndex = observedIds.indexOf(left);
            const rightIndex = observedIds.indexOf(right);
            return leftIndex - rightIndex;
        }));
        assert.deepStrictEqual(returnedIds, [...returnedIds].sort((left, right) => {
            const leftNumber = Number(left.match(/p(\d+)$/)?.[1] || 0);
            const rightNumber = Number(right.match(/p(\d+)$/)?.[1] || 0);
            return leftNumber - rightNumber;
        }));
    });

    it('rejects model evidence that references a hunk outside the current chunk', async () => {
        const diff = makeDiff('src/invalid.ts', '-old\n+new');
        const chat: ChatFn = async () => ({
            changes: [{
                action: 'update',
                target: 'invalid',
                behavior: 'references missing evidence',
                exactSymbols: [],
                evidenceHunkIds: ['h999'],
            }],
            tests: [],
            breakingSignals: [],
            uncertainties: [],
        });

        await assert.rejects(
            () => summarizeFileEvidence(diff, chat, 4_096, 1),
            /referenced unknown hunk ids: h999/
        );
    });

    it('fails explicitly when the model omits a provided hunk id', async () => {
        const diff: DiffData = {
            fileName: 'src/omitted.ts',
            status: 'modified',
            rawDiff: 'diff --git a/src/omitted.ts b/src/omitted.ts\n@@ -1 +1 @@\n-old\n+new',
            diffHunks: [
                {
                    header: '@@ -1 +1 @@',
                    content: '-old\n+new',
                    additions: ['+new'],
                    deletions: ['-old'],
                },
                {
                    header: '@@ -10 +10 @@',
                    content: '-before\n+after',
                    additions: ['+after'],
                    deletions: ['-before'],
                },
            ],
        };
        const chat: ChatFn = async () => ({
            changes: [{
                action: 'update',
                target: 'onlyFirstHunk',
                behavior: 'does not cover the second hunk',
                exactSymbols: [],
                evidenceHunkIds: ['h1'],
            }],
            tests: [],
            breakingSignals: [],
            uncertainties: [],
        });

        await assert.rejects(
            () => summarizeFileEvidence(diff, chat, 10_000, 1),
            /omitted hunk ids: .*h2/
        );
    });

    it('fails explicitly when all summarized evidence still exceeds the target budget', async () => {
        const diffs = [makeDiff('src/small.ts', '-old\n+new')];
        const chat: ChatFn = async messages => summaryResponseFor(messages);

        await assert.rejects(
            () => compactEvidenceToFit({
                diffs,
                evidence: createRawDraftEvidence(diffs),
                chat,
                maxInputTokens: 700,
                maxParallel: 1,
                buildTargetMessages: evidence => [{
                    role: 'user',
                    content: `${JSON.stringify(evidence)}${'x'.repeat(4_000)}`,
                }],
            }),
            /after every file was summarized/
        );
    });

    it('propagates a summary request failure without returning partial evidence', async () => {
        const diffs = [
            makeDiff('src/failing.ts', `-${'a'.repeat(3_000)}\n+${'b'.repeat(3_000)}`),
            makeDiff('src/queued.ts', `-${'c'.repeat(3_000)}\n+${'d'.repeat(3_000)}`),
        ];
        const failure = new Error('summary provider unavailable');
        let chatCalls = 0;
        const chat: ChatFn = async () => {
            chatCalls += 1;
            throw failure;
        };

        await assert.rejects(
            () => compactEvidenceToFit({
                diffs,
                evidence: createRawDraftEvidence(diffs),
                chat,
                maxInputTokens: 1_000,
                maxParallel: 2,
                buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
            }),
            error => error === failure
        );
        assert.ok(chatCalls > 0);
    });

    it('drains sibling summary requests before propagating a batch failure', async () => {
        const diffs = [
            makeDiff('src/failing.ts', `-${'a'.repeat(1_600)}\n+${'A'.repeat(1_600)}`),
            makeDiff('src/slow.ts', `-${'b'.repeat(1_600)}\n+${'B'.repeat(1_600)}`),
        ];
        const failure = new Error('first summary failed');
        let slowSummaryCompleted = false;
        const chat: ChatFn = async messages => {
            const fileName = messages[1].content.match(/"file": "([^"]+)"/)?.[1] || '';
            if (fileName === 'src/failing.ts') {
                throw failure;
            }
            await new Promise(resolve => setTimeout(resolve, 25));
            slowSummaryCompleted = true;
            return summaryResponseFor(messages);
        };

        await assert.rejects(
            () => compactEvidenceToFit({
                diffs,
                evidence: createRawDraftEvidence(diffs),
                chat,
                maxInputTokens: 800,
                maxParallel: 2,
                buildTargetMessages: evidence => [{ role: 'user', content: JSON.stringify(evidence) }],
            }),
            error => error === failure
        );
        assert.strictEqual(slowSummaryCompleted, true);
    });

    it('reports a missing DiffData entry instead of silently dropping a selected file', async () => {
        const diff = makeDiff('src/known.ts', `-${'a'.repeat(3_000)}\n+${'b'.repeat(3_000)}`);
        const evidence = createRawDraftEvidence([diff]);
        evidence[0] = { ...evidence[0], fileName: 'src/missing.ts' };

        await assert.rejects(
            () => compactEvidenceToFit({
                diffs: [diff],
                evidence,
                chat: async () => summaryResponseFor([]),
                maxInputTokens: 1_000,
                maxParallel: 1,
                buildTargetMessages: current => [{ role: 'user', content: JSON.stringify(current) }],
            }),
            /Missing DiffData for 'src\/missing\.ts'/
        );
    });
});
