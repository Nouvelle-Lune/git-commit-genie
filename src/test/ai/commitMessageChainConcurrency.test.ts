import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { generateCommitMessageChain } from '../../services/chain/commitMessageChain';
import { DiffData } from '../../services/git/gitTypes';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';
import { AIMessage, AISession } from '../../services/llm/providers';
import { resolveChainTokenBudget } from '../../services/llm/inputTokenBudget';
import { ChangeAnalysisAgentOutput } from '../../services/analysis/change/investigation/agent';
import { RagRetrievalQuery } from '../../services/chain/types';

describe('commit-message chain selection-driven RAG', () => {
    it('starts RAG after selection and passes grounded query fields before draft', async () => {
        const ragConfig = vscode.workspace.getConfiguration('gitCommitGenie.rag');
        const previousRagEnabled = ragConfig.get<boolean>('enabled');
        await ragConfig.update('enabled', true, vscode.ConfigurationTarget.Global);

        let agentCompleted = false;
        let observedQuery: RagRetrievalQuery | undefined;
        const requestTypes: string[] = [];
        const stages: string[] = [];
        const execution = createExecution(async requestType => {
            requestTypes.push(requestType);
            switch (requestType) {
                case 'changeExtraction':
                    return extractionResponse();
                case 'investigationPlan':
                    return {
                        targets: [{
                            target: 'parse',
                            kind: 'symbol',
                            file: 'src/parser.ts',
                            questions: ['Who calls parse?'],
                        }],
                        notes: null,
                    };
                case 'draft':
                    return {
                        type: 'refactor',
                        scope: 'parser',
                        breaking: false,
                        description: 'simplify parse branch',
                        body: null,
                        footers: [],
                        notes: null,
                    };
                case 'fix':
                    return { commitMessage: 'refactor(parser): simplify parse branch', notes: null };
                default:
                    throw new Error(`Unexpected request type '${requestType}'.`);
            }
        });
        const repositoryAnalysisService = {
            runChangeAnalysis: async (): Promise<ChangeAnalysisAgentOutput> => {
                agentCompleted = true;
                return completeAgentOutput();
            },
        };

        try {
            const output = await generateCommitMessageChain({
                diffs: [parserDiff()],
                repositoryPath: '/tmp/repository',
            }, execution, {
                investigation: { enabled: true, maxSteps: 2, excludePatterns: [] },
                repositoryAnalysisService,
                retrieveRagExamples: async query => {
                    assert.equal(agentCompleted, true);
                    observedQuery = query;
                    return [{
                        commitHash: 'abc123',
                        message: 'refactor(parser): flatten parse flow',
                        subject: 'refactor(parser): flatten parse flow',
                        matchedBy: ['hybrid'],
                        styleReason: 'Uses a concise scoped refactor header.',
                        type: 'refactor',
                        scope: 'parser',
                    }];
                },
                onStage: event => stages.push(event.type),
            });

            assert.deepEqual(observedQuery, {
                mustExpress: ['simplifies parser branching'],
                type: 'refactor',
                scope: 'parser',
            });
            assert.ok(stages.indexOf('informationSelected') < stages.indexOf('ragPrepared'));
            assert.ok(stages.indexOf('ragPrepared') < stages.indexOf('ragRetrievalStart'));
            assert.ok(stages.indexOf('ragRetrievalStart') < stages.indexOf('ragRetrieved'));
            assert.ok(stages.indexOf('ragPrepared') < stages.indexOf('draftStart'));
            assert.ok(stages.indexOf('ragRetrieved') < stages.indexOf('draftStart'));
            assert.deepEqual(requestTypes.filter(requestType => requestType.startsWith('rag')), []);
            assert.equal(output.ragStyleReferences?.[0]?.styleReason, 'Uses a concise scoped refactor header.');
            assert.ok(output.timings.agentStart !== undefined);
            assert.ok(output.timings.agentTerminal !== undefined);
            assert.ok(output.timings.ragReady !== undefined);
            assert.ok(output.timings.ragReady! <= output.timings.draftStart);
            assert.ok(output.timings.draftStart <= output.timings.draftReady);
            assert.equal(output.timings.ttdMs, output.timings.draftReady - output.timings.chainStart);
        } finally {
            await ragConfig.update('enabled', previousRagEnabled, vscode.ConfigurationTarget.Global);
        }
    });
});

function createExecution(
    runRequest: (requestType: string) => Promise<unknown>,
): LLMExecution {
    const tokenBudget = resolveChainTokenBudget({
        provider: 'custom',
        model: 'chain-test',
        contextWindowTokens: 128_000,
    });
    return {
        model: 'chain-test',
        temperature: 0,
        maxOutputTokens: tokenBudget.maxOutputTokens,
        maxRetries: 0,
        thinkingLevel: 'off',
        tokenBudget,
        thinkingFor: () => ({ reasoning: false, level: 'off' }),
        createSession: (): AISession => ({
            provider: 'custom',
            model: 'chain-test',
            run: async () => { throw new Error('Direct session run is not expected in this chain test.'); },
            snapshot: () => ({
                provider: 'custom',
                model: 'chain-test',
                continuation: { serverManaged: false },
                transcript: [],
            }),
        }),
        run: async <T>(_session: AISession, _messages: AIMessage[], options: LLMRunOptions): Promise<T> => (
            runRequest(options.requestType) as Promise<T>
        ),
    };
}

function extractionResponse() {
    return {
        changedFiles: [{ path: 'src/parser.ts', changeType: 'modified' as const }],
        changedSymbols: [{
            name: 'parse',
            file: 'src/parser.ts',
            symbolType: 'function' as const,
            changeKind: 'function_body' as const,
            evidenceRefs: ['D1'],
        }],
        introducedSymbols: [],
        removedSymbols: [],
        changedCalls: [],
        changedConfigs: [],
        changedTypes: [],
        changedDependencies: [],
    };
}

function completeAgentOutput(): ChangeAnalysisAgentOutput {
    return {
        repositoryEvidence: {
            items: [],
            findings: [],
            unresolvedQuestions: [],
            stopReason: 'Compound terminal complete.',
            steps: 1,
            degraded: false,
        },
        semanticAnalysis: {
            changeTargets: [{
                symbol: 'parse', file: 'src/parser.ts', role: 'parser', evidenceRefs: ['D1'],
            }],
            dependencyContext: {
                callers: [], callees: [], stateDependencies: [], relatedConfigs: [], relatedTypes: [],
            },
            observedChanges: [{ claim: 'simplifies parser branching', evidenceRefs: ['D1'] }],
            repositoryFacts: [],
            behaviorAnalysis: { before: 'nested branch', after: 'direct branch', observableEffect: 'same output' },
            capabilityContext: { technicalCapability: 'simpler parsing', productCapability: null },
            supportedInferences: [],
            uncertainInferences: [],
            intentAnalysis: { primaryIntent: 'simplify parsing', supportedBy: ['D1'], confidence: 'high' },
            changeClassification: {
                existingBehaviorCorrected: false,
                newCapabilityAdded: false,
                externalBehaviorChanged: false,
                structuralOnly: true,
                recommendedType: 'refactor',
                reason: 'Behavior is preserved.',
            },
            uncertainties: [],
        },
        informationSelection: {
            mustExpress: ['simplifies parser branching'],
            optional: [],
            omit: [],
            suggestedScope: 'parser',
            notes: null,
        },
        analysisStatus: 'complete',
        issues: [],
        claims: [{
            id: 'C1',
            category: 'observed_change',
            claim: 'simplifies parser branching',
            evidenceRefs: ['D1'],
            disposition: 'must_express',
        }],
    };
}

function parserDiff(): DiffData {
    return {
        fileName: 'src/parser.ts',
        status: 'modified',
        rawDiff: '@@ -1,3 +1,3 @@\n export function parse(value: string) {\n-  return value ? value : "";\n+  return value || "";\n }',
        diffHunks: [{
            header: '@@ -1,3 +1,3 @@',
            content: ' export function parse(value: string) {\n-  return value ? value : "";\n+  return value || "";\n }',
            additions: ['  return value || "";'],
            deletions: ['  return value ? value : "";'],
        }],
    };
}
