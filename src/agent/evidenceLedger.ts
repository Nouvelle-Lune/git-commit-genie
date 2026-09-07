import { DiffData } from '../services/git/gitTypes';
import { RepositoryEvidenceItem } from '../services/analysis/change/types';

export type EvidenceLedgerEntry = DiffEvidenceLedgerEntry | RepositoryEvidenceLedgerEntry;

export interface DiffEvidenceLedgerEntry {
    id: string;
    source: 'diff';
    fileName: string;
    status: DiffData['status'];
    header: string;
    content: string;
}

export interface RepositoryEvidenceLedgerEntry extends RepositoryEvidenceItem {
    source: 'repository';
}

/**
 * Owns evidence identifiers for an entire logical agent run. Diff identifiers
 * are allocated before the first model request and repository identifiers are
 * appended as tool observations arrive. Compaction may change representation,
 * but never identity or ordering.
 */
export class EvidenceLedger {
    private readonly entriesById = new Map<string, EvidenceLedgerEntry>();
    private readonly diffIdsByFile = new Map<string, string[]>();
    private nextRepositoryIndex = 1;

    static fromDiffs(diffs: DiffData[]): EvidenceLedger {
        const ledger = new EvidenceLedger();
        let nextDiffIndex = 1;
        for (const diff of diffs) {
            const units = diff.diffHunks.length > 0
                ? diff.diffHunks.map(hunk => ({ header: hunk.header, content: hunk.content }))
                : [{ header: '', content: diff.rawDiff }];
            const ids: string[] = [];
            for (const unit of units) {
                const id = `D${nextDiffIndex}`;
                nextDiffIndex += 1;
                ledger.entriesById.set(id, {
                    id,
                    source: 'diff',
                    fileName: diff.fileName,
                    status: diff.status,
                    header: unit.header,
                    content: unit.content,
                });
                ids.push(id);
            }
            ledger.diffIdsByFile.set(diff.fileName, ids);
        }
        return ledger;
    }

    getDiffEntries(fileName?: string): DiffEvidenceLedgerEntry[] {
        const entries = Array.from(this.entriesById.values())
            .filter((entry): entry is DiffEvidenceLedgerEntry => entry.source === 'diff');
        return fileName ? entries.filter(entry => entry.fileName === fileName) : entries;
    }

    getDiffIds(fileName: string): string[] {
        return [...(this.diffIdsByFile.get(fileName) ?? [])];
    }

    resolveDiffAnchor(fileName: string, line: number): string | undefined {
        const entries = this.getDiffEntries(fileName);
        for (const entry of entries) {
            const match = entry.header.match(/@@\s*-\d+(?:,\d+)?\s*\+(\d+)(?:,(\d+))?/);
            if (!match) {
                continue;
            }
            const start = Number(match[1]);
            const count = match[2] === undefined ? 1 : Number(match[2]);
            if (line >= start && line < start + Math.max(1, count)) {
                return entry.id;
            }
        }
        return entries.length === 1 ? entries[0].id : undefined;
    }

    allocateRepositoryEvidence(
        evidence: Omit<RepositoryEvidenceItem, 'id'>,
    ): RepositoryEvidenceLedgerEntry {
        const id = this.nextRepositoryEvidenceId();
        const entry: RepositoryEvidenceLedgerEntry = { ...evidence, id, source: 'repository' };
        this.entriesById.set(id, entry);
        return entry;
    }

    /** Preview without reserving IDs; callers validate a whole tool result before publishing it. */
    previewRepositoryEvidence(evidence: Array<Omit<RepositoryEvidenceItem, 'id'>>): RepositoryEvidenceItem[] {
        let index = this.nextRepositoryIndex;
        return evidence.map(item => {
            while (this.entriesById.has(`E${index}`)) { index += 1; }
            return { ...item, id: `E${index++}` };
        });
    }

    nextRepositoryEvidenceId(): string {
        let id: string;
        do {
            id = `E${this.nextRepositoryIndex}`;
            this.nextRepositoryIndex += 1;
        } while (this.entriesById.has(id));
        return id;
    }

    recordRepositoryEvidence(evidence: RepositoryEvidenceItem): void {
        if (!/^E\d+$/.test(evidence.id)) {
            throw new Error(`Repository evidence id '${evidence.id}' is not ledger-owned.`);
        }
        if (this.entriesById.has(evidence.id)) {
            throw new Error(`Evidence id '${evidence.id}' was allocated more than once.`);
        }
        this.entriesById.set(evidence.id, { ...evidence, source: 'repository' });
    }

    has(id: string): boolean {
        return this.entriesById.has(id);
    }

    get(id: string): EvidenceLedgerEntry | undefined {
        return this.entriesById.get(id);
    }

    snapshot(): EvidenceLedgerEntry[] {
        return Array.from(this.entriesById.values()).map(entry => ({ ...entry }));
    }
}

/** Inserts stable diff evidence markers without duplicating the full payload. */
export function annotateDiffWithEvidenceIds(diff: DiffData, ledger: EvidenceLedger): string {
    const entries = ledger.getDiffEntries(diff.fileName);
    if (!entries.length) {
        throw new Error(`Evidence ledger has no diff entries for '${diff.fileName}'.`);
    }
    if (!diff.diffHunks.length) {
        return `[${entries[0].id}]\n${diff.rawDiff}`;
    }

    const rawLines = diff.rawDiff.split('\n');
    const preambleEnd = rawLines.findIndex(line => line.startsWith('@@'));
    const preamble = preambleEnd < 0 ? '' : rawLines.slice(0, preambleEnd).join('\n');
    return [
        preamble,
        ...diff.diffHunks.map((hunk, index) => (
            `[${entries[index].id}]\n${hunk.header}\n${hunk.content}`
        )),
    ].filter(Boolean).join('\n');
}
