import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import sinon = require('sinon');
import { z } from 'zod';
import * as vscode from 'vscode';
import { UnifiedLLMService } from '../../../services/llm/unifiedLLMService';
import { TemplateService } from '../../../template/templateService';
import type { CostTrackingService } from '../../../services/cost/costTrackingService';
import type { AIModelConfig, AIRunRequest, AIRunResponse, AISession } from '../../../services/llm/providers';
import * as providerFactory from '../../../services/llm/providers/factory';
import {
    getRequestTypeLabel,
    getValidationSchemaFor,
    requiresRequestScopedSchema,
} from '../../../services/llm/providers/utils/requestTypeMaps';
import type { RequestType } from '../../../services/llm/llmTypes';

/**
 * Request-type matrix of the session seam.
 *
 * Every stage of the chain reaches a model through `execution.run(session, messages, { requestType })`, and
 * the request type is what decides which Zod contract the answer must satisfy. This file pins that mapping
 * for the whole registered set (instead of one stage at a time), so a replacement transport cannot lose,
 * rename or bypass a stage's schema — the failure mode that would turn every structured stage into an
 * unconstrained JSON request.
 *
 * Migration note: nothing here is provider specific; the recording session is the seam itself.
 */

const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';
const MODEL_ID = 'matrix-model';
const ALL_REQUEST_TYPES: readonly RequestType[] = [
    'commitMessage',
    'summary',
    'draft',
    'fix',
    'ragRerank',
    'investigationPlan',
    'investigation',
    'enforceLanguage',
];
/** Every type whose contract is a static schema; `investigation` is free text and the plan is caller-supplied. */
const STATIC_SCHEMA_TYPES: readonly RequestType[] = ['commitMessage', 'summary', 'draft', 'fix', 'ragRerank', 'enforceLanguage'];

interface RecordedCall {
    request: AIRunRequest;
    requestType: string;
}

interface ServiceHarness {
    service: UnifiedLLMService;
    calls: RecordedCall[];
    accountedUsages: Array<AIRunResponse['usage']>;
}

interface Recorder {
    calls: RecordedCall[];
    scripted: { structured?: unknown; text?: string };
}

/** The session a stubbed provider hands back; it records into the harness that is currently under test. */
let activeRecorder: Recorder = { calls: [], scripted: {} };
let stubsInstalled = false;

describe('request-type contract matrix', () => {
    afterEach(() => {
        sinon.restore();
        stubsInstalled = false;
    });

    it('registers a label for every request type and a schema source for each stage', () => {
        // An unlabelled or unregistered type is silently treated as an unconstrained free-text request, so the
        // whole set is asserted here rather than per stage.
        for (const requestType of ALL_REQUEST_TYPES) {
            assert.notEqual(getRequestTypeLabel(requestType), 'thinking', `${requestType}: missing label`);
        }
        assert.equal(getRequestTypeLabel('notARequestType'), 'thinking');

        for (const requestType of STATIC_SCHEMA_TYPES) {
            assert.notEqual(getValidationSchemaFor(requestType), undefined, `${requestType}: missing static schema`);
            assert.equal(requiresRequestScopedSchema(requestType), false, requestType);
        }
        assert.equal(getValidationSchemaFor('investigation'), undefined);
        assert.equal(requiresRequestScopedSchema('investigation'), false);
        assert.equal(getValidationSchemaFor('investigationPlan'), undefined, 'the plan schema is built per request');
        assert.equal(requiresRequestScopedSchema('investigationPlan'), true);
    });

    it('sends the registered schema of every static request type', async () => {
        // One scripted non-JSON answer per type: the request itself must carry that type's registered schema,
        // and the stage must end in the typed missing-output failure rather than in an unconstrained success.
        for (const requestType of STATIC_SCHEMA_TYPES) {
            const harnessed = await createHarness();
            await assert.rejects(
                runType(harnessed, requestType),
                new RegExp(`Provider returned no structured output for ${requestType} after 1 attempts`),
                requestType,
            );

            assert.equal(harnessed.calls.length, 1, `${requestType}: expected exactly one attempt`);
            const format = harnessed.calls[0].request.responseFormat;
            assert.ok(format, `${requestType}: request carried no response schema`);
            assert.equal(format.name, requestType);
            assert.deepEqual(
                format.schema,
                z.toJSONSchema(getValidationSchemaFor(requestType)!) as Record<string, unknown>,
                `${requestType}: schema does not match the registered contract`,
            );
        }
    });

    it('returns the validated structured result and accounts the response exactly once', async () => {
        // The success path is the one the chain reads: the parsed object, and one cost quote per response.
        const harnessed = await createHarness({ structured: { commitMessage: 'feat: keep the matrix' } });
        const result = await runType(harnessed, 'commitMessage');

        assert.deepEqual(result, { commitMessage: 'feat: keep the matrix' });
        assert.equal(harnessed.accountedUsages.length, 1);
        assert.deepEqual(harnessed.accountedUsages[0], {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            raw: { input_tokens: 10, output_tokens: 5 },
        });
    });

    it('carries a caller-supplied schema for the request-scoped plan stage', async () => {
        // The planner builds its contract from the current diff, so the caller's schema must be the one sent.
        const planSchema = z.object({ targets: z.array(z.object({ question: z.string().min(1) })) });
        const harnessed = await createHarness();
        await assert.rejects(
            runType(harnessed, 'investigationPlan', planSchema),
            /Provider returned no structured output for investigationPlan after 1 attempts/,
        );

        assert.deepEqual(
            harnessed.calls[0].request.responseFormat,
            { name: 'investigationPlan', schema: z.toJSONSchema(planSchema) },
        );
    });

    it('keeps investigation free text and outside the structured contract', async () => {
        // Investigation turns carry tools and no terminal format, so the answer must come back as text.
        const harnessed = await createHarness({ text: 'investigation prose' });
        const result = await runType(harnessed, 'investigation');

        assert.equal(result, 'investigation prose');
        assert.equal(harnessed.calls[0].request.responseFormat, undefined);
    });

    it('derives the output ceiling from the execution budget for every request type', async () => {
        // A stage that ignores the shared budget can overflow the window the planner sized for it.
        for (const requestType of STATIC_SCHEMA_TYPES) {
            const harnessed = await createHarness();
            const execution = harnessed.service.createExecution('/tmp/request-type-matrix');
            const session = execution.createSession([{ role: 'user', content: 'go' }]);
            const expected = execution.tokenBudget.maxOutputTokens;

            await assert.rejects(execution.run(session, [{ role: 'user', content: 'go' }], { requestType }));
            assert.ok(expected > 0, requestType);
            assert.equal(harnessed.calls[0].request.maxOutputTokens, expected, `${requestType}: budget not forwarded`);
        }
    });
});

function stubConfiguration(): void {
    // The budget and retry wiring is exercised elsewhere; this matrix uses zero retries so one call means one
    // attempt, and the default context window so the derived ceiling is the seam's own value.
    sinon.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
        get<T>(key: string, defaultValue: T): T {
            if (key === 'llm.maxRetries') {
                return 0 as T;
            }
            return defaultValue;
        },
    } as vscode.WorkspaceConfiguration));
}

/**
 * Installs the provider-factory stub once per test: sinon refuses to wrap an already-wrapped method, and the
 * matrix builds several harnesses inside one test.
 */
function installStubs(): void {
    if (stubsInstalled) {
        return;
    }
    stubsInstalled = true;
    stubConfiguration();
    sinon.stub(providerFactory, 'createAIProvider').callsFake(() => ({
        kind: 'custom',
        createSession: () => recordingSession(),
        listModels: async () => [MODEL_ID],
    }));
}

function recordingSession(): AISession {
    return {
        provider: 'custom',
        model: MODEL_ID,
        run: async (request: AIRunRequest): Promise<AIRunResponse> => {
            activeRecorder.calls.push({ request, requestType: String(request.responseFormat?.name ?? 'investigation') });
            return {
                text: activeRecorder.scripted.text ?? '',
                structured: activeRecorder.scripted.structured,
                toolCalls: [],
                usage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    totalTokens: 15,
                    raw: { input_tokens: 10, output_tokens: 5 },
                },
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
}

async function createHarness(scripted: { structured?: unknown; text?: string } = {}): Promise<ServiceHarness> {
    const calls: RecordedCall[] = [];
    const accountedUsages: Array<AIRunResponse['usage']> = [];
    activeRecorder = { calls, scripted };
    installStubs();

    const context = {
        secrets: { get: async () => 'test-key' },
        globalStorageUri: { fsPath: '/tmp/genie-request-type-matrix' },
        asAbsolutePath: (relativePath: string) => relativePath,
    } as unknown as vscode.ExtensionContext;
    const model: AIModelConfig = {
        id: 'request-type-matrix',
        label: 'Local',
        provider: 'custom',
        model: MODEL_ID,
        baseUrl: UNREACHABLE_BASE_URL,
    };
    const service = new UnifiedLLMService(context, new TemplateService(context), {
        model,
        costTracker: {
            recordCall: async (params: { usage: AIRunResponse['usage'] }) => {
                accountedUsages.push(params.usage);
                return { status: 'pricing-not-configured' as const };
            },
        } as unknown as CostTrackingService,
    });
    await service.refreshFromSettings();
    return { service, calls, accountedUsages };
}

async function runType(
    harnessed: ServiceHarness,
    requestType: RequestType,
    validationSchema?: z.ZodTypeAny,
): Promise<unknown> {
    const execution = harnessed.service.createExecution('/tmp/request-type-matrix');
    const messages = [{ role: 'user' as const, content: `run ${requestType}` }];
    const session = execution.createSession(messages);
    return execution.run(session, messages, { requestType, validationSchema });
}
