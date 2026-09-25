import { fileKind } from './features79';

/**
 * Deterministic routing rules: changes that are decided without the model.
 *
 * The forest answers "would a one-pass message be as good as the deep pipeline?" for changes it was
 * trained on. Three classes are decided by inspection instead, because their diff carries nothing a
 * message writer can read: a binary/media asset, a dependency lockfile, a submodule pointer. They
 * short-circuit before the artifact is even loaded, so a rule hit routes `fast` even when the model
 * fails verification.
 *
 * Product surface: the decision reports `reason: 'rule'` and `rule: <name>` for callers, but those are
 * diagnostics. Users see the route alone ("This change uses Fast."), and the technical fields reach the
 * log only when `gitCommitGenie.ui.rawData.enabled` is on.
 *
 * Which classes qualify was measured, not guessed (`scripts/rule_impact.py`, 4314 labelled cases,
 * judge verdicts from the v6 blind pairwise protocol). The bar is the model's own Fast-lane
 * precision at the shipped operating point — 0.726 holdout at coverage 0.30 (0.812 at 0.20), and every
 * rejected class was re-measured when the coverage target moved. A rule's *flip precision* is the share
 * of `direct` verdicts among the cases it would move from deep to fast — the only cases it changes:
 *
 *   class                     flips   flip precision   disposition
 *   binary-asset-only             0          n/a        shipped  (nothing readable)
 *   lockfile-only                 0          n/a        shipped  (machine-generated)
 *   submodule-bump-only           0          n/a        shipped  (only a SHA)
 *   generated-artifact-only       1          0.0%       rejected (build output is still readable text:
 *                                                       react's vendored bundle went to the pipeline)
 *   no-content-lines              2          0.0%       rejected (renames need context: 0/2 direct)
 *   docs-only                    27        37.0%       rejected (the pipeline reads the code)
 *   ci-config-only                9        44.4%       rejected
 *   test-only                   262        46.9%       rejected (the pipeline reads the assertions)
 *   whitespace-only              41        48.8%       rejected
 *   deletion-only                12        50.0%       rejected
 *   version-bump-only             4        50.0%       rejected
 *   comment-only                181        53.6%       rejected
 *   single-line-source-edit     330        55.2%       rejected
 *
 * Shipping all of them would send 39.9% of changes to Fast at 66.9% precision instead of 21.7% at
 * 79.6% — a visible product regression, so the rejected classes stay rejected. The shipped three move
 * **no** labelled case at all (Fast stays 21.7% at 79.6%) and cover the classes the corpus never
 * contained: for those a rule is a stated product choice, not an evidence-backed one. `deterministicRules.ts` must stay bit-for-bit aligned with `scripts/rules.py`; the generated
 * fixture in `src/test/fixtures/ruleCases.ts` plus `ts/rule-parity.ts` prove it.
 *
 * Order is the evaluation order; the first hit wins.
 */

/** Extensions whose bytes are not text a message writer can read. `.svg` is here because exported
 * icons are assets, but a hand-edited SVG still has content lines, so it never triggers the rule. */
const MEDIA_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff', '.avif', '.heic',
    '.svg', '.pdf', '.psd', '.ai', '.eps', '.raw', '.cr2', '.nef',
    '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

const ARCHIVE_EXTS = new Set([
    '.zip', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.zst', '.7z', '.rar', '.jar', '.war', '.whl', '.egg',
    '.so', '.dll', '.dylib', '.a', '.o', '.obj', '.class', '.pyc', '.wasm', '.bin', '.exe', '.dmg',
    '.apk', '.ipa', '.deb', '.rpm', '.msi', '.pdb', '.lib', '.framework', '.xcframework',
]);

/** Sorted for deterministic reporting; membership is all that matters. */
const BINARY_EXTS = new Set([...MEDIA_EXTS, ...ARCHIVE_EXTS].sort());

export type AutoRouterRuleName =
    | 'binary-asset-only'
    | 'lockfile-only'
    | 'submodule-bump-only';

export interface AutoRouterRule {
    name: AutoRouterRuleName;
    /** Product-facing one-liner, also used as the log `reason`. */
    description: string;
}

export const AUTO_ROUTER_RULES: readonly AutoRouterRule[] = [
    { name: 'binary-asset-only', description: 'media/binary asset with no readable diff line' },
    { name: 'lockfile-only', description: 'dependency lockfile only' },
    { name: 'submodule-bump-only', description: 'submodule pointer moved' },
];

/** `(marker, text)` for every added/removed content line; `+++`/`---` headers are not content. */
export function contentLines(stagedDiff: string): Array<{ marker: '+' | '-'; text: string }> {
    const lines: Array<{ marker: '+' | '-'; text: string }> = [];
    for (const line of stagedDiff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) {
            continue;
        }
        if (line.startsWith('+')) {
            lines.push({ marker: '+', text: line.slice(1) });
        } else if (line.startsWith('-')) {
            lines.push({ marker: '-', text: line.slice(1) });
        }
    }
    return lines;
}

/**
 * False for a binary patch produced without `--binary` (the flags the extension uses), for a mode
 * change, for an empty-file add/delete and for a pure rename. A `GIT binary patch` *delta* can carry
 * payload lines that start with `+`/`-`; that only makes this return true and the rule stand down,
 * which is the conservative direction.
 */
export function hasContentLines(stagedDiff: string): boolean {
    return contentLines(stagedDiff).length > 0;
}

/** Returns the first matching rule, or `null` when the model should decide. */
export function applyDeterministicRules(
    stagedDiff: string,
    changedFiles: readonly string[],
): AutoRouterRuleName | null {
    if (changedFiles.length === 0) {
        return null;
    }
    if (binaryAssetOnly(stagedDiff, changedFiles)) {
        return 'binary-asset-only';
    }
    if (changedFiles.every(path => fileKind(path).isLock)) {
        return 'lockfile-only';
    }
    if (submoduleBumpOnly(stagedDiff, changedFiles)) {
        return 'submodule-bump-only';
    }
    return null;
}

function binaryAssetOnly(stagedDiff: string, changedFiles: readonly string[]): boolean {
    if (hasContentLines(stagedDiff)) {
        return false;
    }
    return changedFiles.every(path => BINARY_EXTS.has(fileKind(path).extension));
}

function submoduleBumpOnly(stagedDiff: string, changedFiles: readonly string[]): boolean {
    const blocks = stagedDiff.split(/(?=^diff --git )/m).filter(block => block.startsWith('diff --git'));
    if (blocks.length === 0 || blocks.length !== changedFiles.length) {
        return false;
    }
    return blocks.every(block => /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/m.test(block));
}
