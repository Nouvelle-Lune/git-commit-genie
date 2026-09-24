import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import { resolve } from 'node:path';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { UnifiedLLMService } from '../../../services/llm/unifiedLLMService';
import { TemplateService } from '../../../template/templateService';
import type { CostTrackingService } from '../../../services/cost/costTrackingService';
import type { AIModelConfig, AIRunRequest, AIRunResponse, AISession } from '../../../services/llm/providers';
import * as providerFactory from '../../../services/llm/providers/factory';
import type { DiffData } from '../../../services/git/gitTypes';

/**
 * Failure surface of the session seam.
 *
 * Everything the user sees when a model request fails goes through `LLMError.statusCode` and the provider
 * label: the "replace API key" flow is triggered by 401, and the retry/notice wording is derived from the
 * same object. This file pins that surface — status codes for an unconfigured key, a provider-side
 * rejection, a transport failure and a missing model, plus the cancellation wiring into the request — so a
 * replacement transport cannot flatten every failure into an anonymous 500.
 */

const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';
const MODEL_ID = 'failure-surface-model';
const REPO_PATH = '/tmp/failure-surface';

describe('provider failure surface', () => {
    afterEach(() => {
        sinon.restore();
        providerStubInstalled = false;
        configurationStubbed = false;
    });

    it('reports a missing API key as an unauthenticated, provider-labelled error', async () => {
        stubConfiguration('fast');
        installProvider(() => assert.fail('a request must not be attempted without a key'));
        const service = await createService({ secret: undefined });

        const result = await service.generateCommitMessage([makeDiff()]);

        assert.equal(errorOf(result).statusCode, 401);
        assert.match(errorOf(result).message, /Local API key/);
    });

    it('reports a provider rejection with the status the provider used', async () => {
        // 401 is the branch the generation command turns into the "replace API key" prompt, so it must not be
        // re-derived from the message text.
        for (const status of [401, 429, 500]) {
            stubConfiguration('fast');
            installProvider(() => {
                throw Object.assign(new Error(`upstream rejected with ${status}`), { status });
            });
            const service = await createService({ secret: 'test-key' });

            const result = await service.generateCommitMessage([makeDiff()]);
            assert.equal(errorOf(result).statusCode, status, `status ${status}`);
        }
    });

    it('falls back to an internal error for a transport failure without a status', async () => {
        stubConfiguration('fast');
        installProvider(() => {
            throw new Error('socket closed');
        });
        const service = await createService({ secret: 'test-key' });

        const result = await service.generateCommitMessage([makeDiff()]);

        assert.equal(errorOf(result).statusCode, 500);
        assert.match(errorOf(result).message, /socket closed/);
    });

    it('reports a missing model selection without reaching the provider', async () => {
        stubConfiguration('fast');
        let requests = 0;
        installProvider(() => {
            requests += 1;
            return response({ structured: { commitMessage: 'feat: unused' } });
        });
        const service = await createService({ secret: 'test-key', model: '' });

        const result = await service.generateCommitMessage([makeDiff()]);

        assert.equal(errorOf(result).statusCode, 400);
        assert.match(errorOf(result).message, /model is not selected/);
        assert.equal(requests, 0);
    });

    it('forwards an already-cancelled token to the provider request', async () => {
        // The cancel button has to reach the transport, otherwise a cancelled generation keeps billing and
        // keeps writing to the session transcript.
        stubConfiguration('fast');
        const signals: Array<AbortSignal | undefined> = [];
        installProvider(request => {
            signals.push(request.signal);
            return response({ structured: { commitMessage: 'feat: cancelled' } });
        });
        const service = await createService({ secret: 'test-key' });
        const source = new vscode.CancellationTokenSource();
        source.cancel();

        await service.generateCommitMessage([makeDiff()], { token: source.token });

        assert.equal(signals.length, 1);
        assert.equal(signals[0]?.aborted, true);
    });
});

interface ServiceOptions {
    secret?: string;
    model?: string;
}

function stubConfiguration(mode: unknown): void {
    if (configurationStubbed) {
        return;
    }
    configurationStubbed = true;
    sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
        if (section === 'gitCommitGenie') {
            return {
                get<T>(key: string, defaultValue: T): T {
                    if (key === 'generationMode') {
                        return mode as T;
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
}

/** What the stubbed session does with the request it receives; replaced per case. */
let requestHandler: (request: AIRunRequest) => AIRunResponse = () => response({});
let providerStubInstalled = false;
let configurationStubbed = false;

/**
 * Stubs the seam once per test — sinon refuses to wrap an already-wrapped method, and several cases replace
 * the behaviour inside one test.
 */
function installProvider(handler: (request: AIRunRequest) => AIRunResponse): void {
    requestHandler = handler;
    if (providerStubInstalled) {
        return;
    }
    providerStubInstalled = true;
    const session: AISession = {
        provider: 'custom',
        model: MODEL_ID,
        run: async (request: AIRunRequest) => requestHandler(request),
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

function response(scripted: { structured?: unknown; text?: string }): AIRunResponse {
    return {
        text: scripted.text ?? '',
        structured: scripted.structured,
        toolCalls: [],
        stopReason: 'completed',
        continuation: { serverManaged: false },
        raw: {},
    };
}

async function createService(options: ServiceOptions): Promise<UnifiedLLMService> {
    const context = {
        secrets: { get: async () => options.secret },
        globalStorageUri: { fsPath: REPO_PATH },
        globalState: { get: () => undefined },
        workspaceState: { get: () => '' },
        asAbsolutePath: (relativePath: string) => resolve(__dirname, '../../../../', relativePath),
    } as unknown as vscode.ExtensionContext;
    const model: AIModelConfig = {
        id: 'failure-surface',
        label: 'Local',
        provider: 'custom',
        model: options.model ?? MODEL_ID,
        baseUrl: UNREACHABLE_BASE_URL,
    };
    const service = new UnifiedLLMService(context, new TemplateService(context), {
        model,
        costTracker: {
            recordCall: async () => ({ status: 'pricing-not-configured' as const }),
        } as unknown as CostTrackingService,
    });
    // Loading the stored credential is what makes the provider available to a generation request; without a
    // key the service must fail before the seam is reached at all.
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

function errorOf(result: Awaited<ReturnType<UnifiedLLMService['generateCommitMessage']>>): { message: string; statusCode?: number } {
    if ('message' in result) {
        return { message: result.message, statusCode: result.statusCode };
    }
    throw new Error(`Expected a service error result, got: ${result.content}`);
}
