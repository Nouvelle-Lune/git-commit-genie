import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { hashContent, SnapshotIdentity } from '../../services/git/repositorySnapshot';
import { MemoryStore } from '../../services/memory/store';
import { MEMORY_DEFAULTS, MemorySettings, resolveMemorySettings } from '../../services/memory/settings';
import { InvestigationEpisode } from '../../services/memory/types';

describe('repository memory settings', function () {
    this.timeout(20_000);

    it('resolves all operational defaults from the memory configuration section and freezes the result', () => {
        const requested: string[] = [];
        const resolved = resolveMemorySettings({
            get<T>(key: string, defaultValue: T): T {
                requested.push(key);
                return defaultValue;
            },
        });

        assert.deepEqual(resolved, MEMORY_DEFAULTS);
        assert.deepEqual(requested.sort(), Object.keys(MEMORY_DEFAULTS).sort());
        assert.equal(Object.isFrozen(resolved), true);
    });

    it('accepts zero search calls while rejecting non-positive, fractional, non-finite, and out-of-range settings', () => {
        const zeroSearch = resolveMemorySettings(configWith({ 'search.maxCalls': 0 }));
        assert.equal(zeroSearch['search.maxCalls'], 0);

        const invalid: Array<[keyof MemorySettings, number]> = [
            ['navigation.maxTokens', 0],
            ['navigation.maxInputPercent', 101],
            ['search.maxCalls', -1],
            ['sources.maxChunks', Number.NaN],
            ['sources.timeoutMs', 2_147_483_648],
            ['sources.maxResultTokens', 1.5],
            ['consolidation.maxInputTokens', Number.POSITIVE_INFINITY],
            ['consolidation.maxOutputTokens', 0],
            ['consolidation.maxCallsPer24h', 0],
            ['maxStorageMiB', 0],
            ['storage.maxEpisodes', -1],
            ['storage.maxEpisodeKiB', 1.5],
            ['storage.maxManifestMiB', 0],
        ];

        for (const [key, value] of invalid) {
            assert.throws(
                () => resolveMemorySettings(configWith({ [key]: value })),
                new RegExp(`Invalid gitCommitGenie\\.memory\\.${key.replace('.', '\\.')}`),
                key,
            );
        }
    });

    it('refreshes storage quotas for each operation and reads existing episodes after a quota reduction', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'a'.repeat(64);
            let settings = makeSettings({ 'storage.maxEpisodes': 1, 'storage.maxEpisodeKiB': 64 });
            const store = new MemoryStore(storageRoot, repositoryId, () => settings);
            const first = makeEpisode(repositoryId, { summary: 'first' });
            await store.recordEpisode(first, await store.epoch());

            settings = makeSettings({ 'storage.maxEpisodes': 2, 'storage.maxEpisodeKiB': 64 });
            const second = makeEpisode(repositoryId, { summary: 'second' });
            await store.recordEpisode(second, await store.epoch());
            assert.deepEqual((await store.inspect()).episodes.map(item => item.id), [first.id, second.id]);

            settings = makeSettings({ 'storage.maxEpisodes': 1, 'storage.maxEpisodeKiB': 64 });
            assert.deepEqual((await store.inspect()).episodes.map(item => item.id), [first.id, second.id],
                'lowering the write quota does not make stored episodes unreadable or delete them immediately');
        });
    });

    it('applies the latest episode size quota to new writes without invalidating existing payloads', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'b'.repeat(64);
            let settings = makeSettings({ 'storage.maxEpisodeKiB': 64 });
            const store = new MemoryStore(storageRoot, repositoryId, () => settings);
            const large = makeEpisode(repositoryId, { summary: 'x'.repeat(4_000) });
            await store.recordEpisode(large, await store.epoch());

            settings = makeSettings({ 'storage.maxEpisodeKiB': 1 });
            assert.deepEqual((await store.inspect()).episodes.map(item => item.id), [large.id]);
            await assert.rejects(
                async () => store.recordEpisode(makeEpisode(repositoryId, { summary: 'y'.repeat(4_000) }), await store.epoch()),
                /Episode exceeds 1 KiB/,
            );
        });
    });
});

function configWith(overrides: Partial<MemorySettings>): { get<T>(key: string, defaultValue: T): T } {
    return {
        get<T>(key: string, defaultValue: T): T {
            return (key in overrides ? overrides[key as keyof MemorySettings] : defaultValue) as T;
        },
    };
}

function makeSettings(overrides: Partial<MemorySettings> = {}): MemorySettings {
    return Object.freeze({ ...MEMORY_DEFAULTS, ...overrides });
}

async function withTempStorage<T>(action: (storageRoot: string) => Promise<T>): Promise<T> {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-memory-settings-test-'));
    try {
        return await action(storageRoot);
    } finally {
        await fs.rm(storageRoot, { recursive: true, force: true });
    }
}

function makeEpisode(repositoryId: string, options: { summary: string }): InvestigationEpisode {
    const snapshot: SnapshotIdentity = {
        id: 'c'.repeat(64), repositoryId, worktreeId: 'd'.repeat(64), head: 'e'.repeat(40),
        beforeTree: 'f'.repeat(40), afterTree: '0'.repeat(40), indexFingerprint: '1'.repeat(64), autoStaged: false,
    };
    const excerpt = 'const value = 1;';
    return {
        version: 2,
        id: randomUUID(),
        createdAt: Date.now(),
        snapshot,
        changedPaths: ['src/settings.ts'],
        changedSymbols: ['value'],
        questions: ['How is the setting used?'],
        observations: [{
            step: 0,
            tool: 'readFileContent',
            arguments: { filePath: 'src/settings.ts' },
            ok: true,
            summary: options.summary,
            evidence: [{
                id: 'E1',
                source: {
                    snapshotId: snapshot.id,
                    path: 'src/settings.ts',
                    side: 'after',
                    blobOid: '2'.repeat(40),
                    startLine: 1,
                    endLine: 1,
                    excerpt,
                    contentHash: hashContent(excerpt),
                    truncated: false,
                    sourceType: 'text',
                },
            }],
            durationMs: 1,
            truncated: false,
        }],
        claims: [{ claim: 'The setting is read.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        status: 'complete',
        model: 'settings-test',
        promptVersion: 'memory-experience-1',
        toolsetVersion: 'snapshot-memory-experience-1',
    };
}
