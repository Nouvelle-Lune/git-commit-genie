import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { RepositorySnapshotReader } from '../services/git/repositorySnapshot';
import { createHash } from 'crypto';
import { createPipelineReplayAdapter, replayManifestSchema, runSequentialReplay, validateReplayHistory } from '../services/memory/benchmark';
import { generateCommitMessageChain } from '../services/chain/commitMessageChain';
import { createConsolidationRunner } from '../services/memory/service';
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
            try { await this.manage(); } catch (error) { this.services.getMemoryService().warn(error); }
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
                        runChain: generateCommitMessageChain, consolidation: createConsolidationRunner,
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
            { label: vscode.l10n.t('Inspect episodes and handbook'), id: 'inspect' },
            { label: vscode.l10n.t('Delete selected episodes'), id: 'delete' },
            { label: vscode.l10n.t('Clear repository memory'), id: 'clear' },
            { label: vscode.l10n.t('Rebuild memory index'), id: 'rebuild' },
            { label: vscode.l10n.t('Consolidate pending episodes'), id: 'consolidate' },
            { label: vscode.l10n.t('Cancel background consolidation'), id: 'cancel' },
            { label: config.get<boolean>('consolidation.enabled', true) ? vscode.l10n.t('Pause automatic consolidation') : vscode.l10n.t('Resume automatic consolidation'), id: 'pause' },
            { label: config.get<boolean>('enabled', false) ? vscode.l10n.t('Disable repository memory') : vscode.l10n.t('Enable repository memory'), id: 'toggle' },
        ];
        const action = await vscode.window.showQuickPick(actions, { placeHolder: selected.rootUri.fsPath });
        if (!action) { return; }
        if (action.id === 'inspect') {
            const view = await store.inspect();
            const uri = vscode.Uri.parse(`genie-memory:/${identity.repositoryId}/${view.generation}.json`);
            this.documents.clear(); this.documents.set(uri.toString(), JSON.stringify(view, null, 2));
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        } else if (action.id === 'clear') {
            const confirm = vscode.l10n.t('Clear memory');
            if (await vscode.window.showWarningMessage(vscode.l10n.t('Delete all memory for this clone, including shared worktrees? This cannot be undone.'), { modal: true }, confirm) !== confirm) { return; }
            memory.cancel(store.repositoryId); await store.clear();
            void vscode.window.showInformationMessage(vscode.l10n.t('Repository memory cleared. Source files were not changed.'));
        } else if (action.id === 'delete') {
            const view = await store.inspect();
            const picked = await vscode.window.showQuickPick(view.episodes.map(episode => ({
                label: new Date(episode.createdAt).toISOString(), description: episode.changedPaths.join(', '), detail: `${episode.status} · ${episode.snapshot.id}`, id: episode.id,
            })), { canPickMany: true, placeHolder: vscode.l10n.t('Select episodes to delete permanently') });
            if (picked?.length) { memory.cancel(store.repositoryId); await store.deleteEpisodes(picked.map(item => item.id)); }
        } else if (action.id === 'consolidate') {
            await memory.consolidate(store.repositoryId, this.services.getCurrentLLMService());
        } else if (action.id === 'rebuild') {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Rebuilding repository memory index') }, () => store.rebuildIndex());
        } else if (action.id === 'cancel') {
            memory.cancel(store.repositoryId);
        } else if (action.id === 'pause') {
            memory.cancel(store.repositoryId);
            await config.update('consolidation.enabled', !config.get<boolean>('consolidation.enabled', true), vscode.ConfigurationTarget.Global);
        } else if (action.id === 'toggle') {
            memory.cancel(store.repositoryId);
            await config.update('enabled', !config.get<boolean>('enabled', false), vscode.ConfigurationTarget.Global);
        }
    }
}
