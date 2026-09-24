import { strict as assert } from 'assert';
import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { describe, it } from 'mocha';
import { buildStagedDiff, routeAutoGeneration, scoreDirectProbability } from '../../services/router/autoRouter';
import {
    ARTIFACT_SHA256,
    DEFAULT_COVERAGE_TARGET,
    loadRouterArtifact,
    loadRouterArtifactFrom,
    operatingPointFor,
    resetRouterArtifactCache,
    RouterArtifactError,
    verifyAndDecryptRouterArtifact,
} from '../../services/router/modelArtifact';
import { ROUTER_ARTIFACT_BASE64, ROUTER_ARTIFACT_SHA256 } from '../../services/router/modelArtifact.generated';
import { deriveRouterArtifactKey } from '../../services/router/modelKey';
import type { DiffData, DiffStatus } from '../../services/git/gitTypes';

const ARTIFACT_PATH = resolve(__dirname, '../../../resources/models/router/rf-79-router.enc');
const THRESHOLD_AT_DEFAULT_COVERAGE = 0.6219035253036144;

describe('Auto generation router', () => {
    it('loads an authenticated forest whose coverage table holds the shipped operating point', () => {
        // The artifact must be a 400-tree two-class forest over 79 named features, and the threshold
        // the router uses has to be the one the calibration table records for the default coverage.
        const artifact = loadRouterArtifact();
        const operatingPoint = operatingPointFor(artifact.calibration, DEFAULT_COVERAGE_TARGET);

        assert.equal(artifact.format, 'router-artifact-v1');
        assert.equal(artifact.model.format, 'router-rf-v1');
        assert.equal(artifact.model.nEstimators, 400);
        assert.equal(artifact.model.trees.length, 400);
        assert.equal(artifact.model.nClasses, 2);
        assert.equal(artifact.model.featureNames.length, 79);
        assert.equal(new Set(artifact.model.featureNames).size, 79);

        // Semantics carried in the file are the ones this implementation applies.
        assert.equal(artifact.model.semantics.comparisonOperator, '<=');
        assert.equal(artifact.model.semantics.leftChildOnTrue, true);
        assert.equal(artifact.model.semantics.featurePrecision, 'float32');
        assert.equal(artifact.model.semantics.missingValueBranch, null);

        assert.equal(DEFAULT_COVERAGE_TARGET, 0.2);
        assert.equal(operatingPoint.targetCoverage, 0.2);
        assert.equal(operatingPoint.threshold, THRESHOLD_AT_DEFAULT_COVERAGE);
        assert.ok(operatingPoint.threshold > 0 && operatingPoint.threshold < 1);
        assert.ok(operatingPoint.directPrecision > 0.7, `holdout Direct precision ${operatingPoint.directPrecision}`);
        assert.ok(Math.abs(operatingPoint.achievedCoverage - 0.2035) < 0.005);
        assert.ok(artifact.provenance.modelSha256.length === 64);
    });

    it('ships the same bytes in the bundle, in the resource file and under the pinned hash', () => {
        // Two copies exist on purpose (embedded base64 for synchronous bundling, .enc for audit); this
        // test is what makes them provably identical instead of merely intended to be.
        const onDisk = readFileSync(ARTIFACT_PATH);
        const embedded = Buffer.from(ROUTER_ARTIFACT_BASE64, 'base64');
        assert.equal(createHash('sha256').update(onDisk).digest('hex'), ARTIFACT_SHA256);
        assert.equal(createHash('sha256').update(embedded).digest('hex'), ARTIFACT_SHA256);
        assert.equal(ROUTER_ARTIFACT_SHA256, ARTIFACT_SHA256);
        assert.ok(onDisk.length > 100_000 && onDisk.length < 512 * 1024, `artifact is ${onDisk.length} bytes`);
        assert.ok(statSync(ARTIFACT_PATH).size === onDisk.length);
    });

    it('rejects a modified artifact at the hash and, with the hash fixed, at the GCM tag', () => {
        // The hash catches edits that leave the pinned constant alone; the authentication tag catches a
        // payload whose hash was recomputed. Both must be hard failures, never a silent degraded model.
        const flip = (index: number): string => {
            const buffer = Buffer.from(ROUTER_ARTIFACT_BASE64, 'base64');
            buffer[index] ^= 0x01;
            return buffer.toString('base64');
        };
        const ciphertextTamper = flip(100_000);
        assert.throws(
            () => verifyAndDecryptRouterArtifact(ciphertextTamper),
            (error: Error) => error instanceof RouterArtifactError && /hash mismatch/.test(error.message),
        );

        const tagTamper = flip(Buffer.from(ROUTER_ARTIFACT_BASE64, 'base64').length - 1);
        assert.throws(
            () => verifyAndDecryptRouterArtifact(tagTamper, sha256Of(tagTamper)),
            (error: Error) => error instanceof RouterArtifactError && /failed authentication/.test(error.message),
        );

        const nonceTamper = flip(0);
        assert.throws(
            () => verifyAndDecryptRouterArtifact(nonceTamper, sha256Of(nonceTamper)),
            (error: Error) => error instanceof RouterArtifactError && /failed authentication/.test(error.message),
        );

        const truncated = Buffer.from(ROUTER_ARTIFACT_BASE64, 'base64').subarray(0, 4_096).toString('base64');
        assert.throws(() => verifyAndDecryptRouterArtifact(truncated, sha256Of(truncated)), RouterArtifactError);

        assert.throws(() => verifyAndDecryptRouterArtifact('not base64 at all!!'), RouterArtifactError);
    });

    it('refuses payloads that decrypt but do not match the router contract', () => {
        // A correctly authenticated payload can still be the wrong artifact: an unknown format, a forest
        // with inconsistent node arrays, or a calibration table without the shipped coverage target.
        const sealed = (payload: unknown): string => {
            const nonce = Buffer.alloc(12, 7);
            const cipher = createCipheriv('aes-256-gcm', deriveRouterArtifactKey(), nonce);
            const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))), cipher.final()]);
            return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
        };
        const expectRejection = (payload: unknown, pattern: RegExp): void => {
            const base64 = sealed(payload);
            // `loadRouterArtifactFrom` is the full load path, so this exercises the schema checks and not
            // just the decryption: a correctly authenticated payload can still be the wrong artifact.
            assert.throws(
                () => loadRouterArtifactFrom(base64, sha256Of(base64)),
                (error: Error) => error instanceof RouterArtifactError && pattern.test(error.message),
            );
        };

        expectRejection({ format: 'router-artifact-v2' }, /unsupported router artifact format/);
        expectRejection({ format: 'router-artifact-v1', model: { format: 'router-rf-v1' } }, /missing its model or calibration section/);
        expectRejection({
            format: 'router-artifact-v1',
            model: {
                format: 'router-rf-v1',
                nClasses: 2,
                nEstimators: 1,
                featureNames: ['a'],
                semantics: artifactSemantics(),
                trees: [{ feature: [0], threshold: [1], left: [-1] }],
            },
            calibration: calibrationStub(),
        }, /inconsistent node arrays/);
        expectRejection({
            format: 'router-artifact-v1',
            model: {
                format: 'router-rf-v1',
                nClasses: 2,
                nEstimators: 1,
                featureNames: ['a'],
                semantics: artifactSemantics(),
                trees: [{ feature: [-2], threshold: [-2], left: [-1], right: [-1], leafP1: [0.5] }],
            },
            calibration: calibrationStub(),
        }, /no operating point for coverage 0.2/);
        expectRejection({
            format: 'router-artifact-v1',
            model: {
                format: 'router-rf-v1',
                nClasses: 2,
                nEstimators: 1,
                featureNames: ['a'],
                semantics: { ...artifactSemantics(), featurePrecision: 'float64' },
                trees: [{ feature: [-2], threshold: [-2], left: [-1], right: [-1], leafP1: [0.5] }],
            },
            calibration: calibrationStub(),
        }, /semantics differ from this implementation/);
    });

    it('routes representative diffs to the Fast and Deep routes with the calibrated threshold', () => {
        // Probabilities are the extension's own output for these inputs, guarded to 1e-12 so a feature or
        // forest regression cannot pass unnoticed; the reference values come from the Python pipeline.
        const deepDecision = routeAutoGeneration([makeDiff(DEEP_DIFF)]);
        assert.ok(Math.abs((deepDecision.probabilityDirect ?? 0) - 0.4737819892150832) < 1e-12);
        assert.equal(deepDecision.route, 'deep');
        assert.equal(deepDecision.directThreshold, THRESHOLD_AT_DEFAULT_COVERAGE);
        assert.equal(deepDecision.coverageTarget, 0.2);
        assert.equal(deepDecision.artifactSha256, ARTIFACT_SHA256);
        assert.equal(deepDecision.failure, undefined);

        const fastDecision = routeAutoGeneration([makeDiff(FAST_DIFF)]);
        assert.ok(Math.abs((fastDecision.probabilityDirect ?? 0) - 0.6563285346750021) < 1e-12);
        assert.equal(fastDecision.route, 'fast');
        assert.ok(fastDecision.probabilityDirect! >= fastDecision.directThreshold!);
        assert.ok(deepDecision.probabilityDirect! < deepDecision.directThreshold!);

        // The exported scoring seam and the decision path must not drift apart. The seam takes the
        // rebuilt staged diff, which is the diff terminated by one newline.
        const stagedDiff = buildStagedDiff([makeDiff(FAST_DIFF)]);
        assert.equal(stagedDiff, `${FAST_DIFF}\n`);
        assert.equal(
            scoreDirectProbability(stagedDiff, ['src/service.ts']),
            fastDecision.probabilityDirect,
        );
    });

    it('declines to route and falls back to Deep when there is nothing to score', () => {
        // Fail-closed: no content or no changed files means the Deep route with the reason attached, never a
        // default probability that pretends to be a decision.
        const empty = routeAutoGeneration([]);
        assert.equal(empty.route, 'deep');
        assert.equal(empty.probabilityDirect, null);
        assert.equal(empty.directThreshold, null);
        assert.match(empty.failure ?? '', /no diff content to route/);

        const blankBlock = routeAutoGeneration([makeDiff('', { fileName: 'src/service.ts' })]);
        assert.equal(blankBlock.route, 'deep');
        assert.equal(blankBlock.probabilityDirect, null);
        assert.match(blankBlock.failure ?? '', /no diff content to route|no changed files to route/);
    });

    it('takes its input from the diff text and the changed paths only', () => {
        // `status` and parsed hunks are diagnostics: they must not move the score, because the model was
        // trained on the staged diff text plus the file list and nothing else.
        const baseline = routeAutoGeneration([makeDiff(DEEP_DIFF, { fileName: 'src/service.ts' })]);
        const variants: DiffStatus[] = ['deleted', 'renamed', 'untracked', 'added'];
        for (const status of variants) {
            const decision = routeAutoGeneration([makeDiff(DEEP_DIFF, { status, hunkCount: 12 })]);
            assert.equal(decision.probabilityDirect, baseline.probabilityDirect, `status ${status} changed the score`);
            assert.equal(decision.route, baseline.route);
        }

        // A differently named file is a different input (path shape features), so it is allowed to move.
        const renamedPath = routeAutoGeneration([makeDiff(DEEP_DIFF, { fileName: 'docs/guide.md' })]);
        assert.notEqual(renamedPath.probabilityDirect, null);
    });

    it('rebuilds the staged diff from per-file blocks without losing a line', () => {
        // The training input was one `git diff --cached` string; these blocks mirror what the extension's
        // splitter hands over: no trailing terminator, except that a block ending in a blank line (every
        // binary patch) ends in a single newline that is content.
        const normal = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a();\n+a2();';
        const binary = 'diff --git a/img.png b/img.png\nnew file mode 100644\nliteral 0\nHcmV?d00001\n';
        const last = 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -3,1 +3,1 @@\n-return 1;\n+return 2;\n';

        assert.equal(
            buildStagedDiff([makeDiff(normal), makeDiff(binary), makeDiff(last)]),
            `${normal}\n${binary}\n${last}`,
        );
        assert.equal(buildStagedDiff([makeDiff('')]), '');
        assert.equal(buildStagedDiff([]), '');
    });

    it('keeps one representative large input below the three-second routing budget', () => {
        // The synchronous local inference path must remain below three seconds on a substantially larger diff.
        const lines = Array.from({ length: 4000 }, (_, index) => `+const value${index} = "内容 ${index}";`);
        const largeDiff = [
            'diff --git a/src/large.ts b/src/large.ts',
            '--- a/src/large.ts',
            '+++ b/src/large.ts',
            '@@ -1,1 +1,4000 @@',
            ...lines,
        ].join('\n');
        const startedAt = process.hrtime.bigint();
        const decision = routeAutoGeneration([makeDiff(largeDiff, { fileName: 'src/large.ts' })]);
        const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        assert.ok(Number.isFinite(decision.probabilityDirect));
        assert.ok(elapsedMilliseconds < 3000, `large decision took ${elapsedMilliseconds.toFixed(2)}ms`);
    });
});

interface DiffOptions {
    fileName?: string;
    status?: DiffStatus;
    hunkCount?: number;
}

function makeDiff(rawDiff: string, options: DiffOptions = {}): DiffData {
    const hunkCount = options.hunkCount ?? 1;
    return {
        fileName: options.fileName ?? 'src/service.ts',
        status: options.status ?? 'modified',
        diffHunks: Array.from({ length: hunkCount }, (_, index) => ({
            header: `@@ -${index + 1},1 +${index + 1},1 @@`,
            content: '',
            additions: [],
            deletions: [],
        })),
        rawDiff,
    };
}

function sha256Of(base64: string): string {
    return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

function artifactSemantics(): Record<string, unknown> {
    return {
        comparisonOperator: '<=',
        featurePrecision: 'float32',
        leftChildOnTrue: true,
        leafValueKind: 'normalisedLeafValues',
        normalisation: 'leaf value = P(class 1) after normalising the node class counts',
        aggregation: 'unweighted mean of per-tree class-1 leaf probabilities',
        missingValueBranch: null,
        thresholdPrecision: 'float64',
        positiveClass: '1 = Chain wins; pDirect = 1 - pChain',
    };
}

function calibrationStub(): Record<string, unknown> {
    return { format: 'router-calibration-v1', productTable: { coverageConstrainedPrecision: [] } };
}

// Referenced so the reset seam is exercised in the suite that owns artifact caching.
resetRouterArtifactCache();

const DEEP_DIFF = [
    'diff --git a/src/service.ts b/src/service.ts',
    'index 1111111..2222222 100644',
    '--- a/src/service.ts',
    '+++ b/src/service.ts',
    '@@ -1,2 +1,2 @@',
    '-const value = 1;',
    '+const value = 2;',
].join('\n');

const FAST_DIFF = [
    'diff --git a/src/service.ts b/src/service.ts',
    '--- /dev/null',
    '+++ b/src/service.ts',
    '@@ -0,0 +1,3 @@',
    "+import { strict as assert } from 'assert';",
    '+assert.equal(1 + 1, 2);',
].join('\n');
