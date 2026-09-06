import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { shouldExclude } from '../analysis/tools/pathFilters';
import { isUtf8 } from 'buffer';

export type SnapshotSide = 'before' | 'after';
export interface SnapshotEntry { path: string; mode: string; oid: string }
export interface SourceObservation {
    snapshotId: string;
    path: string;
    side: SnapshotSide;
    blobOid: string;
    startLine: number;
    endLine: number;
    excerpt: string;
    contentHash: string;
    truncated: boolean;
    sourceType: 'text';
}
export interface SnapshotIdentity {
    id: string;
    repositoryId: string;
    worktreeId: string;
    head: string | null;
    beforeTree: string;
    afterTree: string;
    indexFingerprint: string;
    autoStaged: boolean;
}
export interface SnapshotReadMetrics { gitObjectCalls: number; blobBytes: number; sourceReads: number; searchCalls: number; filesSearched: number }

export const hashContent = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** No shell interpolation: file names and object IDs are always separate arguments. */
export async function snapshotGit(
    gitPath: string, root: string, args: string[],
    options: { input?: Buffer | string; index?: string; signal?: AbortSignal; allowedExitCodes?: number[] } = {},
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn(gitPath, args, {
            cwd: root, signal: options.signal,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1',
                ...(options.index ? { GIT_INDEX_FILE: options.index } : {}) },
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 128 * 1024 * 1024) { child.kill(); reject(new Error('Git snapshot output exceeded 128 MiB.')); }
            else { chunks.push(chunk); }
        });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.on('error', reject);
        child.stdin.on('error', reject);
        child.on('close', code => {
            if (code === 0 || (code !== null && options.allowedExitCodes?.includes(code))) { resolve(Buffer.concat(chunks)); }
            else { reject(new Error(`Git snapshot ${args[0]} failed (${code}): ${stderr}`)); }
        });
        child.stdin.end(options.input);
    });
}

function parseManifest(raw: Buffer, tree: boolean): SnapshotEntry[] {
    if (!isUtf8(raw)) { throw new Error('Git snapshot contains a non-UTF-8 path; exact path identity cannot be represented.'); }
    return raw.toString('utf8').split('\0').filter(Boolean).map(record => {
        const separator = record.indexOf('\t');
        if (separator < 0) { throw new Error('Invalid Git snapshot manifest.'); }
        const fields = record.slice(0, separator).split(' ');
        if (!tree && fields[2] !== '0') { throw new Error('Resolve unmerged index entries before generating a commit message.'); }
        return { mode: fields[0], oid: fields[tree ? 2 : 1], path: record.slice(separator + 1) };
    });
}

/**
 * Captures HEAD and index once. A private index expands sparse/split indexes and
 * supports auto-stage without ever adding or resetting the user's real index.
 * Immutable trees keep subsequent reads independent of editor and branch changes.
 */
export class RepositorySnapshotReader {
    readonly metrics: SnapshotReadMetrics = { gitObjectCalls: 0, blobBytes: 0, sourceReads: 0, searchCalls: 0, filesSearched: 0 };
    private readonly before: Map<string, SnapshotEntry>;
    private readonly after: Map<string, SnapshotEntry>;
    private readonly cache = new Map<string, string>();
    private cacheBytes = 0;
    private constructor(
        readonly root: string, readonly gitPath: string, readonly identity: SnapshotIdentity,
        before: SnapshotEntry[], after: SnapshotEntry[], readonly signal?: AbortSignal,
    ) {
        this.before = new Map(before.map(entry => [entry.path, entry]));
        this.after = new Map(after.map(entry => [entry.path, entry]));
    }

    static async identify(root: string, gitPath: string): Promise<{ repositoryId: string; worktreeId: string }> {
        const realRoot = await fs.realpath(root);
        const commonDir = await fs.realpath(path.resolve(realRoot, (await snapshotGit(gitPath, realRoot, ['rev-parse', '--git-common-dir'])).toString().trim()));
        return { repositoryId: hashContent(commonDir), worktreeId: hashContent(realRoot) };
    }

    /** Historical replay exposes only one commit and its first (or empty) parent. */
    static async fromCommit(root: string, gitPath: string, commit: string, signal?: AbortSignal): Promise<RepositorySnapshotReader> {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) { throw new Error('Replay requires a full immutable commit OID.'); }
        root = await fs.realpath(root);
        const git = (args: string[], input?: string) => snapshotGit(gitPath, root, args, { input, signal });
        const parents = (await git(['rev-list', '--parents', '-n', '1', commit])).toString().trim().split(' ');
        if (parents[0] !== commit || parents.length > 2) { throw new Error('Replay requires a non-merge commit.'); }
        const head = parents[1] ?? null;
        const beforeTree = head ? (await git(['rev-parse', `${head}^{tree}`])).toString().trim()
            : (await git(['hash-object', '-t', 'tree', '-w', '--stdin'], '')).toString().trim();
        const afterTree = (await git(['rev-parse', `${commit}^{tree}`])).toString().trim();
        const raw = await Promise.all([beforeTree, afterTree].map(tree => git(['ls-tree', '-r', '-z', tree])));
        const identity: SnapshotIdentity = { ...await this.identify(root, gitPath), id: hashContent(`${head}\0${beforeTree}\0${afterTree}`), head,
            beforeTree, afterTree, indexFingerprint: hashContent(raw[1]), autoStaged: false };
        return new RepositorySnapshotReader(root, gitPath, Object.freeze(identity), parseManifest(raw[0], true), parseManifest(raw[1], true), signal);
    }

    static async capture(root: string, gitPath: string, autoStage = false, signal?: AbortSignal): Promise<RepositorySnapshotReader> {
        root = await fs.realpath(root);
        const git = (args: string[], options: Parameters<typeof snapshotGit>[3] = {}) =>
            snapshotGit(gitPath, root, args, { ...options, signal });
        const headValue = async () => (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowedExitCodes: [1] })).toString().trim() || null;
        const head = await headValue();
        const rawIndex = await git(['ls-files', '--stage', '-z']);
        const indexEntries = parseManifest(rawIndex, false);
        const commonDir = await fs.realpath(path.resolve(root, (await git(['rev-parse', '--git-common-dir'])).toString().trim()));
        const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-snapshot-'));
        try {
            const index = path.join(temp, 'index');
            await git(['read-tree', '--empty'], { index });
            const manifest = indexEntries.map(entry => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join('');
            await git(['update-index', '-z', '--index-info'], { index, input: manifest });
            const beforeTree = head
                ? (await git(['rev-parse', `${head}^{tree}`])).toString().trim()
                : (await git(['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' })).toString().trim();
            let afterTree = (await git(['write-tree'], { index })).toString().trim();
            const autoStaged = autoStage && beforeTree === afterTree;
            if (autoStaged) {
                await git(['add', '-A'], { index });
                afterTree = (await git(['write-tree'], { index })).toString().trim();
            }
            const currentHead = await headValue();
            const currentIndex = await git(['ls-files', '--stage', '-z']);
            if (currentHead !== head || !currentIndex.equals(rawIndex)) {
                throw new Error('Repository HEAD or index changed while capturing input. Regenerate the message.');
            }
            const [before, after] = await Promise.all([beforeTree, afterTree].map(async tree =>
                parseManifest(await git(['ls-tree', '-r', '-z', tree]), true)));
            const identity: SnapshotIdentity = {
                id: hashContent(`${head}\0${beforeTree}\0${afterTree}`),
                repositoryId: hashContent(commonDir), worktreeId: hashContent(root), head,
                beforeTree, afterTree, indexFingerprint: hashContent(rawIndex), autoStaged,
            };
            return new RepositorySnapshotReader(root, gitPath, Object.freeze(identity), before, after, signal);
        } finally {
            // Only the task-owned mkdtemp directory is removed; never the repository index.
            await fs.rm(temp, { recursive: true, force: true });
        }
    }

    async isCurrent(): Promise<boolean> {
        const current = await RepositorySnapshotReader.capture(this.root, this.gitPath, this.identity.autoStaged, this.signal);
        return current.identity.id === this.identity.id && current.identity.indexFingerprint === this.identity.indexFingerprint;
    }

    relative(candidate: string): string {
        const relative = path.relative(this.root, path.resolve(this.root, candidate));
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Path escapes the repository: ${candidate}`);
        }
        return relative.split(path.sep).join('/');
    }

    entries(side: SnapshotSide = 'after', excludes: string[] = []): SnapshotEntry[] {
        return [...(side === 'before' ? this.before : this.after).values()]
            .filter(entry => !shouldExclude(entry.path, excludes)).map(entry => ({ ...entry }));
    }

    /** Batch object reads avoid launching one Git process per searched file. */
    async readBatch(entries: SnapshotEntry[]): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        const regular = entries.filter(entry => ['100644', '100755'].includes(entry.mode));
        for (const entry of regular) { const cached = this.cache.get(entry.oid); if (cached !== undefined) { result.set(entry.oid, cached); } }
        const ids = [...new Set(regular.filter(entry => !result.has(entry.oid)).map(entry => entry.oid))];
        if (!ids.length) { return result; }
        this.metrics.gitObjectCalls += 1;
        const sizes = (await snapshotGit(this.gitPath, this.root, ['cat-file', '--batch-check'], { input: ids.join('\n') + '\n', signal: this.signal })).toString().trim().split('\n');
        const readable = sizes.flatMap(line => {
            const [id, type, size] = line.split(' ');
            if (type === 'missing') { throw new Error(`Snapshot object is unavailable: ${id}`); }
            return type === 'blob' && Number(size) <= 2 * 1024 * 1024 ? [id] : [];
        });
        if (!readable.length) { return result; }
        this.metrics.gitObjectCalls += 1;
        const bytes = await snapshotGit(this.gitPath, this.root, ['cat-file', '--batch'], { input: readable.join('\n') + '\n', signal: this.signal });
        let cursor = 0;
        for (const expected of readable) {
            const newline = bytes.indexOf(10, cursor);
            const [id, type, size] = bytes.subarray(cursor, newline).toString().split(' ');
            if (newline < 0 || id !== expected || type !== 'blob' || !/^\d+$/.test(size)) { throw new Error('Invalid Git batch response.'); }
            const length = Number(size);
            this.metrics.blobBytes += length;
            const content = bytes.subarray(newline + 1, newline + 1 + length);
            cursor = newline + 2 + length;
            if (content.length !== length || bytes[cursor - 1] !== 10) { throw new Error('Incomplete Git batch response.'); }
            if (content.includes(0) || !isUtf8(content)) { continue; }
            const text = content.toString('utf8'); result.set(id, text);
            if (this.cacheBytes + length <= 32 * 1024 * 1024) { this.cache.set(id, text); this.cacheBytes += length; }
        }
        return result;
    }

    entry(candidate: string, side: SnapshotSide = 'after'): SnapshotEntry | undefined {
        const entry = (side === 'before' ? this.before : this.after).get(this.relative(candidate));
        return entry ? { ...entry } : undefined;
    }

    async read(candidate: string, side: SnapshotSide = 'after', excludes: string[] = []): Promise<string> {
        this.metrics.sourceReads += 1;
        this.signal?.throwIfAborted();
        const relative = this.relative(candidate);
        if (shouldExclude(relative, excludes)) { throw new Error(`Snapshot path is excluded: ${relative}`); }
        const entry = this.entry(relative, side);
        if (!entry) { throw new Error(`Snapshot path is unavailable (${side}): ${relative}`); }
        if (!['100644', '100755'].includes(entry.mode)) {
            throw new Error(`Snapshot entry is not regular text (${entry.mode}): ${relative}`);
        }
        const cached = this.cache.get(entry.oid);
        if (cached !== undefined) { return cached; }
        this.metrics.gitObjectCalls += 1;
        const bytes = await snapshotGit(this.gitPath, this.root, ['cat-file', 'blob', entry.oid], { signal: this.signal });
        this.metrics.blobBytes += bytes.length;
        if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) { throw new Error(`Snapshot entry is binary or exceeds 2 MiB: ${relative}`); }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (this.cacheBytes + bytes.length <= 32 * 1024 * 1024) { this.cache.set(entry.oid, text); this.cacheBytes += bytes.length; }
        return text;
    }

    async observe(candidate: string, startLine: number, maxLines: number, excludes: string[] = [], side: SnapshotSide = 'after', maxChars = 2000): Promise<SourceObservation> {
        if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(maxLines) || maxLines < 1) { throw new Error('Invalid snapshot line range.'); }
        const text = await this.read(candidate, side, excludes);
        const lines = text.split('\n');
        if (startLine > lines.length) { throw new Error('Snapshot start line is outside the source.'); }
        const endLine = Math.min(lines.length, startLine + Math.min(maxLines, 400) - 1);
        const body = lines.slice(startLine - 1, endLine).join('\n');
        const excerpt = body.slice(0, maxChars);
        return { snapshotId: this.identity.id, path: this.relative(candidate), side,
            blobOid: this.entry(candidate, side)!.oid, startLine, endLine, excerpt,
            contentHash: hashContent(excerpt), truncated: body.length > maxChars || endLine < lines.length, sourceType: 'text' };
    }
}
