import { DiffData } from "../git/gitTypes";
import { ChatMessage } from "./chainTypes";
import { ChainInputs, FileSummary } from "./chainTypes";

// Centralized builders for chat prompt messages used in chainThinking

export function buildPolicyExtractionMessages(userTemplate: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: 'You are a configuration extractor. Return STRICT JSON only; no markdown.'
    };
    const user: ChatMessage = {
        role: 'user',
        content: [
            'Extract a concise policy from the following commit template. Output only JSON with this schema:',
            '{',
            '  "header": {"requireScope": boolean, "scopeDerivation": "directory|repo|none", "preferBangForBreaking": boolean, "alsoRequireBreakingFooter": boolean},',
            '  "body": {"alwaysInclude": boolean, "orderedSections": string[], "bulletRules": Array<{"section": string, "maxBullets"?: number, "style"?: "dash"|"asterisk"}>},',
            '  "footers": {"required": string[], "defaults": Array<{"token": string, "value": string}>},',
            '  "lexicon": {"prefer": string[], "avoid": string[], "tone": "imperative|neutral|friendly"}',
            '}',
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
    lines.push(
        'Body bullets MUST NOT include commit types (feat, fix, docs, style, refactor, perf, test, build, ci, chore) or "!" markers; use file/scope labels only.',
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

export function buildValidateAndFixMessages(commitMessage: string, baseRulesMarkdown: string): ChatMessage[] {
    const system: ChatMessage = {
        role: 'system',
        content: [
            'You are a strict Conventional Commits validator and fixer. Output ONLY JSON.',
            'Do not include markdown. Apply minimal edits when fixing.'
        ].join('\n')
    };

    const user: ChatMessage = {
        role: 'user',
        content: [
            'Check the following commit message against the rules. If valid, return:',
            '{"status":"valid","commit_message": string,"violations":[]}',
            'If invalid, minimally edit to fix and return:',
            '{"status":"fixed","commit_message": string, "violations": string[], "notes": string}',
            'Additionally enforce: header <type> MUST be one of [feat, fix, docs, style, refactor, perf, test, build, ci, chore] and MUST NOT be translated.',
            'Additional requirement: Body bullets MUST NOT contain commit types (feat, fix, docs, style, refactor, perf, test, build, ci, chore) or "!" markers. If present, remove those prefixes and keep concise descriptions.',
            '--- Commit message:',
            commitMessage,
            '--- Rules (Markdown):',
            baseRulesMarkdown
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

