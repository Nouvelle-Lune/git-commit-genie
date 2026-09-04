import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { RagRetrievalService } from '../../services/rag/ragRetrievalService';
import { RepoService } from '../../services/repo/repo';
import { Repository } from '../../services/git/git';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';
import { AIMessage, AISession } from '../../services/llm/providers';
import { resolveChainTokenBudget } from '../../services/llm/inputTokenBudget';
import { ragRerankResponseSchema } from '../../services/llm/providers/schemas/common';
import { buildSelectionRagContext } from '../../services/chain/rag/selectionQuery';

describe('selection-driven RAG retrieval', () => {
    it('requires an explicit selected array while allowing the model to reject every candidate', () => {
        assert.equal(ragRerankResponseSchema.safeParse({ notes: 'No candidate is suitable.' }).success, false);
        assert.equal(ragRerankResponseSchema.safeParse({ selected: [], notes: 'No candidate is suitable.' }).success, true);
    });

    it('does not use an internal evidence identifier as the retrieval scope', () => {
        const context = buildSelectionRagContext({
            analysisStatus: 'complete',
            analysisIssues: [],
            primaryIntent: null,
            mustExpress: ['updates the configured model'],
            optional: [],
            omit: [],
            suggestedScope: 'C1',
            recommendedType: 'feat',
            behaviorBefore: null,
            behaviorAfter: null,
            observableEffect: null,
            technicalCapability: null,
            breakingSignals: [],
            uncertainties: [],
        }, []);

        assert.equal(context.query.scope, null);
    });

    it('hard-filters historical rows by the selected commit type before recall', async () => {
        const service = createService();
        const internal = service as any;
        const refactorRow = indexedRow('refactor-1', 'refactor');
        const fixRow = indexedRow('fix-1', 'fix');
        let recalledRows: any[] = [];

        internal.loadIndexedRows = async () => ({
            rows: [refactorRow, fixRow],
            bm25: { documentFrequencies: new Map(), avgDocLength: 0, documentTokens: [] },
        });
        internal.hybridRecall = async (rows: any[]) => {
            recalledRows = rows;
            return [];
        };
        internal.scopeRecall = () => [];

        const references = await service.retrieveStyleReferences({
            repo: repository(),
            query: {
                mustExpress: ['simplifies parser branching'],
                type: 'refactor',
                scope: 'parser',
            },
            execution: createExecution(async () => {
                throw new Error('Rerank must not run without recalled candidates.');
            }),
        });

        assert.deepEqual(recalledRows.map(row => row.commitHash), ['refactor-1']);
        assert.deepEqual(references, []);
    });

    it('preserves a valid empty LLM selection instead of falling back to recall order', async () => {
        const service = createService();
        installSingleCandidate(service);

        const references = await service.retrieveStyleReferences({
            repo: repository(),
            query: {
                mustExpress: ['simplifies parser branching'],
                type: 'refactor',
                scope: 'parser',
            },
            execution: createExecution(async requestType => {
                assert.equal(requestType, 'ragRerank');
                return { selected: [], notes: 'No candidate is suitable.' };
            }),
        });

        assert.deepEqual(references, []);
    });

    it('passes the LLM selection reason through to the Draft style reference', async () => {
        const service = createService();
        installSingleCandidate(service);

        const references = await service.retrieveStyleReferences({
            repo: repository(),
            query: {
                mustExpress: ['simplifies parser branching'],
                type: 'refactor',
                scope: 'parser',
            },
            execution: createExecution(async () => ({
                selected: [{
                    id: 'c1',
                    reason: 'Uses a concise scoped header without borrowing implementation facts.',
                }],
                notes: null,
            })),
        });

        assert.equal(references.length, 1);
        assert.equal(
            references[0].styleReason,
            'Uses a concise scoped header without borrowing implementation facts.',
        );
    });
});

function createService(): RagRetrievalService {
    return new RagRetrievalService({} as vscode.ExtensionContext, {} as RepoService);
}

function installSingleCandidate(service: RagRetrievalService): void {
    const internal = service as any;
    const row = indexedRow('refactor-1', 'refactor');
    const candidate = {
        ...row,
        hybridScore: 0.9,
        denseScore: 0.9,
        bm25Score: 0.5,
        featureScore: 0,
        recencyBoost: 0.5,
        matchedBy: new Set(['hybrid']),
    };
    internal.loadIndexedRows = async () => ({
        rows: [row],
        bm25: { documentFrequencies: new Map(), avgDocLength: 0, documentTokens: [] },
    });
    internal.hybridRecall = async () => [candidate];
    internal.scopeRecall = () => [];
}

function indexedRow(commitHash: string, type: string) {
    const message = `${type}(parser): simplify parse flow`;
    return {
        commitHash,
        message,
        subject: message,
        body: '',
        committedAt: '2026-08-30T00:00:00.000Z',
        changeSetSummary: {
            text: 'simplify parse flow',
            dominantType: type,
            dominantScope: 'parser',
        },
        retrievalFeatures: {
            predictedType: type,
            predictedScope: 'parser',
        },
        documentText: message,
        embeddingText: message,
        searchText: message,
    };
}

function repository(): Repository {
    return { rootUri: vscode.Uri.file('/tmp/repository') } as Repository;
}

function createExecution(
    runRequest: (requestType: string) => Promise<unknown>,
): LLMExecution {
    const tokenBudget = resolveChainTokenBudget({
        provider: 'custom',
        model: 'rag-test',
        contextWindowTokens: 128_000,
    });
    return {
        model: 'rag-test',
        temperature: 0,
        maxOutputTokens: tokenBudget.maxOutputTokens,
        maxRetries: 0,
        thinkingLevel: 'off',
        tokenBudget,
        thinkingFor: () => ({ reasoning: false, level: 'off' }),
        createSession: (): AISession => ({
            provider: 'custom',
            model: 'rag-test',
            run: async () => { throw new Error('Direct session run is not expected in this test.'); },
            snapshot: () => ({
                provider: 'custom',
                model: 'rag-test',
                continuation: { serverManaged: false },
                transcript: [],
            }),
        }),
        run: async <T>(_session: AISession, _messages: AIMessage[], options: LLMRunOptions): Promise<T> => (
            runRequest(options.requestType) as Promise<T>
        ),
        accountCall: async () => ({ status: 'pricing-not-configured' as const }),
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
    };
}
