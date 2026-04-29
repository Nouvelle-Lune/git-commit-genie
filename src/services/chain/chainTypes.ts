// Types related to chain-of-thought prompting and chat interactions

import { DiffData } from "../git/gitTypes";
import { Repository } from "../git/git";


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
}

export interface ChainInputs {
    diffs: DiffData[];
    currentTime?: string;
    userTemplate?: string;
    targetLanguage?: string;
    validationChecklist?: string;
    repositoryPath?: string;
    targetRepo?: Repository;
    // Optional repository analysis (can be string for backward compatibility or structured object)
    repositoryAnalysis?: string | RepositoryAnalysis;
    ragStyleReferences?: RagStyleReference[];
}

export interface FileSummary {
    file: string;
    status: DiffData['status'];
    summary: string;
    breaking: boolean;
}

export interface ChangeSetSummary {
    text: string;
    dominantType?: string;
    dominantScope?: string | null;
    areas: string[];
    fileKinds: string[];
    changeActions: string[];
    entities: string[];
}

export interface RetrievalFeatures {
    predictedType?: string;
    predictedScope?: string | null;
    areas: string[];
    fileKinds: string[];
    changeActions: string[];
    entities: string[];
    touchedPaths: string[];
    fileExtensions: string[];
    statusMix: DiffData['status'][];
    fileCount: number;
    hasDocs: boolean;
    hasTests: boolean;
    hasConfig: boolean;
    hasRenames: boolean;
    isCrossLayer: boolean;
    breakingLike: boolean;
}

export interface RagStyleReference {
    commitHash: string;
    message: string;
    subject: string;
    body?: string;
    committedAt?: string;
    matchedBy: Array<'hybrid' | 'typeScope'>;
    styleReason: string;
    type?: string | null;
    scope?: string | null;
}

export interface ChainOutputs {
    commitMessage: string;
    fileSummaries: FileSummary[];
    changeSetSummary?: ChangeSetSummary;
    retrievalFeatures?: RetrievalFeatures;
    ragStyleReferences?: RagStyleReference[];
    raw?: {
        draft?: string;
        classificationNotes?: string;
        validationNotes?: string;
    };
}
