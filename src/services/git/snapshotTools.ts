import { RepositorySnapshotReader, SnapshotSide } from './repositorySnapshot';
import { FileSearchResult, ReadFileOptions, ReadFileResult, SearchFilesOptions, SearchFilesResult, ToolResult } from '../analysis/tools/types';

export async function readSnapshotFile(snapshot: RepositorySnapshotReader, filePath: string, options: ReadFileOptions, excludes: string[], side: SnapshotSide = 'after'): Promise<ToolResult<ReadFileResult>> {
    const observation = await snapshot.observe(filePath, options.startLine ?? 1, options.maxLines ?? 120, excludes, side, 12000);
    return { success: true, data: { filePath: observation.path, content: observation.excerpt,
        totalLines: (await snapshot.read(filePath, side, excludes)).split('\n').length,
        startLine: observation.startLine, endLine: observation.endLine, hasMore: observation.truncated } };
}

export async function searchSnapshot(snapshot: RepositorySnapshotReader, query: string, options: SearchFilesOptions, side: SnapshotSide = 'after'): Promise<ToolResult<SearchFilesResult>> {
    snapshot.metrics.searchCalls += 1;
    const scope = options.searchPath ? snapshot.relative(options.searchPath) : '';
    const regex = options.useRegex ? new RegExp(query, options.caseSensitive ? '' : 'i') : null;
    const needle = options.caseSensitive ? query : query.toLowerCase();
    const matches = (text: string) => regex ? regex.test(text) : (options.caseSensitive ? text : text.toLowerCase()).includes(needle);
    const candidates = snapshot.entries(side, options.excludePatterns)
        .filter(entry => !scope || entry.path.startsWith(`${scope}/`));
    const results: FileSearchResult[] = [];
    const maxResults = Math.min(options.maxResults ?? 20, 50);
    let scanned = 0;
    let skipped = 0;
    for (let offset = 0; offset < candidates.length; offset += 16) {
        snapshot.signal?.throwIfAborted();
        const batch = candidates.slice(offset, offset + 16);
        const contents = options.searchType === 'content' ? await snapshot.readBatch(batch) : new Map<string, string>();
        for (const entry of batch) {
            scanned += 1;
            snapshot.metrics.filesSearched += 1;
            if (options.searchType === 'name') {
                if (matches(entry.path)) { results.push({ filePath: entry.path }); }
            } else {
                const text = contents.get(entry.oid);
                if (text === undefined) { skipped += 1; continue; }
                const hits = text.split('\n').flatMap((line, index) => matches(line) ? [{ line: index + 1, content: line }] : [])
                    .slice(0, options.maxMatchesPerFile ?? 3);
                if (hits.length) { results.push({ filePath: entry.path, matches: hits }); }
            }
            if (results.length >= maxResults) { break; }
        }
        if (results.length >= maxResults) { break; }
    }
    return { success: true, data: { query, searchType: options.searchType, results,
        totalMatches: results.reduce((total, file) => total + (file.matches?.length ?? 1), 0), truncated: scanned < candidates.length },
        warnings: skipped ? [`${skipped} non-text, non-regular, or oversized snapshot entries were not searched.`] : [] };
}

export function listSnapshotDirectory(snapshot: RepositorySnapshotReader, candidate: string, excludes: string[], side: SnapshotSide = 'after') {
    const scope = snapshot.relative(candidate);
    const entries = new Map<string, { name: string; type: 'file' | 'directory'; path: string }>();
    for (const entry of snapshot.entries(side, excludes)) {
        if (scope && !entry.path.startsWith(`${scope}/`)) { continue; }
        const suffix = scope ? entry.path.slice(scope.length + 1) : entry.path;
        const parts = suffix.split('/');
        entries.set(parts[0], { name: parts[0], type: parts.length > 1 ? 'directory' : 'file', path: entry.path });
    }
    if (scope && !entries.size) { throw new Error(`Snapshot directory is unavailable: ${scope}`); }
    return { success: true, data: { entries: [...entries.values()], dirPath: scope, totalCount: entries.size } };
}
