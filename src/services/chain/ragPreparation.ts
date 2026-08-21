import * as vscode from "vscode";
import { ChatFn } from "../llm/llmTypes";
import { ChangeSetSummary, DraftEvidence, RetrievalFeatures } from "./chainTypes";
import { DiffData } from "../git/gitTypes";
import { buildRagPreparationMessages } from "./chainChatPrompts";

type RagPreparationContext = {
    changeSetSummary: ChangeSetSummary;
    retrievalFeatures: RetrievalFeatures;
};

type RagPreparationResponse = {
    changeSetSummary: {
        text: string;
        dominantType?: string | null;
        dominantScope?: string | null;
        areas: string[];
        fileKinds: string[];
        changeActions: string[];
        entities: string[];
    };
    retrievalFeatures: {
        predictedType?: string | null;
        predictedScope?: string | null;
        areas: string[];
        fileKinds: string[];
        changeActions: string[];
        entities: string[];
        touchedPaths: string[];
        fileExtensions: string[];
        statusMix: DiffData["status"][];
        fileCount: number;
        hasDocs: boolean;
        hasTests: boolean;
        hasConfig: boolean;
        hasRenames: boolean;
        isCrossLayer: boolean;
        breakingLike: boolean;
    };
};

export function isRagPreparationEnabled(): boolean {
    return vscode.workspace.getConfiguration("gitCommitGenie.rag").get<boolean>("enabled", false);
}

export async function prepareRagContext(
    diffs: DiffData[],
    evidence: DraftEvidence[],
    chat: ChatFn
): Promise<RagPreparationContext> {
    const messages = buildRagPreparationMessages(evidence);
    const parsed = await chat(messages, { requestType: "ragPreparation" }) as RagPreparationResponse;
    const deterministic = deriveDeterministicRetrievalFeatures(diffs);

    return {
        changeSetSummary: {
            text: parsed.changeSetSummary.text,
            dominantType: parsed.changeSetSummary.dominantType ?? undefined,
            dominantScope: parsed.changeSetSummary.dominantScope ?? null,
            areas: parsed.changeSetSummary.areas ?? [],
            fileKinds: parsed.changeSetSummary.fileKinds ?? [],
            changeActions: parsed.changeSetSummary.changeActions ?? [],
            entities: parsed.changeSetSummary.entities ?? [],
        },
        retrievalFeatures: {
            predictedType: parsed.retrievalFeatures.predictedType ?? undefined,
            predictedScope: parsed.retrievalFeatures.predictedScope ?? null,
            areas: parsed.retrievalFeatures.areas ?? [],
            fileKinds: parsed.retrievalFeatures.fileKinds ?? [],
            changeActions: parsed.retrievalFeatures.changeActions ?? [],
            entities: parsed.retrievalFeatures.entities ?? [],
            // These fields are exact properties of DiffData. Computing them
            // locally prevents summary compaction from changing structural RAG
            // filters while semantic fields retain the existing model behavior.
            touchedPaths: deterministic.touchedPaths,
            fileExtensions: deterministic.fileExtensions,
            statusMix: deterministic.statusMix,
            fileCount: deterministic.fileCount,
            hasDocs: !!parsed.retrievalFeatures.hasDocs,
            hasTests: !!parsed.retrievalFeatures.hasTests,
            hasConfig: !!parsed.retrievalFeatures.hasConfig,
            hasRenames: !!parsed.retrievalFeatures.hasRenames,
            isCrossLayer: !!parsed.retrievalFeatures.isCrossLayer,
            breakingLike: !!parsed.retrievalFeatures.breakingLike,
        }
    };
}

export function deriveDeterministicRetrievalFeatures(diffs: DiffData[]): Pick<
    RetrievalFeatures,
    'touchedPaths' | 'fileExtensions' | 'statusMix' | 'fileCount'
> {
    const touchedPaths = diffs.map(diff => diff.fileName);
    const fileExtensions = new Set<string>();
    const statusMix = new Set<DiffData['status']>();

    for (const diff of diffs) {
        const filePath = diff.fileName;
        const baseName = filePath.slice(filePath.lastIndexOf('/') + 1);
        const dotIndex = baseName.lastIndexOf('.');
        if (dotIndex > 0 && dotIndex < baseName.length - 1) {
            fileExtensions.add(baseName.slice(dotIndex + 1).toLowerCase());
        }
        statusMix.add(diff.status);
    }

    return {
        touchedPaths,
        fileExtensions: Array.from(fileExtensions),
        statusMix: Array.from(statusMix),
        fileCount: diffs.length,
    };
}
