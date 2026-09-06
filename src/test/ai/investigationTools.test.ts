import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { runInvestigationTool, InvestigationToolContext } from '../../services/analysis/change/investigation/tools';
import { RepositorySnapshotReader } from '../../services/git/repositorySnapshot';

describe('change investigation tools', () => {
    it('returns changed symbols without allocating repository evidence', async () => {
        let allocations = 0;
        const context = makeContext(() => { allocations += 1; });

        const result = await runInvestigationTool(context, {
            tool: 'getChangedSymbols',
        });

        assert.equal(result.ok, true);
        assert.match(result.summary, /parse/);
        assert.equal(allocations, 0);
        assert.deepEqual(result.evidence, []);
    });

    it('reports a path escape as a failed tool outcome before reading or allocating evidence', async () => {
        let allocations = 0;
        const context = makeContext(() => { allocations += 1; });

        const result = await runInvestigationTool(context, {
            tool: 'readFileContent',
            filePath: '../outside.ts',
            startLine: 1,
            maxLines: 20,
        });

        assert.equal(result.ok, false);
        assert.match(result.error ?? '', /escapes the repository/);
        assert.equal(allocations, 0);
    });
});

function makeContext(onAllocate: () => void): InvestigationToolContext {
    return {
        repositoryPath: '/tmp/repository',
        snapshot: {} as RepositorySnapshotReader,
        excludePatterns: [],
        changedSymbols: [{
            name: 'parse',
            file: 'src/parser.ts',
            symbolType: 'function',
            changeKind: 'function_body',
        }],
        allocateEvidence: evidence => {
            onAllocate();
            return { ...evidence, id: 'E1' };
        },
    };
}
