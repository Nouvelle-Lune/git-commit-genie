// Types related to chain-of-thought prompting and chat interactions

import { DiffData } from "../git/gitTypes";

export type ChatRole = 'system' | 'user';

export type NormalizedLang =
    | 'en' | 'zh' | 'ja' | 'ko'
    | 'de' | 'fr' | 'es' | 'pt' | 'ru' | 'it'
    | 'other';

export interface ChatMessage {
    role: ChatRole;
    content: string;
}

export type ChatFn = (
    messages: ChatMessage[],
    options?: { model?: string; temperature?: number }
) => Promise<string>;

// Extracted constraints from a user template (template-first policy)
export interface TemplatePolicy {
    header?: {
        requireScope?: boolean;
        scopeDerivation?: 'directory' | 'repo' | 'none';
        preferBangForBreaking?: boolean;
        alsoRequireBreakingFooter?: boolean;
    };
    body?: {
        alwaysInclude?: boolean;
        orderedSections?: string[]; // e.g., ["Summary", "Changes", "Impact", "Risk", "Notes"]
        bulletRules?: Array<{ section: string; maxBullets?: number; style?: 'dash' | 'asterisk' }>;
        // Simplified single-switch for bullet content style
        // - 'plain': no special prefixes in bullets
        // - 'file-prefixed': bullets start with file/scope label
        // - 'type-prefixed': bullets start with commit type token (feat|fix|...)
        bulletContentMode?: 'plain' | 'file-prefixed' | 'type-prefixed';
    };
    footers?: {
        required?: string[]; // e.g., ["Refs"]
        defaults?: Array<{ token: string; value: string }>;
    };
    lexicon?: {
        prefer?: string[];
        avoid?: string[];
        tone?: 'imperative' | 'neutral' | 'friendly';
    };
}


export interface ChainInputs {
    diffs: DiffData[];
    baseRulesMarkdown: string;
    currentTime?: string;
    workspaceFilesTree?: string;
    userTemplate?: string;
    targetLanguage?: string;
    validationChecklist?: string;
}

export interface FileSummary {
    file: string;
    status: DiffData['status'];
    summary: string;
    breaking: boolean;
}

export interface ChainOutputs {
    commitMessage: string;
    fileSummaries: FileSummary[];
    raw?: {
        draft?: string;
        classificationNotes?: string;
        validationNotes?: string;
        templatePolicy?: string;
    };
}
