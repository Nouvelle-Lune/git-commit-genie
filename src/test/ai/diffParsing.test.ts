import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { DiffService } from '../../services/git/diff';
import { DiffHunk } from '../../services/git/gitTypes';

type PrivateDiffParser = {
    parseDiff(diffOutput: string): DiffHunk[];
};

describe('DiffService hunk parsing', () => {
    it('preserves a function context in the complete hunk header', () => {
        const header = '@@ -12,3 +12,5 @@ export function parseConfig()';
        const content = ' const before = true;\n-oldValue\n+newValue';
        const [hunk] = parseDiff([header, content].join('\n'));

        assert.ok(hunk);
        assert.equal(hunk.header, header);
        assert.equal(hunk.content, content);
        assert.deepEqual(hunk.additions, ['+newValue']);
        assert.deepEqual(hunk.deletions, ['-oldValue']);
        assert.equal(hunk.content.includes(header), false);
        assert.equal(hunk.additions.includes(header), false);
        assert.equal(hunk.deletions.includes(header), false);
    });

    it('keeps each hunk paired with its own function context', () => {
        const firstHeader = '@@ -1,2 +1,3 @@ function first()';
        const secondHeader = '@@ -20,2 +21,3 @@ function second()';
        const firstContent = ' first context\n-firstValue\n+firstValue';
        const secondContent = ' second context\n-secondValue\n+secondValue';

        const hunks = parseDiff([
            'diff --git a/src/parser.ts b/src/parser.ts',
            '--- a/src/parser.ts',
            '+++ b/src/parser.ts',
            firstHeader,
            firstContent,
            secondHeader,
            secondContent,
        ].join('\n'));

        assert.equal(hunks.length, 2);
        assert.deepEqual(hunks.map(hunk => hunk.header), [firstHeader, secondHeader]);
        assert.deepEqual(hunks.map(hunk => hunk.content), [firstContent, secondContent]);
    });

    it('retains the traditional header when no section heading is present', () => {
        const header = '@@ -4,2 +4,2 @@';
        const [hunk] = parseDiff([header, '-old', '+new'].join('\n'));

        assert.ok(hunk);
        assert.equal(hunk.header, header);
        assert.equal(hunk.content, '-old\n+new');
    });
});

function parseDiff(diffOutput: string): DiffHunk[] {
    const service = new DiffService(undefined as never);
    return (service as unknown as PrivateDiffParser).parseDiff(diffOutput);
}
