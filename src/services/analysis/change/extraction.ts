// Stage 1: Change Extraction.
//
// Answers "what changed?" using deterministic diff analysis first, then lets
// the model fill in only what pattern matching cannot see. The stage
// deliberately produces no intent, commit type, or user impact: anchoring on a
// hypothesis before any repository evidence exists is exactly the failure mode
// the change-conditioned chain is meant to remove.

import { DiffData, DiffHunk } from '../../git/gitTypes';
import { LLMExecution } from '../../llm/llmTypes';
import {
    ChangeExtraction,
    ChangeKind,
    ChangedFile,
    ChangedSymbol,
    ChangedSymbolType,
} from './types';
import { buildChangeExtractionMessages } from './prompts';

type DeclarationPattern = {
    regex: RegExp;
    symbolType: ChangedSymbolType;
    changeKind: ChangeKind;
};

/**
 * Declaration patterns for the languages this extension sees most often. These
 * are intentionally shallow: a false positive costs one extra investigation
 * question, while a missed symbol costs the whole investigation its starting
 * point, so recall is favoured over precision.
 */
const DECLARATION_PATTERNS: DeclarationPattern[] = [
    // TypeScript / JavaScript
    { regex: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/, symbolType: 'function', changeKind: 'signature' },
    { regex: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, symbolType: 'class', changeKind: 'signature' },
    { regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, symbolType: 'interface', changeKind: 'type_shape' },
    { regex: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, symbolType: 'type', changeKind: 'type_shape' },
    { regex: /\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, symbolType: 'type', changeKind: 'type_shape' },
    { regex: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, symbolType: 'function', changeKind: 'signature' },
    { regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, symbolType: 'constant', changeKind: 'value' },
    { regex: /^\s*(?:public|private|protected|readonly|static|async|\*|get|set|\s)*\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{/, symbolType: 'method', changeKind: 'signature' },
    // Python
    { regex: /\b(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, symbolType: 'function', changeKind: 'signature' },
    { regex: /\bclass\s+([A-Za-z_][\w]*)\s*[:(]/, symbolType: 'class', changeKind: 'signature' },
    // Go
    { regex: /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/, symbolType: 'function', changeKind: 'signature' },
    { regex: /\btype\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/, symbolType: 'type', changeKind: 'type_shape' },
    // Rust
    { regex: /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*[(<]/, symbolType: 'function', changeKind: 'signature' },
    { regex: /\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, symbolType: 'type', changeKind: 'type_shape' },
    // Java / C# / Kotlin / Swift
    { regex: /\b(?:public|private|protected|internal|open|final|override|static|suspend|\s)+(?:fun|void|func)\s+([A-Za-z_][\w]*)\s*\(/, symbolType: 'method', changeKind: 'signature' },
    { regex: /\b(?:public|private|protected|internal|sealed|abstract|open|data|\s)+(?:class|record|struct|interface|enum)\s+([A-Za-z_][\w]*)/, symbolType: 'class', changeKind: 'signature' },
    // Ruby / PHP
    { regex: /^\s*def\s+([A-Za-z_][\w?!]*)/, symbolType: 'method', changeKind: 'signature' },
];

const CALL_PATTERN = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;

/**
 * Words that match the call pattern but carry no dependency information.
 * Keeping them out of `changedCalls` prevents the planner from spending
 * investigation questions on control flow keywords.
 */
const CALL_NOISE = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'def', 'fn',
    'func', 'class', 'new', 'typeof', 'await', 'yield', 'super', 'this', 'self',
    'print', 'require', 'import', 'export', 'match', 'with', 'lambda', 'elif',
    'else', 'try', 'except', 'finally', 'assert', 'throw', 'delete', 'void',
    'in', 'is', 'and', 'or', 'not', 'do', 'then', 'end', 'let', 'const', 'var',
]);

const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env']);

const DEPENDENCY_FILES = [
    'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile',
    'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock',
    'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json',
];

const MAX_ITEMS_PER_LIST = 40;

/** New-file line span covered by a hunk, used to build `path:line` citations. */
type HunkAnchor = {
    hunk: DiffHunk;
    /** 1-based new-file line number of the first content line. */
    newStart: number;
};

function parseHunkAnchor(hunk: DiffHunk): HunkAnchor {
    const match = hunk.header.match(/@@\s*-\d+(?:,\d+)?\s*\+(\d+)/);
    return { hunk, newStart: match ? Number(match[1]) : 1 };
}

/**
 * Walks a hunk and reports each added or removed line with the new-file line
 * number it occupies (or the line it was removed from). Removed lines reuse the
 * current new-file cursor so a citation still points at a readable location.
 */
function* iterateChangedLines(anchor: HunkAnchor): Generator<{ text: string; line: number; added: boolean }> {
    let newLine = anchor.newStart;
    for (const raw of anchor.hunk.content.split('\n')) {
        if (raw.startsWith('+++') || raw.startsWith('---')) {
            continue;
        }
        if (raw.startsWith('+')) {
            yield { text: raw.slice(1), line: newLine, added: true };
            newLine += 1;
            continue;
        }
        if (raw.startsWith('-')) {
            yield { text: raw.slice(1), line: newLine, added: false };
            continue;
        }
        if (raw.startsWith('\\')) {
            continue;
        }
        newLine += 1;
    }
}

function fileExtension(filePath: string): string {
    const baseName = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dotIndex = baseName.lastIndexOf('.');
    return dotIndex > 0 ? baseName.slice(dotIndex + 1).toLowerCase() : '';
}

function baseName(filePath: string): string {
    return filePath.slice(filePath.lastIndexOf('/') + 1);
}

function isConfigFile(filePath: string): boolean {
    return CONFIG_EXTENSIONS.has(fileExtension(filePath)) || baseName(filePath).startsWith('.env');
}

function isDependencyFile(filePath: string): boolean {
    return DEPENDENCY_FILES.includes(baseName(filePath));
}

function extractConfigKey(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        return null;
    }
    const jsonKey = trimmed.match(/^"([^"]+)"\s*:/);
    if (jsonKey) {
        return jsonKey[1];
    }
    const yamlKey = trimmed.match(/^-?\s*([A-Za-z_][\w.\-/]*)\s*[:=]/);
    if (yamlKey) {
        return yamlKey[1];
    }
    return null;
}

function extractDependencyName(filePath: string, text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return null;
    }
    const name = baseName(filePath);
    if (name === 'package.json' || name === 'composer.json') {
        const match = trimmed.match(/^"([^"]+)"\s*:\s*"/);
        return match ? match[1] : null;
    }
    if (name === 'requirements.txt' || name === 'Pipfile') {
        const match = trimmed.match(/^([A-Za-z0-9._-]+)\s*(?:[=<>!~[]|$)/);
        return match ? match[1] : null;
    }
    if (name === 'go.mod') {
        const match = trimmed.match(/^(?:require\s+)?([\w.\-]+\/[\w.\-/]+)\s+v/);
        return match ? match[1] : null;
    }
    if (name === 'Cargo.toml' || name === 'pyproject.toml') {
        const match = trimmed.match(/^([A-Za-z0-9._-]+)\s*=/);
        return match ? match[1] : null;
    }
    if (name === 'Gemfile') {
        const match = trimmed.match(/^gem\s+['"]([^'"]+)['"]/);
        return match ? match[1] : null;
    }
    return null;
}

function matchDeclaration(text: string): { name: string; symbolType: ChangedSymbolType; changeKind: ChangeKind } | null {
    for (const pattern of DECLARATION_PATTERNS) {
        const match = text.match(pattern.regex);
        const name = match?.[1];
        if (name && !CALL_NOISE.has(name)) {
            return { name, symbolType: pattern.symbolType, changeKind: pattern.changeKind };
        }
    }
    return null;
}

function collectCalls(text: string): string[] {
    const calls: string[] = [];
    CALL_PATTERN.lastIndex = 0;
    let match = CALL_PATTERN.exec(text);
    while (match) {
        const name = match[1];
        const leaf = name.slice(name.lastIndexOf('.') + 1);
        if (!CALL_NOISE.has(leaf) && !CALL_NOISE.has(name)) {
            calls.push(name);
        }
        match = CALL_PATTERN.exec(text);
    }
    return calls;
}

function dedupe(values: string[]): string[] {
    return Array.from(new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0)))
        .map(value => value.trim());
}

function cap(values: string[]): string[] {
    return dedupe(values).slice(0, MAX_ITEMS_PER_LIST);
}

export type DeterministicChangeExtraction = ChangeExtraction & {
    /** Declaration lines observed in the diff, reused as prompt hints. */
    declarationHints: string[];
};

/**
 * Pattern-based extraction over the parsed diff. Runs before any LLM call so
 * the model receives concrete anchors instead of being asked to invent them,
 * and so a provider outage still leaves the chain with usable targets.
 */
export function extractChangesDeterministically(diffs: DiffData[]): DeterministicChangeExtraction {
    const changedFiles: ChangedFile[] = diffs.map(diff => ({ path: diff.fileName, changeType: diff.status }));
    const symbolIndex = new Map<string, ChangedSymbol>();
    const introducedSymbols: string[] = [];
    const removedSymbols: string[] = [];
    const addedCalls: string[] = [];
    const removedCalls: string[] = [];
    const changedConfigs: string[] = [];
    const changedTypes: string[] = [];
    const changedDependencies: string[] = [];
    const declarationHints: string[] = [];

    for (const diff of diffs) {
        const anchors = diff.diffHunks.map(parseHunkAnchor);
        for (const anchor of anchors) {
            for (const changed of iterateChangedLines(anchor)) {
                const ref = `${diff.fileName}:${changed.line}`;

                const declaration = matchDeclaration(changed.text);
                if (declaration) {
                    const key = `${diff.fileName}::${declaration.name}`;
                    const existing = symbolIndex.get(key);
                    if (existing) {
                        if (!existing.evidenceRefs.includes(ref)) {
                            existing.evidenceRefs.push(ref);
                        }
                        // A declaration touched on both sides is an edit, not a
                        // pure addition or removal.
                        if (
                            (existing.changeKind === 'added' && !changed.added)
                            || (existing.changeKind === 'removed' && changed.added)
                        ) {
                            existing.changeKind = declaration.changeKind;
                        }
                    } else {
                        symbolIndex.set(key, {
                            name: declaration.name,
                            file: diff.fileName,
                            symbolType: declaration.symbolType,
                            changeKind: diff.status === 'added'
                                ? 'added'
                                : diff.status === 'deleted'
                                    ? 'removed'
                                    : declaration.changeKind,
                            evidenceRefs: [ref],
                        });
                    }
                    declarationHints.push(`${ref} ${changed.added ? '+' : '-'} ${changed.text.trim().slice(0, 160)}`);
                    if (changed.added) {
                        introducedSymbols.push(declaration.name);
                    } else {
                        removedSymbols.push(declaration.name);
                    }
                    if (declaration.symbolType === 'type' || declaration.symbolType === 'interface') {
                        changedTypes.push(declaration.name);
                    }
                }

                const calls = collectCalls(changed.text);
                if (changed.added) {
                    addedCalls.push(...calls);
                } else {
                    removedCalls.push(...calls);
                }

                if (isConfigFile(diff.fileName)) {
                    const key = extractConfigKey(changed.text);
                    if (key) {
                        changedConfigs.push(key);
                    }
                }

                if (isDependencyFile(diff.fileName)) {
                    const dependency = extractDependencyName(diff.fileName, changed.text);
                    if (dependency) {
                        changedDependencies.push(dependency);
                    }
                }
            }
        }
    }

    // A call present on both sides of the diff is unchanged context inside an
    // edited region; only calls that appear on exactly one side represent a
    // dependency the change actually introduced or dropped.
    const addedSet = new Set(addedCalls);
    const removedSet = new Set(removedCalls);
    const changedCalls = [
        ...addedCalls.filter(call => !removedSet.has(call)),
        ...removedCalls.filter(call => !addedSet.has(call)),
    ];

    const introduced = new Set(introducedSymbols);
    const removed = new Set(removedSymbols);

    return {
        changedFiles,
        changedSymbols: Array.from(symbolIndex.values()).slice(0, MAX_ITEMS_PER_LIST),
        introducedSymbols: cap(introducedSymbols.filter(name => !removed.has(name))),
        removedSymbols: cap(removedSymbols.filter(name => !introduced.has(name))),
        changedCalls: cap(changedCalls),
        changedConfigs: cap(changedConfigs),
        changedTypes: cap(changedTypes),
        changedDependencies: cap(changedDependencies),
        declarationHints: dedupe(declarationHints).slice(0, 60),
    };
}

function mergeSymbols(
    deterministic: ChangedSymbol[],
    modelSymbols: ChangedSymbol[],
    knownFiles: Set<string>
): ChangedSymbol[] {
    const merged = new Map<string, ChangedSymbol>();
    for (const symbol of deterministic) {
        merged.set(`${symbol.file}::${symbol.name}`, { ...symbol, evidenceRefs: [...symbol.evidenceRefs] });
    }
    for (const symbol of modelSymbols) {
        if (!symbol?.name || !symbol?.file) {
            continue;
        }
        // Reject symbols attributed to files that are not in the change set:
        // the stage must describe this diff, not the repository at large.
        if (!knownFiles.has(symbol.file)) {
            continue;
        }
        const key = `${symbol.file}::${symbol.name}`;
        const existing = merged.get(key);
        if (existing) {
            existing.evidenceRefs = dedupe([...existing.evidenceRefs, ...symbol.evidenceRefs]);
            continue;
        }
        merged.set(key, {
            name: symbol.name,
            file: symbol.file,
            symbolType: symbol.symbolType || 'unknown',
            changeKind: symbol.changeKind || 'unknown',
            evidenceRefs: dedupe(symbol.evidenceRefs),
        });
    }
    return Array.from(merged.values()).slice(0, MAX_ITEMS_PER_LIST);
}

/**
 * Runs Stage 1 end to end. The deterministic result is authoritative for the
 * changed file set and always survives; the model can only add symbols and
 * semantic labels that pattern matching missed.
 */
export async function extractChanges(
    diffs: DiffData[],
    evidencePayload: unknown,
    execution: LLMExecution,
    precomputed?: DeterministicChangeExtraction
): Promise<ChangeExtraction> {
    const deterministic = precomputed ?? extractChangesDeterministically(diffs);
    const knownFiles = new Set(deterministic.changedFiles.map(file => file.path));

    const messages = buildChangeExtractionMessages({
        deterministic,
        evidencePayload,
    });
    const session = execution.createSession(messages);
    const modelExtraction = await execution.run<ChangeExtraction>(session, messages, { requestType: 'changeExtraction' });

    return {
        changedFiles: deterministic.changedFiles,
        changedSymbols: mergeSymbols(
            deterministic.changedSymbols,
            modelExtraction.changedSymbols,
            knownFiles
        ),
        introducedSymbols: cap([...deterministic.introducedSymbols, ...modelExtraction.introducedSymbols]),
        removedSymbols: cap([...deterministic.removedSymbols, ...modelExtraction.removedSymbols]),
        changedCalls: cap([...deterministic.changedCalls, ...modelExtraction.changedCalls]),
        changedConfigs: cap([...deterministic.changedConfigs, ...modelExtraction.changedConfigs]),
        changedTypes: cap([...deterministic.changedTypes, ...modelExtraction.changedTypes]),
        changedDependencies: cap([...deterministic.changedDependencies, ...modelExtraction.changedDependencies]),
    };
}
