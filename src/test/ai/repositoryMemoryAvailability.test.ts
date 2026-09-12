import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { hashContent, RepositorySnapshotReader, SnapshotEntry, SnapshotIdentity } from '../../services/git/repositorySnapshot';
import { assessMemoryAvailability } from '../../services/memory/availability';
import { HandbookEntry, InvestigationEpisode, MemorySupport } from '../../services/memory/types';

describe('repository memory availability', () => {
    it('reports available, needs-revalidation, unavailable, and historical-only locations', () => {
        // Verify navigation location reflects exact after-tree blob matches, missing entries, and entries without targets.
        const episode = makeEpisode(1);
        const support: MemorySupport = { episodeId: episode.id, observationIndex: 0, evidenceId: 'E1' };
        const matching = makeReader({ 'src/parser.ts': { path: 'src/parser.ts', mode: '100644', oid: '1'.repeat(40) } });
        const available = assessMemoryAvailability({ targetPaths: ['src/parser.ts'], supports: [support], retirement: null }, [episode], matching);
        assert.equal(available.snapshotId, matching.identity.id);
        assert.equal(available.location, 'available');
        assert.deepEqual(available.targets, [{ path: 'src/parser.ts', state: 'available' }]);

        const changed = assessMemoryAvailability({ targetPaths: ['src/parser.ts'], supports: [support], retirement: null }, [episode],
            makeReader({ 'src/parser.ts': { path: 'src/parser.ts', mode: '100644', oid: '2'.repeat(40) } }));
        assert.equal(changed.location, 'needs_revalidation');
        assert.equal(changed.targets[0].state, 'needs_revalidation');

        const unavailable = assessMemoryAvailability({ targetPaths: ['src/parser.ts'], supports: [support], retirement: null }, [episode], makeReader());
        assert.equal(unavailable.location, 'unavailable');
        assert.equal(unavailable.targets[0].state, 'unavailable');

        const historicalOnly = assessMemoryAvailability({ targetPaths: [], supports: [support], retirement: null }, [episode], matching);
        assert.equal(historicalOnly.location, 'historical_only');
        assert.deepEqual(historicalOnly.targets, []);
    });

    it('marks a retirement retired only when all counterevidence sources from one episode match', () => {
        // Verify contextual retirement requires one coherent historical counterevidence investigation to match the current after tree.
        const coherent = makeEpisode(1, [
            { path: 'src/parser.ts', oid: '1'.repeat(40) },
            { path: 'src/parserHelpers.ts', oid: '1'.repeat(40) },
        ]);
        const other = makeEpisode(2);
        const retirement = makeRetirement([coherent, other], [
            { episodeId: coherent.id, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 },
            { episodeId: coherent.id, observationIndex: 0, evidenceId: 'E2', questionIndex: 0, claimIndex: 1 },
            { episodeId: other.id, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 },
        ]);
        const exact = assessMemoryAvailability({ targetPaths: ['src/parser.ts'], supports: [], retirement }, [coherent, other], makeReader({
            'src/parser.ts': { path: 'src/parser.ts', mode: '100644', oid: '1'.repeat(40) },
            'src/parserHelpers.ts': { path: 'src/parserHelpers.ts', mode: '100644', oid: '1'.repeat(40) },
        }));
        assert.equal(exact.experience, 'retired');
        assert.equal(exact.retirement?.reason, retirement.reason);
        assert.equal(exact.retirement?.replacementEntryId, null);

        const oneSourceChanged = assessMemoryAvailability({ targetPaths: ['src/parser.ts'], supports: [], retirement }, [coherent, other], makeReader({
            'src/parser.ts': { path: 'src/parser.ts', mode: '100644', oid: '1'.repeat(40) },
            'src/parserHelpers.ts': { path: 'src/parserHelpers.ts', mode: '100644', oid: '2'.repeat(40) },
        }));
        assert.equal(oneSourceChanged.experience, 'retired');

        const allCounterevidenceChanged = assessMemoryAvailability({ targetPaths: ['src/parser.ts'], supports: [], retirement }, [coherent, other], makeReader({
            'src/parser.ts': { path: 'src/parser.ts', mode: '100644', oid: '2'.repeat(40) },
            'src/parserHelpers.ts': { path: 'src/parserHelpers.ts', mode: '100644', oid: '2'.repeat(40) },
        }));
        assert.equal(allCounterevidenceChanged.experience, 'retirement_unmatched');
    });
});

function makeRetirement(episodes: InvestigationEpisode[], supports: MemorySupport[]): NonNullable<HandbookEntry['retirement']> {
    return { reason: 'The historical route is invalidated by current source evidence.', supports, snapshotCount: new Set(episodes.map(episode => episode.snapshot.id)).size, replacementEntryId: null };
}

function makeEpisode(index: number, sources: Array<{ path: string; oid: string }> = [{ path: 'src/parser.ts', oid: '1'.repeat(40) }]): InvestigationEpisode {
    const snapshot = makeIdentity(String(index).repeat(64));
    const evidence = sources.map((item, sourceIndex) => ({ id: `E${sourceIndex + 1}`, source: {
        snapshotId: snapshot.id, path: item.path, side: 'after' as const, blobOid: item.oid,
        startLine: 1, endLine: 1, excerpt: `function parse${sourceIndex}() { return true; }`,
        contentHash: hashContent(`function parse${sourceIndex}() { return true; }`), truncated: false, sourceType: 'text' as const,
    } }));
    return {
        version: 3,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        createdAt: index,
        snapshot,
        changedPaths: sources.map(item => item.path),
        questions: ['Which current source should be checked?'],
        observations: [{ step: 0, tool: 'readFileContent', arguments: { filePath: sources[0].path, reason: 'Check current source.' }, ok: true,
            summary: 'Read the historical source.', evidence, durationMs: 1, truncated: false }],
        claims: evidence.map(item => ({ claim: `The source ${item.source.path} was inspected.`, evidenceRefs: [item.id], disposition: 'must_express' as const })),
        status: 'complete', model: 'availability-test', promptVersion: 'memory-experience-1', toolsetVersion: 'snapshot-memory-experience-1',
    };
}

function makeIdentity(id: string): SnapshotIdentity {
    return { id, repositoryId: 'a'.repeat(64), worktreeId: 'b'.repeat(64), head: 'c'.repeat(40), beforeTree: 'd'.repeat(40),
        afterTree: 'e'.repeat(40), indexFingerprint: 'f'.repeat(64), autoStaged: false };
}

function makeReader(entries: Record<string, SnapshotEntry> = {}): RepositorySnapshotReader {
    const identity = makeIdentity('9'.repeat(64));
    return {
        identity,
        entry: (candidate: string, side: 'before' | 'after' = 'after') => side === 'after' ? entries[candidate] : undefined,
        read: async () => '',
        observe: async () => { throw new Error('Availability tests must not expand source observations.'); },
    } as unknown as RepositorySnapshotReader;
}
