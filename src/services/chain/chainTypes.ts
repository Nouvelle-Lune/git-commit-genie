// Types related to chain-of-thought prompting and chat interactions

import { DiffData } from "../git/gitTypes";

export type ChatRole = 'system' | 'user';

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