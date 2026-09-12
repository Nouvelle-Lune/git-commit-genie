import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    buildInvestigationPlanMessages,
    buildInvestigationToolResultMessage,
} from '../../services/analysis/change/prompts';
import { DraftEvidence } from '../../services/analysis/change/types';
import { INVESTIGATION_TARGET_KINDS, INVESTIGATION_PLAN_LIMITS } from '../../services/llm/providers/schemas/common';

const evidence: DraftEvidence[] = [{
    kind: 'raw',
    fileName: 'parser.ts',
    status: 'modified',
    evidenceIds: ['D1'],
    rawDiff: '@@ -1 +1 @@\n-return old\n+return new',
}];

describe('raw-diff change analysis prompts', () => {
    it('describes raw diff evidence and exactly-once D* planner coverage', () => {
        // Verify the planner prompt makes the raw-diff input and coverage contract explicit to the model.
        const messages = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /complete raw diff/i);
        assert.match(content, /Enumerate every supplied D\* id exactly once in coverage/);
        assert.match(content, /diff_sufficient/);
        assert.match(content, /target ids/);
        assert.match(content, /4 repository tool call/);
        assert.match(content, /information gain/i);
        assert.match(content, /Coverage preserves the diff; it is not a must-express\/optional\/omit decision/);
        assert.doesNotMatch(content, /change extraction/i);
    });

    it('does not describe the removed semantic extraction payload or embed a full schema', () => {
        // Verify the new prompt exposes only the provider schema contract instead of resurrecting extraction fields.
        const messages = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /provider response schema/);
        assert.doesNotMatch(content, /changedSymbols/);
        assert.doesNotMatch(content, /introducedSymbols/);
        assert.doesNotMatch(content, /"properties":\s*\{/);
    });

    it('lists every legal target kind and maps configuration to config', () => {
        // The planner prompt must expose the exact provider enum so a model cannot invent language-specific target kinds.
        const content = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        for (const kind of INVESTIGATION_TARGET_KINDS) {
            assert.match(content, new RegExp(`\\b${kind}\\b`));
        }
        assert.match(content, /Return exactly the top-level keys targets, coverage, and notes/);
        assert.match(content, /Each target has exactly id, target, kind, file, diffEvidenceRefs, and questions/);
        assert.match(content, /Each coverage row has exactly diffEvidenceRef, decision, and targetIds/);
        assert.match(content, /Use "config" for configuration keys/);
        assert.match(content, /"interface" for contracts/);
        assert.match(content, /"cli_or_api" for commands, routes, flags, or parameters/);
        assert.match(content, new RegExp(`at most ${INVESTIGATION_PLAN_LIMITS.maxTargets} targets`));
        assert.match(content, new RegExp(`${INVESTIGATION_PLAN_LIMITS.maxDiffEvidenceRefsPerTarget} D\\* ids per target`));
        assert.match(content, new RegExp(`${INVESTIGATION_PLAN_LIMITS.maxQuestionsPerTarget} questions`));
    });

    it('builds the minimal planner example from the current D* input without a fixed foreign id', () => {
        // The example must use a real input D* only for shape while warning the model not to copy its illustrative planning values.
        const customEvidence: DraftEvidence[] = [{
            kind: 'raw',
            fileName: 'src/custom.ts',
            status: 'modified',
            evidenceIds: ['D7'],
            rawDiff: '@@ -7 +7 @@\n-old\n+new',
        }];
        const content = buildInvestigationPlanMessages({ evidence: customEvidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        assert.match(content, /uses an id from the current input only to demonstrate the output shape/i);
        assert.match(content, /Do not copy its decision, target, or question/i);
        assert.match(content, /"diffEvidenceRef": "D7"/);
        assert.doesNotMatch(content, /"diffEvidenceRef": "D2"/);
    });

    it('guides executable repository questions without turning coverage into fact selection', () => {
        // The planner must ask for concrete evidence routes and keep must-express decisions outside coverage planning.
        const content = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        assert.match(content, /fewest questions that distinguish the correct commit-message claim/i);
        assert.match(content, /concrete repository lookup path/i);
        assert.match(content, /symbol\/call/);
        assert.match(content, /config\/cli_or_api/);
        assert.match(content, /type\/interface/);
        assert.match(content, /file\/hunk\/relation/);
        assert.match(content, /a test file does not prove the test passed/i);
        assert.match(content, /Coverage preserves the diff/);
    });

    it('shows cumulative evidence and a deliberately static planned-question checklist', () => {
        // Tool results must report ledger progress while making clear that planned questions are not auto-marked as complete.
        const message = buildInvestigationToolResultMessage({
            tool: 'readFileContent',
            summary: 'Read the changed parser definition.',
            evidence: [{
                id: 'E1',
                kind: 'definition',
                target: 'parse',
                ref: 'src/parser.ts:1-4',
                excerpt: 'function parse(input) { return input; }',
            }],
            repositoryEvidenceCount: 2,
            remainingSteps: 1,
            plannedQuestions: ['parse: Who calls parse?', 'parse: Which config controls it?'],
        });

        assert.match(message.content, /Repository evidence collected so far: 2 E\* item\(s\)/);
        assert.match(message.content, /Planned-question checklist: parse: Who calls parse\? \| parse: Which config controls it\?/);
        assert.match(message.content, /checklist is not automatically updated/i);
        assert.doesNotMatch(message.content, /Open questions:/);
        assert.match(message.content, /Call finishInvestigation now/i);
        assert.match(message.content, /leave any unanswered question unresolved/i);
    });

    it('requires a real evidence-producing lookup before finishing a non-empty investigation', () => {
        // A zero-E* result must steer the agent away from finishInvestigation and away from navigation-only tools.
        const message = buildInvestigationToolResultMessage({
            tool: 'listDirectory',
            summary: 'Listed one directory.',
            evidence: [],
            repositoryEvidenceCount: 0,
            remainingSteps: 2,
            plannedQuestions: ['parse: Who calls parse?'],
        });

        assert.match(message.content, /Do not call finishInvestigation yet/i);
        assert.match(message.content, /evidence-producing read or content search/i);
        assert.match(message.content, /listDirectory, searchRepositoryMemory, and searchCode with searchType "name" do not themselves publish E\* evidence/i);
    });

    it('spends the last repository call on evidence when no E* exists and then lets runtime finalize', () => {
        // With one call left and no repository evidence, the tool result must require one evidence lookup before runtime closes the phase.
        const message = buildInvestigationToolResultMessage({
            tool: 'searchCode',
            summary: 'The search returned no matching source.',
            evidence: [],
            repositoryEvidenceCount: 0,
            remainingSteps: 1,
            plannedQuestions: ['parse: Who calls parse?'],
        });

        assert.match(message.content, /Only one repository call remains and no E\* evidence exists/i);
        assert.match(message.content, /Use that final call on the highest-priority evidence-producing read or search/i);
        assert.match(message.content, /runtime will then close investigation and continue/i);
        assert.doesNotMatch(message.content, /Call finishInvestigation now/i);
    });
});
