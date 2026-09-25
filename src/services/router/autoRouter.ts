import type { DiffData } from '../git/gitTypes';
import { applyDeterministicRules, type AutoRouterRuleName } from './deterministicRules';
import { extractFeatures79, toFeatureVector } from './features79';
import {
    ARTIFACT_SHA256,
    DEFAULT_COVERAGE_TARGET,
    loadRouterArtifact,
    operatingPointFor,
    predictDirectProbability,
    routeDirect,
    RouterArtifactError,
} from './modelArtifact';

/**
 * Auto routing: a 400-tree random forest over 79 structural diff features decides between the
 * Fast route (one generation) and the Deep route (the multi-stage chain workflow).
 *
 * Everything here is a function of the staged diff and the changed file list — that is the whole
 * input space the model was trained on (`stagedDiff` + `changedFiles`), so the decision cannot see
 * commit messages, repository identity, file paths outside the diff, or anything produced after
 * generation.
 *
 * Three behaviours are deliberate:
 *
 * - **Deterministic rules run first** (`deterministicRules.ts`). When a change has no readable diff
 *   content at all — a screenshot, a lockfile, a build artifact, a submodule pointer — a rule routes
 *   it `fast` and the model is never consulted. Rule hits do not depend on the artifact, so they keep
 *   working even when the artifact fails verification; the rejection list and its measurements live
 *   in that module.
 *
 * - **The threshold comes from the artifact's coverage table.** `0.3` means "route the top ~30% of
 *   scores", which on the 678-case holdout buys Direct precision 0.7264. A precision floor chosen on
 *   training OOF does not transfer to new data, so the knob is expressed as coverage and the
 *   precision it bought is recorded in the table instead of promised.
 * - **Failures refuse to route.** A hash mismatch, a broken GCM tag, a truncated payload or an
 *   artifact whose semantics differ from this implementation all end in `route: 'deep'` with the
 *   reason attached; the caller logs it. Routing with a model that failed verification would be
 *   worse than not having a router.
 *
 * Naming: the two routes are the product's `Fast` (one generation) and `Deep` (multi-stage chain).
 * The training data and the model card call the same two things `Direct` and `Chain`, because that
 * is what the judged candidates were; the mapping is 1:1 and does not change any score.
 */

export type AutoRoute = 'fast' | 'deep';

export interface AutoRouterDecision {
    route: AutoRoute;
    /**
     * Which layer decided: a deterministic rule, the model's score versus the coverage threshold, or
     * the fail-closed path. `probabilityDirect`/`directThreshold` are only *used* when this is
     * `'model'`; on a rule hit they are `null` because the model was never consulted.
     */
    reason: 'rule' | 'model' | 'fallback';
    /** Set when `reason === 'rule'`. */
    rule?: AutoRouterRuleName;
    /** `null` when a rule decided, or when the artifact could not be loaded. */
    probabilityDirect: number | null;
    /** `null` when a rule decided, or when the artifact could not be loaded. */
    directThreshold: number | null;
    /** Coverage target the threshold was looked up for (route the top N% of scores). */
    coverageTarget: number;
    /** sha256 of the encrypted artifact that produced the decision; `null` on a rule hit or failure. */
    artifactSha256: string | null;
    /** Present only when the router declined to score and fell back to the Deep route. */
    failure?: string;
}

/** Routes a change with the exported RF-79 forest and the calibrated coverage threshold. */
export function routeAutoGeneration(diffs: readonly DiffData[]): AutoRouterDecision {
    const stagedDiff = buildStagedDiff(diffs);
    if (stagedDiff.length === 0) {
        return failureDecision('no diff content to route', false);
    }
    const changedFiles = changedFilesOf(diffs);
    if (changedFiles.length === 0) {
        return failureDecision('no changed files to route', false);
    }

    const rule = applyDeterministicRules(stagedDiff, changedFiles);
    if (rule) {
        return {
            route: 'fast',
            reason: 'rule',
            rule,
            probabilityDirect: null,
            directThreshold: null,
            coverageTarget: DEFAULT_COVERAGE_TARGET,
            artifactSha256: null,
        };
    }

    try {
        const artifact = loadRouterArtifact();
        const operatingPoint = operatingPointFor(artifact.calibration, DEFAULT_COVERAGE_TARGET);
        const probabilityDirect = scoreDirectProbability(stagedDiff, changedFiles);
        return {
            route: routeDirect(probabilityDirect, operatingPoint.threshold) ? 'fast' : 'deep',
            reason: 'model',
            probabilityDirect,
            directThreshold: operatingPoint.threshold,
            coverageTarget: operatingPoint.targetCoverage,
            artifactSha256: ARTIFACT_SHA256,
        };
    } catch (error) {
        const message = error instanceof RouterArtifactError
            ? error.message
            : `unexpected router failure: ${error instanceof Error ? error.message : String(error)}`;
        return failureDecision(message, false);
    }
}

/**
 * `pDirect` for one staged diff. Exported because the parity harness drives this exact function
 * against the Python reference rather than re-implementing the path.
 */
export function scoreDirectProbability(stagedDiff: string, changedFiles: readonly string[]): number {
    const artifact = loadRouterArtifact();
    const features = extractFeatures79(stagedDiff, changedFiles);
    const vector = toFeatureVector(artifact.model.featureNames, features);
    return predictDirectProbability(artifact.model, vector);
}

/**
 * Rebuilds the staged diff the model was trained on from per-file `DiffData` blocks.
 *
 * Training saw a single `git diff --cached` string: one `diff --git` block per file, concatenated
 * with no separator, LF-terminated. Per-file `rawDiff` values are slices of that same command, so
 * this reverses the split losslessly: join the blocks with one newline each and terminate once.
 *
 * The contract that makes this exact is how a `rawDiff` block relates to its terminator:
 *
 * - Every block **except the last** is a `lines.slice(start, end).join('\n')` of the original text
 *   (that is what `extractFileDiffFromFullDiff` returns), so it carries no terminator — and a block
 *   that ends in `\n` there ends in a **blank content line**, which is exactly how git hands over a
 *   binary patch (`literal 0` / payload / blank line). Stripping it would shift those diffs by one
 *   line; the fixture asserts the round trip block for block.
 * - The **last** block keeps its terminator (the split leaves the trailing empty element), so its
 *   final `\n` is removed here and re-added once at the end.
 *
 * CRLF is folded to LF because the model never saw CRLF: normalising keeps the input
 * in-distribution instead of feeding `\r` into line-shape features.
 */
export function buildStagedDiff(diffs: readonly DiffData[]): string {
    const blocks = diffs
        .map(diff => diff.rawDiff.replace(/\r\n?/gu, '\n').replace(/^\n+/u, ''))
        .filter(block => block.trim().length > 0);
    if (blocks.length === 0) {
        return '';
    }
    const last = blocks.length - 1;
    const normalised = blocks.map((block, index) => (
        index === last && block.endsWith('\n') ? block.slice(0, -1) : block
    ));
    return `${normalised.join('\n')}\n`;
}

function changedFilesOf(diffs: readonly DiffData[]): string[] {
    const seen = new Set<string>();
    const files: string[] = [];
    for (const diff of diffs) {
        if (diff.rawDiff.trim().length === 0 || seen.has(diff.fileName)) {
            continue;
        }
        seen.add(diff.fileName);
        files.push(diff.fileName);
    }
    return files;
}

function failureDecision(reason: string, artifactLoaded: boolean): AutoRouterDecision {
    return {
        route: 'deep',
        reason: 'fallback',
        probabilityDirect: null,
        directThreshold: null,
        coverageTarget: DEFAULT_COVERAGE_TARGET,
        artifactSha256: artifactLoaded ? ARTIFACT_SHA256 : null,
        failure: reason,
    };
}
