import * as vscode from "vscode";
import { ChatFn } from "../llm/llmTypes";
import { ChangeSetSummary, FileSummary, RetrievalFeatures } from "./chainTypes";
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
    summaries: FileSummary[],
    chat: ChatFn
): Promise<RagPreparationContext> {
    const messages = buildRagPreparationMessages(summaries, diffs);
    const parsed = await chat(messages, { requestType: "ragPreparation" }) as RagPreparationResponse;

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
            touchedPaths: parsed.retrievalFeatures.touchedPaths ?? [],
            fileExtensions: parsed.retrievalFeatures.fileExtensions ?? [],
            statusMix: parsed.retrievalFeatures.statusMix ?? [],
            fileCount: parsed.retrievalFeatures.fileCount ?? diffs.length,
            hasDocs: !!parsed.retrievalFeatures.hasDocs,
            hasTests: !!parsed.retrievalFeatures.hasTests,
            hasConfig: !!parsed.retrievalFeatures.hasConfig,
            hasRenames: !!parsed.retrievalFeatures.hasRenames,
            isCrossLayer: !!parsed.retrievalFeatures.isCrossLayer,
            breakingLike: !!parsed.retrievalFeatures.breakingLike,
        }
    };
}
