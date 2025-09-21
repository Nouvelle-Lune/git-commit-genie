import * as vscode from 'vscode';
import { DiffData, DiffHunk, DiffStatus} from '../git/git_types';
import { API, Change, GitExtension, Repository, Status } from "../git/git";
import * as path from 'path';

/**
 * Gets the Git API from the VS Code Git extension, if available.
 * It waits for the extension to be enabled and the API to be initialized.
 */
async function getGitApi(): Promise<API | undefined> {
	try {
		const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
		if (!gitExtension) {
			console.warn('VS Code Git extension not found.');
			return undefined;
		}
		const exports = gitExtension.getAPI(1);
		return exports;
	} catch (error) {
		console.error('Failed to get Git API:', error);
		return undefined;
	}
}

/**
 * Gets the first available Git repository, waiting for it to be initialized if necessary.
 * @param api The Git API instance.
 * @returns A promise that resolves to the Repository object or null if none is found.
 */
async function getRepository(api: API): Promise<Repository | null> {
	if (api.repositories.length > 0) {
		return api.repositories[0];
	}

	if (api.onDidOpenRepository) {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				console.warn('Timed out waiting for Git repository to open.');
				disposable.dispose();
				resolve(null);
			}, 5000); // 5-second timeout

			const disposable = api.onDidOpenRepository((repo: Repository) => {
				clearTimeout(timeout);
				disposable.dispose();
				resolve(repo);
			});
		});
	}

	return null;
}

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
	public async getDiff(): Promise<DiffData[]> {
		const api = await getGitApi();
		if (!api) {
			throw new Error('The official VS Code Git extension is not enabled or failed to initialize.');
		}

		const repo = await getRepository(api);
		if (!repo) {
			console.warn('No Git repository found or it could not be initialized in time.');
			return [];
		}
		// TODO: 适配vscode的智能提交功能（智能提交会在暂存区为空时自动提交所有更改）
		const indexChanges = repo.state.indexChanges;

		if (indexChanges.length === 0) {
			console.warn('No changes found in the Git repository.');
			return [];
		}

		const diffDataPromises: Promise<DiffData | null>[] = [];


		for (const change of indexChanges) {
			diffDataPromises.push(this.processChange(repo, change));
		}

		const diffs = await Promise.all(diffDataPromises);

		return diffs.filter((d): d is DiffData => d !== null && d.status !== 'ignored');
	}

	/**
	 * Processes a single Change object into a structured DiffData object.
	 * @param repo The repository instance.
	 * @param change The change object from the Git API.
	 * @returns A promise that resolves to a DiffData object, or null if the diff cannot be generated.
	 */
	private async processChange(repo: Repository, change: Change): Promise<DiffData | null> {
		const status: DiffStatus = this.convertStatus(change.status);
		const fileName: string = path.relative(repo.rootUri.fsPath, change.uri.fsPath);

		let rawDiff: string;
		// TODO: 捕获逻辑不够健壮，找不到没有ADD的文件，查阅官方API尝试修复
		try {
			if (this.isStaged(change.status)) {
				rawDiff = await repo.diffIndexWithHEAD(change.uri.fsPath);
			} else {
				//rawDiff = await repo.diffWithHEAD(change.uri.fsPath);
				console.error(`Unstaged diff not implemented for ${fileName}`);
				return null;
			}

		} catch (error) {
			console.error(`Failed to get diff for ${fileName}:`, error);
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