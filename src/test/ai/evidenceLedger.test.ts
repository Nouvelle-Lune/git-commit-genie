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
            '@@ -1 +1 @@ function first()',
            '@@ -10 +10 @@ function second()',
        ]);
        const second = makeDiff('second.ts', ['@@ -3 +3 @@ function third()']);
        const ledger = EvidenceLedger.fromDiffs([first, second]);

        const annotated = annotateDiffWithEvidenceIds(first, ledger);

        assert.match(annotated, /\[D1\]\n@@ -1 \+1 @@ function first\(\)/);
        assert.match(annotated, /\[D2\]\n@@ -10 \+10 @@ function second\(\)/);
        assert.deepEqual(ledger.getDiffIds('first.ts'), ['D1', 'D2']);
        assert.deepEqual(ledger.getDiffIds('second.ts'), ['D3']);
        assert.equal(ledger.getDiffEntries().length, 3);
    });

    it('stores complete hunk headers and emits them with their D marker', () => {
        const header = '@@ -12,3 +12,5 @@ export function parseConfig()';
        const content = ' context\n-oldValue\n+newValue';
        const diff = {
            fileName: 'config.ts',
            status: 'modified' as const,
            diffHunks: [{
                header,
                content,
                additions: ['+newValue'],
                deletions: ['-oldValue'],
            }],
            rawDiff: `${header}\n${content}`,
        };
        const ledger = EvidenceLedger.fromDiffs([diff]);

        assert.equal(ledger.getDiffEntries('config.ts')[0]?.header, header);
        assert.equal(
            annotateDiffWithEvidenceIds(diff, ledger),
            `[D1]\n${header}\n${content}`,
        );
    });

    it('resolves new-file line anchors from complete hunk headers', () => {
        const diff = makeDiff('parser.ts', [
            '@@ -1,2 +10,2 @@ function first()',
            '@@ -30,2 +40,3 @@ function second()',
        ]);
        const ledger = EvidenceLedger.fromDiffs([diff]);

        assert.equal(ledger.resolveDiffAnchor('parser.ts', 10), 'D1');
        assert.equal(ledger.resolveDiffAnchor('parser.ts', 11), 'D1');
        assert.equal(ledger.resolveDiffAnchor('parser.ts', 40), 'D2');
        assert.equal(ledger.resolveDiffAnchor('parser.ts', 42), 'D2');
        assert.equal(ledger.resolveDiffAnchor('parser.ts', 99), undefined);
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
