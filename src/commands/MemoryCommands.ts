import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { RepositorySnapshotReader } from '../services/git/repositorySnapshot';
import { createHash } from 'crypto';
import { createPipelineReplayAdapter, replayManifestSchema, runSequentialReplay, validateReplayHistory } from '../services/memory/benchmark';
import { generateCommitMessageChain } from '../services/chain/commitMessageChain';
import { createConsolidationRunner, describeConsolidationResult, logMemoryOperation, readMemorySettings } from '../services/memory/service';
import { resolveInvestigationSettings } from '../services/analysis/change/investigation/config';

/** Read-only inspection plus explicit repository-scoped maintenance commands. */
export class MemoryCommands {
    private readonly documents = new Map<string, string>();
    constructor(private readonly context: vscode.ExtensionContext, private readonly services: ServiceRegistry) {}

    register(): void {
        this.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('genie-memory', {
            provideTextDocumentContent: uri => this.documents.get(uri.toString()) ?? '',
        }));
        this.context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.manageMemory', async () => {
            try { await this.manage(); } catch (error) {
                const message = vscode.l10n.t('Memory operation failed: {0}', error instanceof Error ? error.message : String(error));
                vscode.window.setStatusBarMessage(message, 5000);
                await vscode.window.showErrorMessage(message);
            }
        }));
        this.context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.benchmarkMemory', async () => {
            try { await this.replay(); } catch (error) { this.services.getMemoryService().warn(error); }
        }));
    }

    private async replay(): Promise<void> {
        const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, title: vscode.l10n.t('Select a Memory replay manifest') });
        if (!selected?.[0]) { return; }
        const input = replayManifestSchema.omit({ configurationFingerprint: true }).parse(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(selected[0])).toString('utf8')));
        const models = input.models.map(id => {
            const model = this.services.getModel(id);
            if (!model) { throw new Error(`Replay model is not configured: ${id}`); }
            return model;
        });
        const fingerprint = () => createHash('sha256').update(JSON.stringify({
            models: input.models.map(id => this.services.getModel(id)),
            settings: vscode.workspace.getConfiguration('gitCommitGenie'),
        })).digest('hex');
        const manifest = { ...input, configurationFingerprint: fingerprint() };
        const generations = input.repositories.reduce((count, repository) => count + repository.commits.length, 0) * models.length * input.repetitions * 3;
        const confirm = vscode.l10n.t('Run paid replay');
        if (await vscode.window.showWarningMessage(vscode.l10n.t('This replay runs {0} commit generations plus bounded background consolidation using your configured providers. It incurs API costs and does not change repository checkouts.', generations), { modal: true }, confirm) !== confirm) { return; }
        const gitPath = this.services.getRepoService().getGitApi()?.git.path;
        if (!gitPath) { throw new Error('VS Code Git API is unavailable.'); }
        const abort = new AbortController();
        const cancellation = new vscode.CancellationTokenSource();
        const memory = this.services.getMemoryService(); memory.beginForeground();
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Repository Memory replay'), cancellable: true }, async (progress, token) => {
                const disposable = token.onCancellationRequested(() => { abort.abort(); cancellation.cancel(); });
                try {
                    await validateReplayHistory(manifest, gitPath, abort.signal);
                    const adapter = createPipelineReplayAdapter({ gitPath, diffs: this.services.getDiffService(),
                        repository: root => {
                            const repository = this.services.getRepoService().getRepositories().find(repo => repo.rootUri.fsPath === root);
                            if (!repository) { throw new Error(`Replay repository must be open in this window: ${root}`); }
                            return repository;
                        },
                        execution: (id, root) => {
                            const service = this.services.getLLMService(id);
                            if (!service) { throw new Error(`Replay model disappeared: ${id}`); }
                            return service.createExecution(root, { token: cancellation.token });
                        },
                        runChain: generateCommitMessageChain, consolidation: createConsolidationRunner, settings: readMemorySettings(),
                        excludes: [...resolveInvestigationSettings().excludePatterns, ...vscode.workspace.getConfiguration('gitCommitGenie.memory').get<string[]>('excludePatterns', [])],
                    });
                    const output = await runSequentialReplay({ manifest, outputRoot: vscode.Uri.joinPath(this.context.globalStorageUri, 'memory-replays').fsPath,
                        adapter, signal: abort.signal, assertEnvironment: () => {
                            if (fingerprint() !== manifest.configurationFingerprint) { throw new Error('Replay settings changed; resume with the original model and configuration.'); }
                        }, onProgress: (done, total, item) => progress.report({ message: `${done}/${total} · ${item.model} · ${item.group} · ${item.commit.slice(0, 8)}`, increment: 100 / total }) });
                    void vscode.window.showInformationMessage(vscode.l10n.t('Memory replay checkpoints saved to {0}. Quality and cost gains require comparison; successful execution alone is not evidence of improvement.', output));
                } finally { disposable.dispose(); }
            });
        } finally { cancellation.dispose(); memory.endForeground(); }
    }

    private async manage(): Promise<void> {
        const repositories = this.services.getRepoService().getRepositories();
        if (!repositories.length) { throw new Error(vscode.l10n.t('No Git repository is open.')); }
        const selected = repositories.length === 1 ? repositories[0] : (await vscode.window.showQuickPick(repositories.map(repo => ({
            label: this.services.getRepoService().getRepositoryLabel(repo), description: repo.rootUri.fsPath, repo,
        })), { placeHolder: vscode.l10n.t('Select repository memory') }))?.repo;
        if (!selected) { return; }
        const gitPath = this.services.getRepoService().getGitApi()?.git.path;
        if (!gitPath) { throw new Error('VS Code Git API is unavailable.'); }
        const identity = await RepositorySnapshotReader.identify(selected.rootUri.fsPath, gitPath);
        const memory = this.services.getMemoryService();
        const store = memory.storeFor(identity.repositoryId, selected.rootUri.fsPath);
        const config = vscode.workspace.getConfiguration('gitCommitGenie.memory');
        const actions = [
            { label: vscode.l10n.t('Inspect episodes and handbook'), id: 'inspect', detail: vscode.l10n.t('Read-only view of this clone\'s episodes and handbook. No model call or API cost; no data changes.') },
            { label: vscode.l10n.t('Delete selected episodes'), id: 'delete', detail: vscode.l10n.t('Permanently delete selected episodes and dependent handbook entries across this clone\'s shared worktrees. No model call or API cost.') },
            { label: vscode.l10n.t('Clear repository memory'), id: 'clear', detail: vscode.l10n.t('Permanently delete all episodes and handbook entries for this clone. Source files and the 24-hour call allowance are unchanged. No model call or API cost.') },
            { label: vscode.l10n.t('Rebuild memory index'), id: 'rebuild', detail: vscode.l10n.t('Rebuild metadata from this clone\'s stored episodes; no repository scan, model call or API cost. Episode contents are preserved.') },
            { label: vscode.l10n.t('Consolidate pending episodes'), id: 'consolidate', detail: vscode.l10n.t('Manually organize this clone\'s episodes using a model; API charges may apply. Requires five eligible episodes in one area and an available configured 24-hour allowance. Updates the handbook.') },
            { label: vscode.l10n.t('Cancel background consolidation'), id: 'cancel', detail: vscode.l10n.t('Cancel waiting work or request cancellation of this clone\'s running consolidation. Sent API requests may still be charged; existing memory is preserved.') },
            { label: config.get<boolean>('consolidation.enabled', true) ? vscode.l10n.t('Pause automatic consolidation') : vscode.l10n.t('Resume automatic consolidation'), id: 'pause', detail: vscode.l10n.t('Global setting. Pausing preserves recording, retrieval and manual consolidation. No immediate model call; automatic consolidation can incur API costs after resuming. Reversible.') },
            { label: config.get<boolean>('enabled', false) ? vscode.l10n.t('Disable repository memory') : vscode.l10n.t('Enable repository memory'), id: 'toggle', detail: vscode.l10n.t('Global setting. Disabling stops recording, retrieval and consolidation without deleting data. No immediate model call; enabled automatic consolidation may incur API costs. Reversible.') },
        ];
        const action = await vscode.window.showQuickPick(actions, { placeHolder: selected.rootUri.fsPath, matchOnDetail: true });
        if (!action) { return; }
        const root = selected.rootUri.fsPath;
        let ids: string[] = [];
        if (action.id === 'clear') {
            const confirm = vscode.l10n.t('Clear memory');
            if (await vscode.window.showWarningMessage(vscode.l10n.t('Delete all memory for this clone, including shared worktrees? This cannot be undone.'), { modal: true }, confirm) !== confirm) { return; }
        }
        if (action.id === 'delete') {
            const loading = vscode.window.setStatusBarMessage(`$(sync~spin) ${action.label}`);
            let view;
            try { view = await store.inspect(); }
            catch (error) { logMemoryOperation(root, action.id, 'manual', 'failed', String(error)); throw error; }
            finally { loading.dispose(); }
            if (!view.episodes.length) {
                const message = vscode.l10n.t('No episodes to delete.');
                logMemoryOperation(root, action.id, 'manual', 'not-ready', message);
                vscode.window.setStatusBarMessage(message, 5000);
                await vscode.window.showInformationMessage(message);
                return;
            }
            const picked = await vscode.window.showQuickPick(view.episodes.map(episode => ({
                label: new Date(episode.createdAt).toISOString(), description: episode.changedPaths.join(', '), detail: `${episode.status} · ${episode.snapshot.id}`, id: episode.id,
            })), { canPickMany: true, matchOnDetail: true, placeHolder: vscode.l10n.t('Select episodes to delete permanently') });
            if (!picked?.length) { return; }
            ids = picked.map(item => item.id);
            const confirm = vscode.l10n.t('Delete selected episodes');
            if (await vscode.window.showWarningMessage(vscode.l10n.t('Permanently delete {0} selected episodes and their dependent handbook entries for this clone? This cannot be undone.', ids.length),
                { modal: true }, confirm) !== confirm) { return; }
        }
        const running = action.id === 'consolidate' ? vscode.l10n.t('Consolidating Memory; model API charges may apply.') : action.label;
        const statusBar = vscode.window.setStatusBarMessage(`$(sync~spin) ${running}`);
        if (action.id !== 'consolidate') { logMemoryOperation(root, action.id, 'manual', 'running', running); }
        let message: string;
        let status = 'completed';
        try {
            if (action.id === 'inspect') {
                const view = await store.inspect();
                const uri = vscode.Uri.parse(`genie-memory:/${identity.repositoryId}/${view.generation}.json`);
                this.documents.clear(); this.documents.set(uri.toString(), JSON.stringify(view, null, 2));
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
                message = vscode.l10n.t('Opened {0} episodes and {1} handbook entries (read-only).', view.episodes.length, view.handbook.length);
            } else if (action.id === 'clear') {
                memory.cancel(store.repositoryId); await store.clear();
                message = vscode.l10n.t('Repository memory permanently cleared. Source files are unchanged; the 24-hour call allowance was not reset.');
            } else if (action.id === 'delete') {
                memory.cancel(store.repositoryId);
                const count = await store.deleteEpisodes(ids);
                message = vscode.l10n.t('Permanently deleted {0} episodes and removed their dependent handbook entries.', count);
            } else if (action.id === 'consolidate') {
                const result = await memory.consolidate(store.repositoryId, this.services.getCurrentLLMService(), 'manual');
                status = result.status;
                message = describeConsolidationResult(result);
            } else if (action.id === 'rebuild') {
                message = vscode.l10n.t('Rebuilt the index from {0} stored episodes.', await store.rebuildIndex());
            } else if (action.id === 'cancel') {
                status = memory.cancel(store.repositoryId);
                message = status === 'nothing-to-cancel' ? vscode.l10n.t('No consolidation task to cancel.') : status === 'scheduled-cancelled'
                    ? vscode.l10n.t('Cancelled the waiting consolidation task.') : vscode.l10n.t('Cancellation requested for running consolidation. Sent API requests may still be charged.');
            } else if (action.id === 'pause') {
                const enabled = !config.get<boolean>('consolidation.enabled', true);
                memory.cancel();
                await config.update('consolidation.enabled', enabled, vscode.ConfigurationTarget.Global);
                message = enabled ? vscode.l10n.t('Automatic consolidation resumed globally. Existing memory is preserved.')
                    : vscode.l10n.t('Automatic consolidation paused globally. Recording, retrieval and manual consolidation remain available; existing memory is preserved.');
            } else if (action.id === 'toggle') {
                const enabled = !config.get<boolean>('enabled', false);
                memory.cancel();
                await config.update('enabled', enabled, vscode.ConfigurationTarget.Global);
                message = enabled ? vscode.l10n.t('Repository Memory enabled globally. Existing data is preserved.')
                    : vscode.l10n.t('Repository Memory disabled globally. Recording, retrieval and consolidation stopped; existing data is preserved.');
            } else { throw new Error(`Unknown Memory operation: ${action.id}`); }
            if (action.id !== 'consolidate') { logMemoryOperation(root, action.id, 'manual', status, message); }
        } catch (error) {
            if (action.id !== 'consolidate') { logMemoryOperation(root, action.id, 'manual', 'failed', String(error)); }
            throw error;
        } finally { statusBar.dispose(); }
        vscode.window.setStatusBarMessage(message, 5000);
        await vscode.window.showInformationMessage(message);
    }
}
