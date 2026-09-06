import { strict as assert } from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import {
    ReplayCase,
    ReplayManifest,
    ReplayResult,
    runSequentialReplay,
    validateReplayHistory,
} from '../../services/memory/benchmark';

describe('repository memory replay benchmark', function () {
    this.timeout(20_000);

    it('freezes one manifest, isolates A/B/C storage, and resumes complete/error checkpoints without rerunning them', async () => {
        await withTempDirectory(async root => {
            const manifest = makeManifest('frozen-manifest');
            const firstCalls: ReplayCase[] = [];
            const storageRoots: string[] = [];
            const firstRun = await runSequentialReplay({
                manifest,
                outputRoot: root,
                adapter: {
                    run: async (input, storageRoot) => {
                        firstCalls.push(input);
                        storageRoots.push(storageRoot);
                        if (input.group === 'B') {
                            throw new Error('mock provider failure');
                        }
                        return { status: 'complete', costs: [], maintenanceCosts: [] };
                    },
                },
                signal: new AbortController().signal,
                onProgress: () => undefined,
            });

            assert.equal(firstCalls.length, 3);
            assert.equal(new Set(storageRoots).size, 3, 'A/B/C receive independent memory roots');
            assert.equal(new Set(firstCalls.map(input => input.id)).size, 3);
            assert.equal(new Set(firstCalls.map(input => input.group)).size, 3);

            const checkpointFiles = (await fs.readdir(firstRun))
                .filter(file => file.endsWith('.json') && file !== 'manifest.json');
            assert.equal(checkpointFiles.length, 3);
            const firstStatuses = await readStatuses(firstRun, checkpointFiles);
            assert.deepEqual(new Set(firstStatuses.map(item => item.status)), new Set(['complete', 'error']));
            assert.equal(firstStatuses.filter(item => item.status === 'error').length, 1,
                'errors remain in the denominator instead of being retried');

            const resumedCalls: ReplayCase[] = [];
            const resumedProgress: ReplayCase[] = [];
            const resumedRun = await runSequentialReplay({
                manifest,
                outputRoot: root,
                adapter: { run: async input => {
                    resumedCalls.push(input);
                    return { status: 'complete', costs: [], maintenanceCosts: [] };
                } },
                signal: new AbortController().signal,
                onProgress: (_done, _total, input) => resumedProgress.push(input),
            });
            assert.equal(resumedRun, firstRun);
            assert.equal(resumedCalls.length, 0, 'complete and error checkpoints are terminal');
            assert.equal(resumedProgress.length, 3);

            const otherManifest = makeManifest('different-fingerprint');
            const isolatedRun = await runSequentialReplay({
                manifest: otherManifest,
                outputRoot: root,
                adapter: { run: async () => ({ status: 'complete', costs: [], maintenanceCosts: [] }) },
                signal: new AbortController().signal,
                onProgress: () => undefined,
            });
            assert.notEqual(isolatedRun, firstRun, 'changing frozen inputs creates a separate experiment');

            const unknownFile = path.join(firstRun, checkpointFiles[2]);
            const unknown = JSON.parse(await fs.readFile(unknownFile, 'utf8')) as ReplayResult;
            (unknown as unknown as { status: string }).status = 'unknown';
            await fs.writeFile(unknownFile, JSON.stringify(unknown));
            const unknownCalls: ReplayCase[] = [];
            await assert.rejects(
                () => runSequentialReplay({
                    manifest,
                    outputRoot: root,
                    adapter: { run: async input => {
                        unknownCalls.push(input);
                        return { status: 'complete', costs: [], maintenanceCosts: [] };
                    } },
                    signal: new AbortController().signal,
                    onProgress: () => undefined,
                }),
                /Invalid replay checkpoint/,
            );
            assert.equal(unknownCalls.length, 0, 'unknown checkpoints are never automatically rerun');
        });
    });

    it('records a cancelled attempt once so a later resume cannot charge it again', async () => {
        await withTempDirectory(async root => {
            const manifest = makeManifest('cancelled-once');
            const controller = new AbortController();
            let calls = 0;
            await assert.rejects(
                () => runSequentialReplay({
                    manifest,
                    outputRoot: root,
                    adapter: { run: async (_input, _storageRoot, signal) => {
                        calls += 1;
                        controller.abort();
                        signal.throwIfAborted();
                        return { status: 'complete', costs: [], maintenanceCosts: [] };
                    } },
                    signal: controller.signal,
                    onProgress: () => undefined,
                }),
                /aborted/i,
            );
            assert.equal(calls, 1);
            const firstRun = path.join(root, (await fs.readdir(root))[0]);
            const checkpoints = (await fs.readdir(firstRun)).filter(file => file !== 'manifest.json');
            assert.equal(checkpoints.length, 1, 'the cancelled case is checkpointed as an error');
            const checkpoint = JSON.parse(await fs.readFile(path.join(firstRun, checkpoints[0]), 'utf8')) as ReplayResult;
            assert.equal(checkpoint.status, 'error');
            assert.match(checkpoint.error ?? '', /aborted|cancelled|Interrupted/i);

            const resumedCalls: ReplayCase[] = [];
            await runSequentialReplay({
                manifest,
                outputRoot: root,
                adapter: { run: async input => {
                    resumedCalls.push(input);
                    return { status: 'complete', costs: [], maintenanceCosts: [] };
                } },
                signal: new AbortController().signal,
                onProgress: () => undefined,
            });
            assert.equal(resumedCalls.length, 2, 'only the two never-started cases are resumed');
            assert.equal(resumedCalls.some(input => input.group === 'A'), false, 'the cancelled case is not charged twice');
        });
    });

    it('performs a chronological, non-merge history preflight before replay', async () => {
        await withTempGit(async root => {
            await fs.writeFile(path.join(root, 'file.txt'), 'one\n');
            await commitAll(root, 'one');
            const first = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
            await fs.writeFile(path.join(root, 'file.txt'), 'two\n');
            await commitAll(root, 'two');
            const second = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();

            const manifest = makeManifest('history', root, [first, second]);
            await validateReplayHistory(manifest, 'git', new AbortController().signal);
            await assert.rejects(
                () => validateReplayHistory({ ...manifest, repositories: [{ ...manifest.repositories[0], commits: [second, first] }] }, 'git', new AbortController().signal),
                /chronological|non-merge commit/,
            );

            const branch = (await git(root, ['branch', '--show-current'])).toString().trim();
            await git(root, ['checkout', '-b', 'benchmark-side']);
            await fs.writeFile(path.join(root, 'side.txt'), 'side\n');
            await commitAll(root, 'side');
            await git(root, ['checkout', branch]);
            await fs.writeFile(path.join(root, 'main.txt'), 'main\n');
            await commitAll(root, 'main');
            await git(root, ['merge', '--no-ff', 'benchmark-side', '-m', 'merge']);
            const merge = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
            await assert.rejects(
                () => validateReplayHistory({ ...manifest, repositories: [{ ...manifest.repositories[0], commits: [merge] }] }, 'git', new AbortController().signal),
                /non-merge commit/,
            );
        });
    });
});

function makeManifest(fingerprint: string, repository = '/tmp/repository', commits = ['a'.repeat(40)]): ReplayManifest {
    return {
        version: 1,
        models: ['mock-model'],
        repetitions: 1,
        repositories: [{ path: repository, commits }],
        configurationFingerprint: fingerprint,
    };
}

async function readStatuses(directory: string, files: string[]): Promise<ReplayResult[]> {
    return Promise.all(files.map(async file => JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')) as ReplayResult));
}

async function withTempDirectory<T>(action: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-memory-benchmark-'));
    try {
        return await action(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function withTempGit<T>(action: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-memory-history-'));
    try {
        await git(root, ['init', '--quiet']);
        await git(root, ['config', 'user.name', 'Benchmark Test']);
        await git(root, ['config', 'user.email', 'benchmark-test@example.invalid']);
        return await action(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function commitAll(root: string, message: string): Promise<void> {
    await git(root, ['add', '-A']);
    await git(root, ['commit', '--quiet', '-m', message]);
}

function git(root: string, args: string[], input?: string | Buffer): Promise<Buffer> {
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
        child.stdin.end(input);
    });
}
