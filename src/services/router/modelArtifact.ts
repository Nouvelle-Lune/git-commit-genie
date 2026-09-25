import { createDecipheriv, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ROUTER_ARTIFACT_BASE64, ROUTER_ARTIFACT_SHA256 } from './modelArtifact.generated';
import { deriveRouterArtifactKey } from './modelKey';

/**
 * Loads the encrypted Auto router artifact.
 *
 * The payload is `nonce(12) || AES-256-GCM ciphertext || tag(16)` over `gzip(JSON)`; the JSON holds
 * the exported random forest plus the calibration/decision table. Loading is fail-closed: a wrong
 * hash, a broken tag, malformed JSON or a payload whose shape does not match this loader all raise
 * `RouterArtifactError`, and `autoRouter.routeAutoGeneration` then declines to route rather than
 * running a model nobody vouched for.
 *
 * The schema checks below are deliberately the *load-bearing* subset — the things that silently
 * change predictions if they drift: forest/feature dimensions, the comparison and precision
 * semantics recorded in the file, and the presence of the operating point the router tunes against.
 */

const FORMAT = 'router-artifact-v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Coverage the shipped default routes at: top 30% of scores, which on the 678-case holdout bought
 * Direct precision 0.7264 (274 false Fast per 1000 routed) at an achieved coverage of 0.2965.
 *
 * The knob is coverage, not probability: the model has no high-confidence region (`pDirect` never
 * exceeds ~0.83), so a rule like "pDirect >= 0.9" would never fire. Raising the target trades Fast-lane
 * correctness for cost — 0.2 buys precision 0.8116, 0.3 buys 0.7264 — and the full curve lives in the
 * artifact's `productTable`; this constant must match `DEFAULT_COVERAGE_TARGET` in
 * `scripts/export_artifact_encrypted.py`, which writes the model card from the same table.
 */
export const DEFAULT_COVERAGE_TARGET = 0.3;

export class RouterArtifactError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'RouterArtifactError';
    }
}

export interface RfTree {
    feature: number[];
    threshold: number[];
    left: number[];
    right: number[];
    leafP1: number[];
}

export interface RfSemantics {
    comparisonOperator: string;
    featurePrecision: string;
    leftChildOnTrue: boolean;
    leafValueKind: string;
    normalisation: string;
    aggregation: string;
    missingValueBranch: null;
    thresholdPrecision: string;
    positiveClass: string;
}

export interface RfModel {
    format: string;
    producedBy: string;
    sourceModel: { path: string; sha256: string };
    semantics: RfSemantics;
    featureNames: string[];
    nEstimators: number;
    nClasses: number;
    trees: RfTree[];
}

/** One row of the decision table: a coverage target, the threshold that achieves it, and what it bought. */
export interface CoverageOperatingPoint {
    targetCoverage: number;
    achievedCoverage: number;
    threshold: number;
    directPrecision: number;
    directRecall: number;
    falseDirectPer1000: number;
}

export interface RouterCalibration {
    format: string;
    model: string;
    family: string;
    productTable: {
        note: string;
        coverageConstrainedPrecision: CoverageOperatingPoint[];
        precisionFloorCoverage: Record<string, number>;
    };
    diagnostics: Record<string, number>;
    scoreRange: Record<string, number>;
}

export interface RouterArtifact {
    format: string;
    model: RfModel;
    calibration: RouterCalibration;
    provenance: {
        modelSha256: string;
        calibrationSha256: string;
        producedBy: string;
        keyDerivation: string;
    };
}

/** sha256 of the encrypted artifact; pinned in the generated module and asserted by the tests. */
export const ARTIFACT_SHA256 = ROUTER_ARTIFACT_SHA256;

let cachedArtifact: RouterArtifact | undefined;
let cachedFailure: RouterArtifactError | undefined;

/**
 * Decrypts, verifies and validates the artifact. The result (or the failure) is cached: the router
 * runs on every commit and re-decrypting 200 kB to rediscover a broken bundle is pointless.
 */
export function loadRouterArtifact(): RouterArtifact {
    if (cachedArtifact) {
        return cachedArtifact;
    }
    if (cachedFailure) {
        throw cachedFailure;
    }
    try {
        cachedArtifact = loadRouterArtifactFrom(ROUTER_ARTIFACT_BASE64);
        return cachedArtifact;
    } catch (error) {
        cachedFailure = asArtifactError(error);
        throw cachedFailure;
    }
}

/**
 * The whole load path — hash, authenticated decryption, schema validation — without the cache.
 * Exported so the tests can drive a deliberately tampered or wrongly shaped payload through the real
 * verification instead of asserting that a mock was called. `expectedSha256` is overridable because
 * the hash and the GCM tag catch different tampering: a modified artifact whose hash was recomputed
 * still has to fail at the tag.
 */
export function loadRouterArtifactFrom(
    base64: string,
    expectedSha256: string = ROUTER_ARTIFACT_SHA256,
): RouterArtifact {
    try {
        return parseArtifact(verifyAndDecryptRouterArtifact(base64, expectedSha256));
    } catch (error) {
        throw asArtifactError(error);
    }
}

/** Test seam: forget the cached artifact so a tampered bundle can be exercised. */
export function resetRouterArtifactCache(): void {
    cachedArtifact = undefined;
    cachedFailure = undefined;
}

/**
 * The threshold for a coverage target.
 *
 * Thresholds are never invented here: the calibration table is the only source, and an unknown
 * target is an error rather than a silent fallback, because a made-up threshold (say 0.5) routes a
 * completely different share of traffic at a completely different precision.
 */
export function operatingPointFor(
    calibration: RouterCalibration,
    coverageTarget: number = DEFAULT_COVERAGE_TARGET,
): CoverageOperatingPoint {
    const rows = calibration.productTable.coverageConstrainedPrecision;
    const row = rows.find(candidate => Math.abs(candidate.targetCoverage - coverageTarget) < 1e-9);
    if (!row) {
        throw new RouterArtifactError(
            `router artifact has no operating point for coverage ${coverageTarget}; `
            + `available: ${rows.map(candidate => candidate.targetCoverage).join(', ')}`,
        );
    }
    return row;
}

/**
 * Mean of the per-tree class-1 leaf probabilities — the forest's own `pChain` (class 1 is Chain).
 *
 * `Math.fround` is not decoration: sklearn casts the design matrix to float32 before comparing
 * against the float64 thresholds, and skipping it moves predictions by up to 1.9e-4 (measured; see
 * `semanticsMeasurements` in the artifact).
 */
export function predictChainProbability(model: RfModel, features: ArrayLike<number>): number {
    const narrow = model.semantics.featurePrecision === 'float32';
    const inclusive = model.semantics.comparisonOperator === '<=';
    let total = 0;
    for (const tree of model.trees) {
        let node = 0;
        while (tree.left[node] >= 0) {
            const raw = features[tree.feature[node]];
            if (raw === undefined || !Number.isFinite(raw)) {
                throw new RouterArtifactError('router features must be dense and finite');
            }
            const value = narrow ? Math.fround(raw) : raw;
            const goLeft = inclusive
                ? value <= tree.threshold[node]
                : value < tree.threshold[node];
            node = goLeft ? tree.left[node] : tree.right[node];
        }
        total += tree.leafP1[node];
    }
    return total / model.trees.length;
}

/** `pDirect`, the quantity the coverage threshold is applied to. */
export function predictDirectProbability(model: RfModel, features: ArrayLike<number>): number {
    return 1 - predictChainProbability(model, features);
}

/** At or above the threshold routes to Fast; below it routes to Deep. */
export function routeDirect(probabilityDirect: number, threshold: number): boolean {
    return probabilityDirect >= threshold;
}

function asArtifactError(error: unknown): RouterArtifactError {
    return error instanceof RouterArtifactError
        ? error
        : new RouterArtifactError(`router artifact could not be loaded: ${messageOf(error)}`);
}

/**
 * Hash check + authenticated decryption of a base64 artifact, without validation or caching.
 */
export function verifyAndDecryptRouterArtifact(
    base64: string,
    expectedSha256: string = ROUTER_ARTIFACT_SHA256,
): unknown {
    const blob = Buffer.from(base64, 'base64');
    if (blob.length <= NONCE_BYTES + TAG_BYTES) {
        throw new RouterArtifactError('router artifact is too short to be a payload');
    }
    const digest = createHash('sha256').update(blob).digest('hex');
    if (digest !== expectedSha256) {
        throw new RouterArtifactError(
            `router artifact hash mismatch: expected ${expectedSha256}, got ${digest}`,
        );
    }

    const nonce = blob.subarray(0, NONCE_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const ciphertext = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', deriveRouterArtifactKey(), nonce);
    decipher.setAuthTag(tag);

    let compressed: Buffer;
    try {
        compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
        // The tag is the integrity guarantee: reaching here means the bytes are not the bytes we shipped.
        throw new RouterArtifactError('router artifact failed authentication; refusing to load a modified model');
    }

    try {
        return JSON.parse(gunzipSync(compressed).toString('utf8'));
    } catch (error) {
        throw new RouterArtifactError(`router artifact payload is not valid JSON: ${messageOf(error)}`);
    }
}

function parseArtifact(payload: unknown): RouterArtifact {
    if (!isRecord(payload) || payload.format !== FORMAT) {
        throw new RouterArtifactError(`unsupported router artifact format: ${String((payload as { format?: unknown })?.format)}`);
    }
    const model = payload.model as RfModel | undefined;
    const calibration = payload.calibration as RouterCalibration | undefined;
    if (!isRecord(model) || !isRecord(calibration)) {
        throw new RouterArtifactError('router artifact is missing its model or calibration section');
    }

    if (model.format !== 'router-rf-v1' || model.nClasses !== 2 || !Array.isArray(model.trees)) {
        throw new RouterArtifactError('router artifact does not contain a two-class random forest');
    }
    if (model.nEstimators !== model.trees.length || model.trees.length === 0) {
        throw new RouterArtifactError(
            `router artifact declares ${model.nEstimators} trees but ships ${model.trees.length}`,
        );
    }
    if (!Array.isArray(model.featureNames) || model.featureNames.length === 0) {
        throw new RouterArtifactError('router artifact has no feature names');
    }
    for (const [index, tree] of model.trees.entries()) {
        const width = tree.feature?.length;
        if (!width
            || tree.threshold?.length !== width
            || tree.left?.length !== width
            || tree.right?.length !== width
            || tree.leafP1?.length !== width) {
            throw new RouterArtifactError(`router artifact tree ${index} has inconsistent node arrays`);
        }
    }

    // Semantics are checked, not assumed: a future export that changes any of them must update this loader.
    const semantics = model.semantics;
    if (!isRecord(semantics)
        || semantics.comparisonOperator !== '<='
        || semantics.leftChildOnTrue !== true
        || semantics.featurePrecision !== 'float32'
        || semantics.leafValueKind !== 'normalisedLeafValues'
        || semantics.missingValueBranch !== null) {
        throw new RouterArtifactError('router artifact prediction semantics differ from this implementation');
    }

    if (!isRecord(calibration.productTable)
        || !Array.isArray(calibration.productTable.coverageConstrainedPrecision)) {
        throw new RouterArtifactError('router artifact has no coverage decision table');
    }
    operatingPointFor(calibration, DEFAULT_COVERAGE_TARGET);

    const provenance = payload.provenance;
    if (!isRecord(provenance) || typeof provenance.modelSha256 !== 'string') {
        throw new RouterArtifactError('router artifact has no provenance record');
    }

    return payload as unknown as RouterArtifact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
