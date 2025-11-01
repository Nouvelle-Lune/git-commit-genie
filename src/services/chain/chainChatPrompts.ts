import { DiffData } from "../git/gitTypes";
import { ChatMessage } from "../llm/llmTypes";
import { ChainInputs, FileSummary } from "./chainTypes";

// Centralized builders for chat prompt messages used in chainThinking

export function buildSummarizeFileMessages(diff: DiffData): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: [
            '<role>',
            'You are a senior software engineer helping generate high-quality Conventional Commit messages.',
            'Analyze a single unified git diff and return a strict JSON summary.',
            '</role>',
            '',
            '<critical>',
            'No commentary. Return ONLY JSON.',
            '</critical>'
        ].join('\n')
    };

    const user: ChatMessage = {
        role: 'user',
        content: [
            '<instructions>',
            'Summarize the following file change based on the provided git diff.',
            '</instructions>',
            '',
            '<constraints>',
            '- Identify a concise change summary (<= 18 words)',
            '- Detect if this change might be a breaking change (boolean)',
            '- Respond ONLY with JSON using the specified schema',
            '',
            // Guardrails for documentation files to avoid misclassification later
            '- IMPORTANT: If the modified file is a document, or if the changes involve non-code elements such as documentation or textual descriptions, you may summarize it as a documentation update.',
            '- Do NOT claim new features or code changes from documentation text. Prefer phrasing like "update changelog", "update README", or "revise docs".',
            '- For documentation-only files, the "breaking" field is almost always false; do not infer breaking changes solely from documentation wording.',
            '</constraints>',
            '',
            '<schema>',
            '{',
            '  "file": string,',
            '  "status": "added|modified|deleted|renamed|untracked|ignored",',
            '  "summary": string,',
            '  "breaking": boolean',
            '}',
            '</schema>',
            '',
            '<input>',
            `file: ${diff.fileName}`,
            `status: ${diff.status}`,
            'diff:',
            diff.rawDiff,
            '</input>'
        ].join('\n')
    };

    return [system, user];
}

export function buildClassifyAndDraftMessages(
    summaries: FileSummary[],
    inputs: ChainInputs
): ChatMessage[] {
    const { userTemplate, currentTime, targetLanguage, repositoryAnalysis } = inputs;

    const system: ChatMessage = {
        role: 'system',
        content: [
            '<role>',
            'You are an expert on Conventional Commits.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only.',
            'Follow the provided rules and examples EXACTLY.',
            'No markdown in values.',
            'If a user template is provided, follow it with HIGHEST PRIORITY while maintaining Conventional Commits structure.',
            '</critical>'
        ].join('\n')
    };

    // Process repository analysis - include complete data in payload only
    let repoAnalysisForPayload: string | object = '';

    if (repositoryAnalysis) {
        // Include complete repository analysis in payload for LLM processing
        repoAnalysisForPayload = repositoryAnalysis;
    }

    const payload = {
        now: currentTime ?? new Date().toISOString(),
        file_summaries: summaries,
        target_language: targetLanguage || '',
        repo_analysis: repoAnalysisForPayload
    };

    const lines: string[] = [
        '<input>',
        'Inputs (JSON):',
        JSON.stringify(payload, null, 2),
        '</input>',
        '',
        '<context>',
        'Context-aware commit message generation guidelines:',
        '• **Commit Types**: Select appropriate types based on the nature of changes (feat, fix, docs, etc.)',
        '• **Scopes**: Use meaningful scopes derived from file paths, component names, or functional areas',
        '• **Terminology**: Apply consistent technical language appropriate to the codebase',
        '• **Change Impact**: Describe changes clearly, considering their scope and significance',
        '• **Repository Context**: If repo_analysis is available in input, use it as background context to understand the project better, but base decisions primarily on the actual file changes',
        '  - repo_analysis structure: { summary: string (project overview), projectType: string (e.g., "Desktop Application"), technologies: string[] (tech stack array), insights: string[] (architectural patterns), importantFiles: string[] (key project files) }',
        '  - Use this context to inform terminology, scope selection, and change significance assessment',
        '</context>',
        '',
        '<multi_file_correlation_analysis>',
        'When analyzing multiple file changes, consider their relationships:',
        '',
        '• **Related Changes**: Files that work together (feature implementation, bug fix across layers, refactoring)',
        '• **Independent Changes**: Unrelated modifications in different areas',
        '',
        '**For Related Changes:**',
        '- Use unified scope that covers the main functional area',
        '- Describe the overall purpose rather than individual file changes',
        '- Consider collective impact for breaking changes',
        '',
        '**For Independent Changes:**',
        '- Focus on the most significant change',
        '- Use broader scope or omit scope if changes span multiple areas',
        '</multi_file_correlation_analysis>',
        '',
        '<schema>',
        'Output JSON schema (STRICT):',
        '{',
        '  "type": string,',
        '  "scope": string|null (default: null),',
        '  "breaking": boolean,',
        '  "description": string,',
        '  "body": string|null (default: null),',
        '  "footers": Array<{ "token": string (default: ""), "value": string (default: "") }>(default: []),',
        '  "commitMessage": string,',
        '  "notes": string|null (default: null)',
        '}',
        '</schema>',
    ];

    // Add template guidance if template is provided
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

    lines.push(
        '',
        '<analysis_workflow>',
        'For multiple file changes:',
        '1. Identify if files are related or independent',
        '2. Choose appropriate scope and commit type',
        '3. Write description that captures the main purpose',
        '</analysis_workflow>',
        '',
        '<format_requirements>',
        'First line: <type>[optional scope][!]: <description>',
        'If breaking=true and you use "!", do not require BREAKING CHANGE footer.',
        'If breaking=true and no "!" is used, include a footer: BREAKING CHANGE: <details>.',
        'Body must start after one blank line.',
        'Footers must start after one blank line (after body if present).',
        'First line length must be <= 72 characters.',
        'No markdown, code fences, or extra commentary in any field.',
        '</format_requirements>',
        '',
        '<type_constraint>',
        'Available commit types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, and any other types provided by user template.',
        'Choose the most appropriate type based on change analysis.',
        '',
        'HARD RULES FOR DOCUMENTATION-ONLY CHANGES:',
        '- Do NOT infer new features or bug fixes from documentation changed.',
        '- The description should reflect that documentation was updated (e.g., "update changelog for function calling").',
        '</type_constraint>',
        '',
        '<language_requirement>',
        'Use the target language for narrative text (description, body, footer values).',
        'Do NOT translate the <type> token; keep it in English.',
        'Do NOT translate footer tokens like BREAKING CHANGE or Refs.',
        (targetLanguage && targetLanguage.trim() ? `Target language hint: ${targetLanguage}` : 'Target language hint: en'),
        '</language_requirement>',
        '',
        '<critical>',
        'Return strictly valid JSON.',
        '</critical>'
    );

    const user: ChatMessage = { role: 'user', content: lines.join('\n') };
    return [system, user];
}

export function buildValidateAndFixMessages(commitMessage: string, checklistText?: string, userTemplate?: string): ChatMessage[] {
    const system: ChatMessage = {
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

    const user: ChatMessage = {
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

export function buildEnforceStrictFixMessages(current: string, problems: string[], userTemplate?: string): ChatMessage[] {
    const system: ChatMessage = {
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

    const user: ChatMessage = {
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

export function buildEnforceLanguageMessages(commitMessage: string, lang: string, userTemplate?: string): ChatMessage[] {
    const system: ChatMessage = {
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

    const user: ChatMessage = {
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
