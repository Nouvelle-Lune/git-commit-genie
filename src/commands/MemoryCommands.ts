import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { RepositorySnapshotReader } from '../services/git/repositorySnapshot';
import { createHash } from 'crypto';
import { createPipelineReplayAdapter, replayManifestSchema, runSequentialReplay, validateReplayHistory } from '../services/memory/benchmark';
import { generateCommitMessageChain } from '../services/chain/commitMessageChain';
import { createConsolidationRunner, describeConsolidationResult, logMemoryOperation, readMemorySettings } from '../services/memory/service';
import { buildConsolidationGroups } from '../services/memory/consolidator';
import type { ConsolidationGroup, GroupOutcome } from '../services/memory/consolidator';
import { resolveInvestigationSettings } from '../services/analysis/change/investigation/config';
import type { HandbookEntry, InvestigationEpisode } from '../services/memory/types';
import { formatRecheckGroupReport } from '../ui/memoryExperienceReport';

interface RecheckGroupItem extends vscode.QuickPickItem {
    path: string;
    group: ConsolidationGroup;
}

/** Read-only inspection plus explicit repository-scoped maintenance commands. */
export class MemoryCommands {
    private readonly documents = new Map<string, string>();
    private readonly evidencePanels = new Map<string, vscode.WebviewPanel>();
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

    private async selectRecheckGroups(groups: ConsolidationGroup[], handbook: readonly HandbookEntry[], episodes: readonly InvestigationEpisode[], repositoryId: string): Promise<string[] | undefined> {
        const items: RecheckGroupItem[] = groups.map(group => ({
            label: group.title,
            description: vscode.l10n.t('{0} historical versions · {1} saved evidence records',
                new Set(group.episodes.map(episode => episode.snapshot.id)).size, group.observations.length),
            buttons: [{ iconPath: new vscode.ThemeIcon('info'), tooltip: vscode.l10n.t('Understand this evidence group') }],
            path: group.seedId,
            group,
        }));
        const quickPick = vscode.window.createQuickPick<RecheckGroupItem>();
        quickPick.items = items;
        quickPick.canSelectMany = true;
        quickPick.matchOnDescription = true;
        quickPick.title = vscode.l10n.t('Recheck historical evidence');
        quickPick.placeholder = vscode.l10n.t('Select evidence groups to recheck; use the info button to view details.');
        return new Promise(resolve => {
            let settled = false;
            const subscriptions = [
                quickPick.onDidTriggerItemButton(event => {
                    this.openRecheckGroupDetails(repositoryId, event.item.group, handbook, episodes);
                }),
                quickPick.onDidAccept(() => {
                    const paths = quickPick.selectedItems.map(item => item.path);
                    finish(paths.length ? paths : undefined);
                }),
                quickPick.onDidHide(() => finish(undefined)),
            ];
            const finish = (paths: string[] | undefined): void => {
                if (settled) { return; }
                settled = true;
                for (const subscription of subscriptions) { subscription.dispose(); }
                quickPick.hide();
                quickPick.dispose();
                resolve(paths);
            };
            quickPick.show();
        });
    }

    private openRecheckGroupDetails(repositoryId: string, group: ConsolidationGroup, handbook: readonly HandbookEntry[], episodes: readonly InvestigationEpisode[], outcome?: GroupOutcome): void {
        const panelKey = `${repositoryId}:${group.fingerprint}`;
        const existing = this.evidencePanels.get(panelKey);
        if (existing) {
            existing.webview.html = formatRecheckGroupReport(group, handbook, episodes, outcome);
            existing.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        // The report deliberately uses native <details> elements and no scripts: it remains
        // read-only while still supporting progressive disclosure for non-technical users.
        const panel = vscode.window.createWebviewPanel(
            'gitCommitGenie.memoryEvidence',
            vscode.l10n.t('Historical evidence for {0}', group.seedId),
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: false, retainContextWhenHidden: false },
        );
        panel.webview.html = formatRecheckGroupReport(group, handbook, episodes, outcome);
        this.evidencePanels.set(panelKey, panel);
        this.context.subscriptions.push(panel);
        panel.onDidDispose(() => this.evidencePanels.delete(panelKey), undefined, this.context.subscriptions);
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
            { label: vscode.l10n.t('View repository memory'), id: 'inspect', description: vscode.l10n.t("View this repository's saved memory.") },
            { label: vscode.l10n.t('Delete selected records'), id: 'delete', description: vscode.l10n.t('Permanently delete selected memory.') },
            { label: vscode.l10n.t('Clear repository memory'), id: 'clear', description: vscode.l10n.t('Permanently delete all memory in this repository and its shared worktrees.') },
            { label: vscode.l10n.t('Rebuild memory index'), id: 'rebuild', description: vscode.l10n.t('Rebuild the search index from saved investigation records.') },
            { label: vscode.l10n.t('Organize pending records'), id: 'consolidate', description: vscode.l10n.t('Organize pending records and update memory.') },
            { label: vscode.l10n.t('Recheck organized evidence'), id: 'recheck', description: vscode.l10n.t('Run the model again for evidence groups already checked with no source changes.') },
            { label: vscode.l10n.t('Cancel background organization'), id: 'cancel', description: vscode.l10n.t('Cancel queued or active memory organization.') },
            { label: config.get<boolean>('consolidation.enabled', true) ? vscode.l10n.t('Pause automatic organization') : vscode.l10n.t('Resume automatic organization'), id: 'pause', description: config.get<boolean>('consolidation.enabled', true) ? vscode.l10n.t('Pause automatic memory organization.') : vscode.l10n.t('Resume automatic memory organization.') },
            { label: config.get<boolean>('enabled', false) ? vscode.l10n.t('Disable repository memory') : vscode.l10n.t('Enable repository memory'), id: 'toggle', description: config.get<boolean>('enabled', false) ? vscode.l10n.t('Disable: stop recording, search, and organization; existing memory stays.') : vscode.l10n.t('Enable: resume recording, search, and organization.') },
        ];
        const action = await vscode.window.showQuickPick(actions, { placeHolder: selected.rootUri.fsPath, matchOnDescription: true });
        if (!action) { return; }
        const root = selected.rootUri.fsPath;
        let ids: string[] = [];
        let recheckSeeds: string[] | undefined;
        let recheckGroups: ConsolidationGroup[] = [];
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
        if (action.id === 'recheck') {
            const view = await store.inspect();
            const organized = new Set(view.organizedSeeds);
            const groups = buildConsolidationGroups(view.episodes, [], view.handbook).filter(group => organized.has(group.seedId));
            if (!groups.length) {
                const message = vscode.l10n.t('No evidence groups have enough independent snapshots to recheck.');
                vscode.window.setStatusBarMessage(message, 5000);
                await vscode.window.showInformationMessage(message);
                return;
            }
            const picked = await this.selectRecheckGroups(groups, view.handbook, view.episodes, identity.repositoryId);
            if (!picked?.length) { return; }
            recheckSeeds = picked;
            recheckGroups = groups.filter(group => picked.includes(group.seedId));
            const confirm = vscode.l10n.t('Recheck organized evidence');
            if (await vscode.window.showWarningMessage(vscode.l10n.t('Recheck {0} selected evidence groups even when their sources have not changed? This runs new model calls and may incur API charges.', recheckSeeds.length),
                { modal: true }, confirm) !== confirm) { return; }
        }
        const consolidationAction = action.id === 'consolidate' || action.id === 'recheck';
        const running = consolidationAction ? vscode.l10n.t('Consolidating Memory; model API charges may apply.') : action.label;
        const statusBar = vscode.window.setStatusBarMessage(`$(sync~spin) ${running}`);
        if (!consolidationAction) { logMemoryOperation(root, action.id, 'manual', 'running', running); }
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
                message = vscode.l10n.t('Repository memory permanently cleared. Source files are unchanged; the 24-hour consolidation start allowance was not reset.');
            } else if (action.id === 'delete') {
                memory.cancel(store.repositoryId);
                const count = await store.deleteEpisodes(ids);
                message = vscode.l10n.t('Permanently deleted {0} episodes and removed their dependent handbook entries.', count);
            } else if (action.id === 'consolidate') {
                const result = await memory.consolidate(store.repositoryId, this.services.getCurrentLLMService(), 'manual');
                status = result.status;
                message = describeConsolidationResult(result);
            } else if (action.id === 'recheck') {
                const messages: string[] = [];
                for (const group of recheckGroups) {
                    try {
                        const result = await memory.consolidate(store.repositoryId, this.services.getCurrentLLMService(), 'manual-recheck', [group.seedId]);
                        const view = await store.inspect();
                        const outcome: GroupOutcome = 'groupOutcomes' in result ? result.groupOutcomes[0]
                            : { seedId: group.seedId, status: 'failed', entryIds: [], issues: [describeConsolidationResult(result)] };
                        this.openRecheckGroupDetails(identity.repositoryId, group, view.handbook, view.episodes, outcome);
                        messages.push(describeConsolidationResult(result));
                        status = result.status;
                        if (!('groupOutcomes' in result)) { break; }
                    } catch (error) {
                        const view = await store.inspect();
                        this.openRecheckGroupDetails(identity.repositoryId, group, view.handbook, view.episodes,
                            { seedId: group.seedId, status: 'failed', entryIds: [], issues: [String(error)] });
                        throw error;
                    }
                }
                message = messages.join('\n');
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
            if (!consolidationAction) { logMemoryOperation(root, action.id, 'manual', status, message); }
        } catch (error) {
            if (!consolidationAction) { logMemoryOperation(root, action.id, 'manual', 'failed', String(error)); }
            throw error;
        } finally { statusBar.dispose(); }
        vscode.window.setStatusBarMessage(message, 5000);
        await vscode.window.showInformationMessage(message);
    }
}
