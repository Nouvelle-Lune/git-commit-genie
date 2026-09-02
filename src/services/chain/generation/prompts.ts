import { AIMessage } from '../../llm/providers';
import { structuredOutputInstructionBlock } from '../../llm/structuredOutputPrompt';
import { SelectedSemanticInformation } from '../../analysis/change/types';
import { ChainInputs, RagStyleReference } from '../types';

/** Internal claim/evidence ids describe traceability, never a code scope. */
function isInternalTraceIdentifier(value: string | null): boolean {
    return value !== null && /^\[?[CDE]\d+(?:\/P\d+)?\]?$/i.test(value.trim());
}

// Stage 6: Commit Generation
// ---------------------------------------------------------------------------

/**
 * The generator receives selected semantic information plus the diff — not the
 * investigation trajectory. Re-analyzing the repository here would reintroduce
 * exactly the unfiltered context the selection stage exists to remove.
 */
export function buildChangeConditionedDraftMessages(input: {
    selected: SelectedSemanticInformation;
    evidencePayload: unknown;
    inputs: ChainInputs;
    ragStyleReferences?: RagStyleReference[];
}): AIMessage[] {
    const { userTemplate, currentTime, targetLanguage } = input.inputs;
    const ragStyleReferences = input.ragStyleReferences ?? [];
    const suggestedScopeIsInternal = isInternalTraceIdentifier(input.selected.suggestedScope);

    const system: AIMessage = {
        role: 'system',
        content: [
            '<role>',
            'You are an expert on Conventional Commits.',
            'You convert an already-completed semantic analysis into a concise commit message.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only. No markdown in values.',
            'Your job is to express the selected semantic information, not to re-analyze',
            'the repository or to add facts that the analysis did not establish.',
            'If a user template is provided, follow it with HIGHEST PRIORITY while',
            'maintaining Conventional Commits structure.',
            '</critical>',
        ].join('\n'),
    };

    const lines: string[] = [
        '<input>',
        JSON.stringify({
            now: currentTime ?? new Date().toISOString(),
            target_language: targetLanguage || '',
            selected_information: {
                analysis_status: input.selected.analysisStatus,
                analysis_issues: input.selected.analysisIssues,
                primary_intent: input.selected.primaryIntent,
                must_express: input.selected.mustExpress,
                optional: input.selected.optional,
                omit: input.selected.omit,
                suggested_scope: suggestedScopeIsInternal ? null : input.selected.suggestedScope,
                discarded_internal_scope: suggestedScopeIsInternal,
                recommended_type: input.selected.recommendedType,
                behavior_before: input.selected.behaviorBefore,
                behavior_after: input.selected.behaviorAfter,
                observable_effect: input.selected.observableEffect,
                technical_capability: input.selected.technicalCapability,
                breaking_signals: input.selected.breakingSignals,
                uncertainties: input.selected.uncertainties,
            },
        }, null, 2),
        '</input>',
        '',
        '<change_evidence>',
        'The diff is provided so you can pick precise wording and exact identifiers.',
        'Entries with kind="raw" contain complete file diffs; entries with kind="summary"',
        'contain hunk-referenced structured evidence.',
        'Use it for accuracy of naming, never as a reason to introduce a claim that',
        'selected_information does not contain.',
        JSON.stringify(input.evidencePayload, null, 2),
        '</change_evidence>',
        '',
        '<content_policy>',
        '• Every statement in must_express appears in the message.',
        '• Statements in optional appear only when they fit within the length limits.',
        '• Statements in omit never appear, not even reworded.',
        '• uncertainties are never presented as facts; prefer leaving them out entirely.',
        '• When primary_intent is null, describe the observable change instead of guessing why.',
        '• When analysis_status is degraded, use the surviving normalized must_express and optional claims; analysis_issues are diagnostics, not message content.',
        '• When analysis_status is unavailable, use only changes directly observable in change_evidence.',
        '• When must_express is empty, do not state intent, product impact, or repository facts; describe the concrete diff conservatively.',
        '• Do not enumerate changed files; describe the change.',
        '• C1, D1, E1, D1/P1, and similar C*/D*/E* values are internal claim/evidence identifiers, not semantic content.',
        '• Never copy internal claim/evidence identifiers into the commit header, body, or footers.',
        '</content_policy>',
        '',
        '<type_and_scope>',
        'Available commit types: feat, fix, docs, style, refactor, perf, test, build, ci,',
        'chore, and any other type provided by the user template.',
        'Prefer recommended_type when it is non-null; it was derived from evidence.',
        'Override it only when the diff plainly contradicts it, and only to another',
        'allowed type. When recommended_type is null, choose the type from the diff.',
        'Prefer suggested_scope when it is non-null; omit the scope when it is null and',
        'no single area honestly covers the change.',
        'A scope must name a real module, package, component, feature, or code area that a developer would recognize.',
        'Never use an internal identifier such as C1, D2, E3, [D1], or D1/P2 as the scope.',
        'When discarded_internal_scope is true, derive a real scope from changed symbols or paths; omit scope if none is clear.',
        '',
        'HARD RULES FOR DOCUMENTATION-ONLY CHANGES:',
        '- Do NOT infer new features or bug fixes from documentation changes.',
        '- The description should reflect that documentation was updated.',
        '</type_and_scope>',
        '',
        '<format_requirements>',
        'First line: <type>[optional scope][!]: <description>',
        'If breaking=true and you use "!", do not require a BREAKING CHANGE footer.',
        'If breaking=true and no "!" is used, include a footer: BREAKING CHANGE: <details>.',
        'Body must start after one blank line.',
        'Footers must start after one blank line (after body if present).',
        'First line length must be <= 72 characters; imperative; no trailing period.',
        'Return only the structured components in the schema; local code assembles the final commit message.',
        'Do not repeat footer lines such as BREAKING CHANGE inside body.',
        'No markdown, code fences, or extra commentary in any field.',
        '</format_requirements>',
        '',
        '<language_requirement>',
        'Use the target language for narrative text (description, body, footer values).',
        'Do NOT translate the <type> token; keep it in English.',
        'Do NOT translate footer tokens like BREAKING CHANGE or Refs.',
        (targetLanguage && targetLanguage.trim() ? `Target language hint: ${targetLanguage}` : 'Target language hint: en'),
        '</language_requirement>',
        '',
        structuredOutputInstructionBlock(),
    ];

    if (userTemplate && userTemplate.trim()) {
        lines.push(
            '',
            '<template_priority>',
            'USER TEMPLATE - HIGHEST PRIORITY:',
            '- The user has provided a custom template. Follow it with HIGHEST PRIORITY.',
            '- Maintain Conventional Commits header format: <type>[scope]: <description>',
            '- Apply ALL template requirements for body structure, formatting, tone, and content.',
            '- Template rules override base rules when there are conflicts.',
            '</template_priority>',
            '',
            '<user_template>',
            userTemplate,
            '</user_template>'
        );
    }

    if (ragStyleReferences.length) {
        const styleRefs = ragStyleReferences.map(reference => ({
            commit_message: reference.message,
            type: reference.type || null,
            scope: reference.scope ?? null,
            matched_by: reference.matchedBy,
            style_reason: reference.styleReason,
        }));

        lines.push(
            '',
            '<rag_style_reference>',
            'Historical commit messages below are STYLE REFERENCES ONLY.',
            'Each example carries a `style_reason` field describing the stylistic features',
            'worth learning from it (type/scope granularity, title length, tone, body structure).',
            '**Your core reference is the textual description in `style_reason`**, rather than',
            'the specific content of the example messages themselves.',
            '- Do NOT copy, paraphrase, or reuse any concrete facts, entities, file names,',
            '  feature names, bug names, or claims from these examples.',
            '- Every factual statement in the new commit message must be grounded in',
            '  selected_information and change_evidence, not in the historical examples.',
            '- A style example must never change WHICH facts you state, only HOW you state them.',
            '- If a style example conflicts with the current change, ignore it.',
            JSON.stringify(styleRefs, null, 2),
            '</rag_style_reference>',
            '',
            '<style_requirement>',
            'Use rag_style_references only for style calibration: you may mirror style',
            'patterns, but you must not borrow topic-specific content from them.',
            '</style_requirement>'
        );
    }

    lines.push(
        '',
        '<critical>',
        'Return strictly valid JSON.',
        '</critical>'
    );

    return [system, { role: 'user', content: lines.join('\n') }];
}
