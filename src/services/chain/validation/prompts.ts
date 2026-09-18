import { AIMessage } from '../../llm/providers';
import type { CommitFactContext } from './commitValidation';

export function buildValidateAndFixMessages(
    commitMessage: string,
    checklistText?: string,
    userTemplate?: string,
    factContext?: CommitFactContext,
): AIMessage[] {
    const system: AIMessage = {
        role: 'system',
        content: [
            '<role>',
            'You are a strict Conventional Commits validator and fixer.',
            '</role>',
            '',
            '<critical>',
            'Output ONLY JSON.',
            'Do not include markdown.',
            'Apply minimal edits when fixing, but you may edit header, body, footers, language, and template structure as required.',
            'The semantic facts supplied below are authoritative. Never drop the meaning of a required fact, and never add a fact that is not supplied.',
            'Compressed wording is valid: a required fact is preserved when the message entails it, even if no phrase restates it. Never expand a message just to make a fact explicit.',
            'If user template is provided, follow it with HIGHEST PRIORITY while maintaining Conventional Commits structure.',
            '</critical>'
        ].join('\n')
    };

    // Build concise validation checklist string
    const defaultChecklist = [
        '<validation_rules>',
        '- Header: <type>(optional-scope)[!]: <description>',
        '- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore and any other type provided by the user template(If provided) (English only)',
        '- Header length <= 72; imperative; no trailing period',
        '- One blank line between header/body and body/footers',
        '- Language policy: narrative text follows target language; do NOT translate <type> or footer tokens',
        '- Body: omitted by default; a body is justified only by a distinct fact the header cannot carry, or by a user template that mandates one. When a body is present, prefer short paragraphs separated by blank lines (no list markers). Flag a body that only restates the header unless a user template requires a body',
        '- Footers: Token: value; use hyphen in tokens (except BREAKING CHANGE)',
        '- Breaking change: either ! in header or BREAKING CHANGE: <details> footer',
        '- Multiple footers allowed; BREAKING-CHANGE == BREAKING CHANGE',
        '- Return valid JSON only; no markdown fences or extra commentary',
        '</validation_rules>'
    ].join('\n');

    const checklist = [
        '<validation_checklist>',
        'Validation checklist:',
        (checklistText && checklistText.trim()) ? checklistText.trim() : defaultChecklist,
        '</validation_checklist>'
    ].join('\n');

    let templateSection = '';
    if (userTemplate && userTemplate.trim()) {
        templateSection = [
            '',
            '<user_template>',
            'USER TEMPLATE - HIGHEST PRIORITY:',
            '- Follow the user template with highest priority',
            '- Apply template requirements for body, footers, and formatting',
            '',
            userTemplate,
            '</user_template>'
        ].join('\n');
    }

    const user: AIMessage = {
        role: 'user',
        content: [
            '<instructions>',
            'Check the following commit message against the rules.',
            '</instructions>',
            '',
            '<schema>',
            'Output JSON schema (STRICT):',
            '{',
            '  "status": "valid"|"fixed" (default: "valid"),',
            '  "commitMessage": string,',
            '  "violations": string[] (default: []),',
            '  "preservedFactIds": string[] (every required C* id that remains expressed),',
            '  "notes": string|null (default: null)',
            '}',
            '</schema>',
            '',
            '<constraints>',
            'Additionally enforce: header <type> MUST be one of [feat, fix, docs, style, refactor, perf, test, build, ci, chore, and any other type provided by user template] and MUST NOT be translated.',
            '</constraints>',
            '',
            checklist,
            templateSection,
            '',
            '<fact_contract>',
            'A required fact counts as expressed when the message semantically entails it, including through a higher-level statement that subsumes several facts.',
            'preservedFactIds must list every required fact id that commitMessage entails, however compressed the wording is.',
            'Do NOT expand the message merely to increase explicit coverage, and do not restate before/after/mechanism/effect separately when they describe the same change.',
            'Fix only genuine omissions: a required fact that no part of the message entails.',
            'Optional facts may be retained or removed; never add a fact that is not supplied.',
            JSON.stringify({
                required_facts: factContext?.requiredFacts ?? [],
                optional_facts: factContext?.optionalFacts ?? [],
            }, null, 2),
            '</fact_contract>',
            '',
            '<input>',
            'Commit message:',
            commitMessage,
            '</input>'
        ].join('\n')
    };

    return [system, user];
}

export function buildEnforceLanguageMessages(
    commitMessage: string,
    lang: string,
    userTemplate?: string,
    factContext?: CommitFactContext,
): AIMessage[] {
    const system: AIMessage = {
        role: 'system',
        content: [
            '<role>',
            'You are a precise editor for Conventional Commit messages.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only; do not include markdown or code fences.',
            'If user template is provided, follow it with HIGHEST PRIORITY while maintaining Conventional Commits structure.',
            '</critical>'
        ].join('\n')
    };

    let templateSection = '';
    if (userTemplate && userTemplate.trim()) {
        templateSection = [
            '',
            '<user_template>',
            'USER TEMPLATE - HIGHEST PRIORITY:',
            '- Follow the user template with highest priority when translating',
            '- Maintain Conventional Commits header format',
            '- Apply template tone and formatting requirements',
            '',
            userTemplate,
            '</user_template>'
        ].join('\n');
    }

    const user: AIMessage = {
        role: 'user',
        content: [
            '<instructions>',
            'Task: Ensure the following Conventional Commit message uses the target language for all narrative text',
            '(description, body contents, and footer values) while preserving tokens and structure.',
            '</instructions>',
            '',
            '<constraints>',
            '- Do NOT translate the Conventional Commit <type> token (must be a valid commit type in English)',
            '- Do NOT translate footer tokens such as BREAKING CHANGE or Refs',
            '- Preserve the exact structure: header, blank lines, body, footers',
            '- Preserve the meaning of every required semantic fact and every exact identifier from the fact contract; a fact the message still entails is preserved, however compressed the wording',
            '- Translate only: never add a fact, and never expand wording that already entails its facts. Restore a required fact only when no part of the message entails it',
            '</constraints>',
            templateSection,
            '',
            '<target_language>',
            `Target language: ${lang}`,
            '</target_language>',
            '',
            '<schema>',
            'Return only JSON: {"commitMessage": string, "preservedFactIds": string[]}',
            '</schema>',
            '',
            '<fact_contract>',
            'A required fact counts as expressed when the translated message semantically entails it, including through a higher-level statement that subsumes several facts.',
            'preservedFactIds must list every required fact id that the translated message entails.',
            'Fix only genuine omissions: a required fact that no part of the translated message entails.',
            JSON.stringify({
                required_facts: factContext?.requiredFacts ?? [],
                optional_facts: factContext?.optionalFacts ?? [],
            }, null, 2),
            '</fact_contract>',
            '',
            '<input>',
            'Commit message:',
            commitMessage,
            '</input>'
        ].filter(Boolean).join('\n')
    };
    return [system, user];
}
