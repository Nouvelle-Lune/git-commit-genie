import { AIMessage } from '../../llm/providers';

export function buildValidateAndFixMessages(commitMessage: string, checklistText?: string, userTemplate?: string): AIMessage[] {
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
            'Apply minimal edits when fixing.',
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
        '- Body: optional; when no user-template, prefer short paragraphs separated by blank lines (no list markers)',
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
            '- Maintain Conventional Commits header format',
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
            '<input>',
            'Commit message:',
            commitMessage,
            '</input>'
        ].join('\n')
    };

    return [system, user];
}

export function buildEnforceStrictFixMessages(current: string, problems: string[], userTemplate?: string): AIMessage[] {
    const system: AIMessage = {
        role: 'system',
        content: [
            '<critical>',
            'Return STRICT JSON only.',
            'Fix commit message to satisfy Conventional Commits exactly.',
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
            '- Follow the user template with highest priority',
            '- Maintain Conventional Commits header format',
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
            'Fix the commit message to satisfy all constraints.',
            '</instructions>',
            '',
            '<schema>',
            'Output only:',
            '{"commitMessage": string}',
            '</schema>',
            '',
            '<input>',
            'Current message:',
            current,
            '</input>',
            '',
            '<problems>',
            'Detected problems:',
            JSON.stringify(problems),
            '</problems>',
            templateSection
        ].filter(Boolean).join('\n')
    };
    return [system, user];
}

export function buildEnforceLanguageMessages(commitMessage: string, lang: string, userTemplate?: string): AIMessage[] {
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
            '</constraints>',
            templateSection,
            '',
            '<target_language>',
            `Target language: ${lang}`,
            '</target_language>',
            '',
            '<schema>',
            'Return only JSON: {"commitMessage": string}',
            '</schema>',
            '',
            '<input>',
            'Commit message:',
            commitMessage,
            '</input>'
        ].filter(Boolean).join('\n')
    };
    return [system, user];
}
