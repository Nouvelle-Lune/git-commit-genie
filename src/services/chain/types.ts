// Public data contracts for the commit-message pipeline.

import { DiffData } from "../git/gitTypes";
import { Repository } from "../git/git";
import { ChangeAnalysisTrace, RepositoryAnalysisContext } from "../analysis/change/types";


export type NormalizedLang =
    | 'en' | 'zh' | 'ja' | 'ko'
    | 'de' | 'fr' | 'es' | 'pt' | 'ru' | 'it'
    | 'other';



export interface ChainInputs {
    diffs: DiffData[];
    currentTime?: string;
    userTemplate?: string;
    targetLanguage?: string;
    validationChecklist?: string;
    repositoryPath?: string;
    targetRepo?: Repository;
    repositoryAnalysis?: RepositoryAnalysisContext;
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
    /** Stage-by-stage record of the change analysis, for logs and benchmarks. */
    changeAnalysis: ChangeAnalysisTrace;
    raw?: {
        draft?: string;
        classificationNotes?: string;
        validationNotes?: string;
    };
}
