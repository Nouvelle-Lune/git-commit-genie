import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { planInvestigation } from '../../services/analysis/change/investigation/agent';
import { DraftEvidence, InvestigationPlan } from '../../services/analysis/change/types';
import { AIMessage, AISession } from '../../services/llm/providers';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';
import { investigationPlanResponseSchema } from '../../services/llm/providers/schemas/common';

const evidence: DraftEvidence[] = [{
    kind: 'raw',
    fileName: 'src/ui/pipelineDisplay.ts',
    status: 'modified',
    evidenceIds: ['D1', 'D2'],
    rawDiff: '@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-old2\n+new2',
}];

function executionForPlans(
    plans: InvestigationPlan[],
    requests: AIMessage[][] = [],
): LLMExecution {
    let callIndex = 0;
    return {
        signal: undefined,
        temperature: 0,
        maxOutputTokens: 128,
        maxRetries: plans.length - 1,
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
        run: async <T>(_session: AISession, messages: AIMessage[], _options: LLMRunOptions): Promise<T> => {
            requests.push(messages);
            const plan = plans[callIndex];
            assert.ok(plan, `Unexpected investigation planning call ${callIndex + 1}.`);
            callIndex += 1;
            return plan as T;
        },
        accountCall: async () => ({ status: 'pricing-not-configured' as const }),
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
    };
}

function validPlan(): InvestigationPlan {
    return {
        targets: [{
            id: 'T1',
            target: 'buildDetailsForStage',
            kind: 'symbol',
            file: 'src/ui/pipelineDisplay.ts',
            diffEvidenceRefs: ['D1'],
            questions: ['What role does this symbol play?'],
        }],
        coverage: [
            { diffEvidenceRef: 'D1', decision: 'investigate', targetIds: ['T1'] },
            { diffEvidenceRef: 'D2', decision: 'diff_sufficient', targetIds: [] },
        ],
        notes: 'The second hunk is self-explanatory.',
    };
}

describe('raw-diff investigation planning contract', () => {
    it('accepts a target and exactly-once coverage entry for every D* item', async () => {
        // Verify a planner can bind an investigation target to one D* item while retaining a diff-sufficient hunk.
        const plan = await planInvestigation(evidence, executionForPlans([validPlan()]));

        assert.deepEqual(plan, validPlan());
    });

    it('accepts the new target identifiers and coverage fields in the provider schema', () => {
        // Verify the provider-facing planner schema requires explicit target ids and D* coverage bindings.
        const parsed = investigationPlanResponseSchema.parse(validPlan());

        assert.equal(parsed.targets[0].id, 'T1');
        assert.deepEqual(parsed.coverage.map(entry => entry.diffEvidenceRef), ['D1', 'D2']);
    });

    it('retries an invalid plan and sends the complete raw-diff correction contract', async () => {
        // Verify an invalid target binding is corrected within execution.maxRetries and the correction names allowed D* ids.
        const requests: AIMessage[][] = [];
        const invalid: InvestigationPlan = {
            ...validPlan(),
            coverage: [
                { diffEvidenceRef: 'D1', decision: 'investigate', targetIds: ['missing-target'] },
                { diffEvidenceRef: 'D2', decision: 'diff_sufficient', targetIds: [] },
            ],
        };

        const plan = await planInvestigation(evidence, executionForPlans([invalid, validPlan()], requests));

        assert.deepEqual(plan, validPlan());
        assert.equal(requests.length, 2);
        assert.match(requests[1][0].content, /<plan_rejected>/);
        assert.match(requests[1][0].content, /Allowed diff evidence ids: \["D1","D2"\]/);
        assert.match(requests[1][0].content, /Every allowed D\* id must appear once in coverage/);
    });

    it('rejects a diff-sufficient entry that carries a target', async () => {
        // Verify diff_sufficient coverage cannot silently trigger repository investigation.
        const invalid: InvestigationPlan = {
            ...validPlan(),
            coverage: [
                { diffEvidenceRef: 'D1', decision: 'diff_sufficient', targetIds: ['T1'] },
                { diffEvidenceRef: 'D2', decision: 'diff_sufficient', targetIds: [] },
            ],
        };

        await assert.rejects(
            planInvestigation(evidence, executionForPlans([invalid])),
            /diff-sufficient evidence 'D1' must not have investigation targets/,
        );
    });

    it('fails explicitly after maxRetries when coverage is incomplete', async () => {
        // Verify planner protocol failures are surfaced after bounded retries instead of becoming an empty plan.
        const invalid: InvestigationPlan = {
            targets: [],
            coverage: [{ diffEvidenceRef: 'D1', decision: 'diff_sufficient', targetIds: [] }],
            notes: null,
        };

        await assert.rejects(
            planInvestigation(evidence, executionForPlans([invalid, invalid])),
            /missing from coverage/,
        );
    });

    it('allows a zero-target plan only when every D* item is explicitly diff-sufficient', async () => {
        // Verify a plan with no repository targets still covers all diff evidence and remains a valid finalization path.
        const plan: InvestigationPlan = {
            targets: [],
            coverage: ['D1', 'D2'].map(diffEvidenceRef => ({
                diffEvidenceRef,
                decision: 'diff_sufficient' as const,
                targetIds: [],
            })),
            notes: 'The complete diff is sufficient.',
        };

        const result = await planInvestigation(evidence, executionForPlans([plan]));

        assert.deepEqual(result.targets, []);
        assert.deepEqual(result.coverage, plan.coverage);
    });
});
