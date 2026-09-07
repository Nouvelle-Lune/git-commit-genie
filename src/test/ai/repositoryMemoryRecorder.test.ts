import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { hashContent, SnapshotIdentity, SourceObservation } from '../../services/git/repositorySnapshot';
import {
    EpisodeRecorder,
    isEligibleEpisode,
    validateEpisodeSources,
} from '../../services/memory/recorder';
import {
    InvestigationEpisode,
    RecordedObservation,
    sourceObservationSchema,
} from '../../services/memory/types';

describe('EpisodeRecorder', () => {
    it('seals detached observations bound to the same snapshot and valid excerpt hashes', () => {
        const snapshot = makeSnapshot();
        const recorder = new EpisodeRecorder(snapshot, 'test-model');
        const observation = makeObservation(snapshot);
        recorder.record(observation);

        observation.summary = 'mutated after recording';
        observation.evidence[0].source.excerpt = 'mutated after recording';

        const episode = recorder.seal(makeSealInput());

        assert.deepEqual(episode.snapshot, snapshot);
        assert.equal(episode.model, 'test-model');
        assert.equal(episode.promptVersion, 'memory-2');
        assert.equal(episode.toolsetVersion, 'snapshot-memory-handles-3');
        assert.equal(episode.observations[0].summary, 'read source');
        assert.equal(episode.observations[0].evidence[0].source.excerpt, 'const value = 1;');
        assert.equal(episode.observations[0].evidence[0].source.contentHash, hashContent('const value = 1;'));
        assert.equal(episode.claims[0].evidenceRefs[0], 'E1');
    });

    it('rejects evidence from another snapshot or with a mismatched content hash', () => {
        const snapshot = makeSnapshot();
        const recorder = new EpisodeRecorder(snapshot, 'test-model');
        const foreign = makeObservation(makeSnapshot({ id: 'f'.repeat(64) }));
        recorder.record(foreign);
        assert.throws(() => recorder.seal(makeSealInput()), /not bound to its recorded snapshot/);

        const hashMismatchRecorder = new EpisodeRecorder(snapshot, 'test-model');
        const hashMismatch = makeObservation(snapshot);
        hashMismatch.evidence[0].source.contentHash = hashContent('different excerpt');
        hashMismatchRecorder.record(hashMismatch);
        assert.throws(() => hashMismatchRecorder.seal(makeSealInput()), /not bound to its recorded snapshot/);
    });

    it('rejects duplicate evidence IDs and claims that reference an unobserved E id', () => {
        const snapshot = makeSnapshot();
        const duplicateRecorder = new EpisodeRecorder(snapshot, 'test-model');
        duplicateRecorder.record(makeObservation(snapshot));
        duplicateRecorder.record({ ...makeObservation(snapshot), step: 1 });
        assert.throws(() => duplicateRecorder.seal(makeSealInput()), /Duplicate episode evidence: E1/);

        const missingReferenceRecorder = new EpisodeRecorder(snapshot, 'test-model');
        missingReferenceRecorder.record(makeObservation(snapshot));
        assert.throws(
            () => missingReferenceRecorder.seal(makeSealInput(['E99'])),
            /unobserved source/,
        );
    });

    it('enforces source and episode schema boundaries before validation', () => {
        const snapshot = makeSnapshot();
        const invalidPath = makeSource(snapshot, { path: '../outside.ts' });
        assert.equal(sourceObservationSchema.safeParse(invalidPath).success, false);

        const invalidRange = makeSource(snapshot, { startLine: 3, endLine: 2 });
        assert.equal(sourceObservationSchema.safeParse(invalidRange).success, false);

        const recorder = new EpisodeRecorder(snapshot, 'test-model');
        const invalidObservation = makeObservation(snapshot);
        invalidObservation.step = -1;
        recorder.record(invalidObservation);
        assert.throws(() => recorder.seal(makeSealInput()), /too_small|positive|nonnegative/i);
    });

    it('classifies only complete episodes with non-memory successful evidence as eligible', () => {
        const snapshot = makeSnapshot();
        const completeRecorder = new EpisodeRecorder(snapshot, 'test-model');
        completeRecorder.record(makeObservation(snapshot));
        const complete = completeRecorder.seal(makeSealInput());
        assert.equal(isEligibleEpisode(complete), true);

        const memoryRecorder = new EpisodeRecorder(snapshot, 'test-model');
        memoryRecorder.record(makeObservation(snapshot, { tool: 'readMemorySources' }));
        const memoryOnly = memoryRecorder.seal(makeSealInput());
        assert.equal(isEligibleEpisode(memoryOnly), false);

        const errorRecorder = new EpisodeRecorder(snapshot, 'test-model');
        errorRecorder.record(makeObservation(snapshot));
        const errored = errorRecorder.seal(makeSealInput([], 'error'));
        assert.equal(isEligibleEpisode(errored), false);
    });

    it('validates already sealed episodes when called directly', () => {
        const snapshot = makeSnapshot();
        const recorder = new EpisodeRecorder(snapshot, 'test-model');
        recorder.record(makeObservation(snapshot));
        const episode = recorder.seal(makeSealInput());
        assert.doesNotThrow(() => validateEpisodeSources(episode));

        const tampered = structuredClone(episode);
        tampered.claims[0].evidenceRefs = ['E2'];
        assert.throws(() => validateEpisodeSources(tampered), /unobserved source/);
    });
});

function makeSnapshot(overrides: Partial<SnapshotIdentity> = {}): SnapshotIdentity {
    return {
        id: 'a'.repeat(64),
        repositoryId: 'b'.repeat(64),
        worktreeId: 'c'.repeat(64),
        head: 'd'.repeat(40),
        beforeTree: 'e'.repeat(40),
        afterTree: 'f'.repeat(40),
        indexFingerprint: '0'.repeat(64),
        autoStaged: false,
        ...overrides,
    };
}

function makeSource(snapshot: SnapshotIdentity, overrides: Partial<SourceObservation> = {}): SourceObservation {
    const source: SourceObservation = {
        snapshotId: snapshot.id,
        path: 'src/parser.ts',
        side: 'after',
        blobOid: '1'.repeat(40),
        startLine: 1,
        endLine: 1,
        excerpt: 'const value = 1;',
        contentHash: hashContent('const value = 1;'),
        truncated: false,
        sourceType: 'text',
        ...overrides,
    };
    return source;
}

function makeObservation(snapshot: SnapshotIdentity, overrides: Partial<RecordedObservation> = {}): RecordedObservation {
    return {
        step: 0,
        tool: 'readFileContent',
        arguments: { filePath: 'src/parser.ts', startLine: 1, maxLines: 1 },
        ok: true,
        summary: 'read source',
        evidence: [{ id: 'E1', source: makeSource(snapshot) }],
        durationMs: 1,
        truncated: false,
        ...overrides,
    };
}

function makeSealInput(
    evidenceRefs: string[] = ['E1'],
    status: InvestigationEpisode['status'] = 'complete',
): Pick<InvestigationEpisode, 'changedPaths' | 'changedSymbols' | 'questions' | 'claims' | 'status'> {
    return {
        changedPaths: ['src/parser.ts'],
        changedSymbols: ['parse'],
        questions: ['How does parsing change?'],
        claims: [{ claim: 'Parsing uses the updated value.', evidenceRefs, disposition: 'must_express' }],
        status,
    };
}
