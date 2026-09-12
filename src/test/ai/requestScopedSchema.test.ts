import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import sinon = require('sinon');
import { z } from 'zod';
import * as vscode from 'vscode';
import { UnifiedLLMService } from '../../services/llm/unifiedLLMService';
import { TemplateService } from '../../template/templateService';
import { AIMessage, AIModelConfig, AIRunResponse, AISession } from '../../services/llm/providers';
import * as providerFactory from '../../services/llm/providers/factory';
import { createInvestigationPlanResponseSchema } from '../../services/llm/providers/schemas/common';
import {
    getValidationSchemaFor,
    requiresRequestScopedSchema,
} from '../../services/llm/providers/utils/requestTypeMaps';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';
import { logger } from '../../services/logger';
import type { CostTrackingService } from '../../services/cost/costTrackingService';

/**
 * Port 9 is the discard port: if a request ever escapes the guard under test it
 * fails immediately instead of reaching a real endpoint.
 */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';
const REPOSITORY_PATH = '/tmp/repository';
const MODEL_ID = 'local-model';
/** The shipped repository tool budget; the plan schema needs it to size its target array. */
const MAX_TOOL_CALLS = 4;
const USER_MESSAGES: AIMessage[] = [{ role: 'user', content: 'return an investigation plan' }];

function createService(): UnifiedLLMService {
    const context = {
        secrets: { get: async () => 'test-key' },
        globalStorageUri: { fsPath: '/tmp/genie-request-scoped-schema' },
    } as unknown as vscode.ExtensionContext;
    const model: AIModelConfig = {
        id: 'request-scoped-schema',
        label: 'Local',
        provider: 'custom',
        model: MODEL_ID,
        baseUrl: UNREACHABLE_BASE_URL,
    };
    return new UnifiedLLMService(context, new TemplateService(context), {
        model,
        // Every successful response is accounted exactly once, so a scripted run needs a recorder.
        costTracker: {
            recordCall: async () => ({ status: 'pricing-not-configured' as const }),
        } as unknown as CostTrackingService,
    });
}

describe('request-scoped validation schema enforcement', () => {
    it('registers the investigation plan as a request-scoped type with no static schema', () => {
        // The planner's contract lives in a schema built from the current diff, so the static table must not
        // carry one and the type must be listed as requiring a caller-supplied schema.
        assert.equal(getValidationSchemaFor('investigationPlan'), undefined);
        assert.equal(requiresRequestScopedSchema('investigationPlan'), true);
    });

    it('keeps every other request type on its static schema', () => {
        // Only the investigation plan is request-scoped; the remaining types, an absent type, and an unknown
        // string must all stay outside the guard so no other stage loses its registration.
        for (const requestType of ['commitMessage', 'summary', 'draft', 'fix', 'ragRerank', 'enforceLanguage']) {
            assert.notEqual(getValidationSchemaFor(requestType), undefined, requestType);
            assert.equal(requiresRequestScopedSchema(requestType), false, requestType);
        }
        assert.equal(requiresRequestScopedSchema('investigation'), false);
        assert.equal(requiresRequestScopedSchema(undefined), false);
        assert.equal(requiresRequestScopedSchema('notARequestType'), false);
    });

    it('refuses an investigation plan request that carries no caller-supplied schema', async () => {
        // The stage has no meaning without its coverage contract, so a missing schema must fail with the named
        // request type instead of falling through to an unconstrained JSON request.
        const service = createService();
        await service.refreshFromSettings();
        const execution = service.createExecution(REPOSITORY_PATH);
        const session = execution.createSession(USER_MESSAGES);

        await assert.rejects(
            execution.run(session, USER_MESSAGES, { requestType: 'investigationPlan' }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(
                    error.message,
                    "Request type 'investigationPlan' requires a request-scoped validation schema.",
                );
                return true;
            },
        );
    });
});

describe('structured rejection logging for schema-validated requests', () => {
    afterEach(() => sinon.restore());

    it('records the compact schema size on every missing-output rejection of a request-scoped request', async () => {
        // The planner schema is built from the current diff, so each rejection must report the compact size of
        // the schema the request was validated against, with the attempt counters of its own retry budget.
        const schema = createInvestigationPlanResponseSchema(['D1', 'D2'], MAX_TOOL_CALLS);
        const totalAttempts = configuredMaxRetries() + 1;
        const logs = captureSchemaValidationLogs();
        scriptProvider(Array.from({ length: totalAttempts }, () => scriptedResponse()));

        const execution = await executionFor();
        await assert.rejects(
            runRequest(execution, { requestType: 'investigationPlan', validationSchema: schema }),
            /Provider returned no structured output for investigationPlan/,
        );

        const expectedSchemaBytes = JSON.stringify(z.toJSONSchema(schema)).length;
        assert.equal(logs.length, totalAttempts);
        assert.deepEqual(
            logs.map(entry => payloadOf(entry).failureKind),
            Array.from({ length: totalAttempts }, () => 'missingOutput'),
        );
        assert.deepEqual(
            logs.map(entry => payloadOf(entry).schemaBytes),
            Array.from({ length: totalAttempts }, () => expectedSchemaBytes),
        );
        // Only the last attempt of the shared budget is a final failure; the earlier ones are still retries.
        assert.deepEqual(
            logs.map(entry => payloadOf(entry).finalFailure),
            logs.map((_, index) => index === logs.length - 1),
        );
    });

    it('records the compact schema size on a schema-mismatch rejection of a static request type', async () => {
        // The size is measured for every schema-validated request, not only the request-scoped one: a static
        // type must report the compact size of its registered schema together with the failing fields.
        const schema = getValidationSchemaFor('draft')!;
        const totalAttempts = configuredMaxRetries() + 1;
        const logs = captureSchemaValidationLogs();
        scriptProvider(Array.from(
            { length: totalAttempts },
            () => scriptedResponse({ structured: { type: 'feat' } }),
        ));

        const execution = await executionFor();
        await assert.rejects(
            runRequest(execution, { requestType: 'draft' }),
            /Structured result failed local validation for draft/,
        );

        const expectedSchemaBytes = JSON.stringify(z.toJSONSchema(schema)).length;
        assert.equal(logs.length, totalAttempts);
        const payloads = logs.map(payloadOf);
        assert.deepEqual(payloads.map(payload => payload.failureKind), Array.from({ length: totalAttempts }, () => 'schemaMismatch'));
        assert.deepEqual(payloads.map(payload => payload.schemaBytes), Array.from({ length: totalAttempts }, () => expectedSchemaBytes));
        assert.deepEqual(
            payloads.map(payload => (payload.fieldIssues as unknown[]).length > 0),
            Array.from({ length: totalAttempts }, () => true),
        );
    });

    it('reports a caller-owned rejection against the caller budget instead of a single-request failure', async () => {
        // A planner attempt runs exactly one request, so a rejection there is not the end of the caller's
        // budget: the log must carry the caller's counters and must not declare a final failure.
        const schema = createInvestigationPlanResponseSchema(['D1'], MAX_TOOL_CALLS);
        const logs = captureSchemaValidationLogs();
        scriptProvider([scriptedResponse({ structured: { targets: [], coverage: {}, notes: null } })]);

        const execution = await executionFor();
        await assert.rejects(
            runRequest(execution, {
                requestType: 'investigationPlan',
                validationSchema: schema,
                callerOwnedRetry: { attempt: 2, totalAttempts: 5 },
            }),
            /Structured result failed local validation for investigationPlan/,
        );

        assert.equal(logs.length, 1);
        const payload = payloadOf(logs[0]);
        assert.equal(payload.failureKind, 'schemaMismatch');
        assert.equal(payload.attempt, 2);
        assert.equal(payload.totalAttempts, 5);
        assert.equal(payload.finalFailure, false);
        assert.equal(payload.schemaBytes, JSON.stringify(z.toJSONSchema(schema)).length);
    });
});

function configuredMaxRetries(): number {
    return vscode.workspace.getConfiguration('gitCommitGenie').get<number>('llm.maxRetries', 2);
}

async function executionFor(): Promise<LLMExecution> {
    const service = createService();
    await service.refreshFromSettings();
    return service.createExecution(REPOSITORY_PATH);
}

function runRequest(execution: LLMExecution, options: LLMRunOptions): Promise<unknown> {
    return execution.run(execution.createSession(USER_MESSAGES), USER_MESSAGES, options);
}

/** One scripted provider turn: `overrides` decides whether it carries reusable structured output. */
function scriptedResponse(overrides: Partial<AIRunResponse> = {}): AIRunResponse {
    return {
        text: '',
        toolCalls: [],
        stopReason: 'completed',
        continuation: { serverManaged: false },
        raw: {},
        ...overrides,
    };
}

/**
 * Replaces the provider factory with a session that replays the scripted turns
 * in order, so the real structured retry path runs without an HTTP endpoint.
 *
 * The stub belongs on the factory module: the provider index re-exports
 * `createAIProvider` through a lazy getter that sinon cannot replace, and the
 * getter resolves the factory's current value at call time.
 */
function scriptProvider(turns: AIRunResponse[]): void {
    let turnIndex = 0;
    const session: AISession = {
        provider: 'custom',
        model: MODEL_ID,
        run: async () => {
            const turn = turns[turnIndex];
            assert.ok(turn, `Unexpected provider request ${turnIndex + 1}.`);
            turnIndex += 1;
            return turn;
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

/** Captures the structured-validation log lines this service writes for the Webview. */
function captureSchemaValidationLogs(): Array<{ content: string }> {
    const captured: Array<{ content: string }> = [];
    sinon.stub(logger, 'logToolCall').callsFake((toolName: string, args: string) => {
        if (toolName === 'schemaValidation') {
            captured.push({ content: args });
        }
    });
    return captured;
}

function payloadOf(entry: { content: string }): Record<string, unknown> {
    return JSON.parse(entry.content) as Record<string, unknown>;
}
