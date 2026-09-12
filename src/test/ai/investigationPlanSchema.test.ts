import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import {
    createInvestigationPlanResponseSchema,
    INVESTIGATION_LOOKUPS,
    INVESTIGATION_PLAN_LIMITS,
    INVESTIGATION_TARGET_KINDS,
} from '../../services/llm/providers/schemas/common';
import { AIRunResponse, CustomProvider } from '../../services/llm/providers';
import { StructuredFieldRejectionError, runStructuredCompletion } from '../../services/llm/structuredCompletion';

/**
 * The subset of the exported JSON Schema this contract is defined in terms of.
 * `z.toJSONSchema` is untyped, so the assertions read through this view instead
 * of scattering casts across every test.
 */
interface CoverageValueSchema {
    required?: string[];
    additionalProperties?: boolean;
    properties?: {
        decision?: { enum?: string[] };
        targetIds?: { maxItems?: number };
    };
}

interface PlanJsonSchema {
    required?: string[];
    additionalProperties?: boolean;
    properties?: {
        targets?: {
            maxItems?: number;
            required?: string[];
            additionalProperties?: boolean;
            items?: {
                required?: string[];
                additionalProperties?: boolean;
                properties?: Record<string, unknown>;
            };
        };
        coverage?: {
            required?: string[];
            additionalProperties?: boolean;
            properties?: Record<string, CoverageValueSchema>;
        };
    };
}

/** Ids in the shape the ledger allocates: one per hunk, in diff order. */
function diffIds(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `D${index + 1}`);
}

/** The shipped repository tool budget; the target array is capped by it as well as by the granularity ceiling. */
const MAX_TOOL_CALLS = 4;

function exportPlanSchema(
    ids: readonly string[],
    maxToolCalls: number = INVESTIGATION_PLAN_LIMITS.maxTargets,
): PlanJsonSchema {
    return z.toJSONSchema(createInvestigationPlanResponseSchema(ids, maxToolCalls)) as PlanJsonSchema;
}

/** One declared target in the shape the response schema requires. */
function target(id: string): Record<string, unknown> {
    return {
        id,
        target: `symbol ${id}`,
        kind: 'symbol',
        lookup: 'callers',
        file: 'src/parser.ts',
        question: `What calls ${id}?`,
    };
}

/**
 * A response declaring `count` targets.
 *
 * Only the decoded size limit is under test here, so the coverage entries stay diff_sufficient with no target
 * ids: the schema bounds the array without judging whether the graph connects.
 */
function planWithTargets(ids: readonly string[], count: number): Record<string, unknown> {
    return {
        ...planWithCoverageKeys(ids, ids),
        targets: Array.from({ length: count }, (_, index) => target(`T${index + 1}`)),
    };
}

function response(overrides: Partial<AIRunResponse>): AIRunResponse {
    return {
        text: '',
        toolCalls: [],
        stopReason: 'completed',
        continuation: { serverManaged: false },
        raw: {},
        ...overrides,
    };
}

function planWithCoverageKeys(ids: readonly string[], covered: readonly string[]): Record<string, unknown> {
    const coverage: Record<string, unknown> = {};
    for (const id of covered) {
        coverage[id] = { decision: 'diff_sufficient', targetIds: [] };
    }
    return { targets: [], coverage, notes: null };
}

/** Points one coverage entry at the given target ids, leaving every other key as the quiet default. */
function withCoverageTargetIds(
    plan: Record<string, unknown>,
    id: string,
    targetIds: readonly string[],
): Record<string, unknown> {
    return {
        ...plan,
        coverage: {
            ...(plan.coverage as Record<string, unknown>),
            [id]: { decision: 'investigate', targetIds: [...targetIds] },
        },
    };
}

describe('dynamic investigation plan schema', () => {
    it('refuses an empty diff id list instead of emitting a keyless coverage object', () => {
        // An empty request has no coverage contract to declare, so the factory must fail loudly rather than hand
        // the planner a schema that accepts any plan. A silent empty object would make every D* unaccounted for.
        assert.throws(
            () => createInvestigationPlanResponseSchema([], MAX_TOOL_CALLS),
            /An investigation plan schema needs at least one diff evidence id\./,
        );
    });

    it('refuses ids that are not well-formed D* identifiers', () => {
        // Only ledger-allocated D* ids may become coverage keys; a malformed id would define a contract key the
        // ledger can never produce, so it is rejected rather than repaired.
        for (const ids of [['D1', 'E2'], ['1'], ['d1'], ['D'], ['D1 '], ['D-1']]) {
            assert.throws(
                () => createInvestigationPlanResponseSchema(ids, MAX_TOOL_CALLS),
                /is not a well-formed D\* id/,
                `Expected '${ids.join(',')}' to be rejected.`,
            );
        }
    });

    it('refuses a repeated diff evidence id', () => {
        // A duplicated id would collapse two distinct hunks onto one coverage key, so it is an input error.
        assert.throws(
            () => createInvestigationPlanResponseSchema(['D1', 'D2', 'D1'], MAX_TOOL_CALLS),
            /Diff evidence id 'D1' is supplied more than once\./,
        );
    });

    it('declares every D* of the request as a required coverage property at ledger scale', () => {
        // The keyed object is the whole coverage guarantee: for an 80-hunk diff the exported schema must require
        // exactly those 80 keys and no others, which is what makes dropping or duplicating a key impossible.
        const ids = diffIds(80);
        const coverage = exportPlanSchema(ids).properties?.coverage;

        assert.deepEqual(Object.keys(coverage?.properties ?? {}), ids);
        assert.deepEqual(coverage?.required, ids);
        assert.equal(coverage?.additionalProperties, false);
    });

    it('addresses double-digit ids by name so ids are data rather than a pattern match', () => {
        // Keys are literal property names, so D10 is its own key instead of a value the model has to derive.
        const coverage = exportPlanSchema(['D9', 'D10', 'D100']).properties?.coverage;

        assert.deepEqual(Object.keys(coverage?.properties ?? {}), ['D9', 'D10', 'D100']);
        assert.deepEqual(coverage?.required, ['D9', 'D10', 'D100']);
    });

    it('keeps the top-level plan object closed and fixed to three keys', () => {
        // The plan itself is strict: an unlisted top-level key is a model deviation the schema must reject.
        const schema = exportPlanSchema(['D1']);

        assert.deepEqual(schema.required, ['targets', 'coverage', 'notes']);
        assert.equal(schema.additionalProperties, false);
    });

    it('exposes the six-field target contract with one question and no removed diffEvidenceRefs field', () => {
        // The target carries no second copy of the D* relation and no per-target question list: the removed fields
        // must be absent from the exported schema, otherwise a model would keep filling them and re-introduce
        // either the double bookkeeping or a target whose single lookup verb serves several questions.
        const targets = exportPlanSchema(['D1', 'D2']).properties?.targets;

        assert.deepEqual(Object.keys(targets?.items?.properties ?? {}), [
            'id', 'target', 'kind', 'lookup', 'file', 'question',
        ]);
        assert.deepEqual(targets?.items?.required, ['id', 'target', 'kind', 'lookup', 'file', 'question']);
        assert.equal(targets?.items?.additionalProperties, false);
        assert.deepEqual(
            (targets?.items?.properties?.kind as { enum?: string[] } | undefined)?.enum,
            [...INVESTIGATION_TARGET_KINDS],
        );
        assert.deepEqual(
            (targets?.items?.properties?.lookup as { enum?: string[] } | undefined)?.enum,
            [...INVESTIGATION_LOOKUPS],
        );
    });

    it('caps the target array at the smaller of the granularity ceiling and the tool budget', () => {
        // JSON Schema cannot express "the questions of every target sum to at most N calls", so the budget is
        // enforced by construction: one question per target plus a decoded array bound turns the former sum rule
        // into a size the sampler cannot exceed. Below the ceiling the budget wins; above it the ceiling does.
        const ids = ['D1', 'D2'];

        assert.equal(exportPlanSchema(ids, 4).properties?.targets?.maxItems, 4);
        assert.equal(exportPlanSchema(ids, INVESTIGATION_PLAN_LIMITS.maxTargets).properties?.targets?.maxItems, INVESTIGATION_PLAN_LIMITS.maxTargets);
        assert.equal(exportPlanSchema(ids, 30).properties?.targets?.maxItems, INVESTIGATION_PLAN_LIMITS.maxTargets);
        // The exported bound is never more than the calls the investigation can pay for, because every target
        // spends one of them on the lookup it declares.
        for (const maxToolCalls of [1, 4, 12, 30]) {
            const cap = exportPlanSchema(ids, maxToolCalls).properties?.targets?.maxItems;
            assert.ok(
                cap !== undefined && cap <= maxToolCalls,
                `A budget of ${maxToolCalls} call(s) must not decode into ${String(cap)} targets.`,
            );
        }
    });

    it('rejects one target over the decoded cap and accepts exactly the cap', () => {
        // The bound has to bite at the boundary the old sum rule used to reject after the fact: at a 12-call
        // budget a 13-target plan is unsamplable, while a 12-target plan is funded and must still parse.
        const ids = ['D1', 'D2'];
        const schema = createInvestigationPlanResponseSchema(ids, INVESTIGATION_PLAN_LIMITS.maxTargets);

        const atCap = schema.safeParse(planWithTargets(ids, INVESTIGATION_PLAN_LIMITS.maxTargets));
        const overCap = schema.safeParse(planWithTargets(ids, INVESTIGATION_PLAN_LIMITS.maxTargets + 1));

        assert.equal(atCap.success, true, JSON.stringify(atCap.error?.issues));
        assert.equal(overCap.success, false);
        if (!overCap.success) {
            assert.deepEqual(overCap.error.issues.map(issue => [issue.path.join('.'), issue.code]), [
                ['targets', 'too_big'],
            ]);
        }
        // And the same boundary follows a budget smaller than the ceiling rather than the ceiling itself.
        const fourCalls = createInvestigationPlanResponseSchema(ids, 4);
        assert.equal(fourCalls.safeParse(planWithTargets(ids, 4)).success, true);
        assert.equal(fourCalls.safeParse(planWithTargets(ids, 5)).success, false);
    });

    it('accepts one question string per target and rejects the retired question array', () => {
        // A target spends exactly one lookup, so it carries exactly one question: the array form has no place in
        // the schema, and a target that omits the question has no question for its lookup to answer.
        const ids = ['D1', 'D2'];
        const schema = createInvestigationPlanResponseSchema(ids, MAX_TOOL_CALLS);
        const withQuestion = { ...planWithCoverageKeys(ids, ids), targets: [target('T1')] };
        const withQuestionArray = {
            ...planWithCoverageKeys(ids, ids),
            targets: [{ ...target('T1'), questions: ['Who calls T1?'] }],
        };
        const withoutQuestion = { ...planWithCoverageKeys(ids, ids), targets: [target('T1')] } as Record<string, unknown>;
        delete (withoutQuestion.targets as Array<Record<string, unknown>>)[0].question;

        assert.equal(schema.safeParse(withQuestion).success, true);
        // The exported property is a single string, so "one target, two questions" has no encoding to fall back on.
        const exported = exportPlanSchema(ids, MAX_TOOL_CALLS).properties?.targets?.items?.properties?.question as
            { type?: string } | undefined;
        assert.equal(exported?.type, 'string');

        const arrayForm = schema.safeParse(withQuestionArray);
        assert.equal(arrayForm.success, false);
        if (!arrayForm.success) {
            // The retired field is rejected by name, so the repair request tells the model which shape is wrong
            // instead of reporting a missing field it believes it filled.
            assert.deepEqual(arrayForm.error.issues.map(issue => issue.path.join('.')), ['targets.0']);
            const [issue] = arrayForm.error.issues;
            assert.ok(issue.code === 'unrecognized_keys', issue.code);
            assert.deepEqual(issue.keys, ['questions']);
        }

        const missingQuestion = schema.safeParse(withoutQuestion);
        assert.equal(missingQuestion.success, false);
        if (!missingQuestion.success) {
            assert.deepEqual(
                missingQuestion.error.issues.map(issue => [issue.path.join('.'), issue.code]),
                [['targets.0.question', 'invalid_type']],
            );
        }
    });

    it('rejects a target that omits the required lookup verb', () => {
        // A target without a lookup has no retrieval verb for the agent to execute, so the schema rejects the
        // response instead of letting the planner fall back to re-reading the changed file.
        const plan = {
            ...planWithCoverageKeys(['D1'], ['D1']),
            targets: [{ id: 'T1', target: 'parse', kind: 'symbol', file: 'src/parser.ts', question: 'Who calls parse?' }],
        };

        const parsed = createInvestigationPlanResponseSchema(['D1'], MAX_TOOL_CALLS).safeParse(plan);

        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }
        assert.deepEqual(parsed.error.issues.map(issue => issue.path.join('.')), ['targets.0.lookup']);
    });

    it('rejects a lookup verb outside the eight declared literals', () => {
        // The verb vocabulary is closed and maps onto real tools, so an invented verb must not be coerced into a
        // neighbouring one; the rejection names the offending field for the repair request.
        const plan = {
            ...planWithCoverageKeys(['D1'], ['D1']),
            targets: [{
                id: 'T1',
                target: 'parse',
                kind: 'symbol',
                lookup: 'inspect',
                file: 'src/parser.ts',
                question: 'Who calls parse?',
            }],
        };

        const parsed = createInvestigationPlanResponseSchema(['D1'], MAX_TOOL_CALLS).safeParse(plan);

        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }
        assert.deepEqual(parsed.error.issues.map(issue => issue.path.join('.')), ['targets.0.lookup']);
    });

    it('requires decision and targetIds under every coverage value', () => {
        // Each value is a closed two-field object, so a model cannot answer a hunk with a partial decision. The
        // targetIds bound is not the entry ceiling on its own: it is the same arithmetic that caps the plan, so an
        // entry can never name more targets than the plan may declare at this budget.
        const ids = ['D1', 'D2', 'D3'];

        for (const maxToolCalls of [4, INVESTIGATION_PLAN_LIMITS.maxTargets]) {
            const values = exportPlanSchema(ids, maxToolCalls).properties?.coverage?.properties ?? {};
            const expectedCap = Math.min(
                INVESTIGATION_PLAN_LIMITS.maxTargetIdsPerCoverageEntry,
                Math.min(INVESTIGATION_PLAN_LIMITS.maxTargets, maxToolCalls),
            );

            assert.deepEqual(Object.keys(values), ids);
            for (const id of ids) {
                assert.deepEqual(values[id].required, ['decision', 'targetIds']);
                assert.equal(values[id].additionalProperties, false);
                assert.deepEqual(values[id].properties?.decision?.enum, ['investigate', 'diff_sufficient']);
                assert.equal(values[id].properties?.targetIds?.maxItems, expectedCap);
            }
        }
        // The two budgets are different numbers, so the loop cannot pass by always exporting one of them: below the
        // granularity ceiling the tool budget binds, at the ceiling the entry limit does.
        assert.equal(exportPlanSchema(ids, 4).properties?.coverage?.properties?.D1.properties?.targetIds?.maxItems, 4);
        assert.equal(
            exportPlanSchema(ids, INVESTIGATION_PLAN_LIMITS.maxTargets).properties?.coverage?.properties?.D1
                .properties?.targetIds?.maxItems,
            INVESTIGATION_PLAN_LIMITS.maxTargetIdsPerCoverageEntry,
        );
    });

    it('rejects a coverage entry naming more targets than the plan may declare', () => {
        // The per-entry bound is the plan's own cap, so a repair attempt cannot smuggle a target id into the
        // coverage object that the schema never let the plan declare. The bound bites exactly one id over the cap.
        const ids = ['D1', 'D2'];
        const targetIds = (count: number) => Array.from({ length: count }, (_, index) => `T${index + 1}`);

        for (const [maxToolCalls, cap] of [
            [4, 4],
            [INVESTIGATION_PLAN_LIMITS.maxTargets, INVESTIGATION_PLAN_LIMITS.maxTargetIdsPerCoverageEntry],
        ] as const) {
            const schema = createInvestigationPlanResponseSchema(ids, maxToolCalls);

            assert.equal(
                schema.safeParse(withCoverageTargetIds(planWithTargets(ids, cap), 'D1', targetIds(cap))).success,
                true,
                `A ${maxToolCalls}-call plan must accept an entry naming its ${cap} declared targets.`,
            );

            const overCap = schema.safeParse(withCoverageTargetIds(planWithTargets(ids, cap), 'D1', targetIds(cap + 1)));

            assert.equal(overCap.success, false, `An entry naming ${cap + 1} targets must not decode.`);
            if (!overCap.success) {
                assert.deepEqual(overCap.error.issues.map(issue => [issue.path.join('.'), issue.code]), [
                    ['coverage.D1.targetIds', 'too_big'],
                ]);
            }
        }
    });

    it('exports no JavaScript digit-class escape, keeping the schema GBNF-convertible', () => {
        // llama.cpp copies `\d` verbatim into a GBNF literal and llama-server then fails open, so the exported
        // document must not contain the shorthand anywhere.
        const serialized = JSON.stringify(exportPlanSchema(diffIds(80)));

        assert.doesNotMatch(serialized, /\\d/);
    });

    it('rejects a plan whose response omits a required D* key', () => {
        // The missing key is the failure mode the keyed object was introduced to make structurally impossible;
        // local validation must still report it, with the absent key named in the path.
        const parsed = createInvestigationPlanResponseSchema(['D1', 'D2'], MAX_TOOL_CALLS)
            .safeParse(planWithCoverageKeys(['D1', 'D2'], ['D1']));

        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }
        assert.deepEqual(parsed.error.issues.map(issue => issue.path.join('.')), ['coverage.D2']);
    });

    it('rejects a plan that invents a D* key the request never supplied', () => {
        // An invented key would silently attach repository work to a hunk that does not exist.
        const parsed = createInvestigationPlanResponseSchema(['D1', 'D2'], MAX_TOOL_CALLS)
            .safeParse(planWithCoverageKeys(['D1', 'D2'], ['D1', 'D2', 'D9']));

        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }
        assert.deepEqual(parsed.error.issues.map(issue => issue.code), ['unrecognized_keys']);
    });

    it('rejects a decision outside the two allowed literals', () => {
        // The decision vocabulary is closed, so an approximate answer must not be coerced into one of the two.
        const plan = planWithCoverageKeys(['D1'], ['D1']);
        (plan.coverage as Record<string, { decision: string }>).D1.decision = 'maybe';

        const parsed = createInvestigationPlanResponseSchema(['D1'], MAX_TOOL_CALLS).safeParse(plan);

        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }
        assert.deepEqual(parsed.error.issues.map(issue => issue.path.join('.')), ['coverage.D1.decision']);
    });

    it('rejects extra fields inside a coverage value, at the top level, and on a target', () => {
        // Strictness applies at every level, including the retired diffEvidenceRefs field on a target.
        const withCoverageExtra = planWithCoverageKeys(['D1'], ['D1']);
        (withCoverageExtra.coverage as Record<string, Record<string, unknown>>).D1.extra = 1;
        const withTopLevelExtra = { ...planWithCoverageKeys(['D1'], ['D1']), extra: 1 };
        const withTargetExtra = {
            ...planWithCoverageKeys(['D1'], ['D1']),
            targets: [{
                id: 'T1',
                target: 'parse',
                kind: 'symbol',
                lookup: 'callers',
                file: 'src/parser.ts',
                question: 'Who calls parse?',
                diffEvidenceRefs: ['D1'],
            }],
        };

        for (const plan of [withCoverageExtra, withTopLevelExtra, withTargetExtra]) {
            const parsed = createInvestigationPlanResponseSchema(['D1'], MAX_TOOL_CALLS).safeParse(plan);
            assert.equal(parsed.success, false, JSON.stringify(plan));
            if (parsed.success) {
                continue;
            }
            assert.deepEqual(parsed.error.issues.map(issue => issue.code), ['unrecognized_keys']);
        }
    });

    it('surfaces an omitted D* key as a field-level rejection when the retry budget is spent', () => {
        // The planner runs this schema with maxRetries 0 and reuses the field issues, so the rejection type and its
        // message must stay exactly as the single-request path produced them.
        const rejected = planWithCoverageKeys(['D1', 'D2'], ['D1']);

        return assert.rejects(
            runStructuredCompletion({
                run: async () => response({ structured: rejected, text: JSON.stringify(rejected) }),
                schema: createInvestigationPlanResponseSchema(['D1', 'D2'], MAX_TOOL_CALLS) as z.ZodType<unknown>,
                initialMessages: [{ role: 'user', content: 'return an investigation plan' }],
                maxRetries: 0,
                label: 'investigationPlan',
            }),
            (error: unknown) => {
                assert.ok(error instanceof StructuredFieldRejectionError);
                assert.deepEqual(error.fieldIssueLines, ['coverage.D2: required field is absent.']);
                assert.equal(
                    error.message,
                    'Structured result failed local validation for investigationPlan after 1 attempts:\n'
                    + '- coverage.D2: required field is absent.',
                );
                return true;
            },
        );
    });

    it('sends the full per-request schema to an OpenAI-compatible chat endpoint', () => {
        // A compatible endpoint receives the same dynamic contract as every other provider: 80 required coverage
        // keys, closed objects, and no trace of the removed target field.
        const ids = diffIds(80);
        let requestBody: Record<string, unknown> | undefined;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return {
                            choices: [{
                                finish_reason: 'stop',
                                message: {
                                    role: 'assistant',
                                    content: JSON.stringify(planWithCoverageKeys(ids, ids)),
                                },
                            }],
                        };
                    },
                },
            },
        } as any);

        return provider.createSession({ model: 'local-model' }).run({
            messages: [{ role: 'user', content: 'return an investigation plan' }],
            responseFormat: {
                name: 'investigationPlan',
                schema: z.toJSONSchema(createInvestigationPlanResponseSchema(ids, MAX_TOOL_CALLS)) as Record<string, unknown>,
            },
        }).then(() => {
            const format = requestBody?.response_format as {
                type?: string;
                json_schema: { strict?: boolean; schema: PlanJsonSchema };
            };
            const exported = format.json_schema.schema;

            assert.equal(format.type, 'json_schema');
            assert.equal(format.json_schema.strict, true);
            assert.deepEqual(exported.properties?.coverage?.required, ids);
            assert.equal(exported.properties?.coverage?.additionalProperties, false);
            assert.deepEqual(exported.required, ['targets', 'coverage', 'notes']);
            assert.equal(
                (exported.properties?.targets?.items?.properties as Record<string, unknown> | undefined)
                    ?.diffEvidenceRefs,
                undefined,
            );
        });
    });
});
