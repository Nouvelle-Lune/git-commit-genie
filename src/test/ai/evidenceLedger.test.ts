import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    annotateDiffWithEvidenceIds,
    EvidenceLedger,
} from '../../agent/evidenceLedger';
import { DiffData } from '../../services/git/gitTypes';

describe('EvidenceLedger', () => {
    it('annotates every hunk with the globally allocated id in input order', () => {
        const first = makeDiff('first.ts', [
            '@@ -1 +1 @@',
            '@@ -10 +10 @@',
        ]);
        const second = makeDiff('second.ts', ['@@ -3 +3 @@']);
        const ledger = EvidenceLedger.fromDiffs([first, second]);

        const annotated = annotateDiffWithEvidenceIds(first, ledger);

        assert.match(annotated, /\[D1\]\n@@ -1 \+1 @@/);
        assert.match(annotated, /\[D2\]\n@@ -10 \+10 @@/);
        assert.deepEqual(ledger.getDiffIds('second.ts'), ['D3']);
    });

    it('keeps a single id for a file without parsed hunks and allocates repository ids after diff ids', () => {
        const diff = makeDiff('raw.txt', []);
        diff.rawDiff = 'raw content';
        const ledger = EvidenceLedger.fromDiffs([diff]);

        assert.equal(annotateDiffWithEvidenceIds(diff, ledger), '[D1]\nraw content');
        const repository = ledger.allocateRepositoryEvidence({
            kind: 'definition',
            target: 'run',
            ref: 'src/index.ts:4',
            excerpt: 'export function run() {}',
        });

        assert.equal(repository.id, 'E1');
        assert.equal(ledger.get('D1')?.source, 'diff');
        assert.equal(ledger.get('E1')?.source, 'repository');
    });

    it('rejects a repository evidence id that is not ledger-owned', () => {
        const ledger = new EvidenceLedger();

        assert.throws(() => ledger.recordRepositoryEvidence({
            id: 'D1',
            kind: 'references',
            target: 'run',
            ref: 'src/index.ts:1',
            excerpt: 'invalid id',
        }), /not ledger-owned/);
    });
});

function makeDiff(fileName: string, headers: string[]): DiffData {
    return {
        fileName,
        status: 'modified',
        diffHunks: headers.map((header, index) => ({
            header,
            content: `-${index}\n+${index + 1}`,
            additions: [`${index + 1}`],
            deletions: [`${index}`],
        })),
        rawDiff: headers.map((header, index) => `${header}\n-${index}\n+${index + 1}`).join('\n'),
    };
}
