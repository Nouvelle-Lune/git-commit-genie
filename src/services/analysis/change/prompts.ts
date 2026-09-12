// Prompts for change-conditioned analysis stages.
//
// Every stage prompt enforces the same three invariants:
//   1. Change first — reasoning starts from the diff, never from the repository.
//   2. Evidence before inference — a claim without a citation is not a claim.
//   3. Explicit uncertainty — unprovable information stays null, never inferred.

import { FINISH_INVESTIGATION_TOOL } from '../../../agent';
import { AIMessage } from '../../llm/providers';
import { INVESTIGATION_LOOKUPS, INVESTIGATION_PLAN_LIMITS, INVESTIGATION_TARGET_KINDS } from '../../llm/providers/schemas/common';
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
    maxToolCalls: number;
    repositoryMap?: string;
    navigation?: import('../../memory/types').MemoryNavigation[];
}): AIMessage[] {
    const diffEvidenceIds = input.evidence
        .flatMap(item => item.kind === 'raw' ? item.evidenceIds : item.coveredHunkIds);
    // The example shows the value shape for two real ids instead of enumerating
    // every D* key. Enumerating them would make 79 of 80 sample values read
    // "diff_sufficient", and a planner that copies that pattern produces a
    // zero-target plan — which grants no repository tools at all. The schema
    // already declares the full key set, so the example only has to teach what
    // a value looks like under each decision.
    // The excerpt shows both decisions weighted towards the one that should be
    // the common answer. Exactly one investigate entry is always kept: a plan
    // with no target grants no repository tools at all, so an example that reads
    // as "everything is diff_sufficient" costs the whole investigation stage.
    const exampleInvestigatedRef = diffEvidenceIds[0];
    const exampleSufficientRefs = [
        diffEvidenceIds[Math.floor(diffEvidenceIds.length / 2)],
        diffEvidenceIds[diffEvidenceIds.length - 1],
    ]
        .filter(ref => ref !== undefined && ref !== exampleInvestigatedRef)
        .filter((ref, index, refs) => refs.indexOf(ref) === index);
    // The prompt and the response schema read the same arithmetic, so a model
    // can never be shown a target cap that differs from the one its plan is
    // decoded against.
    const targetBudget = Math.min(INVESTIGATION_PLAN_LIMITS.maxTargets, input.maxToolCalls);
    // Coverage references are bounded by the same plan size: an entry cannot
    // name a target the plan was never allowed to declare.
    const targetIdsPerCoverageEntry = Math.min(
        INVESTIGATION_PLAN_LIMITS.maxTargetIdsPerCoverageEntry,
        targetBudget,
    );
    const exampleCoverage: Record<string, { decision: string; targetIds: string[] }> = {};
    if (exampleInvestigatedRef) {
        exampleCoverage[exampleInvestigatedRef] = { decision: 'investigate', targetIds: ['T1'] };
        for (const ref of exampleSufficientRefs) {
            exampleCoverage[ref] = { decision: 'diff_sufficient', targetIds: [] };
        }
    }
    // The excerpt samples the first, middle, and last id, so it is partial for
    // any request of four or more hunks. A one- to three-hunk request is fully
    // covered by those three samples, and there the prompt must not claim an
    // omission the model can see is not there.
    const exampleCoversEveryId = diffEvidenceIds.every(id => id in exampleCoverage);
    const minimalExample = exampleInvestigatedRef
        ? {
            targets: [{
                id: 'T1',
                target: 'changed unit shown by the selected hunk',
                kind: 'hunk',
                lookup: 'definition',
                file: input.evidence[0]?.fileName ?? null,
                question: 'Which nearby definition or focused consumer determines the observable scope of this changed unit?',
            }],
            coverage: exampleCoverage,
            notes: `${exampleInvestigatedRef} needs repository context to qualify its factual description.`,
        }
        : { targets: [], coverage: {}, notes: null };
    const system: AIMessage = {
        role: 'system',
        content: [
            '<role>',
            'You are the repository-investigation planner for one specific code change.',
            'Your plan tells a separate read-only agent which unknowns to resolve before it writes evidence-backed commit-message facts.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only.',
            'Plan evidence acquisition; do not write the commit message, settle unsupported intent, or summarize away the diff.',
            'The response schema already declares one coverage key per D* id of this diff. Those keys are given; your work is the decision stored under each one.',
            'Every D* keeps its coverage key whatever you decide, so diff_sufficient never removes a hunk from the plan: it records that the diff itself already supports that hunks factual description.',
            'investigate is the expensive decision. It spends lookup calls the agent may need elsewhere, so reserve it for hunks whose description genuinely depends on something the diff does not show.',
            `Your plan must fit the shared budget: at most ${targetBudget} target(s), one repository lookup each.`,
            '</critical>',
        ].join('\n'),
    };

    const user: AIMessage = {
        role: 'user',
        content: [
            '<planning_objective>',
            'Read the complete raw diff first. Investigate only an unknown whose answer could materially change or qualify the factual commit message:',
            '- what runtime/build/test behavior the changed unit participates in;',
            '- which caller, consumer, implementation, configuration, or public boundary gives the change its scope;',
            '- whether several hunks form one behavior or independent changes;',
            '- whether a test or contract establishes behavior that the changed implementation alone does not.',
            'Do not investigate generic repository background, style preferences, business motivation, or facts already explicit in the diff.',
            `The investigation agent has ${input.maxToolCalls} repository tool call(s), shared by every target in your plan and by nothing else.`,
            `Each target spends one of those calls on the lookup it declares, so a plan declaring more than ${targetBudget} target(s) would promise lookups the agent cannot pay for.`,
            'Order targets by information gain so the agent resolves the most consequential uncertainty first.',
            '</planning_objective>',
            '',
            '<coverage_contract>',
            'Return exactly the top-level keys targets, coverage, and notes. notes is a string or null.',
            'coverage is a JSON object keyed by diff evidence id, not an array. The schema declares one required key per supplied D* id and forbids any other key.',
            'Never delete, rename, or add a coverage key. The key set is fixed before you answer; only the value under each key is yours to decide.',
            'Each value has exactly decision and targetIds.',
            '1. "diff_sufficient" is the normal answer: that hunk already supports its factual description and a repository lookup would not change the wording. Its targetIds must be [].',
            '2. "investigate" is the exception and it is expensive: it spends part of a shared budget the agent also needs for every other target. Use it only when a repository lookup can resolve a material unknown, and name one or more declared target ids in its targetIds.',
            'A hunk the diff already determines is diff_sufficient, not investigate. Coverage is about what the diff can support alone, and the agent reads the whole diff before any lookup.',
            'Every target you declare must be named by at least one investigate entry. Never create an unattached target.',
            'Coverage preserves the diff; it is not a must-express/optional/omit decision.',
            '</coverage_contract>',
            '',
            '<target_contract>',
            'Each target has exactly id, target, kind, lookup, file, and question. file is an exact changed path or null; ids and targetIds are strings.',
            `Every target.kind must be exactly one of these literal values: ${INVESTIGATION_TARGET_KINDS.join(', ')}.`,
            'Copy one literal exactly. Use "config" for configuration keys, "interface" for contracts, and "cli_or_api" for commands, routes, flags, or parameters.',
            `Every target.lookup must be exactly one of these literal values: ${INVESTIGATION_LOOKUPS.join(', ')}.`,
            'lookup is the retrieval verb the agent uses first for that target. definition, references, callers, callees, implementations, type, and search each name a relation that no hunk shows; "read" returns a region of a changed file, which is worth a lookup only when the hunks around the change do not show the surrounding control flow, the imports, or the rest of the definition.',
            'Prefer a relation verb when the unknown is a relation, and mark a hunk diff_sufficient when the diff settles it: a read target spends budget that a caller, implementation, or test lookup could have used.',
            'A target is one coherent unknown plus a concrete repository entry point. Prefer an exact changed symbol and file path; use "hunk" only when the diff exposes no reliable symbol.',
            `A target carries exactly one question, and a plan declares at most ${targetBudget} target(s): one coverage entry may name at most ${targetIdsPerCoverageEntry} targets.`,
            `That cap is the whole budget: ${input.maxToolCalls} repository call(s) are all the agent has, and each target spends one on the lookup it declares.`,
            `Use that budget on the highest-value unknowns. When the material unknowns cannot all fit in ${targetBudget} target(s), keep the hunks whose answer most changes the commit message, mark the rest diff_sufficient, declare no target those entries no longer name, and state in notes which unknowns the budget left unfunded.`,
            'Never pad the plan with targets the budget cannot reach, and never label a hunk investigate when the diff already establishes its factual description.',
            '</target_contract>',
            '',
            '<question_design>',
            'Write the fewest questions that distinguish the correct commit-message claim from plausible but unsupported alternatives, remembering that each one costs a whole target and the repository call that target spends.',
            'Each question must be answerable by the available read/search tools and must name the concrete symbol, path, key, endpoint, or relation to inspect.',
            'Order questions as an executable route:',
            '- symbol/call: locate or read the changed definition, then trace callers, callees, or references only when that relation changes the claim;',
            '- config/cli_or_api: locate the exact parser or consumer, then inspect the branch or handler controlled by it;',
            '- type/interface: inspect the definition, then implementations or consumers that establish compatibility or observable scope;',
            '- file/hunk/relation: read the changed region, then search the exact connected name in the other changed or consuming file;',
            '- tests: inspect a focused test only when it defines the expected contract; a test file does not prove the test passed.',
            'Do not ask vague questions such as "What does this repository do?" or "Why was this change made?" Repository co-occurrence cannot prove intent.',
            '</question_design>',
            '',
            '<self_check>',
            'Before returning JSON, verify all of the following:',
            '- every coverage key the schema supplied is still present, spelled exactly as it was supplied;',
            '- every kind is one of the exact literals above;',
            '- every investigate entry names at least one target you declared, and every diff_sufficient entry names none;',
            '- every target you declared is named by at least one investigate entry;',
            '- every lookup is one of the exact literals above;',
            `- the plan declares at most ${targetBudget} target(s), one question each;`,
            '- when that budget forced a cut, notes says which unknowns it left unfunded;',
            '- every question is answerable by the declared lookup of the target it belongs to and could affect the factual commit message.',
            '</self_check>',
            '',
            '<minimal_example>',
            ...(exampleCoversEveryId
                ? ['This excerpt uses ids from the current input only to demonstrate the output shape, and for this request it happens to show every supplied D* id. The response you return must still carry one entry for each of them.']
                : ['This excerpt uses ids from the current input only to demonstrate the output shape. Its coverage is incomplete on purpose: the response you return must contain one entry for every D* id the schema supplies, not only the ones shown here.']),
            'Most hunks of a diff are diff_sufficient; the excerpt keeps one investigate entry because a plan with no target grants the agent no repository tools at all.',
            'Do not copy its decisions, target, or question without independently checking those hunks.',
            JSON.stringify(minimalExample, null, 2),
            // Repeated after the JSON as well as before it: an answer formed by
            // copying the excerpt has to know what the excerpt is, and the last
            // line before the close tag is where that copying is most likely to
            // happen. Which warning applies depends on whether the excerpt is
            // actually partial for this request.
            ...(exampleCoversEveryId
                ? ['The object above happens to satisfy this request, but its decisions are illustrative. Return your own plan, with one entry for every D* id the schema supplies.']
                : ['The object above is not a valid plan for this request: it omits most coverage keys. Return one entry for every D* id the schema supplies.']),
            '</minimal_example>',
            '',
            structuredOutputInstructionBlock(),
            '',
            // Plain text rather than jsonBlock: the map is line-oriented and
            // JSON-escaping it would turn a readable table into one long string.
            // It comes before the diff so the model sees the repository before
            // the change, which is what makes a repository-wide lookup choosable
            // instead of defaulting to the changed files it can already see.
            ...(input.repositoryMap ? [
                '<repository_map>',
                input.repositoryMap,
                // An inventory invites a repository tour. Naming what it is not
                // keeps the map an aiming aid rather than a work list.
                'This map locates structure outside the diff. It is an inventory, not evidence: nothing in it has been read, and it never answers a question by itself.',
                '</repository_map>',
            ] : []),
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
    repositoryEvidenceCount: number;
    remainingSteps: number;
    plannedQuestions: string[];
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
        `Repository evidence collected so far: ${input.repositoryEvidenceCount} E* item(s).`,
        input.plannedQuestions.length
            ? `Planned-question checklist: ${input.plannedQuestions.join(' | ')}`
            : 'The plan contains no repository questions.',
        'This checklist is not automatically updated. Use the tool results already seen to decide which questions are answered, still material, or unanswerable.',
        // The step budget is a ceiling, not a quota. Saying so on every turn is
        // what keeps a model from burning the remainder on unrelated lookups.
        input.remainingSteps === 0
            ? 'The repository investigation is over; no further tool call is possible.'
            : input.remainingSteps === 1 && input.repositoryEvidenceCount > 0
                ? `The next repository call would reach the limit. Call ${FINISH_INVESTIGATION_TOOL} now and leave any unanswered question unresolved; do not spend the final call on optional context.`
                : input.remainingSteps === 1
                    ? `Only one repository call remains and no E* evidence exists. Use that final call on the highest-priority evidence-producing read or search; the runtime will then close investigation and continue with whatever evidence was actually collected.`
            : input.repositoryEvidenceCount === 0 && input.plannedQuestions.length
                ? `Do not call ${FINISH_INVESTIGATION_TOOL} yet. Use an evidence-producing read or content search on the highest-priority target; listDirectory, searchRepositoryMemory, and searchCode with searchType "name" do not themselves publish E* evidence.`
                : `Call ${FINISH_INVESTIGATION_TOOL} as soon as the material planned questions are answered or are unanswerable.`
                + ' There is no reward for spending the remaining budget.',
        '</state>'
    );

    return { role: 'user', content: lines.join('\n') };
}
