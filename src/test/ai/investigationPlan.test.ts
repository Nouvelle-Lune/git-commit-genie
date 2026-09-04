import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { planInvestigation } from '../../services/analysis/change/investigation/agent';
import { ChangeExtraction, InvestigationPlan } from '../../services/analysis/change/types';
import { AIMessage, AISession } from '../../services/llm/providers';
import { LLMExecution, LLMRunOptions } from '../../services/llm/llmTypes';
import { investigationPlanResponseSchema } from '../../services/llm/providers/schemas/common';

const extraction: ChangeExtraction = {
    changedFiles: [{ path: 'src/ui/pipelineDisplay.ts', changeType: 'modified' }],
    changedSymbols: [{
        name: 'buildDetailsForStage',
        file: 'src/ui/pipelineDisplay.ts',
        symbolType: 'function',
        changeKind: 'function_body',
        evidenceRefs: ['D1'],
    }],
    introducedSymbols: [],
    removedSymbols: [],
    changedCalls: [],
    changedConfigs: [],
    changedTypes: [],
    changedDependencies: [],
};

function executionFor(plan: InvestigationPlan): LLMExecution {
    return executionForPlans([plan]);
}

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
        thinkingLevel: 'off',
        tokenBudget: {} as LLMExecution['tokenBudget'],
        thinkingFor: () => ({ reasoning: false, level: 'off' }),
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

describe('investigation planning target grounding', () => {
    it('accepts file as an investigation target kind in structured output', () => {
        const parsed = investigationPlanResponseSchema.parse({
            targets: [{
                target: 'src/ui/pipelineDisplay.ts',
                kind: 'file',
                file: 'src/ui/pipelineDisplay.ts',
                questions: ['How do the changed declarations work together?'],
            }],
            notes: null,
        });

        assert.equal(parsed.targets[0].kind, 'file');
    });

    it('accepts a file target when the exact path is present in the change', async () => {
        const plan = await planInvestigation(extraction, executionFor({
            targets: [{
                target: 'src/ui/pipelineDisplay.ts',
                kind: 'file',
                file: 'src/ui/pipelineDisplay.ts',
                questions: ['How do the changed declarations work together?'],
            }],
            notes: null,
        }));

        assert.deepEqual(plan.targets, [{
            target: 'src/ui/pipelineDisplay.ts',
            kind: 'file',
            file: 'src/ui/pipelineDisplay.ts',
            questions: ['How do the changed declarations work together?'],
        }]);
    });

    it('rejects a file target whose file field names a different path', async () => {
        const plan = await planInvestigation(extraction, executionFor({
            targets: [{
                target: 'src/ui/pipelineDisplay.ts',
                kind: 'file',
                file: 'src/ui/different.ts',
                questions: ['How do the changed declarations work together?'],
            }],
            notes: null,
        }));

        assert.deepEqual(plan.targets, []);
    });

    it('rejects a file target that is not part of the change', async () => {
        const plan = await planInvestigation(extraction, executionFor({
            targets: [{
                target: 'src/ui/unrelated.ts',
                kind: 'file',
                file: 'src/ui/unrelated.ts',
                questions: ['What role does this file play?'],
            }],
            notes: null,
        }));

        assert.deepEqual(plan.targets, []);
    });

    it('does not accept a changed file path mislabeled as a symbol', async () => {
        const plan = await planInvestigation(extraction, executionFor({
            targets: [{
                target: 'src/ui/pipelineDisplay.ts',
                kind: 'symbol',
                file: 'src/ui/pipelineDisplay.ts',
                questions: ['What role does this symbol play?'],
            }],
            notes: null,
        }));

        assert.deepEqual(plan.targets, []);
    });

    it('retries when non-empty candidates are all rejected by grounding', async () => {
        const requests: AIMessage[][] = [];
        const plan = await planInvestigation(extraction, executionForPlans([{
            targets: [{
                target: 'src/ui/pipelineDisplay.ts',
                kind: 'symbol',
                file: 'src/ui/pipelineDisplay.ts',
                questions: ['What role does this symbol play?'],
            }],
            notes: 'The file path was mislabeled as a symbol.',
        }, {
            targets: [{
                target: 'src/ui/pipelineDisplay.ts',
                kind: 'file',
                file: 'src/ui/pipelineDisplay.ts',
                questions: ['How do the changed declarations work together?'],
            }],
            notes: 'The corrected target uses the file kind.',
        }], requests));

        assert.deepEqual(plan.targets, [{
            target: 'src/ui/pipelineDisplay.ts',
            kind: 'file',
            file: 'src/ui/pipelineDisplay.ts',
            questions: ['How do the changed declarations work together?'],
        }]);
        assert.equal(requests.length, 2);
        assert.match(requests[1][0].content, /<grounding_rejected>/);
        assert.match(requests[1][0].content, /Allowed changed file paths/);
    });

    it('does not retry an intentionally empty investigation plan', async () => {
        const requests: AIMessage[][] = [];
        const plan = await planInvestigation(extraction, executionForPlans([{
            targets: [],
            notes: 'The diff is self-explanatory.',
        }, {
            targets: [{
                target: 'src/ui/pipelineDisplay.ts',
                kind: 'file',
                file: 'src/ui/pipelineDisplay.ts',
                questions: ['What role does this file play?'],
            }],
            notes: null,
        }], requests));

        assert.deepEqual(plan.targets, []);
        assert.equal(requests.length, 1);
    });
});
