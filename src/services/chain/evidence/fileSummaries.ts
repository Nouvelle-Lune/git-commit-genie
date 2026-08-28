import { DiffData } from '../../git/gitTypes';
import { DraftEvidence, FileEvidence } from '../../analysis/change/types';
import { FileSummary } from '../types';

export function summarizeFileEvidenceForDisplay(evidence: FileEvidence): string {
    return [
        ...evidence.changes.map(change => `${change.action} ${change.target}: ${change.behavior}`),
        ...evidence.tests.map(test => `test: ${test.detail}`),
        ...evidence.breakingSignals.map(signal => `breaking: ${signal.detail}`),
        ...evidence.uncertainties.map(uncertainty => `uncertain: ${uncertainty.detail}`),
    ].slice(0, 2).join('; ');
}

export function buildFileSummaries(evidence: DraftEvidence[], diffs: DiffData[]): FileSummary[] {
    const diffByFile = new Map(diffs.map(diff => [diff.fileName, diff]));
    return evidence.map(item => {
        if (item.kind === 'summary') {
            return {
                file: item.fileName,
                status: item.status,
                summary: summarizeFileEvidenceForDisplay(item),
                breaking: item.breakingSignals.length > 0,
            };
        }

        const diff = diffByFile.get(item.fileName);
        const additions = diff?.diffHunks.reduce((count, hunk) => count + hunk.additions.length, 0) ?? 0;
        const deletions = diff?.diffHunks.reduce((count, hunk) => count + hunk.deletions.length, 0) ?? 0;
        return {
            file: item.fileName,
            status: item.status,
            summary: `Raw diff retained (${additions} additions, ${deletions} deletions)`,
            breaking: false,
        };
    });
}
