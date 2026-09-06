import * as vscode from 'vscode';
import { DiffData, DiffHunk, DiffStatus } from './gitTypes';
import { Repository } from "../git/git";
import { spawn } from 'child_process';
import { RepositorySnapshotReader, snapshotGit } from './repositorySnapshot';
import { buildNotebookSourceOnlyDiff } from './ipynbDiff';

import { RepoService } from "../repo/repo";


/**
 * Uses the VS Code Git executable with immutable trees so diff extraction and
 * investigation read the same version, including partially staged changes.
 */
export class DiffService {

	private repoService: RepoService;
	constructor(repoService: RepoService) {
		this.repoService = repoService;
	}

	public async captureSnapshot(repo: Repository, signal?: AbortSignal): Promise<RepositorySnapshotReader> {
		const api = this.repoService.getGitApi();
		if (!api) { throw new Error('VS Code Git API is unavailable.'); }
		const autoStage = vscode.workspace.getConfiguration().get<boolean>('gitCommitGenie.autoStageAllForDiff', false);
		return RepositorySnapshotReader.capture(repo.rootUri.fsPath, api.git.path, autoStage, signal);
	}

	public async getDiff(repo: Repository, snapshot?: RepositorySnapshotReader): Promise<DiffData[]> {
		const current = snapshot ?? await this.captureSnapshot(repo);
		const git = (args: string[]) => snapshotGit(current.gitPath, current.root, args, { signal: current.signal });
		const { beforeTree, afterTree } = current.identity;
		const records = (await git(['diff', '--name-status', '-z', '--find-renames', beforeTree, afterTree])).toString().split('\0');
		const diffs: DiffData[] = [];
		for (let index = 0; index < records.length - 1;) {
			const token = records[index++];
			const oldPath = records[index++];
			const renamed = token.startsWith('R');
			const fileName = renamed ? records[index++] : oldPath;
			if (!fileName) { throw new Error('Invalid Git diff path record.'); }
			const status: DiffStatus = renamed ? 'renamed' : token === 'A' ? 'added' : token === 'D' ? 'deleted' : 'modified';
			let rawDiff: string;
			if (fileName.endsWith('.ipynb')) {
				const before = current.entry(oldPath, 'before') ? await current.read(oldPath, 'before') : null;
				const after = current.entry(fileName) ? await current.read(fileName) : null;
				rawDiff = buildNotebookSourceOnlyDiff(before, after, oldPath, fileName);
			} else {
				rawDiff = (await git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3', beforeTree, afterTree, '--', ...new Set([oldPath, fileName])])).toString();
			}
			diffs.push({ fileName, status, rawDiff, diffHunks: this.parseDiff(rawDiff) });
		}
		return diffs;
	}

	public async getCommitDiff(repo: Repository, commitHash: string): Promise<DiffData[]> {
		const api = this.repoService.getGitApi();
		if (!api) { return []; }

		const gitPath = api.git.path;
		const cwd = repo.rootUri.fsPath;

		const [fullDiff, nameStatus] = await Promise.all([
			this.runGitCapture(gitPath, cwd, ['show', '--format=', '--find-renames', '--patch', '--unified=3', commitHash]),
			this.runGitCapture(gitPath, cwd, ['show', '--format=', '--name-status', '--find-renames', commitHash])
		]);

		const records = this.parseCommitNameStatus(nameStatus);
		const out: DiffData[] = [];
		for (const record of records) {
			const rawDiff = this.extractFileDiffFromFullDiff(fullDiff, record.path) || this.buildSyntheticCommitDiff(record);
			out.push({
				fileName: record.path,
				status: record.status,
				diffHunks: this.parseDiff(rawDiff),
				rawDiff,
			});
		}
		return out;
	}

	private async runGitCapture(gitPath: string, cwd: string, args: string[]): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			const child = spawn(gitPath, args, { cwd });
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', d => { stdout += String(d); });
			child.stderr.on('data', d => { stderr += String(d); });
			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) { resolve(stdout); }
				else { reject(new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr}`)); }
			});
		});
	}

	private extractFileDiffFromFullDiff(fullDiff: string, relativeFilePath: string): string {
		const lines = fullDiff.split('\n');
		let startIndex = -1;
		let endIndex = -1;
		const escapedPath = relativeFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const exactMatchA = new RegExp(`^diff --git a/${escapedPath} b/`);
			const exactMatchB = new RegExp(`^diff --git a/.* b/${escapedPath}\\s*$`);
			if (line.startsWith('diff --git') && (exactMatchA.test(line) || exactMatchB.test(line))) {
				startIndex = i;
				break;
			}
		}

		if (startIndex === -1) {
			return '';
		}
		for (let i = startIndex + 1; i < lines.length; i++) {
			if (lines[i].startsWith('diff --git')) {
				endIndex = i;
				break;
			}
		}
		if (endIndex === -1) {
			endIndex = lines.length;
		}
		return lines.slice(startIndex, endIndex).join('\n');
	}

	private parseCommitNameStatus(raw: string): Array<{ path: string; status: DiffStatus; previousPath?: string }> {
		const out: Array<{ path: string; status: DiffStatus; previousPath?: string }> = [];
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) { continue; }
			const parts = trimmed.split('\t');
			const token = (parts[0] || '').toUpperCase();
			if (token.startsWith('R') && parts.length >= 3) {
				out.push({ path: parts[2], previousPath: parts[1], status: 'renamed' });
				continue;
			}
			if (parts.length < 2) { continue; }
			const status = token.startsWith('A')
				? 'added'
				: token.startsWith('D')
					? 'deleted'
					: 'modified';
			out.push({ path: parts[1], status });
		}
		return out;
	}

	private buildSyntheticCommitDiff(record: { path: string; status: DiffStatus; previousPath?: string }): string {
		const lines = [
			'== Historical commit file change ==',
			`File: ${record.path}`,
			`Status: ${record.status}`
		];
		if (record.previousPath) {
			lines.push(`Previous: ${record.previousPath}`);
		}
		return lines.join('\n');
	}

	/**
	 * Parses a raw diff string into hunks, additions, and deletions.
	 * @param diffOutput The raw diff string for a single file.
	 * @returns An object containing the parsed hunks, additions, and deletions.
	 */
	private parseDiff(diffOutput: string): DiffHunk[] {
		const cleanOutput: string = diffOutput.replace(/[\u001b\u009b][[()#;?]*.?[0-9A-Za-z/]*/g, '').trim();
		if (!cleanOutput) {
			return [];
		}

		const lines: string[] = cleanOutput.split('\n');

		const hunkStartPositions: number[] = [];
		let pos: number = 0;
		while (pos < lines.length) {
			if (lines[pos].startsWith('@@')) {
				hunkStartPositions.push(pos);
			}
			pos++;
		}

		const diffHunks: DiffHunk[] = [];
		diffHunks.push(...hunkStartPositions.map(startPos => this.parseHunk(startPos, lines)));

		return diffHunks;
	}

	private parseHunk(hunkStartPosition: number, lines: string[]): DiffHunk {
		const additions: string[] = [];
		const deletions: string[] = [];
		const contentLines: string[] = [];

		// Keep Git's optional section heading because it can identify the function
		// or declaration that owns a body-only change.
		const header: string = lines[hunkStartPosition];

		let pos = hunkStartPosition + 1;
		while (pos < lines.length && !lines[pos].startsWith('@@')) {
			const line = lines[pos];
			contentLines.push(line);
			if (line.startsWith('+') && !line.startsWith('+++')) {
				additions.push(line);
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				deletions.push(line);
			}
			pos++;
		}

		const content: string = contentLines.join('\n');

		return {
			header,
			content,
			additions,
			deletions
		};

	}

}
