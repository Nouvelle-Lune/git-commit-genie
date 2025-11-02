/**
 * Formatting helpers to minimize token usage when sending tool outputs
 * into the LLM conversation, without losing essential semantics.
 */

import { ToolResult } from './toolTypes';

/** Create compact JSON and text representations of a tool result. */
export function compactToolResultForConversation(
	repoPath: string,
	toolName: string,
	result: ToolResult<any>
): { compactJson: any; compactText: string } {
	const MAX_LIST_LINES = 300;
	const MAX_SNIPPET_CHARS = 160;
	const MAX_CONTENT_CHARS = 8000; // for readFileContent payloads

	try {
		if (!result || (result as any).success === false) {
			const err = (result as any)?.error ? `error: ${(result as any).error}` : 'error';
			return { compactJson: result || { success: false }, compactText: `TOOL_RESULT(${toolName}): ${err}` };
		}

		switch (toolName) {
			case 'readFileContent': {
				const d = (result as any).data || {};
				const filePath: string = String(d.filePath || '');
				const rel = toRelativePath(repoPath, filePath);
				const content: string = String(d.content || '');
				const truncated = content.length > MAX_CONTENT_CHARS;
				const contentSlim = truncated
					? content.slice(0, MAX_CONTENT_CHARS) + `\n...[truncated ${content.length - MAX_CONTENT_CHARS} chars]`
					: content;

				const compactJson = {
					success: true,
					data: {
						filePath: rel || filePath,
						startLine: d.startLine,
						endLine: d.endLine,
						totalLines: d.totalLines,
						hasMore: !!d.hasMore,
						content: contentSlim,
					},
				};

				const header = [
					`TOOL_RESULT(readFileContent)`,
					`file: ${rel || filePath}`,
					`range: ${d.startLine}-${d.endLine}/${d.totalLines} more=${d.hasMore ? 'yes' : 'no'}`,
				].join('\n');

				const compactText = `${header}\nCONTENT_START\n${contentSlim}\nCONTENT_END`;
				return { compactJson, compactText };
			}

			case 'searchFiles': {
				const d = (result as any).data || {};
				const searchType: 'name' | 'content' = d.searchType || 'name';
				const query = String(d.query || '');
				const totalMatches = Number(d.totalMatches || 0);
				const truncated = !!d.truncated;
				const results = Array.isArray(d.results) ? d.results : [];

				if (searchType === 'name') {
					const paths: string[] = [];
					for (const r of results) {
						const p = r?.filePath ? String(r.filePath) : '';
						if (!p) {
							continue;
						}
						paths.push(p);
						if (paths.length >= MAX_LIST_LINES) {
							break;
						}
					}

					const compactJson = {
						success: true,
						data: {
							query,
							searchType,
							totalMatches,
							truncated,
							results: paths,
						},
					};

					const lines = paths.join('\n');
					const more = results.length > paths.length ? `\n...[+${results.length - paths.length} more]` : '';
					const compactText = `TOOL_RESULT(searchFiles): type=name query="${query}" total=${totalMatches} truncated=${truncated}\n${lines}${more}`;
					return { compactJson, compactText };
				}

				// content search
				let count = 0;
				const slimResults: Array<{ filePath: string; matches: Array<{ line: number; snippet: string }> }> = [];
				const textLines: string[] = [];
				for (const r of results) {
					const fp = r?.filePath ? String(r.filePath) : '';
					const ms = Array.isArray(r?.matches) ? r.matches : [];
					const slimMatches: Array<{ line: number; snippet: string }> = [];
					for (const m of ms) {
						if (count >= MAX_LIST_LINES) {
							break;
						}
						const ln = Number(m?.line || 0);
						const raw = String(m?.content || '');
						const snippet = raw.replace(/\r|\n/g, ' ').slice(0, MAX_SNIPPET_CHARS);
						slimMatches.push({ line: ln, snippet });
						textLines.push(`${fp}:${ln}: ${snippet}`);
						count++;
					}
					if (slimMatches.length) {
						slimResults.push({ filePath: fp, matches: slimMatches });
					}
					if (count >= MAX_LIST_LINES) {
						break;
					}
				}

				const compactJson = {
					success: true,
					data: {
						query,
						searchType,
						totalMatches,
						truncated,
						results: slimResults,
					},
				};

				const totalOrig = results?.reduce((s: number, r: any) => s + (Array.isArray(r?.matches) ? r.matches.length : 0), 0) || 0;
				const more = totalOrig > count ? `\n...[+${totalOrig - count} more]` : '';
				const compactText = `TOOL_RESULT(searchFiles): type=content query="${query}" total=${totalMatches} truncated=${truncated}\n${textLines.join('\n')}${more}`;
				return { compactJson, compactText };
			}

			case 'listDirectory': {
				const d = (result as any).data || {};
				const entries = Array.isArray(d.entries) ? d.entries : [];
				const lines: string[] = [];
				for (const e of entries.slice(0, MAX_LIST_LINES)) {
					const nm = String(e?.path || e?.name || '');
					if (!nm) {
						continue;
					}
					lines.push(e?.type === 'directory' ? `${nm}/` : nm);
				}
				const compactJson = {
					success: true,
					data: {
						dirPath: d.dirPath,
						totalCount: Number(d.totalCount || entries.length || 0),
						truncated: entries.length > MAX_LIST_LINES,
						entries: lines,
					},
				};
				const more = entries.length > MAX_LIST_LINES ? `\n...[+${entries.length - MAX_LIST_LINES} more]` : '';
				const compactText = `TOOL_RESULT(listDirectory): dir=${d.dirPath} total=${d.totalCount || entries.length} truncated=${entries.length > MAX_LIST_LINES}\n${lines.join('\n')}${more}`;
				return { compactJson, compactText };
			}
			default: {
				// Fallback: stringify minimally with a cap
				const json = JSON.stringify(result);
				const slim = json.length > 4000 ? json.slice(0, 4000) + `...[truncated ${json.length - 4000}]` : json;
				return { compactJson: result, compactText: `TOOL_RESULT(${toolName}): ${slim}` };
			}
		}
	} catch (e) {
		return { compactJson: result, compactText: `TOOL_RESULT(${toolName}): success` };
	}
}

export function toRelativePath(repoPath: string, fullPath: string): string {
	try {
		if (!fullPath) {
			return '';
		}
		if (!repoPath) {
			return fullPath;
		}
		const base = repoPath.endsWith('/') ? repoPath : repoPath + '/';
		return fullPath.startsWith(base) ? fullPath.slice(base.length) : fullPath;
	} catch {
		return fullPath;
	}
}

