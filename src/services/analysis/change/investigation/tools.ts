// Change-oriented tools shared by the repository analysis agent.
//
// The generic exploration tools (listDirectory / searchCode / readFileContent)
// are kept, but the agent's primary vocabulary is symbol-oriented: definition,
// references, callers, callees, implementations, type. Expressing retrieval in
// those terms is what keeps the investigation anchored to the change instead of
// degenerating into a repository tour.
//
// No language server is available inside the extension host for arbitrary
// repositories, so resolution is regex-based over captured Git blobs. Results are
// therefore treated as candidate evidence: every item carries a `path:line`
// citation the model can verify with readFileContent.

import * as path from 'path';
import { listSnapshotDirectory, readSnapshotFile, searchSnapshot } from '../../../git/snapshotTools';
import { RepositorySnapshotReader } from '../../../git/repositorySnapshot';
import { RepositoryEvidenceItem, RepositoryEvidenceKind } from '../types';

export const CHANGE_ANALYSIS_TOOL_NAMES = [
    'findSymbolDefinition',
    'findSymbolReferences',
    'findCallers',
    'findCallees',
    'findImplementations',
    'findTypeDefinition',
    'searchCode',
    'readFileContent',
    'listDirectory',
] as const;

export type InvestigationToolName = typeof CHANGE_ANALYSIS_TOOL_NAMES[number];

export interface InvestigationToolCall {
    side?: 'before' | 'after' | null;
    tool: InvestigationToolName;
    symbol?: string | null;
    filePath?: string | null;
    dirPath?: string | null;
    query?: string | null;
    searchType?: 'name' | 'content' | null;
    useRegex?: boolean | null;
    startLine?: number | null;
    maxLines?: number | null;
    maxResults?: number | null;
}

export interface InvestigationToolOutcome {
    ok: boolean;
    /** One-line result description shown to the agent and in logs. */
    summary: string;
    evidence: RepositoryEvidenceItem[];
    error?: string;
}

export interface InvestigationToolContext {
    side?: 'before' | 'after';
    snapshot: RepositorySnapshotReader;
    repositoryPath: string;
    excludePatterns: string[];
    /** Allocates and records stable evidence ids (`E1`, `E2`, …) through AgentRuntime. */
    allocateEvidence: (evidence: Omit<RepositoryEvidenceItem, 'id'>) => RepositoryEvidenceItem;
}

/**
 * Directories and files that never answer an investigation question but can
 * dominate a regex scan. Excluding them keeps latency bounded and stops
 * vendored copies of a symbol from outranking the real definition.
 */
export const DEFAULT_CHANGE_ANALYSIS_EXCLUDES: string[] = [
    '.git', '.gitgenie', 'node_modules', 'dist', 'out', 'build', 'coverage',
    '.next', '.nuxt', '.turbo', '.cache', 'vendor', 'target', '__pycache__',
    '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.gradle', 'Pods',
    '*.min.js', '*.min.css', '*.map', 'package-lock.json', 'yarn.lock',
    'pnpm-lock.yaml', 'poetry.lock', 'Cargo.lock', 'go.sum',
];

const MAX_EVIDENCE_PER_CALL = 8;
const MAX_EXCERPT_CHARS = 600;
const MAX_BODY_LINES = 120;

const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[A-Za-z]+$/i;
const DOC_PATH_PATTERN = /\.(md|mdx|rst|adoc|txt)$/i;

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(value: string, limit = MAX_EXCERPT_CHARS): string {
    const collapsed = value.replace(/\s+$/g, '');
    return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

function classifyPath(filePath: string): RepositoryEvidenceKind | null {
    if (TEST_PATH_PATTERN.test(filePath)) {
        return 'tests';
    }
    if (DOC_PATH_PATTERN.test(filePath)) {
        return 'documentation';
    }
    return null;
}

/**
 * Declaration forms for a specific symbol name across the languages this
 * extension commonly sees. Combined into one alternation so a single content
 * scan can answer "where is this defined?".
 */
function buildDefinitionRegex(symbol: string): string {
    const name = escapeRegex(symbol);
    return [
        `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*[(<]`,
        `(?:export\\s+)?(?:abstract\\s+)?class\\s+${name}\\b`,
        `(?:export\\s+)?interface\\s+${name}\\b`,
        `(?:export\\s+)?type\\s+${name}\\b`,
        `(?:export\\s+)?enum\\s+${name}\\b`,
        `(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*[:=]`,
        `(?:async\\s+)?def\\s+${name}\\s*\\(`,
        `class\\s+${name}\\s*[:(]`,
        `func\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\(`,
        `type\\s+${name}\\s+(?:struct|interface)\\b`,
        `(?:pub\\s+)?(?:async\\s+)?fn\\s+${name}\\s*[(<]`,
        `(?:pub\\s+)?(?:struct|enum|trait)\\s+${name}\\b`,
        `${name}\\s*\\([^)]*\\)\\s*(?::[^{;]+)?\\{`,
        `"${name}"\\s*:`,
        `^\\s*${name}\\s*[:=]`,
    ].join('|');
}

function buildTypeDefinitionRegex(symbol: string): string {
    const name = escapeRegex(symbol);
    return [
        `(?:export\\s+)?interface\\s+${name}\\b`,
        `(?:export\\s+)?type\\s+${name}\\b`,
        `(?:export\\s+)?enum\\s+${name}\\b`,
        `(?:export\\s+)?(?:abstract\\s+)?class\\s+${name}\\b`,
        `type\\s+${name}\\s+(?:struct|interface)\\b`,
        `(?:pub\\s+)?(?:struct|enum|trait)\\s+${name}\\b`,
        `class\\s+${name}\\s*[:(]`,
    ].join('|');
}

function buildImplementationRegex(symbol: string): string {
    const name = escapeRegex(symbol);
    return [
        `implements\\s+[^{]*\\b${name}\\b`,
        `extends\\s+[^{]*\\b${name}\\b`,
        `:\\s*${name}\\s*(?:=|\\{|,|\\)|$)`,
        `impl\\s+(?:<[^>]*>\\s*)?${name}\\s+for\\b`,
        `\\(\\s*[A-Za-z_][\\w]*\\s+${name}\\s*\\)`,
        `class\\s+[A-Za-z_][\\w]*\\s*\\([^)]*\\b${name}\\b[^)]*\\)`,
    ].join('|');
}

function buildCallRegex(symbol: string): string {
    const name = escapeRegex(symbol);
    return `\\b${name}\\s*(?:<[^>]*>)?\\s*\\(`;
}

async function runContentSearch(
    context: InvestigationToolContext,
    regex: string,
    maxResults: number,
    searchPath?: string
): Promise<Array<{ filePath: string; line: number; content: string }>> {
    const result = await searchSnapshot(context.snapshot, regex, {
        searchType: 'content',
        useRegex: true,
        searchPath,
        maxResults,
        caseSensitive: true,
        excludePatterns: context.excludePatterns,
        maxMatchesPerFile: 3,
        contextLines: 0,
    }, context.side);

    if (!result.success || !result.data) {
        throw new Error(result.error ?? 'Snapshot search failed.');
    }

    const flattened: Array<{ filePath: string; line: number; content: string }> = [];
    for (const file of result.data.results) {
        for (const match of file.matches || []) {
            flattened.push({ filePath: file.filePath, line: match.line, content: match.content });
        }
    }
    return flattened;
}

async function toEvidence(
    context: InvestigationToolContext,
    kind: RepositoryEvidenceKind,
    target: string,
    matches: Array<{ filePath: string; line: number; content: string }>
): Promise<RepositoryEvidenceItem[]> {
    return Promise.all(matches.slice(0, MAX_EVIDENCE_PER_CALL).map(match => allocateObserved(context, {
        kind: classifyPath(match.filePath) ?? kind,
        target,
        ref: `${match.filePath}:${match.line}`,
        excerpt: truncate(match.content.trim()),
    })));
}

async function allocateObserved(context: InvestigationToolContext, evidence: Omit<RepositoryEvidenceItem, 'id'>): Promise<RepositoryEvidenceItem> {
    const match = evidence.ref.match(/^([\s\S]+):(\d+)(?:-(\d+))?$/);
    if (!match) { throw new Error('Evidence requires a snapshot line range.'); }
    const start = Number(match[2]);
    const source = await context.snapshot.observe(match[1], start, Number(match[3] ?? match[2]) - start + 1,
        context.excludePatterns, context.side ?? 'after', Math.max(evidence.excerpt.length, 600));
    return context.allocateEvidence({ ...evidence, excerpt: source.excerpt, provenance: source });
}

/**
 * Ranks candidate definition sites so the most plausible one is read first.
 * Test and documentation hits are pushed down because a symbol's role is
 * defined by production code, while tests only describe expected behavior.
 */
function rankDefinitionCandidates(
    matches: Array<{ filePath: string; line: number; content: string }>,
    preferredFile?: string | null
): Array<{ filePath: string; line: number; content: string }> {
    const normalizedPreferred = preferredFile ? preferredFile.replace(/\\/g, '/') : undefined;
    return [...matches].sort((left, right) => score(left) - score(right));

    function score(match: { filePath: string; line: number }): number {
        let value = 0;
        if (normalizedPreferred && match.filePath.replace(/\\/g, '/') === normalizedPreferred) {
            value -= 100;
        }
        if (TEST_PATH_PATTERN.test(match.filePath)) {
            value += 40;
        }
        if (DOC_PATH_PATTERN.test(match.filePath)) {
            value += 60;
        }
        return value;
    }
}

/**
 * Reads the body that follows a declaration. Uses brace balance when the file
 * looks brace-delimited and indentation otherwise, so Python and YAML-like
 * sources are handled without a per-language parser.
 */
async function readDeclarationBody(
    context: InvestigationToolContext,
    filePath: string,
    startLine: number
): Promise<{ text: string; endLine: number } | null> {
    const absolute = resolveInsideRepository(context.repositoryPath, filePath);
    const read = await readSnapshotFile(context.snapshot, absolute, { startLine, maxLines: MAX_BODY_LINES }, context.excludePatterns, context.side);
    if (!read.success || !read.data) {
        return null;
    }

    const lines = read.data.content.split('\n');
    const first = lines[0] ?? '';
    const baseIndent = first.length - first.trimStart().length;
    const braceStyle = /[{(]\s*$/.test(first) || first.includes('{');

    let depth = 0;
    let seenOpen = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (braceStyle) {
            for (const character of line) {
                if (character === '{') {
                    depth += 1;
                    seenOpen = true;
                } else if (character === '}') {
                    depth -= 1;
                }
            }
            if (seenOpen && depth <= 0) {
                return {
                    text: lines.slice(0, index + 1).join('\n'),
                    endLine: startLine + index,
                };
            }
            continue;
        }

        if (index > 0 && line.trim().length > 0) {
            const indent = line.length - line.trimStart().length;
            if (indent <= baseIndent) {
                return {
                    text: lines.slice(0, index).join('\n'),
                    endLine: startLine + index - 1,
                };
            }
        }
    }

    return {
        text: lines.join('\n'),
        endLine: read.data.endLine,
    };
}

/**
 * Resolves a model-supplied path against the repository root and refuses to
 * escape it. Tool arguments come from model output, so containment is enforced
 * here rather than trusted.
 */
export function resolveInsideRepository(repositoryPath: string, candidate: string): string {
    const root = path.resolve(repositoryPath);
    const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Path escapes the repository: ${candidate}`);
    }
    return absolute;
}

function toRelative(repositoryPath: string, absolute: string): string {
    return path.relative(path.resolve(repositoryPath), absolute).split(path.sep).join('/');
}

function requireSymbol(call: InvestigationToolCall): string {
    const symbol = (call.symbol || '').trim();
    if (!symbol) {
        throw new Error(`Tool '${call.tool}' requires a symbol argument.`);
    }
    return symbol;
}

export async function runInvestigationTool(
    context: InvestigationToolContext,
    call: InvestigationToolCall
): Promise<InvestigationToolOutcome> {
    context = { ...context, side: call.side ?? 'after' };
    try {
        switch (call.tool) {
            case 'findSymbolDefinition': {
                const symbol = requireSymbol(call);
                const matches = rankDefinitionCandidates(
                    await runContentSearch(context, buildDefinitionRegex(symbol), call.maxResults ?? 12),
                    call.filePath
                );
                if (!matches.length) {
                    return { ok: true, summary: `No definition found for '${symbol}'.`, evidence: [] };
                }

                const best = matches[0];
                const body = await readDeclarationBody(context, best.filePath, best.line);
                const primary = await allocateObserved(context, {
                    kind: 'definition',
                    target: symbol,
                    ref: body ? `${best.filePath}:${best.line}-${body.endLine}` : `${best.filePath}:${best.line}`,
                    excerpt: truncate(body ? body.text : best.content, 1200),
                });
                const others = await toEvidence(context, 'definition', symbol, matches.slice(1, 4));
                return {
                    ok: true,
                    summary: `Definition of '${symbol}' at ${primary.ref}${others.length ? ` (${others.length} other candidate definition site(s))` : ''}.`,
                    evidence: [primary, ...others],
                };
            }

            case 'findSymbolReferences': {
                const symbol = requireSymbol(call);
                const matches = await runContentSearch(
                    context,
                    `\\b${escapeRegex(symbol)}\\b`,
                    call.maxResults ?? 20
                );
                const evidence = await toEvidence(context, 'references', symbol, matches);
                return {
                    ok: true,
                    summary: `Found ${matches.length} reference line(s) to '${symbol}' across ${new Set(matches.map(match => match.filePath)).size} file(s).`,
                    evidence,
                };
            }

            case 'findCallers': {
                const symbol = requireSymbol(call);
                const definitionRegex = new RegExp(buildDefinitionRegex(symbol));
                const matches = (await runContentSearch(context, buildCallRegex(symbol), call.maxResults ?? 20))
                    // A definition line also matches "name(" ; excluding it keeps
                    // callers distinct from the symbol's own declaration.
                    .filter(match => !definitionRegex.test(match.content));
                const evidence = await toEvidence(context, 'callers', symbol, matches);
                return {
                    ok: true,
                    summary: matches.length
                        ? `'${symbol}' is called from ${new Set(matches.map(match => match.filePath)).size} file(s).`
                        : `No callers of '${symbol}' were found.`,
                    evidence,
                };
            }

            case 'findCallees': {
                const symbol = requireSymbol(call);
                const matches = rankDefinitionCandidates(
                    await runContentSearch(context, buildDefinitionRegex(symbol), 12),
                    call.filePath
                );
                if (!matches.length) {
                    return { ok: true, summary: `No definition found for '${symbol}', so callees are unknown.`, evidence: [] };
                }
                const best = matches[0];
                const body = await readDeclarationBody(context, best.filePath, best.line);
                if (!body) {
                    return { ok: true, summary: `Could not read the body of '${symbol}'.`, evidence: [] };
                }
                const callees = new Set<string>();
                const pattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
                let match = pattern.exec(body.text);
                while (match) {
                    if (match[1] !== symbol) {
                        callees.add(match[1]);
                    }
                    match = pattern.exec(body.text);
                }
                return {
                    ok: true,
                    summary: callees.size
                        ? `'${symbol}' calls: ${Array.from(callees).slice(0, 25).join(', ')}.`
                        : `'${symbol}' makes no direct calls.`,
                    evidence: [{
                        ...await allocateObserved(context, {
                            kind: 'callees',
                            target: symbol,
                            ref: `${best.filePath}:${best.line}-${body.endLine}`,
                            excerpt: truncate(body.text, 1200),
                        }),
                    }],
                };
            }

            case 'findImplementations': {
                const symbol = requireSymbol(call);
                const matches = await runContentSearch(
                    context,
                    buildImplementationRegex(symbol),
                    call.maxResults ?? 15
                );
                return {
                    ok: true,
                    summary: matches.length
                        ? `Found ${matches.length} candidate implementation or consumer site(s) of '${symbol}'.`
                        : `No implementations of '${symbol}' were found.`,
                    evidence: await toEvidence(context, 'implementations', symbol, matches),
                };
            }

            case 'findTypeDefinition': {
                const symbol = requireSymbol(call);
                const matches = rankDefinitionCandidates(
                    await runContentSearch(context, buildTypeDefinitionRegex(symbol), call.maxResults ?? 10),
                    call.filePath
                );
                if (!matches.length) {
                    return { ok: true, summary: `No type definition found for '${symbol}'.`, evidence: [] };
                }
                const best = matches[0];
                const body = await readDeclarationBody(context, best.filePath, best.line);
                return {
                    ok: true,
                    summary: `Type '${symbol}' is defined at ${best.filePath}:${best.line}.`,
                    evidence: [{
                        ...await allocateObserved(context, {
                            kind: 'type',
                            target: symbol,
                            ref: body ? `${best.filePath}:${best.line}-${body.endLine}` : `${best.filePath}:${best.line}`,
                            excerpt: truncate(body ? body.text : best.content, 1000),
                        }),
                    }],
                };
            }

            case 'searchCode': {
                const query = (call.query || '').trim();
                if (!query) {
                    throw new Error("Tool 'searchCode' requires a query argument.");
                }
                const searchType = call.searchType === 'name' ? 'name' : 'content';
                const searchPath = call.dirPath
                    ? resolveInsideRepository(context.repositoryPath, call.dirPath)
                    : undefined;
                const result = await searchSnapshot(context.snapshot, query, {
                    searchType,
                    useRegex: call.useRegex === true,
                    searchPath,
                    maxResults: call.maxResults ?? 20,
                    caseSensitive: false,
                    excludePatterns: context.excludePatterns,
                    maxMatchesPerFile: 3,
                    contextLines: 0,
                }, context.side);
                if (!result.success || !result.data) {
                    return { ok: false, summary: 'searchCode failed.', evidence: [], error: result.error };
                }
                if (searchType === 'name') {
                    const files = result.data.results.map(entry => entry.filePath);
                    return {
                        ok: true,
                        summary: files.length ? `Matching files: ${files.slice(0, 25).join(', ')}.` : 'No matching file names.',
                        evidence: [],
                    };
                }
                const flattened = result.data.results.flatMap(file =>
                    (file.matches || []).map(match => ({
                        filePath: file.filePath,
                        line: match.line,
                        content: match.content,
                    }))
                );
                return {
                    ok: true,
                    summary: `Found ${flattened.length} match(es) for '${query}'.`,
                    evidence: await toEvidence(context, 'search', query, flattened),
                };
            }

            case 'readFileContent': {
                const filePath = (call.filePath || '').trim();
                if (!filePath) {
                    throw new Error("Tool 'readFileContent' requires a filePath argument.");
                }
                const absolute = resolveInsideRepository(context.repositoryPath, filePath);
                const startLine = call.startLine ?? 1;
                const maxLines = call.maxLines ?? 120;
                const read = await readSnapshotFile(context.snapshot, absolute, { startLine, maxLines }, context.excludePatterns, context.side);
                if (!read.success || !read.data) {
                    return { ok: false, summary: `Could not read ${filePath}.`, evidence: [], error: read.error };
                }
                const relative = toRelative(context.repositoryPath, absolute);
                return {
                    ok: true,
                    summary: `Read ${relative}:${read.data.startLine}-${read.data.endLine}${read.data.hasMore ? ' (more lines follow)' : ''}.`,
                    evidence: [{
                        ...await allocateObserved(context, {
                            kind: classifyPath(relative) ?? 'search',
                            target: relative,
                            ref: `${relative}:${read.data.startLine}-${read.data.endLine}`,
                            excerpt: truncate(read.data.content, 2000),
                        }),
                    }],
                };
            }

            case 'listDirectory': {
                const dirPath = (call.dirPath || '.').trim();
                const absolute = resolveInsideRepository(context.repositoryPath, dirPath);
                const listing = listSnapshotDirectory(context.snapshot, absolute, context.excludePatterns, context.side);
                if (!listing.success || !listing.data) {
                    throw new Error(`Could not list ${dirPath}.`);
                }
                const entries = listing.data.entries
                    .slice(0, 60)
                    .map(entry => `${entry.name}${entry.type === 'directory' ? '/' : ''}`)
                    .join(', ');
                return {
                    ok: true,
                    summary: `${toRelative(context.repositoryPath, absolute) || '.'} contains: ${entries}`,
                    evidence: [],
                };
            }

            default: {
                const unknown = call.tool as string;
                return { ok: false, summary: `Unknown tool '${unknown}'.`, evidence: [], error: `Unknown tool '${unknown}'` };
            }
        }
    } catch (error) {
        const message = String((error as Error)?.message || error || 'Tool execution failed');
        return { ok: false, summary: `Tool '${call.tool}' failed: ${message}`, evidence: [], error: message };
    }
}
