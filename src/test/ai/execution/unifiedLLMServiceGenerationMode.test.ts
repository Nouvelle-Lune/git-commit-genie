import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import { resolve } from 'node:path';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { UnifiedLLMService } from '../../../services/llm/unifiedLLMService';
import { TemplateService } from '../../../template/templateService';
import type { CostTrackingService } from '../../../services/cost/costTrackingService';
import type { DiffData } from '../../../services/git/gitTypes';
import type { AIMessage, AIModelConfig, AIRunRequest, AIRunResponse, AISession } from '../../../services/llm/providers';
import * as providerFactory from '../../../services/llm/providers/factory';
import * as chainModule from '../../../services/chain/commitMessageChain';
import { routeAutoGeneration } from '../../../services/router/autoRouter';
import { logger } from '../../../services/logger';

const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';
const MODEL_ID = 'local-model';

describe('UnifiedLLMService generation-mode routing', () => {
    afterEach(() => sinon.restore());

    it('uses the learned Auto decision to reach different real service branches', async () => {
        // Auto must send a model-selected Deep diff to the chain branch and a model-selected Fast diff to the single-pass provider session.
        const deepDiff = makeDiff(DEEP_ROUTE_DIFF);
        const fastDiff = makeDiff(FAST_ROUTE_DIFF);
        assert.equal(routeAutoGeneration([deepDiff]).route, 'deep');
        assert.equal(routeAutoGeneration([fastDiff]).route, 'fast');
        stubConfiguration('auto');
        const providerRequests: AIRunRequest[] = [];
        stubProvider(providerRequests);
        const chainCalls: Array<{ diffs: readonly DiffData[] }> = [];
        stubChain(chainCalls);
        const stageLogs = captureCommitStageLogs();
        const service = await createService();

        const chainResult = await service.generateCommitMessage([deepDiff]);
        assert.equal(contentOf(chainResult), 'chain branch result');
        assert.equal(chainCalls.length, 1);
        assert.deepEqual(chainCalls[0].diffs, [deepDiff]);
        assert.equal(providerRequests.length, 0);
        assert.deepEqual(autoRouteLogs(stageLogs), [{ route: 'deep' }]);

        const fastResult = await service.generateCommitMessage([fastDiff]);
        assert.equal(contentOf(fastResult), 'one prompt branch result');
        assert.equal(chainCalls.length, 1);
        assert.equal(providerRequests.length, 1);
        assert.equal(providerRequests[0].responseFormat?.name, 'commitMessage');
        assert.ok(providerRequests[0].messages?.some(message => message.role === 'user'));
        assert.deepEqual(autoRouteLogs(stageLogs), [{ route: 'deep' }, { route: 'fast' }]);
    });

    it('keeps scores, thresholds, rule names and error internals out of the user-visible surface', async () => {
        // The Output channel and the routing card are user-visible, so the always-on line states the outcome
        // in product terms and the card carries the route only. Diagnostics appear when raw data is enabled.
        const diff = makeDiff(FAST_ROUTE_DIFF);
        stubConfiguration('auto');
        stubProvider([]);
        stubChain([]);
        const stageLogs = captureCommitStageLogs();
        const infoMessages: string[] = [];
        const warnMessages: string[] = [];
        sinon.stub(logger, 'info').callsFake((message: string) => {
            infoMessages.push(message);
        });
        sinon.stub(logger, 'warn').callsFake((message: string) => {
            warnMessages.push(message);
        });
        const service = await createService();

        await service.generateCommitMessage([diff]);

        const autoLines = [...infoMessages, ...warnMessages].filter(message => message.includes('[Auto]'));
        assert.deepEqual(autoLines, ['[Auto] This change uses Fast.']);
        for (const message of autoLines) {
            for (const leak of ['pDirect=', 'threshold=', 'coverageTarget=', 'artifact=', 'reason=', 'failure=']) {
                assert.equal(message.includes(leak), false, `${leak} leaked into: ${message}`);
            }
        }
        // The card that opens the generation flow carries the route and nothing else.
        assert.deepEqual(autoRouteLogs(stageLogs), [{ route: 'fast' }]);
        assert.equal('failure' in stageLogs[0].data, false);
        assert.equal('probabilityDirect' in stageLogs[0].data, false);
        assert.equal('directThreshold' in stageLogs[0].data, false);
        assert.equal('artifactSha256' in stageLogs[0].data, false);
    });

    it('adds the diagnostic line only when raw data is enabled', async () => {
        const diff = makeDiff(FAST_ROUTE_DIFF);
        stubConfiguration('auto', { rawDataEnabled: true });
        stubProvider([]);
        stubChain([]);
        const infoMessages: string[] = [];
        sinon.stub(logger, 'info').callsFake((message: string) => {
            infoMessages.push(message);
        });
        sinon.stub(logger, 'warn').callsFake(() => undefined);
        const service = await createService();

        await service.generateCommitMessage([diff]);

        const debugLines = infoMessages.filter(message => message.includes('[Auto][debug]'));
        assert.equal(debugLines.length, 1);
        assert.match(debugLines[0], /reason=model/u);
        assert.match(debugLines[0], /pDirect=/u);
        assert.match(debugLines[0], /threshold=/u);
        assert.match(debugLines[0], /artifact=[0-9a-f]{12}/u);
    });

    it('honors a forced Fast mode even when the model would select Deep', async () => {
        // Explicit Fast mode must bypass the Auto score and produce a real provider-session request.
        const diff = makeDiff(DEEP_ROUTE_DIFF);
        stubConfiguration('fast');
        const providerRequests: AIRunRequest[] = [];
        stubProvider(providerRequests);
        const chainCalls: Array<{ diffs: readonly DiffData[] }> = [];
        stubChain(chainCalls);
        const stageLogs = captureCommitStageLogs();
        const service = await createService();

        const result = await service.generateCommitMessage([diff]);

        assert.equal(contentOf(result), 'one prompt branch result');
        assert.equal(providerRequests.length, 1);
        assert.equal(chainCalls.length, 0);
        assert.deepEqual(autoRouteLogs(stageLogs), []);
    });

    it('honors a forced Deep mode even when the model would select Fast', async () => {
        // Explicit Deep mode must bypass the Auto score and invoke the chain service branch without a provider session request.
        const diff = makeDiff(FAST_ROUTE_DIFF);
        stubConfiguration('deep');
        const providerRequests: AIRunRequest[] = [];
        stubProvider(providerRequests);
        const chainCalls: Array<{ diffs: readonly DiffData[] }> = [];
        stubChain(chainCalls);
        const stageLogs = captureCommitStageLogs();
        const service = await createService();

        const result = await service.generateCommitMessage([diff]);

        assert.equal(contentOf(result), 'chain branch result');
        assert.equal(chainCalls.length, 1);
        assert.deepEqual(chainCalls[0].diffs, [diff]);
        assert.equal(providerRequests.length, 0);
        // A forced route is not a decision, so no Auto card is written for it.
        assert.deepEqual(autoRouteLogs(stageLogs), []);
    });

    it('keeps honoring a pre-rename onePrompt value by routing it as Fast', async () => {
        // An existing `onePrompt` in settings.json must behave like `fast`: the rename is invisible to
        // users, and no generation may fail because of a configuration string.
        const diff = makeDiff(DEEP_ROUTE_DIFF);
        stubConfiguration('onePrompt');
        const providerRequests: AIRunRequest[] = [];
        stubProvider(providerRequests);
        const chainCalls: Array<{ diffs: readonly DiffData[] }> = [];
        stubChain(chainCalls);
        const service = await createService();

        assert.equal(contentOf(await service.generateCommitMessage([diff])), 'one prompt branch result');
        assert.equal(providerRequests.length, 1);
        assert.equal(chainCalls.length, 0);
    });

    it('keeps honoring a pre-rename chain value by routing it as Deep', async () => {
        // Same guarantee for `chain` → `deep`: a forced legacy value still reaches the chain branch.
        const diff = makeDiff(FAST_ROUTE_DIFF);
        stubConfiguration('chain');
        const providerRequests: AIRunRequest[] = [];
        stubProvider(providerRequests);
        const chainCalls: Array<{ diffs: readonly DiffData[] }> = [];
        stubChain(chainCalls);
        const service = await createService();

        assert.equal(contentOf(await service.generateCommitMessage([diff])), 'chain branch result');
        assert.equal(chainCalls.length, 1);
        assert.equal(providerRequests.length, 0);
    });

    it('fails at the service entry point for an invalid generation mode without a provider request', async () => {
        // Invalid new configuration must become an explicit service error before either generation branch can make a request.
        stubConfiguration('AUTO');
        const providerRequests: AIRunRequest[] = [];
        stubProvider(providerRequests);
        const chainCalls: Array<{ diffs: readonly DiffData[] }> = [];
        stubChain(chainCalls);
        const service = await createService();

        const result = await service.generateCommitMessage([makeDiff(DEEP_ROUTE_DIFF)]);

        assert.match(messageOf(result), /Invalid Git Commit Genie generation mode: AUTO/);
        assert.equal(providerRequests.length, 0);
        assert.equal(chainCalls.length, 0);
    });

    it('ignores simultaneous legacy root settings and still routes Auto normally', async () => {
        // Residual removed settings must not block activation or alter the new model-based Auto route, and the service must not read those root keys.
        const diff = makeDiff(FAST_ROUTE_DIFF);
        assert.equal(routeAutoGeneration([diff]).route, 'fast');
        const configurationTrace = stubConfiguration('auto', {
            legacyChainEnabled: false,
            legacyUseChainPrompts: true,
        });
        const providerRequests: AIRunRequest[] = [];
        stubProvider(providerRequests);
        const chainCalls: Array<{ diffs: readonly DiffData[] }> = [];
        stubChain(chainCalls);
        const service = await createService();

        const result = await service.generateCommitMessage([diff]);

        assert.equal(contentOf(result), 'one prompt branch result');
        assert.equal(providerRequests.length, 1);
        assert.equal(chainCalls.length, 0);
        assert.equal(configurationTrace.rootGetKeys.includes('gitCommitGenie.chain.enabled'), false);
        assert.equal(configurationTrace.rootGetKeys.includes('gitCommitGenie.useChainPrompts'), false);
    });
});

interface LegacyConfiguration {
    legacyChainEnabled?: unknown;
    legacyUseChainPrompts?: unknown;
    rawDataEnabled?: boolean;
}

interface ConfigurationTrace {
    rootGetKeys: string[];
}

function stubConfiguration(mode: unknown, legacy: LegacyConfiguration = {}): ConfigurationTrace {
    const trace: ConfigurationTrace = { rootGetKeys: [] };
    const generationConfig = {
        get<T>(key: string, defaultValue: T): T {
            if (key === 'generationMode') {
                return mode as T;
            }
            if (key === 'llm.maxRetries') {
                return 0 as T;
            }
            if (key === 'ui.rawData.enabled') {
                return (legacy.rawDataEnabled ?? false) as T;
            }
            return defaultValue;
        },
    } as vscode.WorkspaceConfiguration;
    const rootConfig = {
        get<T>(key: string, defaultValue?: T): T | undefined {
            trace.rootGetKeys.push(key);
            if (key === 'gitCommitGenie.chain.enabled') {
                return legacy.legacyChainEnabled as T | undefined;
            }
            if (key === 'gitCommitGenie.useChainPrompts') {
                return legacy.legacyUseChainPrompts as T | undefined;
            }
            return defaultValue;
        },
    } as vscode.WorkspaceConfiguration;
    sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => (
        section === 'gitCommitGenie' ? generationConfig : rootConfig
    ));
    return trace;
}

interface CapturedStageLog {
    stage: string;
    data: Record<string, unknown>;
}

/** Captures `commitStage` tool calls exactly as the Webview receives them. */
function captureCommitStageLogs(): CapturedStageLog[] {
    const captured: CapturedStageLog[] = [];
    sinon.stub(logger, 'logToolCall').callsFake((toolName: string, args: string) => {
        if (toolName === 'commitStage') {
            captured.push(JSON.parse(args) as CapturedStageLog);
        }
    });
    return captured;
}

function autoRouteLogs(stageLogs: CapturedStageLog[]): Array<{ route: unknown }> {
    return stageLogs
        .filter(entry => entry.stage === 'autoRouted')
        .map(entry => ({ route: entry.data.route }));
}

async function createService(): Promise<UnifiedLLMService> {
    const context = {
        secrets: { get: async () => 'test-key' },
        globalStorageUri: { fsPath: '/tmp/genie-generation-mode' },
        globalState: { get: () => '' },
        workspaceState: { get: () => '' },
        asAbsolutePath: (relativePath: string) => resolve(__dirname, '../../../../', relativePath),
    } as unknown as vscode.ExtensionContext;
    const model: AIModelConfig = {
        id: 'generation-mode-test',
        label: 'Local',
        provider: 'custom',
        model: MODEL_ID,
        baseUrl: UNREACHABLE_BASE_URL,
    };
    const service = new UnifiedLLMService(context, new TemplateService(context), {
        model,
        costTracker: {
            recordCall: async () => ({ status: 'pricing-not-configured' as const }),
        } as unknown as CostTrackingService,
    });
    await service.refreshFromSettings();
    return service;
}

function stubProvider(requests: AIRunRequest[]): void {
    const session: AISession = {
        provider: 'custom',
        model: MODEL_ID,
        run: async (request: AIRunRequest): Promise<AIRunResponse> => {
            requests.push(request);
            assert.equal(request.responseFormat?.name, 'commitMessage');
            return {
                text: '',
                structured: { commitMessage: 'one prompt branch result' },
                toolCalls: [],
                stopReason: 'completed',
                continuation: { serverManaged: false },
                raw: {},
            };
        },
        snapshot: () => ({
            provider: 'custom',
            model: MODEL_ID,
            continuation: { serverManaged: false },
            transcript: [],
        }),
    };
    sinon.stub(providerFactory, 'createAIProvider').callsFake(() => ({
        kind: 'custom',
        createSession: () => session,
        listModels: async () => [MODEL_ID],
    }));
}

function stubChain(calls: Array<{ diffs: readonly DiffData[] }>): void {
    sinon.stub(chainModule, 'generateCommitMessageChain').callsFake(async inputs => {
        calls.push({ diffs: inputs.diffs });
        return {
            commitMessage: 'chain branch result',
            fileSummaries: [],
            ragStyleReferences: [],
            changeAnalysis: { memoryUsage: undefined },
        } as unknown as Awaited<ReturnType<typeof chainModule.generateCommitMessageChain>>;
    });
}

function makeDiff(rawDiff: string): DiffData {
    return {
        fileName: 'src/service.ts',
        status: 'modified',
        diffHunks: [{
            header: '@@ -1,1 +1,1 @@',
            content: '-old\n+new',
            additions: ['+new'],
            deletions: ['-old'],
        }],
        rawDiff,
    };
}

function contentOf(result: Awaited<ReturnType<UnifiedLLMService['generateCommitMessage']>>): string {
    if (!('content' in result)) {
        throw new Error(`Expected a successful generation result, got: ${result.message}`);
    }
    return result.content;
}

function messageOf(result: Awaited<ReturnType<UnifiedLLMService['generateCommitMessage']>>): string {
    if (!('message' in result)) {
        throw new Error(`Expected a service error result, got: ${result.content}`);
    }
    return result.message;
}

const DEEP_ROUTE_DIFF = [
    'diff --git a/src/service.ts b/src/service.ts',
    'index 1111111..2222222 100644',
    '--- a/src/service.ts',
    '+++ b/src/service.ts',
    '@@ -1,2 +1,2 @@',
    '-const value = 1;',
    '+const value = 2;',
].join('\n');

// RF-79 scores this new-file diff at pDirect=0.656328 (coverage 0.3 threshold 0.581097), so Auto
// sends it to Fast while DEEP_ROUTE_DIFF stays at pDirect=0.473782.
const FAST_ROUTE_DIFF = [
    'diff --git a/src/service.ts b/src/service.ts',
    '--- /dev/null',
    '+++ b/src/service.ts',
    '@@ -0,0 +1,3 @@',
    "+import { strict as assert } from 'assert';",
    '+assert.equal(1 + 1, 2);',
].join('\n');
