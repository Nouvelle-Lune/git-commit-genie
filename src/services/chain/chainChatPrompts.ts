import { DiffData } from "../git/gitTypes";
import { ChatMessage } from "../llm/llmTypes";
import { ChainInputs, FileSummary, TemplatePolicy } from "./chainTypes";

// Centralized builders for chat prompt messages used in chainThinking

export function buildPolicyExtractionMessages(userTemplate: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: [
            '<role>',
            'You are a configuration extractor specializing in analyzing commit message templates.',
            'The template provided by the user may exist in structured or natural language form.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only; no markdown, no commentary, no extra formatting.',
            '</critical>'
        ].join('\n')
    };
    const user: ChatMessage = {
        role: 'user',
        content: [
            '<instructions>',
            'Extract a concise policy from the following commit template.',
            'Analyze the template and accurately populate the analysis results into the provided schema.',
            'For values that cannot be determined through analysis, use the default values.',
            '',
            'Special attention for types extraction:',
            '1. Look for explicit type definitions (e.g., "use types: feat, fix, hotfix, release")',
            '2. Identify custom types from examples (e.g., "hotfix: critical bug fix")',
            '3. Check for type restrictions or preferences in the template',
            '4. Analyze user intent regarding type usage:',
            '   - EXTEND: template adds custom types to standard ones (e.g., "also support hotfix, release")',
            '   - REPLACE: template specifies complete type list (e.g., "only use: feat, fix, hotfix")',
            '   - PARTIAL: template modifies some types while keeping others',
            '5. Set useStandardTypes: false ONLY when template clearly excludes or replaces standard types',
            '6. If unclear, default to extending standard types rather than replacing',
            '7. Standard types reference: feat, fix, docs, style, refactor, perf, test, build, ci, chore',
            '</instructions>',
            '',
            '<schema>',
            '{',
            '  "header": {',
            '    "requireScope": boolean,',
            '    "scopeDerivation": "directory|repo|none",',
            '    "preferBangForBreaking": boolean,',
            '    "alsoRequireBreakingFooter": boolean',
            '  },',
            '  "types": {',
            '    "allowed": string[],',
            '    "preferred": string|null,',
            '    "useStandardTypes": boolean',
            '  },',
            '  "body": {',
            '    "alwaysInclude": boolean,',
            '    "orderedSections": string[],',
            '    "bulletRules": Array<{',
            '      "section": string,',
            '      "maxBullets"?: number,',
            '      "style"?: "dash"|"asterisk"',
            '    }>,',
            '    "bulletContentMode"?: "plain"|"file-prefixed"|"type-prefixed"',
            '  },',
            '  "footers": {',
            '    "required": string[],',
            '    "defaults": Array<{"token": string, "value": string}>',
            '  },',
            '  "lexicon": {',
            '    "prefer": string[],',
            '    "avoid": string[],',
            '    "tone": "imperative|neutral|friendly"',
            '  }',
            '}',
            '</schema>',
            '',
            '<defaults>',
            '{',
            '  "header": {',
            '    "requireScope": false,',
            '    "scopeDerivation": "none",',
            '    "preferBangForBreaking": false,',
            '    "alsoRequireBreakingFooter": false',
            '  },',
            '  "types": {',
            '    "allowed": ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore"],',
            '    "preferred": null,',
            '    "useStandardTypes": true',
            '  },',
            '  "body": {',
            '    "alwaysInclude": false,',
            '    "orderedSections": [],',
            '    "bulletRules": [],',
            '    "bulletContentMode": "plain"',
            '  },',
            '  "footers": {',
            '    "required": [],',
            '    "defaults": []',
            '  },',
            '  "lexicon": {',
            '    "prefer": [],',
            '    "avoid": [],',
            '    "tone": "neutral"',
            '  }',
            '}',
            '</defaults>',
            '',
            '<rules>',
            '- Return a single JSON object with keys: header, types, body, footers, lexicon',
            '- If a field cannot be inferred, FILL IT WITH THE DEFAULT VALUE above (do not omit)',
            '- Do not include comments, markdown, or extra keys beyond the schema',
            '- For types.allowed: analyze user intent carefully',
            '  * If template shows "add X type" or "also support Y" → EXTEND standard types',
            '  * If template shows "use only X, Y, Z" or "types: X, Y, Z" → REPLACE with specified types',
            '  * If template shows examples with mix of standard + custom → EXTEND appropriately',
            '- For types.preferred: identify if template suggests a primary type to use',
            '- For types.useStandardTypes: set based on actual user intent (extend vs replace)',
            '- When in doubt, favor extending rather than replacing standard types',
            '</rules>',
            '',
            '<input>',
            'Template:',
            userTemplate,
            '</input>'
        ].join('\n')
    };
    return [system, user];
}

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
    inputs: ChainInputs,
    templatePolicyJson: string
): ChatMessage[] {
    const { baseRulesMarkdown, userTemplate, currentTime, targetLanguage, repositoryAnalysis } = inputs;

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
            '</critical>',
            '',
            '<constraints>',
            'Use commit types according to template policy. Handle different type usage patterns:',
            '- If useStandardTypes=true: merge template types with standard types',
            '- If useStandardTypes=false: use only the template-specified types',
            '- Consider user intent: extend, replace, or modify standard type set',
            '</constraints>'
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
        template: userTemplate ?? '',
        template_policy: templatePolicyJson || '',
        target_language: targetLanguage || '',
        repo_analysis: repoAnalysisForPayload
    };    // Parse template policy to extract allowed types and other configuration
    let policy: TemplatePolicy | null = null;
    const standardTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore'];
    let allowedTypes = standardTypes.join(', '); // default to standard types
    try {
        policy = templatePolicyJson ? (JSON.parse(templatePolicyJson) as TemplatePolicy) : null;
        if (policy?.types?.allowed && policy.types.allowed.length > 0) {
            // Handle different type usage patterns based on template policy
            if (policy.types.useStandardTypes === false) {
                // Template specifies complete replacement - use only template types
                allowedTypes = policy.types.allowed.join(', ');
            } else {
                // Template extends or modifies standard types - merge them
                const mergedTypes = [...new Set([...standardTypes, ...policy.types.allowed])];
                allowedTypes = mergedTypes.join(', ');
            }
        }
    } catch {
        policy = null;
    }
    const bulletMode: 'plain' | 'file-prefixed' | 'type-prefixed' | undefined = policy?.body?.bulletContentMode as any;

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
        '<rules>',
        'Rules and examples (Markdown):',
        baseRulesMarkdown,
        '</rules>',
        '',
        '<schema>',
        'Output JSON schema (STRICT):',
        '{',
        '  "type": "string",',
        '  "scope": "string|null",',
        '  "breaking": "boolean",',
        '  "description": "string",',
        '  "body": "string|null",',
        '  "footers": "Array<{token:string,value:string}>",',
        '  "commitMessage": "string",',
        '  "notes": "string"',
        '}',
        '</schema>',
    ];
    if (templatePolicyJson) {
        lines.push(
            '',
            '<template_precedence>',
            'Precedence and assembly rules (MUST follow):',
            '- If a template and template_policy are provided, FOLLOW THEM STRICTLY for body/footers structure, wording preferences, and required sections.',
            '- Conventional Commit HEADER MUST remain valid at all times.',
            '</template_precedence>'
        );
    }
    // Compose bullet guidance lines based on template policy
    if (bulletMode === 'type-prefixed') {
        lines.push('', '<bullet_mode>', `Each body bullet MUST start with a commit type token (${allowedTypes}). Keep tokens in English.`, '</bullet_mode>');
    } else if (bulletMode === 'file-prefixed') {
        lines.push('', '<bullet_mode>', 'Prefix each body bullet with a file/scope label when relevant.', '</bullet_mode>');
    } else if (bulletMode === 'plain') {
        lines.push('', '<bullet_mode>', 'Body bullets MUST NOT include commit type tokens or "!" markers. Keep bullets concise.', '</bullet_mode>');
    }

    lines.push(
        '',
        '<format_requirements>',
        'First line: <type>[optional scope][!]: <description>',
        'If breaking=true and you use "!", do not require BREAKING CHANGE footer.',
        'If breaking=true and no "!" is used, include a footer: BREAKING CHANGE: <details>.',
        'Body must start after one blank line' + (templatePolicyJson ? '; format body according to template_policy if present.' : '.'),
        'Footers must start after one blank line (after body if present)' + (templatePolicyJson ? '; include any required footers per template_policy.' : '.'),
        'First line length must be <= 72 characters.',
        'No markdown, code fences, or extra commentary in any field.',
        '</format_requirements>',
        '',
        '<type_constraint>',
        `Available commit types: ${allowedTypes}.`,
        'Type selection priority:',
        '1. Use preferred type if specified in template and applicable',
        '2. Choose most appropriate type based on change analysis',
        '3. Respect template type usage pattern (extend vs replace standard types)',
        '4. Standard types: feat (new features), fix (bug fixes), docs (documentation), etc.',
        '5. Custom types: use when change fits custom type definition better',
        policy?.types?.preferred ? `Preferred type (when applicable): ${policy.types.preferred}.` : '',
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

export function buildValidateAndFixMessages(commitMessage: string, checklistText?: string, templatePolicyJson?: string): ChatMessage[] {
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
            '</critical>'
        ].join('\n')
    };

    // Parse template policy to derive extra checks (if any)
    let policy: TemplatePolicy | null = null;
    const standardTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore'];
    let allowedTypes = standardTypes.join(', '); // default to standard types
    try {
        policy = templatePolicyJson ? (JSON.parse(templatePolicyJson) as TemplatePolicy) : null;
        if (policy?.types?.allowed && policy.types.allowed.length > 0) {
            // Handle different type usage patterns based on template policy
            if (policy.types.useStandardTypes === false) {
                // Template specifies complete replacement - use only template types
                allowedTypes = policy.types.allowed.join(', ');
            } else {
                // Template extends or modifies standard types - merge them
                const mergedTypes = [...new Set([...standardTypes, ...policy.types.allowed])];
                allowedTypes = mergedTypes.join(', ');
            }
        }
    } catch {
        policy = null;
    }

    // Build concise validation checklist string (provider passes it; fallback inline only)
    const defaultChecklist = [
        '<validation_rules>',
        '- Header: <type>(optional-scope)[!]: <description>',
        '- User template precedence for body/sections/bullets/tone/required footers; CC header/structure still apply',
        `- Allowed types: ${allowedTypes} (English only)`,
        '- Header length <= 72; imperative; no trailing period',
        '- One blank line between header/body and body/footers',
        '- Language policy: narrative text follows target language; do NOT translate <type> or footer tokens',
        '- Body: optional; when no user-template, prefer short paragraphs separated by blank lines (no list markers). If a template requires bullets/sections, follow it exactly',
        '- Footers: Token: value; use hyphen in tokens (except BREAKING CHANGE)',
        '- Breaking change: either ! in header or BREAKING CHANGE: <details> footer',
        '- Multiple footers allowed; BREAKING-CHANGE == BREAKING CHANGE',
        '- Required footers from template must be present; if none available, use a sensible placeholder (e.g., Refs: N/A)',
        '- Return valid JSON only; no markdown fences or extra commentary',
        '</validation_rules>'
    ].join('\n');

    const bulletMode: 'plain' | 'file-prefixed' | 'type-prefixed' | undefined = policy?.body?.bulletContentMode as any;
    const extraChecks: string[] = [];
    if (bulletMode === 'type-prefixed') {
        extraChecks.push(`- Body bullets: each starts with a commit type token (${allowedTypes}), tokens in English`);
    } else if (bulletMode === 'file-prefixed') {
        extraChecks.push('- Body bullets: prefix with file/scope label when relevant');
    } else if (bulletMode === 'plain') {
        extraChecks.push('- Body bullets: do not include commit type tokens or "!" markers');
    }
    if (policy?.footers?.required?.length) {
        extraChecks.push(`- Required footers: ${policy.footers.required.join(', ')}`);
    }
    if (policy?.header?.requireScope) {
        extraChecks.push('- Header must include a scope');
    }
    if (policy?.header?.preferBangForBreaking) {
        extraChecks.push('- For breaking changes, prefer using "!" in header');
    }
    if (policy?.header?.alsoRequireBreakingFooter) {
        extraChecks.push('- For breaking changes, also include BREAKING CHANGE footer');
    }

    const checklist = [
        '<validation_checklist>',
        'Validation checklist:',
        (checklistText && checklistText.trim()) ? checklistText.trim() : defaultChecklist,
        extraChecks.length ? 'Template-derived checks:' : '',
        extraChecks.length ? '<template_checks>' : '',
        ...extraChecks,
        extraChecks.length ? '</template_checks>' : '',
        '</validation_checklist>'
    ].filter(Boolean).join('\n');

    const user: ChatMessage = {
        role: 'user',
        content: [
            '<instructions>',
            'Check the following commit message against the rules.',
            '</instructions>',
            '',
            '<output_options>',
            'If valid, return:',
            '{"status":"valid","commitMessage": string,"violations":[]}',
            '',
            'If invalid, minimally edit to fix and return:',
            '{"status":"fixed","commitMessage": string, "violations": string[], "notes": string}',
            '</output_options>',
            '',
            '<constraints>',
            `Additionally enforce: header <type> MUST be one of [${allowedTypes}] and MUST NOT be translated.`,
            '</constraints>',
            '',
            checklist,
            '',
            '<input>',
            'Commit message:',
            commitMessage,
            '</input>'
        ].join('\n')
    };

    return [system, user];
}

export function buildEnforceStrictFixMessages(current: string, problems: string[], baseRulesMarkdown: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: [
            '<critical>',
            'Return STRICT JSON only.',
            'Fix commit message to satisfy Conventional Commits exactly.',
            '</critical>'
        ].join('\n')
    };
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
            '',
            '<rules>',
            'Rules (Markdown):',
            baseRulesMarkdown,
            '</rules>'
        ].join('\n')
    };
    return [system, user];
}

export function buildEnforceLanguageMessages(commitMessage: string, lang: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: [
            '<role>',
            'You are a precise editor for Conventional Commit messages.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only; do not include markdown or code fences.',
            '</critical>'
        ].join('\n')
    };
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
        ].join('\n')
    };
    return [system, user];
}
