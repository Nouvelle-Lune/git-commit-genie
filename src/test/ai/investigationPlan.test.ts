import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import sinon = require('sinon');
import { z } from 'zod';
import { planInvestigation } from '../../services/analysis/change/investigation/agent';
import { DraftEvidence, InvestigationPlan } from '../../services/analysis/change/types';
import { AIMessage, AISession } from '../../services/llm/providers';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';
import { INVESTIGATION_PLAN_LIMITS } from '../../services/llm/providers/schemas/common';
import { StructuredFieldRejectionError } from '../../services/llm/structuredCompletion';
import { logger } from '../../services/logger';
import { StageRawData } from '../../ui/StageNotificationManager';

const REPOSITORY_PATH = '/tmp/repository';
const MAX_TOOL_CALLS = 4;

const evidence: DraftEvidence[] = [{
    kind: 'raw',
    fileName: 'src/parser.ts',
    status: 'modified',
    evidenceIds: ['D1', 'D2'],
    rawDiff: '@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-old2\n+new2',
}];

/** A plan that satisfies every cross-reference rule the schema cannot express. */
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

/** One planner turn: either a returned plan or the rejection the shared structured path would raise. */
type PlannerStep = { plan: InvestigationPlan } | { error: Error };

interface PlannerHarness {
    execution: LLMExecution;
    calls: Array<{ messages: AIMessage[]; options: LLMRunOptions }>;
}

function plan(overrides: Partial<InvestigationPlan>): InvestigationPlan {
    return { ...validPlan(), ...overrides };
}

/**
 * Builds an execution whose `run` records every planner request and answers with
 * the next scripted step, so a test can assert both the retry loop and the
 * options the planner passes for each attempt.
 */
function harnessFor(steps: PlannerStep[], maxRetries = steps.length - 1): PlannerHarness {
    const calls: PlannerHarness['calls'] = [];
    let callIndex = 0;
    const execution: LLMExecution = {
        signal: undefined,
        temperature: 0,
        maxOutputTokens: 128,
        maxRetries,
        thinking: { reasoning: false, level: 'off' },
        tokenBudget: {} as LLMExecution['tokenBudget'],
        createSession: (): AISession => ({
            provider: 'custom',
            model: 'test',
            run: async () => { throw new Error('Direct session run is not expected.'); },
            snapshot: () => ({
                provider: 'custom',
                model: 'test',
                continuation: { serverManaged: false },
                transcript: [],
            }),
        }),
        run: async <T>(_session: AISession, messages: AIMessage[], options: LLMRunOptions): Promise<T> => {
            calls.push({ messages, options });
            const step = steps[callIndex];
            assert.ok(step, `Unexpected investigation planning request ${callIndex + 1}.`);
            callIndex += 1;
            if ('error' in step) {
                throw step.error;
            }
            return step.plan as T;
        },
        accountCall: async () => ({ status: 'pricing-not-configured' as const }),
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
    };
    return { execution, calls };
}

function planWith(
    harness: PlannerHarness,
    overrides: Partial<Parameters<typeof planInvestigation>[0]> = {},
): Promise<InvestigationPlan> {
    return planInvestigation({
        evidence,
        execution: harness.execution,
        maxToolCalls: MAX_TOOL_CALLS,
        repositoryPath: REPOSITORY_PATH,
        ...overrides,
    });
}

/**
 * The rejection type and field lines the shared structured path raises for the planner.
 *
 * The message is fixture text, not part of the contract under test: the planner's
 * schema repair consumes `fieldIssueLines` and never reads the message, and only a
 * caller-owned run of the real path can pin the attempt count it names.
 */
function schemaRejection(issueLine: string): StructuredFieldRejectionError {
    return new StructuredFieldRejectionError(
        [issueLine],
        `Structured result failed local validation for investigationPlan after 1 attempts:\n- ${issueLine}`,
    );
}

function promptOf(call: { messages: AIMessage[] }): string {
    return call.messages.map(message => message.content).join('\n');
}

function coverageKeysOf(schema: z.ZodTypeAny): string[] {
    const exported = z.toJSONSchema(schema) as {
        properties?: { coverage?: { required?: string[] } };
    };
    return exported.properties?.coverage?.required ?? [];
}

/** The decoded size limit of the target array the planner validated its response against. */
function targetCapOf(schema: z.ZodTypeAny): number | undefined {
    const exported = z.toJSONSchema(schema) as {
        properties?: { targets?: { maxItems?: number } };
    };
    return exported.properties?.targets?.maxItems;
}

function contractViolationError(pattern: RegExp): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Investigation plan violated the coverage contract: /);
        assert.match(error.message, pattern);
        return true;
    };
}

interface CapturedLog {
    toolName: string;
    content: string;
    reason?: string;
    repoPath?: string;
    rawData?: StageRawData;
}

describe('investigation planner keyed coverage contract', () => {
    afterEach(() => sinon.restore());

    it('accepts one decision per D* and reports the caller-owned attempt budget', async () => {
        // Verify a single valid turn returns the normalized plan, carrying the dynamic schema built from the
        // request's own D* ids plus the caller's attempt counters so the shared path cannot retry behind it.
        const harness = harnessFor([{ plan: validPlan() }], 2);

        const result = await planWith(harness);

        assert.deepEqual(result, validPlan());
        assert.equal(harness.calls.length, 1);
        const { options, messages } = harness.calls[0];
        assert.equal(options.requestType, 'investigationPlan');
        assert.deepEqual(options.callerOwnedRetry, { attempt: 1, totalAttempts: 3 });
        assert.ok(options.validationSchema, 'The planner must supply its request-scoped schema.');
        assert.deepEqual(coverageKeysOf(options.validationSchema), ['D1', 'D2']);
        assert.match(promptOf({ messages }), /The investigation agent has 4 repository tool call/);
    });

    it('orders coverage by the request diff order instead of the model output order', async () => {
        // Verify normalization walks the request's ids: a model that emits D2 first still yields diff order, and
        // the key set can be neither dropped nor duplicated because it is rebuilt from the request.
        const outOfOrder = plan({
            coverage: {
                D2: { decision: 'diff_sufficient', targetIds: [] },
                D1: { decision: 'investigate', targetIds: ['T1'] },
            },
        });
        const harness = harnessFor([{ plan: outOfOrder }]);

        const result = await planWith(harness);

        assert.deepEqual(Object.keys(result.coverage), ['D1', 'D2']);
        assert.deepEqual(result.coverage.D1, { decision: 'investigate', targetIds: ['T1'] });
        assert.deepEqual(result.coverage.D2, { decision: 'diff_sufficient', targetIds: [] });
    });

    it('trims every declared target field during normalization', async () => {
        // Verify normalization keeps the declared target, its lookup verb, and its single question while removing
        // the surrounding whitespace from the id, the target, the file, and the question itself.
        const noisy = plan({
            targets: [{
                id: ' T1 ',
                target: ' parse ',
                kind: 'symbol',
                lookup: 'definition',
                file: ' src/parser.ts ',
                question: ' Who calls parse? ',
            }],
        });
        const harness = harnessFor([{ plan: noisy }]);

        const result = await planWith(harness);

        assert.deepEqual(result.targets, [{
            id: 'T1',
            target: 'parse',
            kind: 'symbol',
            lookup: 'definition',
            file: 'src/parser.ts',
            question: 'Who calls parse?',
        }]);
        assert.equal(result.notes, 'The second hunk is self-explanatory.');
    });

    it('normalizes an empty file to null instead of an empty path', async () => {
        // The file is an optional locator: whitespace-only must become null so downstream consumers never treat
        // an empty string as a repository path.
        const harness = harnessFor([{ plan: plan({
            targets: [{
                id: 'T1', target: 'parse', kind: 'symbol', lookup: 'callers', file: '   ',
                question: 'Who calls parse?',
            }],
        }) }]);

        const result = await planWith(harness);

        assert.equal(result.targets[0].file, null);
    });

    it('spends exactly one request per attempt from a single shared rejection budget', async () => {
        // Verify one schema rejection and one contract rejection consume the same counter, so three attempts mean
        // three provider requests and the caller's counters are reported on each of them.
        const harness = harnessFor([
            { error: schemaRejection('coverage.D2: required field is absent.') },
            { plan: plan({ coverage: { D1: { decision: 'investigate', targetIds: ['T9'] }, D2: { decision: 'diff_sufficient', targetIds: [] } } }) },
            { plan: validPlan() },
        ], 2);

        const result = await planWith(harness);

        assert.deepEqual(result, validPlan());
        assert.equal(harness.calls.length, 3);
        assert.deepEqual(
            harness.calls.map(call => call.options.callerOwnedRetry),
            [
                { attempt: 1, totalAttempts: 3 },
                { attempt: 2, totalAttempts: 3 },
                { attempt: 3, totalAttempts: 3 },
            ],
        );
        for (const call of harness.calls) {
            assert.ok(call.options.validationSchema, 'Every attempt must carry the request-scoped schema.');
        }
    });

    it('asks for a schema-shaped correction after the response schema rejects a turn', async () => {
        // Verify the repair request after a schema rejection names the failing fields and restates that the
        // coverage key set is fixed, instead of replaying a serialized schema error.
        const harness = harnessFor([
            { error: schemaRejection('coverage.D2: required field is absent.') },
            { plan: validPlan() },
        ]);

        await planWith(harness);

        assert.equal(harness.calls.length, 2);
        const correction = harness.calls[1].messages;
        assert.equal(correction.length, 1);
        const content = correction[0].content;
        assert.match(content, /<plan_rejected>/);
        assert.match(content, /The previous response did not match the investigation plan schema\./);
        assert.match(content, /- coverage\.D2: required field is absent\./);
        assert.match(content, /The coverage object must contain exactly the keys the schema declares, once each, with their spelling unchanged\./);
    });

    it('returns the cross-reference violations and the fixed key set in the contract repair request', async () => {
        // Verify a contract rejection is repaired with the exact named violations, the previous plan, and the
        // instruction that no coverage key may be removed, renamed, or added.
        const violated = plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T9'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        });
        const harness = harnessFor([{ plan: violated }, { plan: validPlan() }]);

        await planWith(harness, { maxToolCalls: 7 });

        assert.equal(harness.calls.length, 2);
        const content = harness.calls[1].messages[0].content;
        assert.match(content, /- investigated evidence 'D1' references unknown target 'T9'/);
        assert.match(content, /- target 'T1' is not attached to any investigate coverage entry/);
        assert.ok(content.includes(`Previous plan: ${JSON.stringify(violated)}`), content);
        assert.match(content, /Keep every coverage key exactly as it was supplied: the key set is fixed, and a key must never be removed, renamed, or added\./);
        assert.match(content, /Use diff_sufficient with an empty targetIds when that hunk needs no repository lookup\./);
        assert.match(content, /Every declared target must be named by at least one investigate coverage entry\./);
    });

    it('keeps the retired budget and cut instructions out of the repair request', async () => {
        // Plan size is now decoded, not validated, so a repair request that still asked the model to cut questions
        // would spend an attempt on arithmetic no decoder can express and no local check can report.
        const violated = plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T9'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        });
        const harness = harnessFor([{ plan: violated }, { plan: validPlan() }]);

        await planWith(harness);

        const repair = harness.calls[1].messages[0].content;
        assert.doesNotMatch(repair, /Repository tool budget/);
        assert.doesNotMatch(repair, /Question budget/);
        assert.doesNotMatch(repair, /To cut:/);
        assert.doesNotMatch(repair, /question\(s\)/);
    });

    it('fails when a target declares an empty id', async () => {
        // Verify an unusable target identifier is an explicit contract violation rather than a dropped target.
        const harness = harnessFor([{ plan: plan({
            targets: [{
                id: '   ', target: 'parse', kind: 'symbol', lookup: 'callers', file: null,
                question: 'Who calls parse?',
            }],
        }) }]);

        await assert.rejects(planWith(harness), contractViolationError(/target '   ' has an empty id/));
    });

    it('fails when a target id is declared twice', async () => {
        // Verify a repeated target id is reported instead of being merged into one target during normalization.
        const harness = harnessFor([{ plan: plan({
            targets: [
                { id: 'T1', target: 'parse', kind: 'symbol', lookup: 'callers', file: null, question: 'Who calls parse?' },
                { id: 'T1', target: 'parse', kind: 'call', lookup: 'callees', file: null, question: 'Who calls parse twice?' },
            ],
        }) }]);

        await assert.rejects(planWith(harness), contractViolationError(/target id 'T1' is declared more than once/));
    });

    it('fails when a diff-sufficient entry carries investigation targets', async () => {
        // Verify diff_sufficient cannot smuggle repository work through a target reference.
        const harness = harnessFor([{ plan: plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T1'] }, D2: { decision: 'diff_sufficient', targetIds: ['T1'] } },
        }) }]);

        await assert.rejects(
            planWith(harness),
            contractViolationError(/diff-sufficient evidence 'D2' must not have investigation targets/),
        );
    });

    it('fails when an investigated entry names no target', async () => {
        // Verify an investigate decision without a target is rejected instead of silently degrading to diff_sufficient.
        const harness = harnessFor([{ plan: plan({
            targets: [],
            coverage: { D1: { decision: 'investigate', targetIds: [] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        }) }]);

        await assert.rejects(planWith(harness), contractViolationError(/investigated evidence 'D1' has no target/));
    });

    it('fails when an investigated entry repeats a target id', async () => {
        // Verify a duplicated target reference inside one entry stays visible to the planner instead of being deduped.
        const harness = harnessFor([{ plan: plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T1', 'T1'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        }) }]);

        await assert.rejects(planWith(harness), contractViolationError(/investigated evidence 'D1' repeats a target id/));
    });

    it('fails when an investigated entry references an unknown target', async () => {
        // Verify a dangling target reference is named explicitly so the model learns which id has no declaration.
        const harness = harnessFor([{ plan: plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T9'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        }) }]);

        await assert.rejects(
            planWith(harness),
            contractViolationError(/investigated evidence 'D1' references unknown target 'T9'/),
        );
    });

    it('fails when a declared target is attached to no investigate entry', async () => {
        // Verify an unattached target is rejected so no repository work can be planned without a hunk that needs it.
        const harness = harnessFor([{ plan: plan({
            coverage: { D1: { decision: 'diff_sufficient', targetIds: [] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        }) }]);

        await assert.rejects(
            planWith(harness),
            contractViolationError(/target 'T1' is not attached to any investigate coverage entry/),
        );
    });

    it('joins every violation of one plan with a pipe separator in the final error', async () => {
        // Verify the exhausted-retry error is one message carrying all violations in evaluation order.
        const harness = harnessFor(
            [{ plan: plan({
                coverage: { D1: { decision: 'investigate', targetIds: ['T9'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
            }) }],
            0,
        );

        await assert.rejects(planWith(harness), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
                error.message,
                'Investigation plan violated the coverage contract: '
                + "investigated evidence 'D1' references unknown target 'T9' | "
                + "target 'T1' is not attached to any investigate coverage entry",
            );
            return true;
        });
    });

    it('throws on the final attempt instead of degrading to an empty plan', async () => {
        // Verify a plan that never satisfies the contract fails explicitly after the budget is spent; no empty
        // plan is manufactured and the model's decisions are not rewritten to force a pass.
        const violated = plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T9'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        });
        const harness = harnessFor([{ plan: violated }, { plan: violated }], 1);

        await assert.rejects(planWith(harness), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /^Investigation plan violated the coverage contract: /);
            assert.match(error.message, /references unknown target 'T9'/);
            return true;
        });
        assert.equal(harness.calls.length, 2);
        assert.match(promptOf(harness.calls[1]), /<plan_rejected>/);
    });

    it('rethrows the original schema rejection when the last attempt is rejected by the schema', async () => {
        // Verify the final schema rejection reaches the caller unchanged, preserving the field issues the shared
        // structured path already reported to the Webview.
        const rejection = schemaRejection('coverage.D2: required field is absent.');
        const harness = harnessFor([{ error: rejection }, { error: rejection }], 1);

        await assert.rejects(planWith(harness), (error: unknown) => error === rejection);
    });

    it('keeps the diff-only path valid when every D* is diff-sufficient', async () => {
        // Verify a zero-target plan remains a legal finalization path: no target, no repository tool budget spent.
        const diffOnly: InvestigationPlan = {
            targets: [],
            coverage: {
                D1: { decision: 'diff_sufficient', targetIds: [] },
                D2: { decision: 'diff_sufficient', targetIds: [] },
            },
            notes: 'The complete diff is sufficient.',
        };
        const harness = harnessFor([{ plan: diffOnly }]);

        const result = await planWith(harness);

        assert.deepEqual(result, diffOnly);
        assert.equal(harness.calls.length, 1);
    });

    // The former "the questions of every target sum to at most the shared tool budget" rule was deleted with the
    // old contract. Plan size is now decoded rather than validated: the response schema caps the target array at
    // min(INVESTIGATION_PLAN_LIMITS.maxTargets, maxToolCalls), so an overspending plan cannot be sampled and no
    // local budget violation is observable. The tests that asserted that sum rule, its repair instructions, its
    // ordering against the target id violations, and the fixtures of an "over budget but graph-legal" plan are
    // gone with it; the decoded cap is covered in investigationPlanSchema.test.ts and by the two tests below.

    it('validates every attempt against a schema whose target cap is the shared tool budget', async () => {
        // The prompt and the decoder must publish one number: the schema the planner validates its own response
        // with caps the target array at min(maxTargets, maxToolCalls), which is what makes an overspending plan
        // unwritable instead of a contract violation discovered after a complete generation.
        for (const maxToolCalls of [4, 30]) {
            const harness = harnessFor([{ plan: validPlan() }], 0);

            await planWith(harness, { maxToolCalls });

            const cap = targetCapOf(harness.calls[0].options.validationSchema!);
            assert.equal(cap, Math.min(INVESTIGATION_PLAN_LIMITS.maxTargets, maxToolCalls));
            assert.ok(cap! <= maxToolCalls, `A plan may never promise more lookups than the ${maxToolCalls} calls it has.`);
        }
    });

    it('accepts a plan that spends the whole decoded target budget', async () => {
        // The cap is an upper bound, not a target minus one: four targets against four calls is funded, so the
        // planner must return it unchanged instead of re-deriving a size rule from the questions.
        const fourTargets = plan({
            targets: [
                { id: 'T1', target: 'parse', kind: 'symbol', lookup: 'callers', file: 'src/parser.ts', question: 'Q1' },
                { id: 'T2', target: 'render', kind: 'symbol', lookup: 'references', file: 'src/render.ts', question: 'Q2' },
                { id: 'T3', target: 'options', kind: 'config', lookup: 'search', file: null, question: 'Q3' },
                { id: 'T4', target: 'parse', kind: 'symbol', lookup: 'read', file: 'src/parser.ts', question: 'Q4' },
            ],
            coverage: {
                D1: { decision: 'investigate', targetIds: ['T1', 'T2', 'T3', 'T4'] },
                D2: { decision: 'diff_sufficient', targetIds: [] },
            },
        });
        const harness = harnessFor([{ plan: fourTargets }]);

        const result = await planWith(harness);

        assert.equal(result.targets.length, MAX_TOOL_CALLS);
        assert.deepEqual(result.targets.map(target => target.question), ['Q1', 'Q2', 'Q3', 'Q4']);
        assert.equal(harness.calls.length, 1);
    });

    it('accepts investigate coverage served by a read target', async () => {
        // 'read' is a legal retrieval verb: a target declares it when the hunks around the change do not show the
        // surrounding control flow, imports, or the rest of the definition, so the plan needs no correction.
        const readTarget = plan({
            targets: [{
                id: 'T1',
                target: 'parse',
                kind: 'symbol',
                lookup: 'read',
                file: 'src/parser.ts',
                question: 'What does parse return?',
            }],
        });
        const harness = harnessFor([{ plan: readTarget }]);

        const result = await planWith(harness);

        assert.equal(result.targets[0].lookup, 'read');
        assert.deepEqual(result.coverage.D1, { decision: 'investigate', targetIds: ['T1'] });
        assert.equal(harness.calls.length, 1);
    });
});

describe('investigation planner contract observability', () => {
    afterEach(() => sinon.restore());

    function captureStructuredValidationLogs(): CapturedLog[] {
        const captured: CapturedLog[] = [];
        sinon.stub(logger, 'logToolCall').callsFake((
            toolName: string,
            args: string,
            reason?: string,
            repoPath?: string,
            rawData?: StageRawData,
        ) => {
            if (toolName === 'schemaValidation') {
                captured.push({ toolName, content: args, reason, repoPath, rawData });
            }
        });
        return captured;
    }

    it('reports a retried contract violation against the caller budget without declaring a final failure', async () => {
        // Verify the first rejection of a two-attempt budget is logged with the caller's counters, the exact
        // joined violations, and finalFailure false, because the second attempt may still succeed.
        const logs = captureStructuredValidationLogs();
        const violated = plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T9'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        });
        const harness = harnessFor([{ plan: violated }, { plan: validPlan() }], 1);

        const result = await planWith(harness);

        assert.deepEqual(result, validPlan());
        assert.equal(logs.length, 1);
        const entry = logs[0];
        assert.equal(entry.repoPath, REPOSITORY_PATH);
        assert.equal(entry.reason, 'Structured output validation');
        const payload = JSON.parse(entry.content) as Record<string, unknown>;
        assert.equal(payload.stage, 'investigationPlan');
        assert.equal(payload.failureKind, 'contractViolation');
        assert.equal(payload.attempt, 1);
        assert.equal(payload.totalAttempts, 2);
        assert.equal(payload.finalFailure, false);
        assert.equal(
            payload.error,
            "investigated evidence 'D1' references unknown target 'T9' | "
            + "target 'T1' is not attached to any investigate coverage entry",
        );
        // The rejected plan is too large for a log line, so it travels only in the raw-data envelope.
        assert.equal(payload.rejectedPlan, undefined);
        assert.deepEqual(entry.rawData?.rejectedPlan, violated);
        // The reported size is the compact JSON Schema of the request that was rejected, so the contract
        // violation can be read next to the contract that caused it.
        assert.equal(
            payload.schemaBytes,
            JSON.stringify(z.toJSONSchema(harness.calls[0].options.validationSchema!)).length,
        );
    });

    it('reports the exhausted contract violation as a final failure with accurate counters', async () => {
        // Verify the last rejection of a three-attempt budget is logged once with attempt equal to totalAttempts,
        // finalFailure true, and the violation text the caller will throw.
        const logs = captureStructuredValidationLogs();
        const first = plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T8'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        });
        const second = plan({
            coverage: { D1: { decision: 'investigate', targetIds: ['T9'] }, D2: { decision: 'diff_sufficient', targetIds: [] } },
        });
        const harness = harnessFor([{ plan: first }, { plan: second }, { plan: second }], 2);

        await assert.rejects(planWith(harness), /references unknown target 'T9'/);

        assert.equal(logs.length, 3);
        assert.deepEqual(
            logs.map(entry => {
                const payload = JSON.parse(entry.content) as Record<string, unknown>;
                return [payload.attempt, payload.totalAttempts, payload.finalFailure];
            }),
            [[1, 3, false], [2, 3, false], [3, 3, true]],
        );
        const finalPayload = JSON.parse(logs[2].content) as Record<string, unknown>;
        assert.equal(finalPayload.stage, 'investigationPlan');
        assert.equal(finalPayload.failureKind, 'contractViolation');
        assert.equal(
            finalPayload.error,
            "investigated evidence 'D1' references unknown target 'T9' | "
            + "target 'T1' is not attached to any investigate coverage entry",
        );
        assert.deepEqual(logs[2].rawData?.rejectedPlan, second);
        // The schema is measured once per planning run, not per attempt, so every rejection of this run
        // reports the same size: the one belonging to the schema all three attempts were validated against.
        const expectedSchemaBytes = JSON.stringify(
            z.toJSONSchema(harness.calls[0].options.validationSchema!),
        ).length;
        assert.deepEqual(
            logs.map(entry => (JSON.parse(entry.content) as Record<string, unknown>).schemaBytes),
            [expectedSchemaBytes, expectedSchemaBytes, expectedSchemaBytes],
        );
    });
});
