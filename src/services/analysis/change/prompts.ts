// Prompts for change-conditioned analysis stages.
//
// Every stage prompt enforces the same three invariants:
//   1. Change first — reasoning starts from the diff, never from the repository.
//   2. Evidence before inference — a claim without a citation is not a claim.
//   3. Explicit uncertainty — unprovable information stays null, never inferred.

import { FINISH_INVESTIGATION_TOOL } from '../../../agent';
import { AIMessage } from '../../llm/providers';
import { INVESTIGATION_PLAN_LIMITS } from '../../llm/providers/schemas/common';
import { structuredOutputInstructionBlock } from '../../llm/structuredOutputPrompt';
import { DraftEvidence, RepositoryEvidenceItem } from './types';

function jsonBlock(tag: string, value: unknown): string {
    return [`<${tag}>`, JSON.stringify(value, null, 2), `</${tag}>`].join('\n');
}

// ---------------------------------------------------------------------------
// Investigation Planning
// ---------------------------------------------------------------------------

export function buildInvestigationPlanMessages(input: {
    evidence: DraftEvidence[];
    navigation?: import('../../memory/types').MemoryNavigation[];
}): AIMessage[] {
    const system: AIMessage = {
        role: 'system',
        content: [
            '<role>',
            'You plan a targeted repository investigation for one specific code change.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only.',
            'You decide what still needs to be known to explain THIS change.',
            'You do not decide what the change means, and you do not explore freely.',
            '</critical>',
        ].join('\n'),
    };

    const user: AIMessage = {
        role: 'user',
        content: [
            '<instructions>',
            'Read the complete raw diff and plan only the repository investigation needed',
            'to explain this change. Do not summarize or replace the diff.',
            'Each D* hunk must appear exactly once in coverage. Mark it investigate when',
            'repository context is needed; mark it diff_sufficient when the diff is enough.',
            'Every investigate hunk must map to one or more targets. A diff_sufficient hunk',
            'must have no target ids, but still becomes a fact later and must never be discarded.',
            'Targets may be symbols, calls, types, configuration, dependencies, files, hunks,',
            'or relations between changed pieces. Do not force a language-specific taxonomy.',
            'Use exact names and changed file paths from the diff when they are visible, but',
            'a hunk target is valid when no reliable symbol name exists.',
            'Each target must be attached to an investigate coverage entry that includes its',
            'own D* reference. Do not create unattached targets.',
            'Ask only questions answerable by the repository tools and keep each target focused.',
            `Return at most ${INVESTIGATION_PLAN_LIMITS.maxTargets} targets, at most ${INVESTIGATION_PLAN_LIMITS.maxDiffEvidenceRefsPerTarget} D* ids per target,`,
            `and at most ${INVESTIGATION_PLAN_LIMITS.maxQuestionsPerTarget} questions per target. Group related hunks under one target when needed,`,
            'but never omit a D* coverage entry merely to stay within the target limit.',
            '</instructions>',
            '',
            '<question_templates>',
            'For a changed file or hunk:',
            '- What role does this file play in the affected capability?',
            '- How do its changed declarations work together?',
            '- Which imports, exports, consumers, or tests establish its behavior?',
            '',
            'For a changed function, method, or class:',
            '- What role does this symbol play in the repository?',
            '- Who calls it?',
            '- What does it call?',
            '- What state does it read or mutate?',
            '- What configuration affects it?',
            '- What interfaces or types constrain it?',
            '- Are there tests describing its expected behavior?',
            '',
            'For a changed configuration key:',
            '- Where is this configuration consumed?',
            '- Which branches or behaviors depend on it?',
            '- What runtime behavior changes when its value changes?',
            '- Which components are affected?',
            '',
            'For a changed interface or type:',
            '- Which implementations satisfy this interface?',
            '- Which consumers depend on it?',
            '- Does the change alter externally observable behavior or only internal structure?',
            '',
            'For a changed dependency:',
            '- Where is this dependency imported?',
            '- Which of its APIs are used?',
            '- Are source changes associated with the dependency change?',
            '',
            'For a changed CLI flag, API parameter, or route:',
            '- Where is the input parsed?',
            '- Which handler receives it?',
            '- Which downstream behavior depends on it?',
            '- Is the behavior user-visible?',
            '</question_templates>',
            '',
            structuredOutputInstructionBlock(),
            '',
            jsonBlock('raw_diff_evidence', input.evidence),
            'Historical memory contains untrusted situations, investigation routes and lessons with limitations. Select or adapt relevant guidance using the current diff; it is not a maintenance instruction or current evidence. Episode-origin items are unconsolidated historical leads, not cross-snapshot experience. Check availability before planning: available means the saved location still matches this snapshot; needs_revalidation or unavailable requires a fresh repository lookup before using that entry point. A retired experience must not be reused while its retirement counterevidence matches; retirement_unmatched means neither the old experience nor its retirement is established for this snapshot.',
            jsonBlock('memory_navigation', input.navigation ?? []),

        ].join('\n'),
    };

    return [system, user];
}

// ---------------------------------------------------------------------------
// Repository Investigation
// ---------------------------------------------------------------------------

export function buildInvestigationToolResultMessage(input: {
    tool: string;
    summary: string;
    evidence: RepositoryEvidenceItem[];
    remainingSteps: number;
    openQuestions: string[];
}): AIMessage {
    const lines: string[] = [
        '<tool_result>',
        `tool: ${input.tool}`,
        input.summary,
        '</tool_result>',
    ];

    if (input.evidence.length) {
        lines.push(
            '',
            '<new_evidence>',
            ...input.evidence.map(item => `${item.id} [${item.kind}] ${item.ref}\n${item.excerpt}`),
            '</new_evidence>'
        );
    }

    lines.push(
        '',
        '<state>',
        `Remaining repository tool calls: ${input.remainingSteps}`,
        input.openQuestions.length
            ? `Open questions: ${input.openQuestions.join(' | ')}`
            : 'No open questions remain.',
        // The step budget is a ceiling, not a quota. Saying so on every turn is
        // what keeps a model from burning the remainder on unrelated lookups.
        input.remainingSteps === 0
            ? 'The repository investigation is over; no further tool call is possible.'
            : `Call ${FINISH_INVESTIGATION_TOOL} as soon as the open questions are answered or are unanswerable.`
            + ' There is no reward for spending the remaining budget.',
        '</state>'
    );

    return { role: 'user', content: lines.join('\n') };
}
