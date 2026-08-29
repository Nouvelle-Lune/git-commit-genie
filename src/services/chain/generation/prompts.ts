import { z } from 'zod';
import { AIMessage } from '../../llm/providers';
import { classifyAndDraftResponseSchema } from '../../llm/providers/schemas/common';
import { SelectedSemanticInformation } from '../../analysis/change/types';
import { ChainInputs, RagStyleReference } from '../types';

function structuredSchemaBlock(schema: z.ZodTypeAny): string {
    return [
        '<schema>',
        'Return exactly one JSON object matching this JSON Schema. Use the exact camelCase keys.',
        'Do not add keys, wrap the object, use markdown, or replace primitive values with objects.',
        JSON.stringify(z.toJSONSchema(schema), null, 2),
        '</schema>',
    ].join('\n');
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
                primary_intent: input.selected.primaryIntent,
                must_express: input.selected.mustExpress,
                optional: input.selected.optional,
                omit: input.selected.omit,
                suggested_scope: input.selected.suggestedScope,
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
        '• Do not enumerate changed files; describe the change.',
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
        structuredSchemaBlock(classifyAndDraftResponseSchema),
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
