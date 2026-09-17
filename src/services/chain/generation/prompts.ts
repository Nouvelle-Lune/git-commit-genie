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
            'You convert an already-completed semantic analysis into the smallest commit',
            'message that still identifies the change correctly.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only. No markdown in values.',
            'Your job is to SYNTHESIZE the selected semantic information into one commit',
            'message, not to restate it, enumerate it, or re-analyze the repository.',
            'selected_information is evidence for deciding WHAT the commit means.',
            'It is NOT a checklist to restate, summarize, or enumerate.',
            'Prefer semantic compression over coverage-by-repetition. Multiple selected',
            'claims that describe the same underlying change MUST be fused into one',
            'higher-level statement.',
            'A shorter message that semantically entails several must_express claims is',
            'BETTER than a longer message that restates those claims individually.',
            'Never add facts that the analysis did not establish.',
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
        '• must_express is a semantic coverage set, NOT a sentence-level checklist.',
        '• Preserve the DISTINCT information carried by must_express, but never map each item to a separate phrase or sentence.',
        '• When multiple claims describe the same underlying change, collapse them into the shortest statement that entails them.',
        '• Semantic entailment counts as coverage; explicit restatement is not what establishes it.',
        '• Do not restate information already implied by the header.',
        '• Do not restate the same fact through intent, mechanism, before/after state, and observable effect.',
        '• Prefer the highest-level concrete behavior that distinguishes this change from the previous behavior.',
        '• Include implementation detail only when it is necessary to distinguish the change or when repository style consistently requires it.',
        '• optional is omitted by default. Include it only when it adds a distinct fact necessary to understand the commit.',
        '• Statements in omit never appear, not even reworded.',
        '• uncertainties are never presented as facts; prefer leaving them out entirely.',
        '• When primary_intent is null, describe the observable change instead of guessing why.',
        '• When analysis_status is degraded, use the surviving normalized must_express and optional claims; analysis_issues are diagnostics, not message content.',
        '• When analysis_status is unavailable, use only changes directly observable in change_evidence.',
        '• When must_express is empty, do not state intent, product impact, or repository facts; describe the concrete diff conservatively.',
        '• Do not enumerate changed files or evidence items; describe the change.',
        '• C1, D1, E1, D1/P1, and similar C*/D*/E* values are internal claim/evidence identifiers, not semantic content.',
        '• Never copy internal claim/evidence identifiers into the commit header, body, or footers.',
        '</content_policy>',
        '',
        '<body_policy>',
        'The header is the primary commit message.',
        'Omit the body by default.',
        'Add a body ONLY when there is at least one important, non-redundant semantic',
        'fact that:',
        '1. cannot be naturally expressed in the header, AND',
        '2. materially changes how a developer would understand the commit.',
        'Do not create a body merely to achieve explicit coverage of must_express.',
        'If a body is necessary:',
        '- use at most 2 concise sentences;',
        '- do not repeat the header;',
        '- do not narrate before/after/mechanism/effect separately when they describe',
        '  the same change.',
        '</body_policy>',
        '',
        '<semantic_priority>',
        'Use selected information with the following semantic priority:',
        '1. primary_intent / must_express: determine the semantic identity of the commit.',
        '2. observable_effect: use only when it contributes information not already implied by (1).',
        '3. behavior_before / behavior_after: reasoning aids only. Do not narrate both sides unless the transition itself is essential to understanding the change.',
        '4. technical_capability: implementation context only. Omit unless necessary for precision.',
        '5. optional: omit by default.',
        'The selected fields are multiple views over the analyzed change, not a list of',
        'independently reportable facts.',
        '</semantic_priority>',
        '',
        '<anti_restatement>',
        'Do not produce a message by summarizing each input field.',
        'Before writing, identify the minimum semantic proposition that explains the',
        'change.',
        'Treat intent, mechanism, before/after behavior, observable effect, and',
        'technical capability as potentially different views of the SAME change, not',
        'automatically different facts worth mentioning.',
        'If removing a phrase does not make the commit ambiguous or materially less',
        'informative, remove it.',
        '</anti_restatement>',
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
        'When discarded_internal_scope is true, derive a real scope from the selected claims or changed paths; omit scope if none is clear.',
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
        'Set body to null when body_policy requires no body.',
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
            'Style references never override body_policy: an example having a body is',
            'not a reason for this message to have one.',
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
