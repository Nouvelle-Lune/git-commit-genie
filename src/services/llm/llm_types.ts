import * as vscode from 'vscode';
import * as fs from 'fs';
import { DiffData } from '../git/git_types';

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

		function buildFileTree(paths: string[]): string {
			const tree: any = {};
			for (const fullPath of paths) {
				const parts = fullPath.split(/[\\/]/).filter(Boolean);
				let current = tree;
				
				for (let i = 0; i < parts.length - 1; i++) {
					const part = parts[i];
					if (!current[part]) {
						current[part] = {};
					}
					current = current[part];
				}
				
				if (parts.length > 0) {
					const fileName = parts[parts.length - 1];
					current[fileName] = null;
				}
			}
			
			return JSON.stringify(tree, null, 4);
		}

		const files = await vscode.workspace.findFiles('**/*');
		const filePaths = files.map(file => file.fsPath);
		const fileTree = buildFileTree(filePaths);

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
			} catch (e: any) {
				userTemplateContent = '';
			}
		}

		const data = {
			"diffs": diffs.map(diff => ({
				fileName: diff.fileName,
				rawDiff: diff.rawDiff,
				status: diff.status // "added" | "modified" | "deleted"
			})),
			"current-time": time,
			"workspace-files": fileTree,
			"user-template": userTemplateContent
		};
		return JSON.stringify(data, null, 4);
	}
	}
