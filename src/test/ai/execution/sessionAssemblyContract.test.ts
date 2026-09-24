import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import { resolve } from 'node:path';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { UnifiedLLMService } from '../../../services/llm/unifiedLLMService';
import { TemplateService } from '../../../template/templateService';
import type { CostTrackingService } from '../../../services/cost/costTrackingService';
import type { AIModelConfig, AIRunRequest, AIRunResponse, AISession, AISessionOptions } from '../../../services/llm/providers';
import * as providerFactory from '../../../services/llm/providers/factory';
import { logger } from '../../../services/logger';
import type { DiffData } from '../../../services/git/gitTypes';

/**
 * Session assembly and service-level result integrity.
 *
 * The service, not the provider, decides what a session *is*: one system instruction folded out of every
 * leading system/developer message, the configured model id, an optional cache identity, and the thinking
 * configuration bound for the whole execution. The same layer decides what the caller finally receives —
 * the structured commit message, one cost quote per response, and the Webview's terminal stage event. Both
 * halves are pinned here because a replacement transport changes neither.
 *
 * Migration note: the seam is the provider factory; everything asserted below is service-owned behaviour.
 */

const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';
const MODEL_ID = 'session-contract-model';
const REPO_PATH = '/tmp/session-contract';

interface Recorder {
    runs: AIRunRequest[];
    sessions: AISessionOptions[];
}

const recorder: Recorder = { runs: [], sessions: [] };
let stubsInstalled = false;

describe('session assembly and result integrity', () => {
    afterEach(() => {
        sinon.restore();
        stubsInstalled = false;
        recorder.runs = [];
        recorder.sessions = [];
    });

    it('folds every leading system and developer message into one session instruction', async () => {
        // Providers receive the prompt once per session; replaying the same instructions as conversation
        // turns would change the prompt the model sees and invalidate the cached prefix.
        installStubs({ structured: { commitMessage: 'feat: assembled' } });
        const messages = [
            { role: 'system' as const, content: 'BASE RULES' },
            { role: 'developer' as const, content: 'CHECKLIST' },
            { role: 'user' as const, content: 'DIFF INPUT' },
        ];

        const service = await createService();
        const execution = service.createExecution(REPO_PATH);
        const session = execution.createSession(messages);
        await execution.run(session, messages, { requestType: 'commitMessage' });

        assert.equal(recorder.sessions.length, 1);
        assert.equal(recorder.sessions[0].systemInstruction, 'BASE RULES\n\nCHECKLIST');
        assert.equal(recorder.sessions[0].model, MODEL_ID);
        assert.deepEqual(recorder.runs[0].messages, [{ role: 'user', content: 'DIFF INPUT' }]);
    });

    it('hands the caller cache identity to the transport and keeps it out of the request', async () => {
        // The identity is what makes prompt caching and session routing work; it belongs to the session, not
        // to an individual request.
        installStubs({ structured: { commitMessage: 'feat: cached' } });
        const messages = [
            { role: 'system' as const, content: 'BASE RULES' },
            { role: 'user' as const, content: 'DIFF INPUT' },
        ];

        const service = await createService();
        const execution = service.createExecution(REPO_PATH);
        const session = execution.createSession(messages, 'cache-identity-1');
        await execution.run(session, messages, { requestType: 'commitMessage' });

        assert.equal(recorder.sessions[0].id, 'cache-identity-1');
        assert.equal(JSON.stringify(recorder.runs[0]).includes('cache-identity-1'), false);
    });

    it('returns the structured commit message and accounts the response exactly once', async () => {
        installStubs({ structured: { commitMessage: 'feat: return integrity' } });
        const accounted: Array<AIRunResponse['usage']> = [];
        const stages: Array<Record<string, unknown>> = [];
        captureStageLogs(stages);
        const service = await createService(accounted);

        const result = await service.generateCommitMessage([makeDiff()]);

        assert.deepEqual(result, { content: 'feat: return integrity' });
        assert.equal(accounted.length, 1);
        assert.deepEqual(stages.filter(event => event.stage === 'done').map(event => event.data), [
            { finalMessage: 'feat: return integrity' },
        ]);
    });

    it('reports a structured rejection as the caller-visible failure after one attempt', async () => {
        // The retry budget is read per execution, so a rejected contract must surface as an error result
        // instead of an empty commit message.
        installStubs({ structured: { notACommitMessage: true }, text: 'no json here' });
        const service = await createService();

        const result = await service.generateCommitMessage([makeDiff()]);

        assert.ok('message' in result);
        assert.match(result.message, /failed local validation for commitMessage/);
    });
});

function captureStageLogs(stages: Array<Record<string, unknown>>): void {
    sinon.stub(logger, 'logToolCall').callsFake((toolName: string, args: string) => {
        if (toolName === 'commitStage') {
            stages.push(JSON.parse(args) as Record<string, unknown>);
        }
    });
}

function installStubs(scripted: { structured?: unknown; text?: string }): void {
    if (stubsInstalled) {
        return;
    }
    stubsInstalled = true;
    sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
        if (section === 'gitCommitGenie') {
            return {
                get<T>(key: string, defaultValue: T): T {
                    if (key === 'generationMode') {
                        return 'fast' as T;
                    }
                    if (key === 'llm.maxRetries') {
                        return 0 as T;
                    }
                    return defaultValue;
                },
            } as vscode.WorkspaceConfiguration;
        }
        return { get: <T>(_key: string, defaultValue?: T) => defaultValue } as vscode.WorkspaceConfiguration;
    });
    sinon.stub(providerFactory, 'createAIProvider').callsFake(() => ({
        kind: 'custom',
        createSession: (options: AISessionOptions) => {
            recorder.sessions.push(options);
            const session: AISession = {
                provider: 'custom',
                model: MODEL_ID,
                run: async (request: AIRunRequest): Promise<AIRunResponse> => {
                    recorder.runs.push(request);
                    return {
                        text: scripted.text ?? '',
                        structured: scripted.structured,
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
            return session;
        },
        listModels: async () => [MODEL_ID],
    }));
}

async function createService(accounted: Array<AIRunResponse['usage']> = []): Promise<UnifiedLLMService> {
    const context = {
        secrets: { get: async () => 'test-key' },
        globalStorageUri: { fsPath: REPO_PATH },
        globalState: { get: () => undefined },
        workspaceState: { get: () => '' },
        asAbsolutePath: (relativePath: string) => resolve(__dirname, '../../../../', relativePath),
    } as unknown as vscode.ExtensionContext;
    const model: AIModelConfig = {
        id: 'session-contract',
        label: 'Local',
        provider: 'custom',
        model: MODEL_ID,
        baseUrl: UNREACHABLE_BASE_URL,
    };
    const service = new UnifiedLLMService(context, new TemplateService(context), {
        model,
        costTracker: {
            recordCall: async (params: { usage: AIRunResponse['usage'] }) => {
                accounted.push(params.usage);
                return { status: 'pricing-not-configured' as const };
            },
        } as unknown as CostTrackingService,
    });
    // The provider is created from the stored credential, so this must happen before the first request.
    await service.refreshFromSettings();
    return service;
}

function makeDiff(): DiffData {
    return {
        fileName: 'src/service.ts',
        status: 'modified',
        diffHunks: [{ header: '@@ -1,1 +1,1 @@', content: '-old\n+new', additions: ['+new'], deletions: ['-old'] }],
        rawDiff: [
            'diff --git a/src/service.ts b/src/service.ts',
            '--- a/src/service.ts',
            '+++ b/src/service.ts',
            '@@ -1,1 +1,1 @@',
            '-old',
            '+new',
        ].join('\n'),
    };
}
