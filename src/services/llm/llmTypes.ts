import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DiffData } from '../git/gitTypes';

/**
 * Represents the response from the LLM service.
 */
export interface LLMResponse {
	content: string;
}

/**
 * Represents an error from the LLM service.
 */
export interface LLMError {
	message: string;
	statusCode?: number;
}

/**
 * Interface for an LLM service provider.
 */
export interface LLMService {

	refreshFromSettings(): Promise<void>;

	validateApiKeyAndListModels(apiKey: string): Promise<string[]>;

	setApiKey(apiKey: string): Promise<void>;

	clearApiKey(): Promise<void>;

	generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError>;

}

export abstract class BaseLLMService implements LLMService {
	protected context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	abstract refreshFromSettings(): Promise<void>;
	abstract validateApiKeyAndListModels(apiKey: string): Promise<string[]>;
	abstract setApiKey(apiKey: string): Promise<void>;
	abstract clearApiKey(): Promise<void>;
	abstract generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError>;

	protected async buildJsonDiff(diffs: DiffData[], templatesPath?: string): Promise<string> {
		const time = new Date().toISOString();

		// Settings for workspace files payload
		const cfg = vscode.workspace.getConfiguration();
		const includeWorkspaceFiles = cfg.get<boolean>('gitCommitGenie.workspaceFiles.enabled', true);
		const maxFilesSetting = Math.max(0, cfg.get<number>('gitCommitGenie.workspaceFiles.maxFiles', 2000) || 0);
		const userExcludePatterns = cfg.get<string[]>('gitCommitGenie.workspaceFiles.excludePatterns', []) || [];

		// Parse .gitignore (root of each workspace folder) into patterns
		function parseGitignore(content: string): string[] {
			return content
				.split(/\r?\n/)
				.map(l => l.trim())
				.filter(l => l && !l.startsWith('#'));
		}

		function escapeRegex(s: string): string {
			return s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
		}

		function segmentPatternToRegex(seg: string): string {
			// Convert a single path segment glob to regex (no '/')
			let out = '';
			for (let i = 0; i < seg.length; i++) {
				const ch = seg[i];
				if (ch === '*') out += '[^/]*';
				else if (ch === '?') out += '[^/]';
				else out += escapeRegex(ch);
			}
			return out;
		}

		function globToRegExp(glob: string): { regex: RegExp; negate: boolean; dirOnly: boolean; rooted: boolean } {
			let g = glob.trim();
			let negate = false;
			if (g.startsWith('!')) { negate = true; g = g.slice(1).trim(); }
			const dirOnly = g.endsWith('/');
			if (dirOnly) g = g.slice(0, -1);
			const rooted = g.startsWith('/');
			if (rooted) g = g.slice(1);

			const parts = g.split('/');
			const reParts = parts.map(p => p === '**' ? '.*' : segmentPatternToRegex(p));
			let body = reParts.join('/');
			// If pattern contains '**', allow crossing directory boundaries freely
			body = body.replace(/(^|\/)\.\*($|\/)/g, '(/.*)?');

			let pattern = '';
			if (rooted) {
				pattern = '^' + body + (dirOnly ? '(/.*)?$' : '$');
			} else {
				// match at any depth, but align to segment boundary
				pattern = '(^|.*/)' + body + (dirOnly ? '(/.*)?$' : '($|/.*$)');
			}
			return { regex: new RegExp(pattern), negate, dirOnly, rooted };
		}

		function compilePatterns(patterns: string[]): Array<{ regex: RegExp; negate: boolean }> {
			const compiled: Array<{ regex: RegExp; negate: boolean }> = [];
			for (const p of patterns) {
				try { compiled.push(globToRegExp(p)); } catch { /* ignore bad patterns */ }
			}
			return compiled;
		}

		function isIgnored(relPath: string, rules: Array<{ regex: RegExp; negate: boolean }>): boolean {
			const p = relPath.replace(/\\/g, '/');
			let ignored = false;
			for (const r of rules) {
				if (r.regex.test(p)) {
					ignored = !r.negate; // negation flips to include
				}
			}
			return ignored;
		}

		let workspaceFilesStr = '';
		if (includeWorkspaceFiles) {
			// Collect patterns: all .gitignore files at workspace roots + user excludes
			const allPatterns: string[] = [];
			const folders = vscode.workspace.workspaceFolders || [];
			for (const f of folders) {
				try {
					const gi = path.join(f.uri.fsPath, '.gitignore');
					if (fs.existsSync(gi)) {
						const content = fs.readFileSync(gi, 'utf-8');
						allPatterns.push(...parseGitignore(content));
					}
				} catch { /* ignore */ }
			}
			allPatterns.push(...userExcludePatterns);
			const rules = compilePatterns(allPatterns);

			// Find files across all workspace folders without explicit excludes; hard cap results
			const scanCap = maxFilesSetting > 0 ? Math.max(1000, maxFilesSetting * 5) : 5000;
			const allUris: vscode.Uri[] = [];
			if (folders.length) {
				for (const f of folders) {
					const found = await vscode.workspace.findFiles(new vscode.RelativePattern(f, '**/*'), undefined, scanCap);
					allUris.push(...found);
				}
			} else {
				const found = await vscode.workspace.findFiles('**/*', undefined, scanCap);
				allUris.push(...found);
			}

			// Build unique basenames, applying ignore rules; then hard-truncate to maxFiles
			const names = new Set<string>();
			for (const u of allUris) {
				const rel = vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/');
				if (isIgnored(rel, rules)) continue;
				const base = path.posix.basename(rel);
				if (!base) continue;
				names.add(base);
				if (maxFilesSetting > 0 && names.size >= maxFilesSetting) break;
			}
			workspaceFilesStr = Array.from(names.values()).join('\n');
		}

		let userTemplateContent = '';
		if (templatesPath && typeof templatesPath === 'string' && templatesPath.trim()) {
			try {
				if (fs.existsSync(templatesPath)) {
					const stat = fs.statSync(templatesPath);
					if (stat.isFile() && stat.size > 0) {
						const content = fs.readFileSync(templatesPath, 'utf-8');
						if (content && content.trim().length > 0) {
							userTemplateContent = content;
						}
					}
				}
			} catch {
				userTemplateContent = '';
			}
		}

		// Preferred output language for generated commit message
		let targetLanguage = cfg.get<string>('gitCommitGenie.commitLanguage', 'auto') || 'auto';
		if (!targetLanguage || targetLanguage === 'auto') {
			try { targetLanguage = (vscode.env.language || 'en'); } catch { targetLanguage = 'en'; }
		}

		const data = {
			"diffs": diffs.map(diff => ({
				fileName: diff.fileName,
				rawDiff: diff.rawDiff,
				status: diff.status
			})),
			"current-time": time,
			"workspace-files": workspaceFilesStr,
			"user-template": userTemplateContent,
			"target-language": targetLanguage
		};
		return JSON.stringify(data, null, 2);
	}
}
