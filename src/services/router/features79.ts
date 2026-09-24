/**
 * The 79 structural features the shipped Auto Router model consumes.
 *
 * Direct port of the benchmark's `scripts/features.py` (41 features) and
 * `scripts/features_v2.py` (38 features). Every input is derived from the staged diff and
 * the changed file list — information a client has before either workflow runs. No
 * repository name, no absolute path, no candidate message, no post-generation telemetry.
 *
 * Fidelity notes (things a port gets wrong by "improving" them):
 *
 * - `changeClusters` mirrors the Python verbatim, including its redundant branch: both
 *   arms of `if hunk.file != previous: clusters += 1 else: clusters += 1` add one, so the
 *   value is always the number of hunks. Porting the *intent* instead of the code would
 *   change the feature the model was trained on.
 * - `statistics.fmean` / `statistics.pstdev` are reproduced with compensated summation
 *   (`fsum` semantics): the mean is `compensatedSum(xs) / n` and the population standard
 *   deviation is `sqrt(compensatedSum((x - mean)^2) / n)`.
 * - The regexes are translated literally, with two Python-vs-JS semantics pinned because they
 *   measurably change counts on real diffs: `len(str)` counts code points (not UTF-16 units),
 *   and Python's `\w`/`\d` are Unicode-aware while JS's are ASCII-only, so the number/version
 *   patterns use explicit `\p{L}\p{N}_` / `\p{Nd}` classes. Patterns that still use `\b`
 *   (keyword-ish counts such as `controlFlowLines`) keep JS's ASCII word boundary; on the
 *   225-case parity fixture that residual difference appears in 2 non-ASCII cases and flips no
 *   routing decision (see `ts/feature79-parity.json`).
 *
 * Parity is verified in the benchmark: `scripts/feature79_parity.py` scores reference
 * diffs with both implementations and requires the routing decision to agree exactly.
 */

export const FEATURE_NAMES_V1 = [
  'nFiles',
  'nDirs',
  'nTopDirs',
  'maxDepth',
  'meanDepth',
  'crossDirectory',
  'crossModule',
  'nExtensions',
  'filesPerDir',
  'diffChars',
  'diffLines',
  'additions',
  'deletions',
  'changedLines',
  'hunks',
  'meanHunkSize',
  'maxFileAdditions',
  'meanFileAdditions',
  'diffCharsPerFile',
  'additionRatio',
  'meanLineChars',
  'longDiffLines',
  'identifierTokens',
  'identifierDensity',
  'newFiles',
  'deletedFiles',
  'renames',
  'modeChanges',
  'binaryFiles',
  'nCodeFiles',
  'nTestFiles',
  'nDocFiles',
  'nConfigFiles',
  'nLockFiles',
  'hasTest',
  'hasCode',
  'hasDoc',
  'hasConfig',
  'hasLockfile',
  'testPlusCode',
  'codeExtensionCount',
] as const;

export const FEATURE_NAMES_V2 = [
  'hunksPerFile',
  'filesPerHunk',
  'meanHunkChangedLines',
  'maxHunkChangedLines',
  'maxHunkShare',
  'hunkSizeCV',
  'changeClusters',
  'clustersPerFile',
  'singleChangeRegion',
  'replacementRatio',
  'addDeleteBalance',
  'whitespaceOnlyLines',
  'formatOnlyHunkShare',
  'addedIndentDelta',
  'commentLines',
  'commentRatio',
  'stringLiteralLines',
  'numberLiteralLines',
  'versionLiteralLines',
  'importLines',
  'controlFlowLines',
  'errorHandlingLines',
  'loggingLines',
  'assertionLines',
  'signatureLines',
  'exportedSymbolLines',
  'callSiteLines',
  'renamedIdentifierRatio',
  'newIdentifierRatio',
  'touchedIdentifierDiversity',
  'crossFileIdentifierOverlap',
  'dominantExtensionRatio',
  'singleCodeLanguage',
  'allTestFiles',
  'allDocFiles',
  'allConfigFiles',
  'mixedTestAndSource',
  'sourceOnlyChange',
] as const;

// ------------------------------------------------------------------ patterns
const DIFF_HEADER = /^diff --git a\/(.*?) b\/(.*)$/;
const HUNK = /^@@ /;
const RENAME_FROM = /^rename from /;
const RENAME_TO = /^rename to /;
const NEW_FILE = /^new file mode /;
const DELETED_FILE = /^deleted file mode /;
const MODE_CHANGE = /^old mode |^new mode /;
const BINARY = /^(Binary files .* differ|GIT binary patch)/;
const SIMILARITY = /^similarity index /;
const EXT = /(\.[A-Za-z0-9_+-]+)$/;
const IDENT_TOKEN = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const CI_FILE = /(^|\/)(\.travis\.yml|\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|Makefile|Dockerfile|\.pre-commit-config\.yaml)$/;

const ADDED_SIGNATURES =
  /(^|\s)(def|func|fn|class|interface|struct|enum|trait|impl|module|typedef)\s+\w+|(function\s+\w+\s*\()|(\w+\s*[:=]\s*(async\s*)?\([^)]*\)\s*=>)|((public|private|protected|internal|static|virtual|override|export|pub)\s+[\w<>[\],\s]*\w+\s*\()/;
const EXPORT_TOKENS = /\b(export|module\.exports|exports\.|pub\s|public\s|dllimport|dllexport|__all__)\b/;
const IMPORT_TOKENS = /^\s*(import\s|from\s+\S+\s+import|require\(|use\s+[\w:]+;|#include\s|using\s+[\w:]+;|extern\s|crate::)/;
const CONTROL_FLOW = /\b(if|else|elif|for|while|switch|case|break|continue|do|match|when)\b/;
const ERROR_HANDLING = /\b(try|catch|except|finally|raise|throw|panic|recover|rescue|errors?\.|Error\()/;
const LOGGING = /\b(log(ger)?\.|console\.(log|warn|error|info)|print\(|printf|fmt\.Print|System\.out|warn\(|debug\(|trace\()/;
const ASSERTIONS = /\b(assert|expect\(|should\.|\.toBe|\.toEqual|\.toThrow|verify\(|assertEquals)/;
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|<!--|--|;|'''|"""|%)/;
const STRING_LITERAL = /('([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`[^`]*`)/;
const NUMBER_LITERAL = /(?<![\p{L}\p{N}_.])(\p{Nd}+(\.\p{Nd}+)?([eE][+-]?\p{Nd}+)?)(?![\p{L}\p{N}_.])/u;
const VERSION_LITERAL = /(?<![\p{L}\p{N}_])v?\p{Nd}+\.\p{Nd}+(\.\p{Nd}+)?([-+.][\p{L}\p{N}_.]+)?(?![\p{L}\p{N}_])/u;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const CALL_SITE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

// ------------------------------------------------------------------ file kinds
const TEST_DIRS = new Set(['test', 'tests', 'spec', 'specs', '__tests__', 'testing', 't']);
const DOC_DIRS = new Set(['doc', 'docs', 'documentation', 'website']);
const CONFIG_DIRS = new Set(['config', 'configs', 'conf', '.github', '.circleci', 'ci']);
const CONFIG_EXTS = new Set(['.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.json', '.properties', '.gradle']);
const DOC_EXTS = new Set(['.md', '.rst', '.adoc', '.txt', '.mdx']);
const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.java', '.kt', '.kts', '.go', '.rs',
  '.py', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hh', '.hpp', '.cs', '.swift',
  '.scala', '.lua', '.pl', '.sh', '.bash', '.zsh', '.sql', '.vue', '.svelte', '.dart',
  '.ex', '.exs', '.erl', '.hs', '.clj', '.groovy', '.m', '.mm', '.r', '.jl', '.f90',
]);
const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'cargo.lock',
  'go.sum', 'gemfile.lock', 'composer.lock', 'uv.lock', 'requirements.txt',
  'packages.lock.json', 'flake.lock', 'pnpm-lock.yml',
]);

export interface FileKind {
  extension: string;
  isTest: boolean;
  isDoc: boolean;
  isConfig: boolean;
  isLock: boolean;
  isCode: boolean;
  depth: number;
}

export function fileKind(path: string): FileKind {
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf('/');
  const name = slash >= 0 ? lower.slice(slash + 1) : lower;
  const segments = lower.split('/').slice(0, -1);
  const suffix = EXT.exec(name);
  const extension = suffix ? suffix[1] : '';
  const inTestDir = segments.some((segment) => TEST_DIRS.has(segment));
  const nameTest = /(_test|\.test|_spec|\.spec)\.[^.]+$/.test(name);
  const isTest = inTestDir || nameTest;
  const isDoc = segments.some((segment) => DOC_DIRS.has(segment)) || DOC_EXTS.has(extension);
  const isConfig =
    segments.some((segment) => CONFIG_DIRS.has(segment)) || CONFIG_EXTS.has(extension) || CI_FILE.test(path);
  const isLock = LOCKFILES.has(name);
  const isCode = CODE_EXTS.has(extension) && !isTest && !isDoc;
  return { extension, isTest, isDoc, isConfig, isLock, isCode, depth: path.split('/').length };
}

// ------------------------------------------------------------------ helpers
/**
 * Exact floating-point summation — a port of CPython's `math.fsum` (Shewchuk's algorithm with
 * partials). A compensated (Neumaier) sum is *not* enough: it leaves a 1-ulp difference on
 * `hunkSizeCV`, which is the difference between "close" and "identical" for a feature vector
 * that is compared against float32 threshold midpoints.
 */
export function fsum(values: readonly number[]): number {
  const partials: number[] = [];
  for (const value of values) {
    let x = value;
    let index = 0;
    for (let j = 0; j < partials.length; j += 1) {
      let y = partials[j];
      if (Math.abs(x) < Math.abs(y)) {
        const swap = x;
        x = y;
        y = swap;
      }
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) {
        partials[index] = lo;
        index += 1;
      }
      x = hi;
    }
    partials.length = index; // partials[i:] = [x]
    partials.push(x);
  }
  let total = 0;
  for (const partial of partials) {
    total += partial;
  }
  return total;
}

/** Exact ratio of a double: value = m * 2^e with `m` an integer. */
const exactRatio = (value: number): { m: bigint; e: number } => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (exponent === 0) {
    return { m: fraction, e: -1074 };
  }
  return { m: fraction | (1n << 52n), e: exponent - 1075 };
};

/** Compares `c * c` against the exact fraction `p / q`. */
const compareSquareToFraction = (c: number, p: bigint, q: bigint): number => {
  const { m, e } = exactRatio(c);
  let left = m * m * q;
  const right = p;
  const shift = 2 * e;
  if (shift >= 0) {
    left <<= BigInt(shift);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const scaled = right << BigInt(-shift);
  return left < scaled ? -1 : left > scaled ? 1 : 0;
};

const stepBits = (value: number, delta: bigint): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + delta);
  return view.getFloat64(0);
};

/**
 * Correctly rounded `sqrt(p/q)` for exact non-negative integers.
 *
 * Python's `statistics.pstdev` is not a float algorithm: `_ss` accumulates in `Fraction`s and
 * `_float_sqrt_of_frac` rounds the exact result, so `sqrt(fsum((x-mean)²)/n)` can be one ulp
 * off. Because hunk sizes are small integers, `p = n·Σx² − (Σx)²` and `q = n²` are exact in
 * both languages, and the only thing to reproduce is the rounding — done here by comparing the
 * two neighbouring doubles against `p/q` exactly.
 */
const sqrtOfExactFraction = (p: bigint, q: bigint): number => {
  if (p === 0n) {
    return 0;
  }
  const approximate = Math.sqrt(Number(p) / Number(q));
  const candidates = [approximate, stepBits(approximate, 1n), stepBits(approximate, -1n)].filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  let best = candidates[0];
  let bestDistance: bigint | undefined;
  for (const candidate of candidates) {
    const comparison = compareSquareToFraction(candidate, p, q);
    if (comparison === 0) {
      return candidate;
    }
    // distance expressed as an exact BigInt magnitude: |c²·q − p|
    const { m, e } = exactRatio(candidate);
    let left = m * m * q;
    let right = p;
    if (2 * e >= 0) {
      left <<= BigInt(2 * e);
    } else {
      right <<= BigInt(-2 * e);
    }
    const distance = left > right ? left - right : right - left;
    if (bestDistance === undefined || distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

/** Python `statistics.pstdev` for a list of non-negative integers, bit-exactly. */
export function pstdevOfIntegers(values: readonly number[]): number {
  const n = BigInt(values.length);
  let sx = 0n;
  let sxx = 0n;
  for (const value of values) {
    const v = BigInt(value);
    sx += v;
    sxx += v * v;
  }
  return sqrtOfExactFraction(n * sxx - sx * sx, n * n);
}

/** Python `statistics.fmean`. */
export function fmean(values: readonly number[]): number {
  return fsum(values) / values.length;
}

/** Python `statistics.pstdev`. */
export function pstdev(values: readonly number[]): number {
  const mean = fmean(values);
  const squared = values.map((value) => (value - mean) ** 2);
  return Math.sqrt(fsum(squared) / values.length);
}

/** Python `len(str)` counts code points; JS `String.length` counts UTF-16 units. */
const pyLen = (value: string): number => {
  let count = 0;
  for (const _ of value) {
    count += 1;
  }
  return count;
};

/**
 * Python's `str.isspace()` / `str.strip()` whitespace set. It differs from JS `\s`:
 * Python strips `\x1c`-`\x1f` and `\x85` but NOT `\ufeff`, which JS `\s`/`trim()` do treat
 * as whitespace. Using `String.prototype.trim()` here moved `addedIndentDelta` by 0.029 on a
 * real fixture case, so the set is spelled out.
 */
const PY_SPACE = new Set([
  '\t', '\n', '\u000b', '\f', '\r', ' ', '\u001c', '\u001d', '\u001e', '\u001f',
  '\u0085', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004',
  '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029',
  '\u202f', '\u205f', '\u3000',
]);
const pyStrip = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && PY_SPACE.has(value[start])) {
    start += 1;
  }
  while (end > start && PY_SPACE.has(value[end - 1])) {
    end -= 1;
  }
  return value.slice(start, end);
};
const pyStripIsEmpty = (value: string): boolean => pyStrip(value) === '';

const indentOf = (line: string): number => {
  const expanded = line.replace(/\t/g, '    ');
  let index = 0;
  while (index < expanded.length && PY_SPACE.has(expanded[index])) {
    index += 1;
  }
  return pyLen(expanded.slice(0, index));
};

const tokensOf = (line: string): Set<string> => new Set(line.match(IDENTIFIER) ?? []);

interface Hunk {
  file: string | null;
  added: string[];
  deleted: string[];
  context: number;
}

interface DiffStats {
  lineCount: number;
  filesInDiff: number;
  additions: number;
  deletions: number;
  hunks: number;
  newFiles: number;
  deletedFiles: number;
  renames: number;
  modeChanges: number;
  binaryFiles: number;
  identifierTokens: number;
  longLines: number;
  perFileAdditions: number[];
}

function diffStats(stagedDiff: string): DiffStats {
  const stats: DiffStats = {
    lineCount: 0,
    filesInDiff: 0,
    additions: 0,
    deletions: 0,
    hunks: 0,
    newFiles: 0,
    deletedFiles: 0,
    renames: 0,
    modeChanges: 0,
    binaryFiles: 0,
    identifierTokens: 0,
    longLines: 0,
    perFileAdditions: [],
  };
  let currentAdd = 0;
  for (const line of stagedDiff.split('\n')) {
    stats.lineCount += 1;
    if (DIFF_HEADER.test(line)) {
      if (stats.filesInDiff) {
        stats.perFileAdditions.push(currentAdd);
      }
      stats.filesInDiff += 1;
      currentAdd = 0;
      continue;
    }
    if (HUNK.test(line)) {
      stats.hunks += 1;
      continue;
    }
    if (RENAME_FROM.test(line)) {
      stats.renames += 1;
      continue;
    }
    if (RENAME_TO.test(line) || SIMILARITY.test(line)) {
      continue;
    }
    if (NEW_FILE.test(line)) {
      stats.newFiles += 1;
      continue;
    }
    if (DELETED_FILE.test(line)) {
      stats.deletedFiles += 1;
      continue;
    }
    if (MODE_CHANGE.test(line)) {
      stats.modeChanges += 1;
      continue;
    }
    if (BINARY.test(line)) {
      stats.binaryFiles += 1;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('+')) {
      stats.additions += 1;
      currentAdd += 1;
      stats.identifierTokens += line.match(IDENT_TOKEN)?.length ?? 0;
      if (pyLen(line) > 200) {
        stats.longLines += 1;
      }
    } else if (line.startsWith('-')) {
      stats.deletions += 1;
      stats.identifierTokens += line.match(IDENT_TOKEN)?.length ?? 0;
      if (pyLen(line) > 200) {
        stats.longLines += 1;
      }
    }
  }
  if (stats.filesInDiff) {
    stats.perFileAdditions.push(currentAdd);
  }
  return stats;
}

function hunkBlocks(stagedDiff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let currentFile: string | null = null;
  let current: Hunk | null = null;
  for (const line of stagedDiff.split('\n')) {
    const header = DIFF_HEADER.exec(line);
    if (header) {
      currentFile = header[2];
      current = null;
      continue;
    }
    if (HUNK.test(line)) {
      current = { file: currentFile, added: [], deleted: [], context: 0 };
      hunks.push(current);
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('+')) {
      current.added.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.deleted.push(line.slice(1));
    } else {
      current.context += 1;
    }
  }
  return hunks;
}

// ------------------------------------------------------------------ the extractor
/**
 * Feature vector for one staged change, keyed by feature name. Use
 * `toFeatureVector` to order it the way the model expects.
 */
export function extractFeatures79(stagedDiff: string, changedFiles: readonly string[]): Record<string, number> {
  const files = [...changedFiles];
  if (files.length === 0) {
    throw new Error('extractFeatures79: changedFiles must be non-empty');
  }

  const diff = diffStats(stagedDiff);
  const kinds = files.map(fileKind);
  const dirs = new Set(files.filter((path) => path.includes('/')).map((path) => path.slice(0, path.lastIndexOf('/'))));
  const topDirs = new Set(files.map((path) => path.split('/')[0]));
  const depths = kinds.map((kind) => kind.depth);
  const codeExts = new Set(kinds.map((kind) => kind.extension).filter((extension) => CODE_EXTS.has(extension)));
  const changedLines = diff.additions + diff.deletions;
  const nFiles = files.length;

  const v1: Record<string, number> = {
    nFiles,
    nDirs: dirs.size,
    nTopDirs: topDirs.size,
    maxDepth: Math.max(...depths),
    meanDepth: fmean(depths),
    crossDirectory: dirs.size >= 2 ? 1 : 0,
    crossModule: topDirs.size >= 2 ? 1 : 0,
    nExtensions: new Set(kinds.map((kind) => kind.extension)).size,
    filesPerDir: nFiles / Math.max(1, dirs.size),
    diffChars: pyLen(stagedDiff),
    diffLines: diff.lineCount,
    additions: diff.additions,
    deletions: diff.deletions,
    changedLines,
    hunks: diff.hunks,
    meanHunkSize: diff.hunks ? changedLines / diff.hunks : 0,
    maxFileAdditions: diff.perFileAdditions.length ? Math.max(...diff.perFileAdditions) : 0,
    meanFileAdditions: diff.perFileAdditions.length ? fmean(diff.perFileAdditions) : 0,
    diffCharsPerFile: pyLen(stagedDiff) / nFiles,
    additionRatio: changedLines ? diff.additions / changedLines : 0.5,
    meanLineChars: pyLen(stagedDiff) / Math.max(1, diff.lineCount),
    longDiffLines: diff.longLines,
    identifierTokens: diff.identifierTokens,
    identifierDensity: diff.identifierTokens / Math.max(1, changedLines),
    newFiles: diff.newFiles,
    deletedFiles: diff.deletedFiles,
    renames: diff.renames,
    modeChanges: diff.modeChanges,
    binaryFiles: diff.binaryFiles,
    nCodeFiles: kinds.filter((kind) => kind.isCode).length,
    nTestFiles: kinds.filter((kind) => kind.isTest).length,
    nDocFiles: kinds.filter((kind) => kind.isDoc).length,
    nConfigFiles: kinds.filter((kind) => kind.isConfig).length,
    nLockFiles: kinds.filter((kind) => kind.isLock).length,
    hasTest: kinds.some((kind) => kind.isTest) ? 1 : 0,
    hasCode: kinds.some((kind) => kind.isCode) ? 1 : 0,
    hasDoc: kinds.some((kind) => kind.isDoc) ? 1 : 0,
    hasConfig: kinds.some((kind) => kind.isConfig) ? 1 : 0,
    hasLockfile: kinds.some((kind) => kind.isLock) ? 1 : 0,
    testPlusCode: kinds.some((kind) => kind.isTest) && kinds.some((kind) => kind.isCode) ? 1 : 0,
    codeExtensionCount: codeExts.size,
  };

  // ---- v2 --------------------------------------------------------------- //
  const hunks = hunkBlocks(stagedDiff);
  const hunkSizes = hunks.map((hunk) => hunk.added.length + hunk.deleted.length);
  const totalChanged = hunkSizes.reduce((sum, size) => sum + size, 0);
  const filesWithHunks = new Set(hunks.map((hunk) => hunk.file));

  // mirrors the Python exactly, redundant branch included: every hunk adds one
  let clusters = 0;
  for (const hunk of hunks) {
    if (hunk.file !== null) {
      clusters += 1;
    } else {
      clusters += 1;
    }
  }

  const addedLines = hunks.flatMap((hunk) => hunk.added);
  const deletedLines = hunks.flatMap((hunk) => hunk.deleted);

  let replacement = 0;
  let formatOnly = 0;
  let whitespaceOnly = 0;
  let renamedIdentifiers = 0;
  const addedIdentifiers = new Set<string>();
  const deletedIdentifiers = new Set<string>();
  const perFileIdentifiers = new Map<string, Set<string>>();

  for (const hunk of hunks) {
    const addedSet = new Set<string>();
    for (const line of hunk.added) {
      for (const token of tokensOf(line)) {
        addedSet.add(token);
      }
    }
    const deletedSet = new Set<string>();
    for (const line of hunk.deleted) {
      for (const token of tokensOf(line)) {
        deletedSet.add(token);
      }
    }
    for (const token of addedSet) {
      addedIdentifiers.add(token);
    }
    for (const token of deletedSet) {
      deletedIdentifiers.add(token);
    }
    for (const token of addedSet) {
      if (deletedSet.has(token)) {
        renamedIdentifiers += 1;
      }
    }
    const key = hunk.file ?? '';
    const bucket = perFileIdentifiers.get(key) ?? new Set<string>();
    for (const token of addedSet) {
      bucket.add(token);
    }
    for (const token of deletedSet) {
      bucket.add(token);
    }
    perFileIdentifiers.set(key, bucket);
    if (hunk.added.length && hunk.deleted.length) {
      replacement += Math.min(hunk.added.length, hunk.deleted.length);
      const addedSorted = hunk.added.map((line) => pyStrip(line)).sort();
      const deletedSorted = hunk.deleted.map((line) => pyStrip(line)).sort();
      if (addedSorted.length === deletedSorted.length && addedSorted.every((line, index) => line === deletedSorted[index])) {
        formatOnly += 1;
      }
    }
    whitespaceOnly += [...hunk.added, ...hunk.deleted].filter((line) => pyStripIsEmpty(line)).length;
  }

  const allLines = [...addedLines, ...deletedLines];
  const identifierUnion = new Set([...addedIdentifiers, ...deletedIdentifiers]);
  const addedIndent = addedLines.filter((line) => !pyStripIsEmpty(line)).map(indentOf);
  const deletedIndent = deletedLines.filter((line) => !pyStripIsEmpty(line)).map(indentOf);
  const commentLines = allLines.filter((line) => COMMENT_LINE.test(line)).length;
  const changedLineCount = allLines.length;

  let sharedIdentifiers = 0;
  if (perFileIdentifiers.size > 1) {
    const counts = new Map<string, number>();
    for (const tokens of perFileIdentifiers.values()) {
      for (const token of tokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
    sharedIdentifiers = [...counts.values()].filter((count) => count >= 2).length;
  }

  const extensions = new Map<string, number>();
  for (const kind of kinds) {
    extensions.set(kind.extension, (extensions.get(kind.extension) ?? 0) + 1);
  }
  const codeExtensions = new Map<string, number>();
  for (const kind of kinds) {
    if (kind.isCode && kind.extension) {
      codeExtensions.set(kind.extension, (codeExtensions.get(kind.extension) ?? 0) + 1);
    }
  }
  let dominant = 0;
  if (extensions.size > 0) {
    dominant = Math.max(...extensions.values()) / nFiles;
  }

  const addCount = addedLines.length;
  const deleteCount = deletedLines.length;
  const largest = Math.max(addCount, deleteCount);
  const meanHunkChanged = hunkSizes.length ? fmean(hunkSizes) : 0;

  const v2: Record<string, number> = {
    hunksPerFile: hunks.length / nFiles,
    filesPerHunk: nFiles / Math.max(1, hunks.length),
    meanHunkChangedLines: meanHunkChanged,
    maxHunkChangedLines: hunkSizes.length ? Math.max(...hunkSizes) : 0,
    maxHunkShare: totalChanged ? Math.max(...hunkSizes) / totalChanged : 0,
    hunkSizeCV:
      hunkSizes.length > 1 && meanHunkChanged
        ? hunkSizes.every((size) => Number.isInteger(size) && size >= 0)
          ? pstdevOfIntegers(hunkSizes) / meanHunkChanged
          : pstdev(hunkSizes) / meanHunkChanged
        : 0,
    changeClusters: clusters,
    clustersPerFile: clusters / nFiles,
    singleChangeRegion: clusters === 1 ? 1 : 0,
    replacementRatio: totalChanged ? replacement / totalChanged : 0,
    addDeleteBalance: largest ? Math.min(addCount, deleteCount) / largest : 0,
    whitespaceOnlyLines: whitespaceOnly,
    formatOnlyHunkShare: formatOnly / Math.max(1, hunks.length),
    addedIndentDelta:
      addedIndent.length && deletedIndent.length ? fmean(addedIndent) - fmean(deletedIndent) : 0,
    commentLines,
    commentRatio: changedLineCount ? commentLines / changedLineCount : 0,
    stringLiteralLines: allLines.filter((line) => STRING_LITERAL.test(line)).length,
    numberLiteralLines: allLines.filter((line) => NUMBER_LITERAL.test(line)).length,
    versionLiteralLines: allLines.filter((line) => VERSION_LITERAL.test(line)).length,
    importLines: allLines.filter((line) => IMPORT_TOKENS.test(pyStrip(line))).length,
    controlFlowLines: allLines.filter((line) => CONTROL_FLOW.test(line)).length,
    errorHandlingLines: allLines.filter((line) => ERROR_HANDLING.test(line)).length,
    loggingLines: allLines.filter((line) => LOGGING.test(line)).length,
    assertionLines: allLines.filter((line) => ASSERTIONS.test(line)).length,
    signatureLines: allLines.filter((line) => ADDED_SIGNATURES.test(line)).length,
    exportedSymbolLines: allLines.filter((line) => EXPORT_TOKENS.test(line)).length,
    callSiteLines: allLines.filter((line) => CALL_SITE.test(line)).length,
    renamedIdentifierRatio: identifierUnion.size ? renamedIdentifiers / identifierUnion.size : 0,
    newIdentifierRatio: identifierUnion.size
      ? [...addedIdentifiers].filter((token) => !deletedIdentifiers.has(token)).length / identifierUnion.size
      : 0,
    touchedIdentifierDiversity: identifierUnion.size / Math.max(1, changedLineCount),
    crossFileIdentifierOverlap: identifierUnion.size ? sharedIdentifiers / identifierUnion.size : 0,
    dominantExtensionRatio: dominant,
    singleCodeLanguage: codeExtensions.size <= 1 ? 1 : 0,
    allTestFiles: kinds.every((kind) => kind.isTest) ? 1 : 0,
    allDocFiles: kinds.every((kind) => kind.isDoc) ? 1 : 0,
    allConfigFiles: kinds.every((kind) => kind.isConfig || kind.isLock) ? 1 : 0,
    mixedTestAndSource: kinds.some((kind) => kind.isTest) && kinds.some((kind) => kind.isCode) ? 1 : 0,
    sourceOnlyChange: kinds.every((kind) => kind.isCode) && kinds.some((kind) => kind.isCode) ? 1 : 0,
  };

  void filesWithHunks; // kept for parity with the Python source, which computes it unused
  return { ...v1, ...v2 };
}

/** Orders a feature record the way a model artifact expects. */
export function toFeatureVector(
  featureNames: readonly string[],
  features: Record<string, number>,
): number[] {
  return featureNames.map((name) => {
    const value = features[name];
    if (value === undefined) {
      throw new Error(`toFeatureVector: model expects feature '${name}' which the extractor did not produce`);
    }
    return value;
  });
}
