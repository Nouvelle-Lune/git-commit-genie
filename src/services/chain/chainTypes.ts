// Types related to chain-of-thought prompting and chat interactions

import { DiffData } from "../git/gitTypes";


export type NormalizedLang =
    | 'en' | 'zh' | 'ja' | 'ko'
    | 'de' | 'fr' | 'es' | 'pt' | 'ru' | 'it'
    | 'other';



// Structured repository analysis type
export interface RepositoryAnalysis {
    summary?: string;
    projectType?: string;
    technologies?: string[];
    insights?: string[];
    importantFiles?: string[];
}

export interface ChainInputs {
    diffs: DiffData[];
    baseRulesMarkdown: string;
    currentTime?: string;
    userTemplate?: string;
    targetLanguage?: string;
    validationChecklist?: string;
    // Optional repository analysis (can be string for backward compatibility or structured object)
    repositoryAnalysis?: string | RepositoryAnalysis;
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
    };
}
