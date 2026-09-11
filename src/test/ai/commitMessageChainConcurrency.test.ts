import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { generateCommitMessageChain } from '../../services/chain/commitMessageChain';
import { DiffData } from '../../services/git/gitTypes';
import { RepositorySnapshotReader } from '../../services/git/repositorySnapshot';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';
import { AIMessage, AISession } from '../../services/llm/providers';
import { resolveChainTokenBudget } from '../../services/llm/inputTokenBudget';
import * as changeAnalysisAgentModule from '../../services/analysis/change/investigation/agent';
import { ChangeAnalysisAgentOutput } from '../../services/analysis/change/investigation/agent';

describe('commit-message chain with RAG disabled', () => {
    it('runs the raw-diff planner and does not invoke RAG when RAG is disabled', async () => {
        // Verify the chain reaches draft generation through raw-diff planning while the disabled RAG path stays inert.
        const ragConfig = vscode.workspace.getConfiguration('gitCommitGenie.rag');
        const previousRagEnabled = ragConfig.get<boolean>('enabled');
        await ragConfig.update('enabled', false, vscode.ConfigurationTarget.Global);

        let agentCompleted = false;
        const requestTypes: string[] = [];
        const stages: string[] = [];
        const execution = createExecution(async requestType => {
            requestTypes.push(requestType);
            switch (requestType) {
                case 'investigationPlan':
                    return {
                        targets: [{
                            id: 'T1',
                            target: 'parse',
                            kind: 'symbol',
                            file: 'src/parser.ts',
                            diffEvidenceRefs: ['D1'],
                            questions: ['Who calls parse?'],
                        }],
                        coverage: [{ diffEvidenceRef: 'D1', decision: 'investigate', targetIds: ['T1'] }],
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
                    return { status: 'valid', commitMessage: 'refactor(parser): simplify parse branch', preservedFactIds: ['C1'], violations: [], notes: null };
                default:
                    throw new Error(`Unexpected request type '${requestType}'.`);
            }
        });
        const snapshot = {} as RepositorySnapshotReader;
        const agentStub = sinon.stub(changeAnalysisAgentModule, 'runChangeAnalysisAgent').callsFake(
            async (): Promise<ChangeAnalysisAgentOutput> => {
                agentCompleted = true;
                return completeAgentOutput();
            },
        );

        try {
            const output = await generateCommitMessageChain({
                diffs: [parserDiff()],
                snapshot,
                repositoryPath: '/tmp/repository',
            }, execution, {
                investigation: { enabled: true, maxSteps: 2, excludePatterns: [] },
                onStage: event => stages.push(event.type),
            });

            assert.equal(agentCompleted, true);
            assert.deepEqual(requestTypes, ['investigationPlan', 'draft', 'fix']);
            assert.equal(output.ragStyleReferences, undefined);
            assert.equal(stages.includes('ragPrepared'), false);
            assert.equal(stages.includes('ragRetrievalStart'), false);
            assert.equal(stages.includes('ragRetrieved'), false);
            assert.ok(output.timings.agentStart !== undefined);
            assert.ok(output.timings.agentTerminal !== undefined);
            assert.ok(output.timings.draftStart !== undefined);
            assert.ok(output.timings.draftReady !== undefined);
            assert.equal(output.timings.ttdMs, output.timings.draftReady - output.timings.chainStart);
        } finally {
            agentStub.restore();
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
        thinking: { reasoning: false, level: 'off' },
        tokenBudget,
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
        accountCall: async () => ({ status: 'pricing-not-configured' as const }),
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
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
