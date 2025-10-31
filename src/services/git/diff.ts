import * as vscode from 'vscode';
import { DiffData, DiffHunk, DiffStatus } from './gitTypes';
import { Change, Repository, Status } from "../git/git";
import * as path from 'path';
import { spawn } from 'child_process';
import { logger } from '../logger';
import { buildNotebookSourceOnlyDiff } from './ipynbDiff';

import { RepoService } from "../repo/repo";


/**
 * A service for analyzing Git diffs.
 * It uses the VS Code Git API to fetch structured change data for reliability
 * and then processes each change individually.
 */
export class DiffService {

	/**
	 * Gets all changes (staged and unstaged) as structured data.
	 *
	 * @returns A promise that resolves to an array of DiffData objects,
	 *          or an empty array if there are no changes.
	 */

	private repoService: RepoService;
	constructor(repoService: RepoService) {
		this.repoService = repoService;
	}

	public async getDiff(repo: Repository): Promise<DiffData[]> {

		let indexChanges = repo.state.indexChanges;
		
		let stagedTemporarily = false;

		const api = this.repoService.getGitApi();
		if (!api) { return []; }

		const gitPath = api.git.path;

		const cwd = repo.rootUri.fsPath;

		const runGit = async (args: string[]) => new Promise<void>((resolve, reject) => {
			const child = spawn(gitPath, args, { cwd });
			let stderr = '';
			child.stderr.on('data', d => { stderr += String(d); });
			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) { resolve(); }
				else { reject(new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr}`)); }
			});
		});

		if (indexChanges.length === 0) {
			const autoStage = vscode.workspace.getConfiguration().get<boolean>('gitCommitGenie.autoStageAllForDiff', false);
			if (autoStage) {
				try {
					await runGit(['add', '-A']);
					stagedTemporarily = true;
					await repo.status();
					indexChanges = repo.state.indexChanges;
				} catch (e) {
					logger.warn('[Genie] Auto-stage for diff failed:', e);
				}
			}
			if (indexChanges.length === 0) {
				logger.warn('No changes found in the Git repository.');
				return [];
			}
		}

		const diffDataPromises: Promise<DiffData | null>[] = [];
		for (const change of indexChanges) {
			diffDataPromises.push(this.processChange(repo, change));
		}
		const diffs = await Promise.all(diffDataPromises);

		// Restore index if we temporarily staged files
		if (stagedTemporarily) {
			try {
				await runGit(['reset', '-q', 'HEAD', '--', '.']);
				await repo.status();
			} catch (e2) {
				logger.warn('[Genie] Auto-stage cleanup failed:', e2);
			}
		}

		return diffs.filter((d): d is DiffData => d !== null && d.status !== 'ignored');
	}

	// Close outer block if any lingering scopes existed (no-op stylistically)


	/**
	 * Processes a single Change object into a structured DiffData object.
	 * @param repo The repository instance.
	 * @param change The change object from the Git API.
	 * @returns A promise that resolves to a DiffData object, or null if the diff cannot be generated.
	 */
	private async processChange(repo: Repository, change: Change): Promise<DiffData | null> {
		const status: DiffStatus = this.convertStatus(change.status);
		const fileName: string = path.relative(repo.rootUri.fsPath, change.uri.fsPath);

		// Fast-path: treat known binary/data containers as non-diffable and synthesize a concise summary
		if (this.isBinaryLike(fileName)) {
			const parentDir = this.getParentDirectoryLabel(fileName);
			const ext = (path.extname(fileName) || '').replace(/^\./, '').toLowerCase() || 'binary';
			const kind = this.classifyBinaryKind(ext);
			const lines: string[] = [
				'== Binary/Data file change ==',
				`Type: ${kind}${ext ? ` (${ext})` : ''}`,
				`Status: ${status}`,
				`File: ${fileName}`,
				`Parent: ${parentDir}`
			];
			if (status === 'renamed') {
				const fromPath = path.relative(repo.rootUri.fsPath, (change.originalUri || change.uri).fsPath).replace(/\\/g, '/');
				const toPath = path.relative(repo.rootUri.fsPath, (change.renameUri || change.uri).fsPath).replace(/\\/g, '/');
				lines.push(`Rename: ${fromPath} → ${toPath}`);
			}
			const rawDiff = lines.join('\n');

			return {
				fileName,
				status,
				diffHunks: [],
				rawDiff,
			};
		}

		let rawDiff: string;
		try {
			// Special handling for Jupyter notebooks: always build a source-only diff that ignores outputs/metadata
			if (fileName.endsWith('.ipynb')) {
				try {
					const nbDiff = await buildNotebookSourceOnlyDiff(repo, change);
					if (nbDiff && nbDiff.trim().length > 0) {
						rawDiff = nbDiff;
						// Parse and return immediately to avoid falling back to raw JSON diff noise
						const diffHunks: DiffHunk[] = this.parseDiff(rawDiff);
						return {
							fileName,
							status,
							diffHunks,
							rawDiff,
						};
					}
				} catch (nbErr) {
					logger.warn('Notebook diff failed, falling back to raw diff:', nbErr);
				}
			}

			if (this.isStaged(change.status)) {

				if (status === 'renamed') {
					const fullDiff = await repo.diff(true);

					rawDiff = this.extractFileFromFullDiff(fullDiff, change, repo);

					// If extraction fails, fall back to the original method
					if (!rawDiff) {
						rawDiff = await repo.diffIndexWithHEAD(change.uri.fsPath);
					}
				} else {
					rawDiff = await repo.diffIndexWithHEAD(change.uri.fsPath);
				}
			} else {
				logger.error(`Unstaged diff not implemented for ${fileName}`);
				return null;
			}

		} catch (error) {
			logger.error(`Failed to get diff for ${fileName}:`, error);
			return null;
		}

		if (!rawDiff) {
			return null;
		}

		const diffHunks: DiffHunk[] = this.parseDiff(rawDiff);

		return {
			fileName,
			status,
			diffHunks,
			rawDiff,
		};
	}

	/**
	 * Returns a friendly parent directory label limited to the repository scope.
	 * If the file is at repo root, returns "[repo-root]".
	 */
	private getParentDirectoryLabel(relPath: string): string {
		const norm = relPath.replace(/\\/g, '/');
		const idx = norm.lastIndexOf('/');
		if (idx === -1) { return '[repo-root]'; }
		const dir = norm.substring(0, idx);
		// Show only the immediate parent folder name for brevity
		const lastSep = dir.lastIndexOf('/');
		return lastSep === -1 ? dir : dir.substring(lastSep + 1);
	}

	/**
	 * Classify binary-like files by extension into a coarse type for messaging.
	 */
	private classifyBinaryKind(ext: string): string {
		const archives = new Set(['zip', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'zst', 'lz4', '7z', 'rar', 'tar', 'jar', 'war', 'ear', 'apk', 'ipa']);
		const databases = new Set(['sqlite', 'sqlite3', 'db', 'db3', 'mdb', 'accdb', 'realm', 'parquet', 'feather', 'orc', 'avro', 'dbf']);
		const media = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp', 'ico', 'svgz', 'pdf', 'mp3', 'wav', 'flac', 'mp4', 'mkv', 'mov', 'avi', 'webm']);
		const binaries = new Set(['bin', 'iso', 'dll', 'so', 'dylib', 'exe', 'o', 'a', 'class', 'wasm']);
		if (archives.has(ext)) { return 'archive'; }
		if (databases.has(ext)) { return 'database'; }
		if (media.has(ext)) { return 'media'; }
		if (binaries.has(ext)) { return 'binary'; }
		return 'binary';
	}

	/**
	 * Heuristic: whether a path likely refers to a binary/data file where text diff is not useful.
	 */
	private isBinaryLike(relPath: string): boolean {
		const ext = (path.extname(relPath) || '').replace(/^\./, '').toLowerCase();
		if (!ext) { return false; }
		const binaryExts = new Set<string>([
			// Archives & compressed
			'zip', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'zst', 'lz4', '7z', 'rar', 'tar', 'jar', 'war', 'ear', 'apk', 'ipa',
			// Databases & data containers
			'sqlite', 'sqlite3', 'db', 'db3', 'mdb', 'accdb', 'realm', 'parquet', 'feather', 'orc', 'avro', 'dbf', 'hdf5', 'h5',
			// Media & documents commonly binary
			'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp', 'ico', 'svgz', 'pdf', 'mp3', 'wav', 'flac', 'mp4', 'mkv', 'mov', 'avi', 'webm',
			// Compiled/binary objects
			'bin', 'iso', 'dll', 'so', 'dylib', 'exe', 'o', 'a', 'class', 'wasm'
		]);
		return binaryExts.has(ext);
	}

	/**
	 * Extracts the diff for a specific file from the full diff output.
	 */
	private extractFileFromFullDiff(fullDiff: string, change: Change, repo: Repository): string {
		const lines = fullDiff.split('\n');
		// Get the full relative path from repo root, normalize path separators for Git
		const relativeFilePath = path.relative(repo.rootUri.fsPath, change.uri.fsPath).replace(/\\/g, '/');

		let startIndex = -1;
		let endIndex = -1;

		// Find the start of the diff for the specific file
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Use regex to strictly match the diff header for this specific file
			// This handles renames where a/ and b/ paths might be different
			const escapedPath = relativeFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

		// Find the end of the diff for the specific file
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

		const matchResult = lines[hunkStartPosition].match(/@@.*?@@/g);
		const header: string = matchResult ? matchResult[0] : '';

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

	private isStaged(status: Status): boolean {
		switch (status) {
			case Status.INDEX_ADDED:
			case Status.INDEX_DELETED:
			case Status.INDEX_MODIFIED:
			case Status.INDEX_RENAMED:
				return true;
			default:
				return false;
		}

	}

	/**
	 * Converts a numeric Status from the Git API to a string-based DiffStatus.
	 * @param status The status from the Git API.
	 * @returns The corresponding DiffStatus.
	 */
	private convertStatus(status: Status): DiffStatus {
		switch (status) {
			case Status.INDEX_ADDED:
			case Status.ADDED_BY_US:
			case Status.ADDED_BY_THEM:
			case Status.BOTH_ADDED:
			case Status.INTENT_TO_ADD:
				return 'added';
			case Status.INDEX_DELETED:
			case Status.DELETED:
			case Status.DELETED_BY_US:
			case Status.DELETED_BY_THEM:
			case Status.BOTH_DELETED:
				return 'deleted';
			case Status.INDEX_MODIFIED:
			case Status.MODIFIED:
			case Status.BOTH_MODIFIED:
				return 'modified';
			case Status.INDEX_RENAMED:
			case Status.INTENT_TO_RENAME:
				return 'renamed';
			case Status.UNTRACKED:
				return 'untracked';
			case Status.IGNORED:
				return 'ignored';
			default:
				return 'modified';
		}
	}

}
