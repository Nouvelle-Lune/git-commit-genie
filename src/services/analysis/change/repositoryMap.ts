// Repository map for the investigation stages.
//
// The planner and the investigation agent both answer "what must still be
// known", and both would otherwise only ever see the changed files. On a real
// run every planned target pointed at a changed file, so the agent re-read the
// diff instead of leaving it: it could not even hypothesise that another test
// asserts the same behaviour, because it did not know those files exist. The
// map supplies that missing scale — which directories exist, how much each
// holds, and which ones this change actually touched — without listing files
// and without spending a tool call.
//
// It is built from the same snapshot manifest the repository tools read from,
// so it can never advertise a file the agent is unable to open.

import { SnapshotEntry } from '../../git/repositorySnapshot';

/**
 * Hard ceiling on directory rows: a map that grows with the repository would
 * spend the planner's context on directories it will never look at.
 */
export const REPOSITORY_MAP_MAX_DIRECTORIES = 60;
const MAX_PATH_COLUMN = 44;
const MAX_LANGUAGE_HINTS = 3;

/** Files at the repository root have no directory of their own. */
const ROOT_LABEL = '(root)';

/** The only modes `RepositorySnapshotReader.read`/`readBatch` return content for. */
const READABLE_MODES = new Set(['100644', '100755']);

/**
 * Code-unit ordering rather than `localeCompare`.
 *
 * The map is part of a prompt whose bytes a replay has to reproduce, and
 * `localeCompare` resolves through the host's ICU data, so the same manifest
 * could order differently on another machine.
 */
function comparePaths(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function buildRepositoryMap(
    entries: readonly SnapshotEntry[],
    changedPaths: ReadonlySet<string>,
): string {
    const filesByDirectory = new Map<string, number>();
    const changedByDirectory = new Map<string, number>();
    const filesByExtension = new Map<string, number>();
    let readableFiles = 0;
    for (const entry of entries) {
        // Symlinks and submodule gitlinks sit in the manifest but the reader
        // refuses them, and a map that counts them would name files the agent
        // cannot open.
        if (!READABLE_MODES.has(entry.mode)) {
            continue;
        }
        readableFiles += 1;
        const separator = entry.path.lastIndexOf('/');
        const directory = separator < 0 ? ROOT_LABEL : entry.path.slice(0, separator);
        filesByDirectory.set(directory, (filesByDirectory.get(directory) ?? 0) + 1);
        if (changedPaths.has(entry.path)) {
            changedByDirectory.set(directory, (changedByDirectory.get(directory) ?? 0) + 1);
        }
        const name = entry.path.slice(separator + 1);
        const dot = name.lastIndexOf('.');
        if (dot > 0) {
            const extension = name.slice(dot);
            filesByExtension.set(extension, (filesByExtension.get(extension) ?? 0) + 1);
        }
    }

    const bySize = (left: string, right: string) => (
        filesByDirectory.get(right)! - filesByDirectory.get(left)!
    ) || comparePaths(left, right);
    // Changed directories are the "you are here" marker, so they are listed
    // first. The cap therefore only ever drops a changed directory when the
    // diff itself touches more directories than the cap; for every smaller
    // change, where the change lives stays visible. Both partitions are ordered
    // identically, so the output is a pure function of the manifest.
    const shown = [
        ...[...changedByDirectory.keys()].sort(bySize),
        ...[...filesByDirectory.keys()].filter(directory => !changedByDirectory.has(directory)).sort(bySize),
    ].slice(0, REPOSITORY_MAP_MAX_DIRECTORIES);
    const width = shown.length
        ? Math.min(MAX_PATH_COLUMN, Math.max(...shown.map(directory => directory.length)))
        : MAX_PATH_COLUMN;
    const languages = [...filesByExtension.entries()]
        .sort((left, right) => (right[1] - left[1]) || comparePaths(left[0], right[0]))
        .slice(0, MAX_LANGUAGE_HINTS)
        .filter(([, count]) => count > 0)
        .map(([extension, count]) => `${extension} ${count}`)
        .join(', ');
    const hidden = filesByDirectory.size - shown.length;
    const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
        `${count} ${count === 1 ? singular : pluralForm}`;

    return [
        `${plural(readableFiles, 'file')}, ${plural(filesByDirectory.size, 'directory', 'directories')}${languages ? ` (${languages})` : ''}`,
        ...shown.map(directory => {
            const files = filesByDirectory.get(directory)!;
            const changed = changedByDirectory.get(directory) ?? 0;
            return `${directory.padEnd(width)}  ${plural(files, 'file')}`
                + (changed ? `   [${changed} changed]` : '');
        }),
        ...(hidden > 0 ? [`(+ ${hidden} more directories)`] : []),
    ].join('\n');
}
