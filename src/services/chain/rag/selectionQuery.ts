import * as vscode from 'vscode';
import { SelectedSemanticInformation } from '../../analysis/change/types';
import { DiffData } from '../../git/gitTypes';
import { ChangeSetSummary, RagRetrievalQuery, RetrievalFeatures } from '../types';

export interface SelectionRagContext {
    query: RagRetrievalQuery;
    changeSetSummary: ChangeSetSummary;
    retrievalFeatures: RetrievalFeatures;
}

export function isRagEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitCommitGenie.rag').get<boolean>('enabled', false);
}

/**
 * Builds the retrieval query from locally normalized Agent output.
 *
 * This deliberately avoids a second model interpretation of the diff: RAG
 * must search for examples describing the exact claims that Draft may express.
 */
export function buildSelectionRagContext(
    selected: SelectedSemanticInformation,
    diffs: DiffData[],
): SelectionRagContext {
    const type = normalizeNullable(selected.recommendedType);
    const scope = normalizeScope(selected.suggestedScope);
    const mustExpress = selected.mustExpress
        .map(claim => claim.trim())
        .filter(Boolean);
    const structural = deriveStructuralFeatures(diffs);

    return {
        query: {
            mustExpress,
            type,
            scope,
        },
        changeSetSummary: {
            text: mustExpress.join('\n'),
            dominantType: type ?? undefined,
            dominantScope: scope,
            areas: scope ? [scope] : [],
            fileKinds: structural.fileKinds,
            changeActions: type ? [type] : [],
            entities: [],
        },
        retrievalFeatures: {
            predictedType: type ?? undefined,
            predictedScope: scope,
            areas: scope ? [scope] : [],
            fileKinds: structural.fileKinds,
            changeActions: type ? [type] : [],
            entities: [],
            touchedPaths: structural.touchedPaths,
            fileExtensions: structural.fileExtensions,
            statusMix: structural.statusMix,
            fileCount: diffs.length,
            hasDocs: structural.hasDocs,
            hasTests: structural.hasTests,
            hasConfig: structural.hasConfig,
            hasRenames: structural.hasRenames,
            isCrossLayer: false,
            breakingLike: selected.breakingSignals.length > 0,
        },
    };
}

function deriveStructuralFeatures(diffs: DiffData[]): {
    touchedPaths: string[];
    fileExtensions: string[];
    fileKinds: string[];
    statusMix: DiffData['status'][];
    hasDocs: boolean;
    hasTests: boolean;
    hasConfig: boolean;
    hasRenames: boolean;
} {
    const fileExtensions = new Set<string>();
    const fileKinds = new Set<string>();
    const statusMix = new Set<DiffData['status']>();
    let hasDocs = false;
    let hasTests = false;
    let hasConfig = false;

    for (const diff of diffs) {
        const path = diff.fileName;
        const baseName = path.slice(path.lastIndexOf('/') + 1);
        const dotIndex = baseName.lastIndexOf('.');
        if (dotIndex > 0 && dotIndex < baseName.length - 1) {
            fileExtensions.add(baseName.slice(dotIndex + 1).toLowerCase());
        }
        statusMix.add(diff.status);

        const docs = /(^|\/)(docs?|documentation|readme|changelog)/i.test(path) || /\.(md|mdx|rst)$/i.test(path);
        const tests = /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(path) || /\.(test|spec)\./i.test(path);
        const config = /(^|\/)(package\.json|tsconfig[^/]*\.json|[^/]+\.ya?ml|[^/]+\.toml|dockerfile|\.gitignore)$/i.test(path);
        hasDocs ||= docs;
        hasTests ||= tests;
        hasConfig ||= config;
        fileKinds.add(docs ? 'docs' : tests ? 'test' : config ? 'config' : 'code');
    }

    return {
        touchedPaths: diffs.map(diff => diff.fileName),
        fileExtensions: Array.from(fileExtensions),
        fileKinds: Array.from(fileKinds),
        statusMix: Array.from(statusMix),
        hasDocs,
        hasTests,
        hasConfig,
        hasRenames: diffs.some(diff => diff.status === 'renamed'),
    };
}

function normalizeNullable(value: string | null): string | null {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function normalizeScope(value: string | null): string | null {
    const normalized = normalizeNullable(value);
    return normalized && !/^\[?[CDE]\d+(?:\/P\d+)?\]?$/i.test(normalized)
        ? normalized
        : null;
}
