import { strict as assert } from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { hashContent, RepositorySnapshotReader } from '../../services/git/repositorySnapshot';

describe('RepositorySnapshotReader', function () {
    this.timeout(20_000);

    it('captures HEAD as before and the staged index as after while leaving worktree edits out', async () => {
        await withTempRepo(async root => {
            const file = path.join(root, 'note.txt');
            await fs.writeFile(file, 'head version\n');
            await commitAll(root, 'initial');

            await fs.writeFile(file, 'index version\n');
            await runGit(root, ['add', '--', 'note.txt']);
            await fs.writeFile(file, 'worktree version\n');

            const snapshot = await RepositorySnapshotReader.capture(root, 'git');

            assert.equal(await snapshot.read('note.txt', 'before'), 'head version\n');
            assert.equal(await snapshot.read('note.txt', 'after'), 'index version\n');
            assert.equal(await fs.readFile(file, 'utf8'), 'worktree version\n');
            assert.notEqual(snapshot.identity.beforeTree, snapshot.identity.afterTree);
        });
    });

    it('captures a genuinely partially staged file from the index', async () => {
        await withTempRepo(async root => {
            const file = path.join(root, 'partial.txt');
            const base = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
            const worktree = base.replace('line 1', 'line 1 staged').replace('line 10', 'line 10 unstaged');
            await fs.writeFile(file, base);
            await commitAll(root, 'initial');
            await fs.writeFile(file, worktree);
            await runGit(root, ['apply', '--cached', '--unidiff-zero'], [
                'diff --git a/partial.txt b/partial.txt',
                '--- a/partial.txt',
                '+++ b/partial.txt',
                '@@ -1 +1 @@',
                '-line 1',
                '+line 1 staged',
                '',
            ].join('\n'));

            const snapshot = await RepositorySnapshotReader.capture(root, 'git');

            assert.equal((await snapshot.read('partial.txt', 'before')).split('\n')[0], 'line 1');
            assert.equal((await snapshot.read('partial.txt', 'after')).split('\n')[0], 'line 1 staged');
            assert.equal((await snapshot.read('partial.txt', 'after')).split('\n')[9], 'line 10');
            assert.equal((await fs.readFile(file, 'utf8')).split('\n')[9], 'line 10 unstaged');
        });
    });

    it('keeps before and after immutable after later worktree and index changes', async () => {
        await withTempRepo(async root => {
            const file = path.join(root, 'immutable.txt');
            await fs.writeFile(file, 'head\n');
            await commitAll(root, 'initial');
            await fs.writeFile(file, 'captured index\n');
            await runGit(root, ['add', '--', 'immutable.txt']);

            const snapshot = await RepositorySnapshotReader.capture(root, 'git');

            await fs.writeFile(file, 'later worktree\n');
            await runGit(root, ['add', '--', 'immutable.txt']);
            await fs.writeFile(file, 'later unstaged\n');

            assert.equal(await snapshot.read('immutable.txt', 'before'), 'head\n');
            assert.equal(await snapshot.read('immutable.txt', 'after'), 'captured index\n');
        });
    });

    it('replays a full commit without changing the current branch or index', async () => {
        await withTempRepo(async root => {
            const file = path.join(root, 'history.txt');
            await fs.writeFile(file, 'first\n');
            await commitAll(root, 'first');
            const first = (await runGit(root, ['rev-parse', 'HEAD'])).toString().trim();
            await fs.writeFile(file, 'second\n');
            await commitAll(root, 'second');
            const second = (await runGit(root, ['rev-parse', 'HEAD'])).toString().trim();
            await fs.writeFile(path.join(root, 'staged.txt'), 'staged but uncommitted\n');
            await runGit(root, ['add', '--', 'staged.txt']);
            const branch = (await runGit(root, ['branch', '--show-current'])).toString().trim();
            const index = await runGit(root, ['ls-files', '--stage', '-z']);

            const snapshot = await RepositorySnapshotReader.fromCommit(root, 'git', second);

            assert.equal(snapshot.identity.head, first);
            assert.equal(await snapshot.read('history.txt', 'before'), 'first\n');
            assert.equal(await snapshot.read('history.txt', 'after'), 'second\n');
            assert.equal((await runGit(root, ['branch', '--show-current'])).toString().trim(), branch);
            assert.deepEqual(await runGit(root, ['ls-files', '--stage', '-z']), index);
            await assert.rejects(() => RepositorySnapshotReader.fromCommit(root, 'git', second.slice(0, 8)), /full immutable commit OID/);
        });
    });

    it('rejects merge commits during historical replay and keeps linked worktrees distinct', async () => {
        await withTempRepo(async root => {
            await fs.writeFile(path.join(root, 'base.txt'), 'base\n');
            await commitAll(root, 'base');
            const branch = (await runGit(root, ['branch', '--show-current'])).toString().trim();
            await runGit(root, ['checkout', '-b', 'snapshot-side']);
            await fs.writeFile(path.join(root, 'side.txt'), 'side\n');
            await commitAll(root, 'side');
            await runGit(root, ['checkout', branch]);
            await fs.writeFile(path.join(root, 'main.txt'), 'main\n');
            await commitAll(root, 'main');
            await runGit(root, ['merge', '--no-ff', 'snapshot-side', '-m', 'merge']);
            const merge = (await runGit(root, ['rev-parse', 'HEAD'])).toString().trim();
            await assert.rejects(() => RepositorySnapshotReader.fromCommit(root, 'git', merge), /non-merge commit/);

            const linked = path.join(path.dirname(root), `genie-linked-${path.basename(root)}`);
            await runGit(root, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
            try {
                const first = await RepositorySnapshotReader.identify(root, 'git');
                const second = await RepositorySnapshotReader.identify(linked, 'git');
                assert.equal(first.repositoryId, second.repositoryId, 'linked worktrees share the repository identity');
                assert.notEqual(first.worktreeId, second.worktreeId, 'linked worktrees retain distinct worktree identities');
            } finally {
                await runGit(root, ['worktree', 'remove', '--force', linked]).catch(() => undefined);
                await fs.rm(linked, { recursive: true, force: true });
            }
        });
    });

    it('detects a changed index while treating an unstaged edit as outside the captured identity', async () => {
        await withTempRepo(async root => {
            const file = path.join(root, 'current.txt');
            await fs.writeFile(file, 'one\n');
            await commitAll(root, 'initial');
            const snapshot = await RepositorySnapshotReader.capture(root, 'git');

            await fs.writeFile(file, 'unstaged only\n');
            assert.equal(await snapshot.isCurrent(), true);

            await runGit(root, ['add', '--', 'current.txt']);
            assert.equal(await snapshot.isCurrent(), false);
        });
    });

    it('captures an unborn repository and auto-stages only in its private index', async () => {
        await withTempRepo(async root => {
            const file = path.join(root, 'unborn.txt');
            const realIndexBefore = await runGit(root, ['ls-files', '--stage', '-z']);
            await fs.writeFile(file, 'unborn worktree\n');

            const snapshot = await RepositorySnapshotReader.capture(root, 'git', true);
            const realIndexAfter = await runGit(root, ['ls-files', '--stage', '-z']);

            assert.equal(snapshot.identity.head, null);
            assert.equal(snapshot.identity.autoStaged, true);
            assert.deepEqual(snapshot.entries('before'), []);
            assert.equal(await snapshot.read('unborn.txt', 'after'), 'unborn worktree\n');
            assert.deepEqual(realIndexAfter, realIndexBefore);
        });
    });

    it('round-trips unicode, spaces, tabs, and newlines in NUL-delimited Git manifests', async () => {
        await withTempRepo(async root => {
            const names = [
                'unicode 雪.txt',
                'space name.txt',
                'tab\tname.txt',
                'line\nname.txt',
            ];
            for (const [index, name] of names.entries()) {
                await fs.writeFile(path.join(root, name), `content ${index}\n`);
            }
            await commitAll(root, 'special paths');

            const snapshot = await RepositorySnapshotReader.capture(root, 'git');
            const capturedNames = snapshot.entries('after').map(entry => entry.path);

            assert.deepEqual(new Set(capturedNames), new Set(names));
            for (const [index, name] of names.entries()) {
                assert.equal(await snapshot.read(name), `content ${index}\n`);
            }
        });
    });

    it('rejects unmerged index entries before creating a snapshot', async () => {
        await withTempRepo(async root => {
            const file = path.join(root, 'conflict.txt');
            await fs.writeFile(file, 'base\n');
            await commitAll(root, 'base');
            const mainBranch = (await runGit(root, ['branch', '--show-current'])).toString('utf8').trim();
            await runGit(root, ['checkout', '-b', 'conflict-side']);
            await fs.writeFile(file, 'side\n');
            await commitAll(root, 'side');
            await runGit(root, ['checkout', mainBranch]);
            await fs.writeFile(file, 'main\n');
            await commitAll(root, 'main');
            await runGit(root, ['merge', 'conflict-side']).catch(() => undefined);

            await assert.rejects(
                () => RepositorySnapshotReader.capture(root, 'git'),
                /Resolve unmerged index entries/,
            );
        });
    });

    it('rejects symlinks, gitlinks, binary content, and paths escaping the repository', async () => {
        await withTempRepo(async root => {
            const target = path.join(root, 'target.txt');
            const link = path.join(root, 'link.txt');
            await fs.writeFile(target, 'target\n');
            await fs.symlink('target.txt', link);
            await commitAll(root, 'symlink');
            const symlinkSnapshot = await RepositorySnapshotReader.capture(root, 'git');
            assert.equal(symlinkSnapshot.entry('link.txt')?.mode, '120000');
            await assert.rejects(() => symlinkSnapshot.read('link.txt'), /not regular text \(120000\)/);
        });

        await withTempRepo(async root => {
            await fs.writeFile(path.join(root, 'root.txt'), 'root\n');
            await commitAll(root, 'root');
            const nested = path.join(root, 'nested-repository');
            await fs.mkdir(nested);
            await initRepo(nested);
            await fs.writeFile(path.join(nested, 'nested.txt'), 'nested\n');
            await commitAll(nested, 'nested');
            await runGit(root, ['add', '--', 'nested-repository']);

            const snapshot = await RepositorySnapshotReader.capture(root, 'git');
            assert.equal(snapshot.entry('nested-repository')?.mode, '160000');
            await assert.rejects(() => snapshot.read('nested-repository'), /not regular text \(160000\)/);
        });

        await withTempRepo(async root => {
            const binary = path.join(root, 'binary.bin');
            await fs.writeFile(binary, Buffer.from([0, 1, 2, 255]));
            await commitAll(root, 'binary');
            const snapshot = await RepositorySnapshotReader.capture(root, 'git');
            await assert.rejects(() => snapshot.read('binary.bin'), /binary or exceeds 2 MiB/);
            assert.throws(() => snapshot.relative(path.join(snapshot.root, '..', 'outside.txt')), /Path escapes the repository/);
            assert.throws(() => snapshot.relative('/tmp/outside.txt'), /Path escapes the repository/);
        });
    });

    it('applies exclusions and produces source observations with a verifiable excerpt hash', async () => {
        await withTempRepo(async root => {
            const source = path.join(root, 'source.ts');
            const secret = path.join(root, 'credentials.secret');
            await fs.writeFile(source, 'one\ntwo\nthree\n');
            await fs.writeFile(secret, 'do not read\n');
            await commitAll(root, 'sources');
            const snapshot = await RepositorySnapshotReader.capture(root, 'git');

            assert.equal(snapshot.entries('after', ['*.secret']).some(entry => entry.path === 'credentials.secret'), false);
            await assert.rejects(() => snapshot.read('credentials.secret', 'after', ['*.secret']), /Snapshot path is excluded/);

            const observation = await snapshot.observe('source.ts', 2, 2, [], 'after', 4);
            assert.equal(observation.path, 'source.ts');
            assert.equal(observation.excerpt, 'two\n');
            assert.equal(observation.contentHash, hashContent(observation.excerpt));
            assert.equal(observation.snapshotId, snapshot.identity.id);
            assert.equal(observation.truncated, true);
            await assert.rejects(() => snapshot.observe('source.ts', 0, 1), /Invalid snapshot line range/);
            await assert.rejects(() => snapshot.observe('source.ts', 99, 1), /outside the source/);
        });
    });
});

async function withTempRepo<T>(action: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-snapshot-test-'));
    try {
        await initRepo(root);
        return await action(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function initRepo(root: string): Promise<void> {
    await runGit(root, ['init', '--quiet']);
    await runGit(root, ['config', 'user.name', 'Snapshot Test']);
    await runGit(root, ['config', 'user.email', 'snapshot-test@example.invalid']);
}

async function commitAll(root: string, message: string): Promise<void> {
    await runGit(root, ['add', '-A']);
    await runGit(root, ['commit', '--quiet', '-m', message]);
}

function runGit(root: string, args: string[], input?: string | Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd: root,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve(Buffer.concat(stdout));
            } else {
                reject(new Error(`git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`));
            }
        });
        child.stdin.end(input);
    });
}
