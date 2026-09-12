import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { planInvestigation } from '../../services/analysis/change/investigation/agent';
import { DraftEvidence, InvestigationPlan } from '../../services/analysis/change/types';
import { AIMessage, AIRunRequest, AIRunResponse, AISession } from '../../services/llm/providers';
import * as providerFactory from '../../services/llm/providers/factory';
import { LLMExecution } from '../../services/llm/llmTypes';
import {
    MissingStructuredOutputError,
    StructuredFieldRejectionError,
    StructuredOutputTerminatedError,
} from '../../services/llm/structuredCompletion';
import { UnifiedLLMService } from '../../services/llm/unifiedLLMService';
import { TemplateService } from '../../template/templateService';
import { logger } from '../../services/logger';
import type { CostTrackingService } from '../../services/cost/costTrackingService';

/**
 * The planner's request budget as shipped: one attempt plus the two configured
 * retries. Every count in this file is written against that number, because the
 * invariant under test is "one provider request per planner attempt" and a
 * budget of one request per attempt is meaningless without it.
 */
const PLANNER_ATTEMPTS = 3;

/**
 * Port 9 is the discard port: a request that escapes the scripted provider
 * fails immediately instead of reaching a real endpoint.
 */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';
const REPOSITORY_PATH = '/tmp/repository';
const MODEL_ID = 'local-model';
const MAX_TOOL_CALLS = 4;

const evidence: DraftEvidence[] = [{
    kind: 'raw',
    fileName: 'src/parser.ts',
    status: 'modified',
    evidenceIds: ['D1', 'D2'],
    rawDiff: '@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-old2\n+new2',
}];

/** A plan that satisfies every cross-reference rule the response schema cannot express. */
function validPlan(): InvestigationPlan {
    return {
        targets: [{
            id: 'T1',
            target: 'parse',
            kind: 'symbol',
            lookup: 'callers',
            file: 'src/parser.ts',
            question: 'Who calls parse?',
        }],
        coverage: {
            D1: { decision: 'investigate', targetIds: ['T1'] },
            D2: { decision: 'diff_sufficient', targetIds: [] },
        },
        notes: 'The second hunk is self-explanatory.',
    };
}

/** A response the dynamic schema rejects: D2's required coverage key is absent. */
function missingCoverageKeyPlan(): InvestigationPlan {
    return {
        targets: [],
        coverage: { D1: { decision: 'diff_sufficient', targetIds: [] } },
        notes: null,
    };
}

/** A schema-valid response the planner's own cross-reference check rejects. */
function danglingTargetPlan(): InvestigationPlan {
    return {
        targets: [],
        coverage: {
            D1: { decision: 'investigate', targetIds: ['T9'] },
            D2: { decision: 'diff_sufficient', targetIds: [] },
        },
        notes: null,
    };
}

function createService(): UnifiedLLMService {
    const context = {
        secrets: { get: async () => 'test-key' },
        globalStorageUri: { fsPath: '/tmp/genie-investigation-planner' },
    } as unknown as vscode.ExtensionContext;
    return new UnifiedLLMService(context, new TemplateService(context), {
        model: {
            id: 'investigation-planner',
            label: 'Local',
            provider: 'custom',
            model: MODEL_ID,
            baseUrl: UNREACHABLE_BASE_URL,
        },
        // Every successful response is accounted exactly once, so a scripted run needs a recorder.
        costTracker: {
            recordCall: async () => ({ status: 'pricing-not-configured' as const }),
        } as unknown as CostTrackingService,
    });
}

/**
 * The real execution of a real `UnifiedLLMService`, so `planInvestigation` runs
 * through `runSession`, `runStructuredCompletion`, and the `callerOwnedRetry`
 * degradation instead of a fake `execution.run`.
 */
async function executionFor(): Promise<LLMExecution> {
    const service = createService();
    await service.refreshFromSettings();
    const execution = service.createExecution(REPOSITORY_PATH);
    assert.equal(
        execution.maxRetries + 1,
        PLANNER_ATTEMPTS,
        'This suite is written against the shipped three-attempt planner budget.',
    );
    return execution;
}

function planWith(execution: LLMExecution): Promise<InvestigationPlan> {
    return planInvestigation({
        evidence,
        execution,
        maxToolCalls: MAX_TOOL_CALLS,
        repositoryPath: REPOSITORY_PATH,
    });
}

/** One scripted provider turn: a returned response, or a failure the provider raises instead. */
type ProviderTurn = () => AIRunResponse;

function responseTurn(overrides: Partial<AIRunResponse> = {}): ProviderTurn {
    return () => ({
        text: '',
        toolCalls: [],
        stopReason: 'completed',
        continuation: { serverManaged: false },
        raw: {},
        ...overrides,
    });
}

function failureTurn(error: Error): ProviderTurn {
    return () => { throw error; };
}

interface ProviderScript {
    /** Provider requests that actually happened, in order. */
    requests: Array<{ messages: AIMessage[] }>;
    requestCount: () => number;
}

/**
 * Replaces the provider factory with a session that replays the scripted turns
 * in order and records every request, so the real structured retry path and the
 * planner's own loop both run without an HTTP endpoint.
 *
 * Turns are replayed from the top and the last one repeats once the script is
 * exhausted: an over-asking run must show up as an exact request-count
 * assertion instead of as a stub lookup failure.
 *
 * The stub belongs on the factory module: the provider index re-exports
 * `createAIProvider` through a lazy getter that sinon cannot replace, and the
 * getter resolves the factory's current value at call time.
 */
function scriptProvider(turns: ProviderTurn[]): ProviderScript {
    const requests: ProviderScript['requests'] = [];
    const session: AISession = {
        provider: 'custom',
        model: MODEL_ID,
        run: async (request: AIRunRequest) => {
            const turn = turns[Math.min(requests.length, turns.length - 1)];
            requests.push({ messages: request.messages ?? [] });
            return turn();
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
    return { requests, requestCount: () => requests.length };
}

/** Captures the structured-validation log lines the service writes for the Webview. */
function captureSchemaValidationLogs(): Array<{ content: string }> {
    const captured: Array<{ content: string }> = [];
    sinon.stub(logger, 'logToolCall').callsFake((toolName: string, args: string) => {
        if (toolName === 'schemaValidation') {
            captured.push({ content: args });
        }
    });
    return captured;
}

/** The (failureKind, attempt, totalAttempts, finalFailure) tuple of one rejection log. */
function rejectionTuple(entry: { content: string }): unknown[] {
    const payload = JSON.parse(entry.content) as Record<string, unknown>;
    return [payload.stage, payload.failureKind, payload.attempt, payload.totalAttempts, payload.finalFailure];
}

describe('investigation planner request budget through the real session path', () => {
    afterEach(() => sinon.restore());

    it('runs exactly one provider request per attempt across a schema rejection, a contract violation, and a valid plan', async () => {
        // The planner loop wraps a shared structured loop that itself retries; with caller-owned retry the shared
        // loop must run one request per attempt, so a rejected first turn and a contract-violating second turn
        // cost one request each and both are reported against the planner's three-attempt budget as non-final.
        const logs = captureSchemaValidationLogs();
        const script = scriptProvider([
            responseTurn({ structured: missingCoverageKeyPlan() }),
            responseTurn({ structured: danglingTargetPlan() }),
            responseTurn({ structured: validPlan() }),
        ]);

        const execution = await executionFor();
        const result = await planWith(execution);

        assert.deepEqual(result, validPlan());
        assert.equal(script.requestCount(), PLANNER_ATTEMPTS);
        assert.deepEqual(logs.map(rejectionTuple), [
            ['investigationPlan', 'schemaMismatch', 1, PLANNER_ATTEMPTS, false],
            ['investigationPlan', 'contractViolation', 2, PLANNER_ATTEMPTS, false],
        ]);
    });

    it('spends one request per attempt when every turn is rejected by the response schema', async () => {
        // A schema rejection is repairable, so it is retried until the planner budget is spent. Each retry is a
        // request of its own: the shared loop must not multiply them, and the terminal message names the
        // three-attempt budget the run really spent instead of the single request that reported the rejection.
        const logs = captureSchemaValidationLogs();
        const script = scriptProvider(Array.from({ length: PLANNER_ATTEMPTS }, () => responseTurn({
            structured: missingCoverageKeyPlan(),
        })));

        const execution = await executionFor();
        await assert.rejects(planWith(execution), (error: unknown) => {
            assert.ok(error instanceof StructuredFieldRejectionError);
            assert.equal(
                error.message,
                'Structured result failed local validation for investigationPlan after 3 attempts:\n'
                + '- coverage.D2: required field is absent.',
            );
            return true;
        });

        assert.equal(script.requestCount(), PLANNER_ATTEMPTS);
        assert.deepEqual(logs.map(rejectionTuple), [
            ['investigationPlan', 'schemaMismatch', 1, PLANNER_ATTEMPTS, false],
            ['investigationPlan', 'schemaMismatch', 2, PLANNER_ATTEMPTS, false],
            ['investigationPlan', 'schemaMismatch', 3, PLANNER_ATTEMPTS, true],
        ]);
    });

    it('charges a schema rejection and a contract violation to the same three-attempt budget', async () => {
        // Both rejection kinds draw on one counter, so three rejected turns of mixed origin mean three provider
        // requests, the last one a final failure, and an explicit contract error instead of an empty plan.
        const logs = captureSchemaValidationLogs();
        const script = scriptProvider([
            responseTurn({ structured: missingCoverageKeyPlan() }),
            responseTurn({ structured: danglingTargetPlan() }),
            responseTurn({ structured: danglingTargetPlan() }),
        ]);

        const execution = await executionFor();
        await assert.rejects(planWith(execution), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
                error.message,
                'Investigation plan violated the coverage contract: '
                + "investigated evidence 'D1' references unknown target 'T9'",
            );
            return true;
        });

        assert.equal(script.requestCount(), PLANNER_ATTEMPTS);
        assert.deepEqual(logs.map(rejectionTuple), [
            ['investigationPlan', 'schemaMismatch', 1, PLANNER_ATTEMPTS, false],
            ['investigationPlan', 'contractViolation', 2, PLANNER_ATTEMPTS, false],
            ['investigationPlan', 'contractViolation', 3, PLANNER_ATTEMPTS, true],
        ]);
    });
});

describe('investigation planner repair policy for failures another request cannot fix', () => {
    afterEach(() => sinon.restore());

    it('does not retry a provider context-window termination', async () => {
        // A truncated terminal cannot answer differently the second time, so the planner must let the provider's
        // termination reach the caller after one request: no repair prompt, no budget spent on a lost cause.
        const logs = captureSchemaValidationLogs();
        const script = scriptProvider([responseTurn({ stopReason: 'context_window' })]);

        const execution = await executionFor();
        await assert.rejects(planWith(execution), (error: unknown) => {
            assert.ok(error instanceof StructuredOutputTerminatedError);
            assert.equal(error.kind, 'context_exhausted');
            assert.match(error.message, /The investigationPlan request exhausted the model context window/);
            return true;
        });

        assert.equal(script.requestCount(), 1);
        assert.deepEqual(logs.map(rejectionTuple), [
            ['investigationPlan', 'missingOutput', 1, PLANNER_ATTEMPTS, false],
        ]);
    });

    it('does not retry a provider content-filter termination', async () => {
        // The content filter is the second terminal the shared path refuses to re-ask; the planner must not undo
        // that refusal, so one request is followed by the original termination error.
        const script = scriptProvider([responseTurn({ stopReason: 'content_filter' })]);

        const execution = await executionFor();
        await assert.rejects(planWith(execution), (error: unknown) => {
            assert.ok(error instanceof StructuredOutputTerminatedError);
            assert.equal(error.kind, 'content_filtered');
            return true;
        });

        assert.equal(script.requestCount(), 1);
    });

    it('does not retry a transport failure raised by the provider', async () => {
        // A transport failure says nothing about the plan's shape, so asking again would only hide the cause; the
        // provider error must reach the caller unchanged and unwrapped by the request-logging layer.
        const transportFailure = new Error('connect ECONNREFUSED 127.0.0.1:9');
        const script = scriptProvider([failureTurn(transportFailure)]);

        const execution = await executionFor();
        await assert.rejects(planWith(execution), (error: unknown) => {
            assert.equal(error, transportFailure);
            return true;
        });

        assert.equal(script.requestCount(), 1);
    });

    it('retries a response with no JSON object until the planner budget is spent', async () => {
        // A response that arrives without any final JSON is the one non-schema failure a restated JSON request
        // can fix, so it is retried up to the budget; the thrown error names the planner's three-attempt budget,
        // matching the counters its own logs carry, even though each planner attempt ran one request.
        const logs = captureSchemaValidationLogs();
        const script = scriptProvider(Array.from(
            { length: PLANNER_ATTEMPTS },
            () => responseTurn({ text: 'Here is the plan I would return.' }),
        ));

        const execution = await executionFor();
        await assert.rejects(planWith(execution), (error: unknown) => {
            assert.ok(error instanceof MissingStructuredOutputError);
            assert.equal(
                error.message,
                'Provider returned no structured output for investigationPlan after 3 attempts',
            );
            return true;
        });

        assert.equal(script.requestCount(), PLANNER_ATTEMPTS);
        assert.deepEqual(logs.map(rejectionTuple), [
            ['investigationPlan', 'missingOutput', 1, PLANNER_ATTEMPTS, false],
            ['investigationPlan', 'missingOutput', 2, PLANNER_ATTEMPTS, false],
            ['investigationPlan', 'missingOutput', 3, PLANNER_ATTEMPTS, true],
        ]);
        // The second attempt restates the JSON requirement instead of replaying the planning prompt unchanged,
        // and it must be the missing-JSON branch: a response with no JSON at all is asked for one, never told it
        // did not match the investigation plan schema, which is the mismatch wording this branch stopped reusing.
        assert.equal(script.requests[1].messages.length, 1);
        const correction = script.requests[1].messages[0].content;
        assert.match(correction, /<plan_rejected>/);
        assert.match(correction, /The previous response contained no final JSON object\./);
        assert.match(
            correction,
            /The coverage object must contain exactly the keys the schema declares, once each, with their spelling unchanged\./,
        );
        assert.doesNotMatch(correction, /did not match the investigation plan schema/);
    });
});
