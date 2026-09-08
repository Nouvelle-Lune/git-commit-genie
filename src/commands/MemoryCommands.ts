import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { RepositorySnapshotReader } from '../services/git/repositorySnapshot';
import { createHash } from 'crypto';
import { createPipelineReplayAdapter, replayManifestSchema, runSequentialReplay, validateReplayHistory } from '../services/memory/benchmark';
import { generateCommitMessageChain } from '../services/chain/commitMessageChain';
import { createConsolidationRunner, describeConsolidationResult, logMemoryOperation, readMemorySettings } from '../services/memory/service';
import { buildConsolidationGroups } from '../services/memory/consolidator';
import type { ConsolidationGroup } from '../services/memory/consolidator';
import { resolveInvestigationSettings } from '../services/analysis/change/investigation/config';
import type { HandbookEntry, InvestigationEpisode } from '../services/memory/types';

interface RecheckGroupItem extends vscode.QuickPickItem {
    path: string;
    group: ConsolidationGroup;
}

interface RecheckEvidenceTrace {
    episode: InvestigationEpisode;
    evidence: InvestigationEpisode['observations'][number]['evidence'][number];
    tool: string;
    summary: string;
}

function supportKey(support: HandbookEntry['supports'][number]): string {
    return `${support.episodeId}:${support.evidenceId}`;
}

function collectEvidenceTraces(episodes: readonly InvestigationEpisode[]): Map<string, RecheckEvidenceTrace> {
    const traces = new Map<string, RecheckEvidenceTrace>();
    for (const episode of episodes) {
        for (const observation of episode.observations) {
            for (const evidence of observation.evidence) {
                const support = { episodeId: episode.id, evidenceId: evidence.id };
                traces.set(supportKey(support), { episode, evidence, tool: observation.tool, summary: observation.summary });
            }
        }
    }
    return traces;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character] ?? character));
}

function formatRecordedAt(createdAt: number): string {
    return new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(createdAt));
}

function renderEvidenceRecord(trace: RecheckEvidenceTrace, index: number): string {
    const source = trace.evidence.source;
    const summary = trace.summary || vscode.l10n.t('No investigation note was saved for this record.');
    const excerpt = source.excerpt
        ? `<pre><code>${escapeHtml(source.excerpt)}</code></pre>`
        : `<p class="empty">${escapeHtml(vscode.l10n.t('No excerpt was saved for this record.'))}</p>`;
    const truncated = source.truncated
        ? `<p class="warning">${escapeHtml(vscode.l10n.t('This excerpt was already truncated when the record was created.'))}</p>`
        : '';
    const versionLabel = source.side === 'before'
        ? vscode.l10n.t('Recorded before the change')
        : vscode.l10n.t('Recorded after the change');
    return `
        <details class="evidence-record">
            <summary>
                <span class="timeline-dot" aria-hidden="true"></span>
                <span class="evidence-number">${index + 1}</span>
                <span class="evidence-summary">
                    <strong>${escapeHtml(summary)}</strong>
                    <span>${escapeHtml(formatRecordedAt(trace.episode.createdAt))} · ${escapeHtml(source.path)} · ${escapeHtml(vscode.l10n.t('lines {0}-{1}', source.startLine, source.endLine))}</span>
                </span>
                <span class="version-tag">${escapeHtml(versionLabel)}</span>
            </summary>
            <div class="evidence-body">
                <h4>${escapeHtml(vscode.l10n.t('Saved excerpt'))}</h4>
                ${excerpt}
                ${truncated}
                <details class="technical-details">
                    <summary>${escapeHtml(vscode.l10n.t('Technical information'))}</summary>
                    <dl>
                        <dt>${escapeHtml(vscode.l10n.t('Investigation ID'))}</dt><dd><code>${escapeHtml(trace.episode.id)}</code></dd>
                        <dt>${escapeHtml(vscode.l10n.t('Evidence ID'))}</dt><dd><code>${escapeHtml(trace.evidence.id)}</code></dd>
                        <dt>${escapeHtml(vscode.l10n.t('Repository snapshot'))}</dt><dd><code>${escapeHtml(source.snapshotId)}</code></dd>
                        <dt>${escapeHtml(vscode.l10n.t('Investigation status'))}</dt><dd><code>${escapeHtml(trace.episode.status)}</code></dd>
                        <dt>${escapeHtml(vscode.l10n.t('Collection tool'))}</dt><dd><code>${escapeHtml(trace.tool)}</code></dd>
                    </dl>
                </details>
            </div>
        </details>`;
}

function renderMissingSupport(support: HandbookEntry['supports'][number]): string {
    return `
        <div class="missing-support" role="status">
            <strong>${escapeHtml(vscode.l10n.t('A supporting record could not be found.'))}</strong>
            <span>${escapeHtml(vscode.l10n.t('This memory points to investigation {0}, evidence {1}, but that saved record is unavailable.', support.episodeId, support.evidenceId))}</span>
        </div>`;
}

function formatRecheckGroupReport(group: ConsolidationGroup, handbook: readonly HandbookEntry[], episodes: readonly InvestigationEpisode[]): string {
    const independentSnapshots = new Set(group.sources.map(source => source.episode.snapshot.id)).size;
    const relatedHandbook = handbook.filter(entry => entry.targetPaths.includes(group.anchorPath));
    const evidenceTraces = collectEvidenceTraces(episodes);
    const memories = relatedHandbook.length
        ? relatedHandbook.map((entry, index) => {
            const supports = entry.supports.map((support, supportIndex) => {
                const trace = evidenceTraces.get(supportKey(support));
                return trace ? renderEvidenceRecord(trace, supportIndex) : renderMissingSupport(support);
            }).join('');
            const concerns = entry.concerns.map(concern => `<li>${escapeHtml(concern)}</li>`).join('');
            const triggers = entry.triggers.map(trigger => `<span class="trigger">${escapeHtml(trigger)}</span>`).join('');
            const kind = entry.kind === 'navigation' ? vscode.l10n.t('Where to look') : vscode.l10n.t('How to handle it');
            return `
                <article class="memory-card">
                    <div class="memory-heading">
                        <span class="memory-index">${escapeHtml(vscode.l10n.t('Long-term memory {0}', index + 1))}</span>
                        <span class="kind-tag">${escapeHtml(kind)}</span>
                    </div>
                    <h3>${escapeHtml(vscode.l10n.t('Remembered conclusion'))}</h3>
                    <ul class="conclusions">${concerns}</ul>
                    <div class="recall-context">
                        <span>${escapeHtml(vscode.l10n.t('When this memory may be recalled'))}</span>
                        <div class="triggers">${triggers}</div>
                    </div>
                    <details class="support-section">
                        <summary>${escapeHtml(vscode.l10n.t('{0} historical records support this conclusion', entry.supports.length))}</summary>
                        <div class="support-intro">${escapeHtml(vscode.l10n.t('Why this was remembered'))} · ${escapeHtml(vscode.l10n.t('Only the records below directly support this long-term memory.'))}</div>
                        <div class="evidence-thread">${supports}</div>
                    </details>
                </article>`;
        }).join('')
        : `<div class="empty-state">
                <h3>${escapeHtml(vscode.l10n.t('No long-term memory was created from this evidence group.'))}</h3>
                <p>${escapeHtml(vscode.l10n.t('A recheck asks the model to review this saved history again and decide whether a durable conclusion should be added.'))}</p>
           </div>`;
    const allSources = group.sources.map((source, index) => {
        const trace = evidenceTraces.get(supportKey(source.support));
        return trace ? renderEvidenceRecord(trace, index) : renderMissingSupport(source.support);
    }).join('');
    return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(vscode.l10n.t('Historical evidence for {0}', group.anchorPath))}</title>
    <style>
        * { box-sizing: border-box; }
        body { max-width: 980px; margin: 0 auto; padding: 32px 28px 64px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.6; }
        h1, h2, h3, h4, p { margin-top: 0; }
        h1 { margin-bottom: 10px; font-size: clamp(24px, 4vw, 38px); line-height: 1.18; overflow-wrap: anywhere; }
        h2 { margin: 0 0 8px; font-size: 22px; }
        h3 { margin-bottom: 10px; font-size: 16px; }
        h4 { margin-bottom: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .06em; }
        code, pre { font-family: var(--vscode-editor-font-family); }
        .hero { padding: 4px 0 28px; border-bottom: 1px solid var(--vscode-panel-border); }
        .eyebrow { display: inline-block; margin-bottom: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
        .hero-copy, .section-copy { color: var(--vscode-descriptionForeground); max-width: 760px; }
        section { padding-top: 32px; }
        .memory-list { display: grid; gap: 18px; margin-top: 18px; }
        .memory-card { padding: 20px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 10px; }
        .memory-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 18px; }
        .memory-index { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
        .kind-tag, .version-tag, .trigger { display: inline-flex; align-items: center; border: 1px solid var(--vscode-badge-background); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
        .kind-tag { color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
        .conclusions { margin: 0; padding-left: 22px; font-size: 15px; }
        .conclusions li + li { margin-top: 8px; }
        .recall-context { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
        .recall-context > span { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600; }
        .triggers { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .trigger { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
        details > summary { cursor: pointer; }
        details > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
        .support-section { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); }
        .support-section > summary { color: var(--vscode-textLink-foreground); font-weight: 650; }
        .support-intro { margin: 14px 0; color: var(--vscode-descriptionForeground); }
        .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 18px; }
        .metric { padding: 18px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
        .metric strong { display: block; margin-bottom: 4px; font-size: 28px; line-height: 1; }
        .metric span { display: block; margin-bottom: 7px; font-weight: 650; }
        .metric p { margin: 0; color: var(--vscode-descriptionForeground); }
        .count-note { margin-top: 12px; padding-left: 14px; border-left: 3px solid var(--vscode-focusBorder); color: var(--vscode-descriptionForeground); }
        .evidence-thread { position: relative; padding-left: 20px; border-left: 2px solid var(--vscode-gitDecoration-modifiedResourceForeground); }
        .evidence-record { position: relative; padding: 12px 0; }
        .evidence-record + .evidence-record { border-top: 1px solid var(--vscode-panel-border); }
        .evidence-record > summary { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 10px; align-items: start; list-style: none; }
        .evidence-record > summary::-webkit-details-marker { display: none; }
        .timeline-dot { position: absolute; left: -26px; top: 21px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-gitDecoration-modifiedResourceForeground); box-shadow: 0 0 0 4px var(--vscode-editor-background); }
        .evidence-number { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
        .evidence-summary { min-width: 0; }
        .evidence-summary strong, .evidence-summary span { display: block; }
        .evidence-summary strong { overflow-wrap: anywhere; }
        .evidence-summary span { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
        .version-tag { color: var(--vscode-descriptionForeground); white-space: nowrap; }
        .evidence-body { margin: 12px 0 0 34px; }
        pre { max-height: 420px; margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
        .warning, .missing-support { color: var(--vscode-notificationsWarningIcon-foreground); }
        .warning { margin: 8px 0 0; }
        .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
        .technical-details { margin-top: 12px; color: var(--vscode-descriptionForeground); }
        .technical-details > summary { font-size: 12px; }
        dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin-bottom: 0; font-size: 12px; }
        dt { font-weight: 650; }
        dd { margin: 0; overflow-wrap: anywhere; }
        .empty-state, .missing-support { padding: 16px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
        .empty-state p, .missing-support span { margin: 0; color: var(--vscode-descriptionForeground); }
        .missing-support strong, .missing-support span { display: block; }
        .all-evidence { margin-top: 18px; }
        .all-evidence > summary { font-weight: 650; }
        .all-evidence .evidence-thread { margin-top: 16px; }
        @media (max-width: 620px) {
            body { padding: 24px 16px 48px; }
            .evidence-record > summary { grid-template-columns: 24px minmax(0, 1fr); }
            .version-tag { grid-column: 2; justify-self: start; }
            dl { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <header class="hero">
        <span class="eyebrow">${escapeHtml(vscode.l10n.t('Historical evidence preview'))}</span>
        <h1>${escapeHtml(group.anchorPath)}</h1>
        <p class="hero-copy">${escapeHtml(vscode.l10n.t('This page shows saved records from earlier repository versions, not the file as it is now.'))}</p>
    </header>
    <main>
        <section aria-labelledby="learned-title">
            <h2 id="learned-title">${escapeHtml(vscode.l10n.t('What Repository Memory learned'))}</h2>
            <p class="section-copy">${escapeHtml(vscode.l10n.t('These long-term memories may be recalled when related files or topics appear.'))}</p>
            <div class="memory-list">${memories}</div>
        </section>
        <section aria-labelledby="history-title">
            <h2 id="history-title">${escapeHtml(vscode.l10n.t('History at a glance'))}</h2>
            <div class="metrics">
                <div class="metric"><strong>${independentSnapshots}</strong><span>${escapeHtml(vscode.l10n.t('Versions observed'))}</span><p>${escapeHtml(vscode.l10n.t('{0} repository snapshots contained evidence for this path.', independentSnapshots))}</p></div>
                <div class="metric"><strong>${group.sources.length}</strong><span>${escapeHtml(vscode.l10n.t('Saved evidence'))}</span><p>${escapeHtml(vscode.l10n.t('{0} different evidence records remain after identical sources are counted once.', group.sources.length))}</p></div>
            </div>
            <p class="count-note"><strong>${escapeHtml(vscode.l10n.t('Why the numbers differ'))}:</strong> ${escapeHtml(vscode.l10n.t('One repository version can contain several observations. A long-term memory uses only the records listed under its own "Why this was remembered" section.'))}</p>
        </section>
        <section aria-labelledby="all-evidence-title">
            <h2 id="all-evidence-title">${escapeHtml(vscode.l10n.t('All saved evidence in this group'))}</h2>
            <p class="section-copy">${escapeHtml(vscode.l10n.t('These are all distinct records available for recheck. Some may not support any current long-term memory.'))}</p>
            <details class="all-evidence">
                <summary>${escapeHtml(vscode.l10n.t('Show {0} saved evidence records', group.sources.length))}</summary>
                <div class="evidence-thread">${allSources}</div>
            </details>
        </section>
    </main>
</body>
</html>`;
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
            label: group.anchorPath,
            description: vscode.l10n.t('{0} historical versions · {1} saved evidence records',
                new Set(group.sources.map(source => source.episode.snapshot.id)).size, group.sources.length),
            buttons: [{ iconPath: new vscode.ThemeIcon('info'), tooltip: vscode.l10n.t('Understand this evidence group') }],
            path: group.anchorPath,
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

    private openRecheckGroupDetails(repositoryId: string, group: ConsolidationGroup, handbook: readonly HandbookEntry[], episodes: readonly InvestigationEpisode[]): void {
        const panelKey = `${repositoryId}:${group.fingerprint}`;
        const existing = this.evidencePanels.get(panelKey);
        if (existing) {
            existing.webview.html = formatRecheckGroupReport(group, handbook, episodes);
            existing.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        // The report deliberately uses native <details> elements and no scripts: it remains
        // read-only while still supporting progressive disclosure for non-technical users.
        const panel = vscode.window.createWebviewPanel(
            'gitCommitGenie.memoryEvidence',
            vscode.l10n.t('Historical evidence for {0}', group.anchorPath),
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: false, retainContextWhenHidden: false },
        );
        panel.webview.html = formatRecheckGroupReport(group, handbook, episodes);
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
            { label: vscode.l10n.t('Recheck organized evidence'), id: 'recheck', description: vscode.l10n.t('Run the model again for evidence groups already checked with no source changes; API charges apply.') },
            { label: vscode.l10n.t('Cancel background organization'), id: 'cancel', description: vscode.l10n.t('Cancel queued or active memory organization.') },
            { label: config.get<boolean>('consolidation.enabled', true) ? vscode.l10n.t('Pause automatic organization') : vscode.l10n.t('Resume automatic organization'), id: 'pause', description: config.get<boolean>('consolidation.enabled', true) ? vscode.l10n.t('Pause automatic memory organization.') : vscode.l10n.t('Resume automatic memory organization.') },
            { label: config.get<boolean>('enabled', false) ? vscode.l10n.t('Disable repository memory') : vscode.l10n.t('Enable repository memory'), id: 'toggle', description: config.get<boolean>('enabled', false) ? vscode.l10n.t('Disable: stop recording, search, and organization; existing memory stays.') : vscode.l10n.t('Enable: resume recording, search, and organization.') },
        ];
        const action = await vscode.window.showQuickPick(actions, { placeHolder: selected.rootUri.fsPath, matchOnDescription: true });
        if (!action) { return; }
        const root = selected.rootUri.fsPath;
        let ids: string[] = [];
        let recheckPaths: string[] | undefined;
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
            const organized = new Set(view.consolidated);
            const groups = buildConsolidationGroups(view.episodes, []).filter(group => organized.has(group.fingerprint));
            if (!groups.length) {
                const message = vscode.l10n.t('No evidence groups have enough independent snapshots to recheck.');
                vscode.window.setStatusBarMessage(message, 5000);
                await vscode.window.showInformationMessage(message);
                return;
            }
            const picked = await this.selectRecheckGroups(groups, view.handbook, view.episodes, identity.repositoryId);
            if (!picked?.length) { return; }
            recheckPaths = picked;
            const confirm = vscode.l10n.t('Recheck organized evidence');
            if (await vscode.window.showWarningMessage(vscode.l10n.t('Recheck {0} selected evidence groups even when their sources have not changed? This runs new model calls and may incur API charges.', recheckPaths.length),
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
                const result = await memory.consolidate(store.repositoryId, this.services.getCurrentLLMService(), 'manual-recheck', recheckPaths);
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
            if (!consolidationAction) { logMemoryOperation(root, action.id, 'manual', status, message); }
        } catch (error) {
            if (!consolidationAction) { logMemoryOperation(root, action.id, 'manual', 'failed', String(error)); }
            throw error;
        } finally { statusBar.dispose(); }
        vscode.window.setStatusBarMessage(message, 5000);
        await vscode.window.showInformationMessage(message);
    }
}
