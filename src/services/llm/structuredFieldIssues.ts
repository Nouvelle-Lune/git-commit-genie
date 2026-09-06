import { z } from 'zod';
import type { StructuredFieldIssue } from '../../ui/pipelineDisplay';

/**
 * Turns a Zod rejection into localizable, field-level diagnostics.
 *
 * Rendering `String(zodError)` in the log made every failure look the same and
 * hid the one detail that lets a user act: which field broke which limit. The
 * numbers and type names are kept structured so the Webview can phrase them in
 * the user's language, and the same list is fed back to the model as the
 * correction instruction.
 */

/** Enough to name every distinct problem without turning a log row into a dump. */
const MAX_FIELD_ISSUES = 12;
const MAX_VALUE_LENGTH = 60;

/**
 * Flattened view of `z.core.$ZodIssue`. The union has one variant per check and
 * only a subset of variants carries each field, so reading them through one
 * optional-field view keeps the mapping below readable.
 */
interface ZodIssueView {
    code?: string;
    origin?: string;
    maximum?: unknown;
    minimum?: unknown;
    expected?: unknown;
    pattern?: unknown;
    format?: unknown;
    values?: unknown;
    keys?: unknown;
    message: string;
    path: ReadonlyArray<PropertyKey>;
}

export function buildStructuredFieldIssues(error: z.ZodError, input: unknown): StructuredFieldIssue[] {
    const seen = new Set<string>();
    const collected: StructuredFieldIssue[] = [];
    for (const raw of error.issues) {
        const issue = raw as unknown as ZodIssueView;
        for (const described of describeIssue(issue, input)) {
            const key = [
                described.path,
                described.kind,
                described.limit ?? '',
                described.count ?? '',
                described.expected ?? '',
                described.actual ?? '',
                described.message ?? '',
            ].join('|');
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            collected.push(described);
            if (collected.length >= MAX_FIELD_ISSUES) {
                return collected;
            }
        }
    }
    return collected;
}

/** Renders field issues as a model-facing correction list. */
export function formatFieldIssuesForModel(issues: StructuredFieldIssue[]): string[] {
    return issues.map(issue => {
        switch (issue.kind) {
            case 'tooManyItems':
                return `${issue.path}: contains ${issue.count} items but at most ${issue.limit} are allowed. Keep only the ${issue.limit} most directly supporting entries.`;
            case 'tooFewItems':
                return `${issue.path}: contains ${issue.count} items but at least ${issue.limit} are required.`;
            case 'invalidFormat':
                return `${issue.path}: value ${issue.actual} does not match the required format ${issue.expected}.`;
            case 'invalidType':
                return `${issue.path}: expected ${issue.expected} but received ${issue.actual}.`;
            case 'missing':
                return `${issue.path}: required field is absent.`;
            case 'notAllowed':
                return `${issue.path}: key is not part of the schema and must be removed.`;
            case 'custom':
                return `${issue.path}: ${issue.message}`;
        }
    });
}

function describeIssue(issue: ZodIssueView, input: unknown): StructuredFieldIssue[] {
    const path = formatIssuePath(issue.path);
    const value = resolveValue(input, issue.path);

    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
        return issue.keys
            .filter((key): key is string => typeof key === 'string')
            .map(key => ({ path: path === ROOT_PATH ? key : `${path}.${key}`, kind: 'notAllowed' as const }));
    }

    if (issue.code === 'too_big' && issue.origin === 'array' && typeof issue.maximum === 'number') {
        return [{
            path,
            kind: 'tooManyItems',
            limit: issue.maximum,
            count: Array.isArray(value) ? value.length : 0,
        }];
    }

    if (issue.code === 'too_small' && issue.origin === 'array' && typeof issue.minimum === 'number') {
        return [{
            path,
            kind: 'tooFewItems',
            limit: issue.minimum,
            count: Array.isArray(value) ? value.length : 0,
        }];
    }

    if (issue.code === 'invalid_format') {
        return [{
            path,
            kind: 'invalidFormat',
            expected: String(issue.pattern ?? issue.format ?? ''),
            actual: formatValue(value),
        }];
    }

    if (issue.code === 'invalid_type') {
        return [containerHasKey(input, issue.path)
            ? { path, kind: 'invalidType', expected: String(issue.expected ?? ''), actual: formatValue(value) }
            : { path, kind: 'missing' }];
    }

    if (issue.code === 'invalid_value' && Array.isArray(issue.values)) {
        return [{
            path,
            kind: 'invalidType',
            expected: issue.values.map(entry => formatValue(entry)).join(' | '),
            actual: formatValue(value),
        }];
    }

    return [{ path, kind: 'custom', message: issue.message }];
}

const ROOT_PATH = '(root)';

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
    if (!path.length) {
        return ROOT_PATH;
    }
    return path.reduce<string>((rendered, segment) => {
        if (typeof segment === 'number') {
            return `${rendered}[${segment}]`;
        }
        const key = String(segment);
        return rendered ? `${rendered}.${key}` : key;
    }, '');
}

function resolveValue(input: unknown, path: ReadonlyArray<PropertyKey>): unknown {
    let current = input;
    for (const segment of path) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<PropertyKey, unknown>)[segment];
    }
    return current;
}

/** Distinguishes "wrong type" from "absent" so the model is told the right thing to fix. */
function containerHasKey(input: unknown, path: ReadonlyArray<PropertyKey>): boolean {
    if (!path.length) {
        return true;
    }
    const container = resolveValue(input, path.slice(0, -1));
    if (container === null || typeof container !== 'object') {
        return false;
    }
    const last = path[path.length - 1];
    return typeof last === 'number'
        ? Array.isArray(container) && last < container.length
        : Object.prototype.hasOwnProperty.call(container, last);
}

function formatValue(value: unknown): string {
    if (value === undefined) {
        return 'undefined';
    }
    if (Array.isArray(value)) {
        return `an array of ${value.length} item(s)`;
    }
    if (value !== null && typeof value === 'object') {
        return 'an object';
    }
    const rendered = JSON.stringify(value) ?? String(value);
    return rendered.length > MAX_VALUE_LENGTH ? `${rendered.slice(0, MAX_VALUE_LENGTH)}…` : rendered;
}
