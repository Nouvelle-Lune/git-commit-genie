import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { AIRepositoryAnalysisService } from '../services/analysis/aiRepoAnalysis';

/**
 * Commands for tool-driven AI repository analysis
 */
export class AiRepoAnalysisCommands {
  constructor(
    private context: vscode.ExtensionContext,
    private serviceRegistry: ServiceRegistry,
    private statusBarManager: StatusBarManager
  ) {}

  async register(): Promise<void> {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('git-commit-genie.runAiRepositoryAnalysis', this.runAiRepositoryAnalysis.bind(this))
    );
  }

  private async runAiRepositoryAnalysis(): Promise<void> {
    const repoService = this.serviceRegistry.getRepoService();
    const repositoryPath = await repoService.pickRepository();
    if (!repositoryPath) { return; }

    const currentLLM = this.serviceRegistry.getCurrentLLMService();
    const aiService = new AIRepositoryAnalysisService(this.context, currentLLM, repoService);
    aiService.setLLMResolver((provider: string) => this.serviceRegistry.getLLMService(provider));

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Running AI repository analysis (experimental)…',
      cancellable: true
    }, async (progress, token) => {
      this.statusBarManager.setRepoAnalysisRunning(true, repositoryPath);
      try {
        token.onCancellationRequested(() => aiService.cancelCurrentAnalysis());
        const result = await aiService.updateAnalysis(repositoryPath);
        if (result === 'success') {
          const analysis = await aiService.getAnalysis(repositoryPath);
          if (analysis) {
            const mdPath = await aiService.saveAnalysisMarkdown(repositoryPath, analysis, { overwrite: false });
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
            await vscode.window.showTextDocument(doc);
          }
        }
      } finally {
        this.statusBarManager.setRepoAnalysisRunning(false);
      }
    });
  }
}
