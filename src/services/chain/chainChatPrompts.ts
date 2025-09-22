import { DiffData } from "../git/gitTypes";
import { ChatMessage } from "./chainTypes";
import { ChainInputs, FileSummary, TemplatePolicy } from "./chainTypes";

// Centralized builders for chat prompt messages used in chainThinking

export function buildPolicyExtractionMessages(userTemplate: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: 'You are a configuration extractor, the template provided by the user may exist in a structured or natural language form. You need to analyze the provided template and accurately populate the analysis results into the user-provided schema as much as possible. For values that cannot be determined through analysis, the default values provided by the schema can be used. Return STRICT JSON only; no markdown.'
    };
    const user: ChatMessage = {
        role: 'user',
        content: [
            'Extract a concise policy from the following commit template. Output only JSON with this schema:',
            '{',
            '  "header": {"requireScope": boolean, "scopeDerivation": "directory|repo|none", "preferBangForBreaking": boolean, "alsoRequireBreakingFooter": boolean},',
            '  "body": {"alwaysInclude": boolean, "orderedSections": string[], "bulletRules": Array<{"section": string, "maxBullets"?: number, "style"?: "dash"|"asterisk"}>, "bulletContentMode"?: "plain"|"file-prefixed"|"type-prefixed"},',
            '  "footers": {"required": string[], "defaults": Array<{"token": string, "value": string}>},',
            '  "lexicon": {"prefer": string[], "avoid": string[], "tone": "imperative|neutral|friendly"}',
            '}',
            'Defaults (use when unspecified or unclear):',
            '{',
            '  "header": {"requireScope": false, "scopeDerivation": "none", "preferBangForBreaking": false, "alsoRequireBreakingFooter": false},',
            '  "body": {"alwaysInclude": false, "orderedSections": [], "bulletRules": [], "bulletContentMode": "plain"},',
            '  "footers": {"required": [], "defaults": []},',
            '  "lexicon": {"prefer": [], "avoid": [], "tone": "neutral"}',
            '}',
            'Rules:',
            '- Return a single JSON object with keys: header, body, footers, lexicon.',
            '- If a field cannot be inferred, FILL IT WITH THE DEFAULT VALUE above (do not omit).',
            '- Do not include comments, markdown, or extra keys beyond the schema.',
            'Template:',
            userTemplate
        ].join('\n')
    };
    return [system, user];
}

export function buildSummarizeFileMessages(diff: DiffData): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content:
            'You are a senior software engineer helping generate high-quality Conventional Commit messages. Analyze a single unified git diff and return a strict JSON summary. No commentary.'
    };

    const user: ChatMessage = {
        role: 'user',
        content: [
            'Summarize the following file change. Requirements:',
            '- Identify a concise change summary (<= 18 words).',
            '- Detect if this change might be a breaking change (boolean).',
            '- Respond ONLY with JSON using this schema:',
            '{"file": string, "status": "added|modified|deleted|renamed|untracked|ignored", "summary": string, "breaking": boolean}',
            '---',
            `file: ${diff.fileName}`,
            `status: ${diff.status}`,
            'diff:',
            diff.rawDiff
        ].join('\n')
    };

    return [system, user];
}

export function buildClassifyAndDraftMessages(
    summaries: FileSummary[],
    inputs: ChainInputs,
    templatePolicyJson: string
): ChatMessage[] {
    const { baseRulesMarkdown, userTemplate, workspaceFilesTree, currentTime, targetLanguage } = inputs;

    const system: ChatMessage = {
        role: 'system',
        content: [
            'You are an expert on Conventional Commits. Return STRICT JSON only.',
            'Follow the provided rules and examples EXACTLY. No markdown in values.',
            'Allowed types (use exactly one): feat, fix, docs, style, refactor, perf, test, build, ci, chore.'
        ].join('\n')
    };

    const payload = {
        now: currentTime ?? new Date().toISOString(),
        file_summaries: summaries,
        workspace_files: workspaceFilesTree ?? '',
        template: userTemplate ?? '',
        template_policy: templatePolicyJson || '',
        target_language: targetLanguage || ''
    };

    // Parse template policy to drive body bullet guidance (e.g., per-file prefixes)
    let policy: TemplatePolicy | null = null;
    try {
        policy = templatePolicyJson ? (JSON.parse(templatePolicyJson) as TemplatePolicy) : null;
    } catch {
        policy = null;
    }
    const bulletMode: 'plain' | 'file-prefixed' | 'type-prefixed' | undefined = policy?.body?.bulletContentMode as any;

    const lines: string[] = [
        'Inputs (JSON):',
        JSON.stringify(payload, null, 2),
        '--- Rules and examples (Markdown):',
        baseRulesMarkdown,
        '--- Output JSON schema (STRICT):',
        '{',
        '  "type": "feat|fix|docs|style|refactor|perf|test|build|ci|chore",',
        '  "scope": "string|null",',
        '  "breaking": "boolean",',
        '  "description": "string",',
        '  "body": "string|null",',
        '  "footers": "Array<{token:string,value:string}>",',
        '  "commit_message": "string",',
        '  "notes": "string"',
        '}',
    ];
    if (templatePolicyJson) {
        lines.push(
            'Precedence and assembly rules (MUST follow):',
            '- If a template and template_policy are provided, FOLLOW THEM STRICTLY for body/footers structure, wording preferences, and required sections.',
            '- Conventional Commit HEADER MUST remain valid at all times.',
        );
    }
    const allowedTypes = 'feat, fix, docs, style, refactor, perf, test, build, ci, chore';
    // Compose bullet guidance lines based on template policy
    if (bulletMode === 'type-prefixed') {
        lines.push('Each body bullet MUST start with a commit type token (feat|fix|docs|style|refactor|perf|test|build|ci|chore). Keep tokens in English.');
    } else if (bulletMode === 'file-prefixed') {
        lines.push('Prefix each body bullet with a file/scope label when relevant.');
    } else if (bulletMode === 'plain') {
        lines.push('Body bullets MUST NOT include commit type tokens or "!" markers. Keep bullets concise.');
    }

    lines.push(
        'First line: <type>[optional scope][!]: <description>',
        'If breaking=true and you use "!", do not require BREAKING CHANGE footer.',
        'If breaking=true and no "!" is used, include a footer: BREAKING CHANGE: <details>.',
        'Body must start after one blank line' + (templatePolicyJson ? '; format body according to template_policy if present.' : '.'),
        'Footers must start after one blank line (after body if present)' + (templatePolicyJson ? '; include any required footers per template_policy.' : '.'),
        'First line length must be <= 72 characters.',
        'No markdown, code fences, or extra commentary in any field.',
        `Type constraint: The Conventional Commit <type> MUST be exactly one of: ${allowedTypes}.`,
        `Language requirement: Use the target language for narrative text (description, body, footer values). Do NOT translate the <type> token; keep it in English. Do NOT translate footer tokens like BREAKING CHANGE or Refs.`,
        (targetLanguage && targetLanguage.trim() ? `Target language hint: ${targetLanguage}` : 'Target language hint: en'),
        'Return strictly valid JSON.'
    );

    const user: ChatMessage = { role: 'user', content: lines.join('\n') };
    return [system, user];
}

export function buildValidateAndFixMessages(commitMessage: string, checklistText?: string, templatePolicyJson?: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: [
            'You are a strict Conventional Commits validator and fixer. Output ONLY JSON.',
            'Do not include markdown. Apply minimal edits when fixing.'
        ].join('\n')
    };

    // Build concise validation checklist string (provider passes it; fallback inline only)
    const defaultChecklist = [
        '- Header: <type>(optional-scope)[!]: <description>',
        '- User template precedence for body/sections/bullets/tone/required footers; CC header/structure still apply',
        '- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore (English only)',
        '- Header length <= 72; imperative; no trailing period',
        '- One blank line between header/body and body/footers',
        '- Language policy: narrative text follows target language; do NOT translate <type> or footer tokens',
        '- Body: optional; keep bullets concise; follow template sections/bullet style if present',
        '- Footers: Token: value; use hyphen in tokens (except BREAKING CHANGE)',
        '- Breaking change: either ! in header or BREAKING CHANGE: <details> footer',
        '- Multiple footers allowed; BREAKING-CHANGE == BREAKING CHANGE',
        '- Required footers from template must be present; if none available, use a sensible placeholder (e.g., Refs: N/A)',
        '- Return valid JSON only; no markdown fences or extra commentary'
    ].join('\n');

    // Parse template policy to derive extra checks (if any)
    let policy: TemplatePolicy | null = null;
    try {
        policy = templatePolicyJson ? (JSON.parse(templatePolicyJson) as TemplatePolicy) : null;
    } catch {
        policy = null;
    }
    const bulletMode: 'plain' | 'file-prefixed' | 'type-prefixed' | undefined = policy?.body?.bulletContentMode as any;
    const extraChecks: string[] = [];
    if (bulletMode === 'type-prefixed') {
        extraChecks.push('- Body bullets: each starts with a commit type token (feat|fix|docs|style|refactor|perf|test|build|ci|chore), tokens in English');
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
        'Validation checklist:',
        (checklistText && checklistText.trim()) ? checklistText.trim() : defaultChecklist,
        extraChecks.length ? 'Template-derived checks:' : '',
        extraChecks.join('\n')
    ].filter(Boolean).join('\n');

    const user: ChatMessage = {
        role: 'user',
        content: [
            'Check the following commit message against the rules. If valid, return:',
            '{"status":"valid","commit_message": string,"violations":[]}',
            'If invalid, minimally edit to fix and return:',
            '{"status":"fixed","commit_message": string, "violations": string[], "notes": string}',
            'Additionally enforce: header <type> MUST be one of [feat, fix, docs, style, refactor, perf, test, build, ci, chore] and MUST NOT be translated.',
            '--- Checklist:',
            checklist,
            '--- Commit message:',
            commitMessage,
        ].join('\n')
    };

    return [system, user];
}

export function buildEnforceStrictFixMessages(current: string, problems: string[], baseRulesMarkdown: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: 'Return STRICT JSON only. Fix commit message to satisfy Conventional Commits exactly.'
    };
    const user: ChatMessage = {
        role: 'user',
        content: [
            'Fix the commit message to satisfy all constraints. Output only:',
            '{"commit_message": string}',
            'Current message:',
            current,
            'Detected problems:',
            JSON.stringify(problems),
            'Rules (Markdown):',
            baseRulesMarkdown
        ].join('\n')
    };
    return [system, user];
}

export function buildEnforceLanguageMessages(commitMessage: string, lang: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: [
            'You are a precise editor for Conventional Commit messages.',
            'Return STRICT JSON only; do not include markdown or code fences.'
        ].join('\n')
    };
    const user: ChatMessage = {
        role: 'user',
        content: [
            'Task: Ensure the following Conventional Commit message uses the target language for all narrative text',
            '(description, body bullet contents, and footer values) while preserving tokens and structure.',
            '- Do NOT translate the Conventional Commit <type> token (must remain one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore).',
            '- Do NOT translate footer tokens such as BREAKING CHANGE or Refs.',
            '- Preserve the exact structure: header, blank lines, body, footers.',
            `Target language: ${lang}`,
            'Return only JSON: {"commit_message": string}',
            '--- Commit message:',
            commitMessage
        ].join('\n')
    };
    return [system, user];
}
