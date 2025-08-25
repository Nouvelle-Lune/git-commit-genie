// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { DiffService } from './services/git/diff';
import { OpenAIService } from './providers/openai';
import { LLMError } from './services/llm/llm_types';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "git-commit-genie" is now active!');

	const diffService = new DiffService();
	const llmService = new OpenAIService(context);

	const generateCommitMessageCommand = vscode.commands.registerCommand('git-commit-genie.generateCommitMessage', async () => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.SourceControl,
			title: "AI Generating Commit Message...",
			cancellable: false
		}, async (progress) => {
			try {
				const diffs = await diffService.getDiff();

				if (diffs.length === 0) {
					vscode.window.showInformationMessage("No staged changes found.");
					return;
				}
				
				// For now, we combine all raw diffs for the LLM prompt.
				// This can be enhanced later to handle large diffs.
				const combinedRawDiff = diffs.map(d => d.rawDiff).join('\n');
				console.log('Combined Raw Diff:', combinedRawDiff);

				const result = await llmService.generateCommitMessage({
					fileName: 'combined',
					status: 'modified',
					diffHunks: [],
					rawDiff: combinedRawDiff,
				});

				if ('content' in result) {
					const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
					const api = gitExtension.getAPI(1);
					const repo = api.repositories[0];
					if (repo) {
						repo.inputBox.value = result.content;
					}
				} else {
					vscode.window.showErrorMessage(`Error generating commit message: ${result.message}`);
				}
			} catch (error: any) {
				vscode.window.showErrorMessage(`Failed to generate commit message: ${error.message}`);
			}
		});
	});

}

// This method is called when your extension is deactivated
export function deactivate() {
	console.log('Your extension "git-commit-genie" is now deactivated.');
}
