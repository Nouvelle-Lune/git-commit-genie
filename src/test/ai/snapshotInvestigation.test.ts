import { strict as assert } from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { runInvestigationTool, InvestigationToolContext } from '../../services/analysis/change/investigation/tools';
import { hashContent, RepositorySnapshotReader } from '../../services/git/repositorySnapshot';

describe('snapshot-backed investigation tools', function () {
    this.timeout(20_000);

    it('reads HEAD and the fixed index through real tools with side and blob provenance', async () => {
        await withTempRepo(async root => {
            const source = path.join(root, 'src', 'parser.ts');
            await fs.mkdir(path.dirname(source), { recursive: true });
            await fs.writeFile(source, 'export function parse() { return "head"; }\n');
            await fs.writeFile(path.join(root, 'secret.txt'), 'secret should be excluded\n');
            await commitAll(root, 'head');
            await fs.writeFile(source, 'export function parse() { return "indexed"; }\n');
            await runGit(root, ['add', '--', 'src/parser.ts']);
            await fs.writeFile(source, 'export function parse() { return "worktree"; }\n');

            const snapshot = await RepositorySnapshotReader.capture(root, 'git');
            const context = makeContext(snapshot.root, snapshot);
            const after = await runInvestigationTool(context, {
                tool: 'readFileContent', filePath: 'src/parser.ts', startLine: 1, maxLines: 2,
            });
            const before = await runInvestigationTool(context, {
                tool: 'readFileContent', side: 'before', filePath: 'src/parser.ts', startLine: 1, maxLines: 2,
            });

            assert.equal(after.ok, true);
            assert.equal(before.ok, true);
            assert.match(after.evidence[0].excerpt, /indexed/);
            assert.doesNotMatch(after.evidence[0].excerpt, /worktree/);
            assert.match(before.evidence[0].excerpt, /head/);
            assert.equal(after.evidence[0].provenance?.side, 'after');
            assert.equal(before.evidence[0].provenance?.side, 'before');
            assert.equal(after.evidence[0].provenance?.blobOid, snapshot.entry('src/parser.ts', 'after')?.oid);
            assert.equal(before.evidence[0].provenance?.blobOid, snapshot.entry('src/parser.ts', 'before')?.oid);
            assert.equal(after.evidence[0].provenance?.snapshotId, snapshot.identity.id);
            assert.equal(after.evidence[0].provenance?.contentHash, hashContent(after.evidence[0].provenance?.excerpt ?? ''));

            const search = await runInvestigationTool(context, {
                tool: 'searchCode', query: 'indexed', searchType: 'content', maxResults: 10,
            });
            const headSearch = await runInvestigationTool(context, {
                tool: 'searchCode', side: 'before', query: 'head', searchType: 'content', maxResults: 10,
            });
            assert.equal(search.ok, true);
            assert.equal(headSearch.ok, true);
            assert.equal(search.evidence.length, 1);
            assert.equal(headSearch.evidence.length, 1);
            assert.equal(search.evidence[0].provenance?.side, 'after');
            assert.equal(headSearch.evidence[0].provenance?.side, 'before');

            const excluded = await runInvestigationTool(context, {
                tool: 'readFileContent', filePath: 'secret.txt', startLine: 1, maxLines: 2,
            });
            assert.equal(excluded.ok, false);
            assert.match(excluded.error ?? '', /excluded/);
        });
    });

    it('uses the real snapshot for name search and directory listing instead of an ungrounded cast', async () => {
        await withTempRepo(async root => {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one\n');
            await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two\n');
            await commitAll(root, 'files');
            const snapshot = await RepositorySnapshotReader.capture(root, 'git');
            const context = makeContext(snapshot.root, snapshot);

            const names = await runInvestigationTool(context, {
                tool: 'searchCode', query: 'two.ts', searchType: 'name', maxResults: 10,
            });
            const listing = await runInvestigationTool(context, { tool: 'listDirectory', dirPath: 'src' });

            assert.equal(names.ok, true);
            assert.match(names.summary, /src\/two\.ts/);
            assert.equal(names.evidence.length, 0, 'name search does not invent line provenance');
            assert.equal(listing.ok, true);
            assert.match(listing.summary, /one\.ts/);
            assert.match(listing.summary, /two\.ts/);
        });
    });
});

function makeContext(root: string, snapshot: RepositorySnapshotReader): InvestigationToolContext {
    let nextId = 0;
    return {
        repositoryPath: root,
        snapshot,
        excludePatterns: ['secret.txt'],
        allocateEvidence: evidence => ({ ...evidence, id: `E${++nextId}` }),
    };
}

async function withTempRepo<T>(action: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-investigation-test-'));
    try {
        await runGit(root, ['init', '--quiet']);
        await runGit(root, ['config', 'user.name', 'Investigation Test']);
        await runGit(root, ['config', 'user.email', 'investigation-test@example.invalid']);
        return await action(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function commitAll(root: string, message: string): Promise<void> {
    await runGit(root, ['add', '-A']);
    await runGit(root, ['commit', '--quiet', '-m', message]);
}

function runGit(root: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        child.on('error', reject);
        child.on('close', code => code === 0
            ? resolve(Buffer.concat(stdout))
            : reject(new Error(`git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`)));
        child.stdin.end();
    });
}
