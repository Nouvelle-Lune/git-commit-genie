import { strict as assert } from 'assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { MemoryCommands } from '../../commands/MemoryCommands';
import { hashContent, RepositorySnapshotReader } from '../../services/git/repositorySnapshot';
import { logger } from '../../services/logger';
import { buildConsolidationGroups } from '../../services/memory/consolidator';
import { describeConsolidationResult } from '../../services/memory/service';

describe('MemoryCommands repository maintenance', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(logger, 'logToolCall');
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('describes every structured consolidation outcome for user notifications', () => {
        // Published output keeps only group and handbook counts, while partial and no-findings outputs retain their statistics.
        const published = describeConsolidationResult({
            status: 'published', groupCount: 5, handbookCount: 2, noFindingCount: 1, failedGroupCount: 0,
            skippedGroups: 1, deferredPaths: ['src/deferred.ts'], retryCount: 1,
            groupOutcomes: [{ seedId: '00000000-0000-4000-8000-000000000001', status: 'published', entryIds: [], issues: [] }],
        });
        assert.equal(published, 'Consolidated 5 evidence groups into 2 handbook entries;');
        const partial = describeConsolidationResult({
            status: 'partial', groupCount: 2, handbookCount: 1, noFindingCount: 0, failedGroupCount: 1,
            skippedGroups: 1, deferredPaths: ['src/deferred.ts'], retryCount: 2,
            groupOutcomes: [
                { seedId: '00000000-0000-4000-8000-000000000001', status: 'published', entryIds: [], issues: [] },
                { seedId: '00000000-0000-4000-8000-000000000002', status: 'failed', entryIds: [], issues: ['validation failed'] },
            ],
        });
        assert.match(partial, /Partially consolidated 2 evidence groups into 1 handbook entries/);
        assert.match(partial, /0 groups had no stable findings/);
        assert.match(partial, /1 failed validation/);
        assert.match(partial, /1 were deferred/);
        assert.match(partial, /2 retries/);
        const noFindings = describeConsolidationResult({
            status: 'no-findings', groupCount: 1, handbookCount: 0, noFindingCount: 1, failedGroupCount: 0,
            skippedGroups: 1, deferredPaths: ['src/deferred.ts'], retryCount: 1,
            groupOutcomes: [{ seedId: '00000000-0000-4000-8000-000000000001', status: 'no-findings', entryIds: [], issues: [] }],
        });
        assert.match(noFindings, /Checked 1 evidence groups/);
        assert.match(noFindings, /1 groups were deferred/);
        assert.match(noFindings, /1 retries/);
        assert.match(describeConsolidationResult({ status: 'not-ready', pendingCount: 3, threshold: 2 }), /3\/2/);
        assert.match(describeConsolidationResult({ status: 'budget-exhausted', limit: 2, resumesAt: Date.now() + 60_000 }), /24-hour start allowance/);
        assert.match(describeConsolidationResult({ status: 'memory-disabled' }), /Repository Memory is disabled/);
        assert.match(describeConsolidationResult({ status: 'foreground-busy' }), /commit generation is active/);
        assert.match(describeConsolidationResult({ status: 'already-running' }), /another task holds/);
        assert.match(describeConsolidationResult({ status: 'cancelled' }), /Consolidation cancelled/);
        assert.match(describeConsolidationResult({ status: 'automatic-paused' }), /Automatic consolidation is paused/);
    });

    it('describes all management actions and enables description matching', async () => {
        const config = vscode.workspace.getConfiguration('gitCommitGenie.memory');
        const previousConsolidationEnabled = config.get<boolean>('consolidation.enabled', true);
        const previousMemoryEnabled = config.get<boolean>('enabled', false);
        try {
            await config.update('consolidation.enabled', true, vscode.ConfigurationTarget.Global);
            await config.update('enabled', false, vscode.ConfigurationTarget.Global);

            const store = makeStore();
            const memory = makeMemoryService(store);
            const { context } = makeContext();
            const registry = makeRegistry(store, memory);
            stubIdentity(sandbox);
            const seenMenus: Array<Array<vscode.QuickPickItem & { id?: string }>> = [];
            const seenOptions: Array<vscode.QuickPickOptions | undefined> = [];
            sandbox.stub(vscode.window, 'showQuickPick').callsFake((async (
                items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
                options?: vscode.QuickPickOptions,
            ) => {
                const resolved = Array.isArray(items) ? items : await items;
                seenMenus.push([...resolved] as Array<vscode.QuickPickItem & { id?: string }>);
                seenOptions.push(options);
                return undefined;
            }) as unknown as typeof vscode.window.showQuickPick);

            await invokeManage(new MemoryCommands(context, registry as never));

            await config.update('consolidation.enabled', false, vscode.ConfigurationTarget.Global);
            await config.update('enabled', true, vscode.ConfigurationTarget.Global);
            await invokeManage(new MemoryCommands(context, registry as never));

            assert.equal(seenMenus.length, 2);
            for (const items of seenMenus) {
                assert.deepEqual(items.map(item => item.id), [
                    'inspect', 'delete', 'clear', 'rebuild', 'consolidate', 'recheck', 'cancel', 'pause', 'toggle',
                ]);
                assert.equal(items.every(item => typeof item.description === 'string' && item.description.trim().length > 0), true);
                assert.equal(items.every(item => !Object.prototype.hasOwnProperty.call(item, 'detail')), true);
            }
            const recheck = seenMenus[0].find(item => item.id === 'recheck');
            assert.ok(recheck);
            assert.equal(recheck.description, 'Run the model again for evidence groups already checked with no source changes.');
            assert.doesNotMatch(recheck.description, /API charges apply/);
            for (const options of seenOptions) {
                assert.equal(options?.matchOnDescription, true);
                assert.equal(options?.matchOnDetail, undefined);
            }

            const firstPause = seenMenus[0].find(item => item.id === 'pause');
            const secondPause = seenMenus[1].find(item => item.id === 'pause');
            const firstToggle = seenMenus[0].find(item => item.id === 'toggle');
            const secondToggle = seenMenus[1].find(item => item.id === 'toggle');
            assert.ok(firstPause);
            assert.ok(secondPause);
            assert.ok(firstToggle);
            assert.ok(secondToggle);
            assert.match(firstPause.label, /^Pause /);
            assert.match(secondPause.label, /^Resume /);
            assert.match(firstToggle.label, /^Enable /);
            assert.match(secondToggle.label, /^Disable /);
        } finally {
            await config.update('consolidation.enabled', previousConsolidationEnabled, vscode.ConfigurationTarget.Global);
            await config.update('enabled', previousMemoryEnabled, vscode.ConfigurationTarget.Global);
        }
    });

    it('opens read-only inspection output and releases its spinner before success notification', async () => {
        const store = makeStore();
        const view = {
            epoch: 'epoch', generation: 7, episodes: [{ id: 'episode-1' }], handbook: [{ id: 'entry-1' }], consolidated: [],
        };
        store.inspect.resolves(view);
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'inspect');
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves({ uri: vscode.Uri.parse('genie-memory:/test/7.json') } as never);
        sandbox.stub(vscode.window, 'showTextDocument').resolves(undefined as never);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(store.inspect.calledOnce, true);
        assert.equal(information.length, 1);
        assert.match(information[0], /Opened 1 episodes and 1 handbook entries/);
        assert.equal(statuses.length, 2);
        assert.equal(statuses[0].message.startsWith('$(sync~spin)'), true);
        assert.equal(statuses[0].disposed, true);
    });

    it('surfaces a structured not-ready consolidation result and releases its spinner', async () => {
        const store = makeStore();
        const memory = makeMemoryService(store);
        memory.consolidate.resolves({ status: 'not-ready', pendingCount: 3, threshold: 2 });
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'consolidate');
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);
        const model = { model: 'memory-model' };
        const registry = makeRegistry(store, memory, model);

        await invokeManage(new MemoryCommands(context, registry as never));

        assert.deepEqual(memory.consolidate.firstCall.args, ['r'.repeat(64), model, 'manual']);
        assert.equal(information.length, 1);
        assert.match(information[0], /Consolidation not run/);
        assert.match(information[0], /3\/2/);
        assert.equal(statuses[0].disposed, true);
    });

    it('uses a multi-select QuickPick with canonical group items and passes selected paths after confirmation', async () => {
        // The recheck picker exposes each anchor path, both evidence counts, and a details button before confirmation, then sends the selected paths to manual recheck.
        const store = makeStore();
        const episodes = makeRecheckEpisodes();
        const groups = buildConsolidationGroups(episodes as any, []);
        store.inspect.resolves({ epoch: 'epoch', generation: 1, episodes, handbook: [], consolidated: groups.map(group => group.fingerprint), organizedSeeds: groups.map(group => group.seedId) });
        const memory = makeMemoryService(store);
        memory.consolidate.resolves({
            status: 'no-findings', groupCount: 2, skippedGroups: 0, deferredPaths: [], retryCount: 0,
            groupOutcomes: [
                { seedId: '00000000-0000-4000-8000-000000000001', status: 'no-findings', entryIds: [], issues: [] },
                { seedId: '00000000-0000-4000-8000-000000000002', status: 'no-findings', entryIds: [], issues: [] },
            ],
        });
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'recheck');
        const picker = stubRecheckSelection(sandbox, items => {
            assert.deepEqual(items.map(item => item.label), ['Where should src/parser.ts be investigated?', 'Where should src/unorganized.ts be investigated?']);
            assert.deepEqual(items.map(item => item.path), [episodes[0].id, episodes[2].id]);
            assert.deepEqual(items.map(item => item.description), ['2 historical versions · 2 saved evidence records', '2 historical versions · 2 saved evidence records']);
            assert.equal(items.every(item => item.buttons?.length === 1), true);
            assert.equal(items.every(item => item.buttons?.[0].tooltip === 'Understand this evidence group'), true);
            assert.equal(picker.quickPick.canSelectMany, true);
            assert.equal(picker.quickPick.matchOnDescription, true);
            assert.equal(picker.quickPick.title, 'Recheck historical evidence');
            assert.equal(picker.quickPick.placeholder, 'Select evidence groups to recheck; use the info button to view details.');
        }, ['src/parser.ts', 'src/unorganized.ts']);
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Recheck organized evidence' as never);
        const model = { model: 'memory-model' };

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory, model) as never));

        assert.equal(warning.calledOnce, true);
        assert.deepEqual(warning.firstCall.args[1], { modal: true });
        assert.equal(warning.firstCall.args[2], 'Recheck organized evidence');
        assert.deepEqual(memory.consolidate.firstCall.args, ['r'.repeat(64), model, 'manual-recheck', [episodes[0].id, episodes[2].id]]);
        assert.equal(information.length, 1);
        assertSpinnersReleased(statuses);
    });

    it('does not call consolidation when the recheck cost confirmation is cancelled', async () => {
        // Cancelling the paid recheck confirmation leaves the selected evidence groups untouched and does not start consolidation.
        const store = makeStore();
        const episodes = makeRecheckEpisodes();
        const groups = buildConsolidationGroups(episodes as any, []);
        const organizedFingerprint = groups[0].fingerprint;
        store.inspect.resolves({ epoch: 'epoch', generation: 1, episodes, handbook: [], consolidated: [organizedFingerprint], organizedSeeds: [groups[0].seedId] });
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'recheck');
        stubRecheckSelection(sandbox);
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const information = stubInformation(sandbox);
        const statuses = stubStatusBar(sandbox);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(warning.calledOnce, true);
        assert.equal(memory.consolidate.called, false);
        assert.deepEqual(information, []);
        assert.deepEqual(statuses, []);
    });

    it('opens a read-only evidence webview from an item button without changing selection or confirming cost', async () => {
        // An item-button click opens historical evidence details only; it preserves selection and defers confirmation and model calls until acceptance.
        const store = makeStore();
        const episodes = makeRecheckEpisodes();
        const groups = buildConsolidationGroups(episodes as any, []);
        store.inspect.resolves({
            epoch: 'epoch', generation: 1, episodes, handbook: makeRecheckHandbook(episodes),
            consolidated: groups.map(group => group.fingerprint), organizedSeeds: groups.map(group => group.seedId),
        });
        const memory = makeMemoryService(store);
        memory.consolidate.resolves({
            status: 'no-findings', groupCount: 1, skippedGroups: 0, deferredPaths: [], retryCount: 0,
            groupOutcomes: [{ seedId: '00000000-0000-4000-8000-000000000003', status: 'no-findings', entryIds: [], issues: [] }],
        });
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'recheck');
        const picker = makeRecheckQuickPick();
        sandbox.stub(vscode.window, 'createQuickPick').returns(picker.quickPick as never);
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Recheck organized evidence' as never);
        const information = stubInformation(sandbox);
        const webview = stubRecheckWebview(sandbox);
        stubCommandRegistration(sandbox);
        const commands = new MemoryCommands(context, makeRegistry(store, memory) as never);
        commands.register();

        const pending = invokeManage(commands);
        await flushAsync();
        const parserItem = picker.quickPick.items.find(item => item.label === 'Where should src/parser.ts be investigated?');
        const selectedItem = picker.quickPick.items.find(item => item.label === 'Where should src/unorganized.ts be investigated?');
        assert.ok(parserItem);
        assert.ok(selectedItem);
        picker.quickPick.selectedItems = [selectedItem];

        picker.triggerItemButton(parserItem);
        await flushAsync();

        assert.equal(warning.called, false);
        assert.equal(memory.consolidate.called, false);
        assert.deepEqual(picker.quickPick.selectedItems, [selectedItem]);
        assert.equal(webview.create.calledOnce, true);
        assert.equal(webview.create.firstCall.args[0], 'gitCommitGenie.memoryEvidence');
        assert.equal(webview.create.firstCall.args[1], 'Historical evidence for 00000000-0000-4000-8000-000000000001');
        assert.equal((webview.create.firstCall.args[2] as { viewColumn?: vscode.ViewColumn }).viewColumn, vscode.ViewColumn.Beside);
        assert.equal((webview.create.firstCall.args[2] as { preserveFocus?: boolean }).preserveFocus, true);
        assert.equal((webview.create.firstCall.args[3] as vscode.WebviewOptions).enableScripts, false);

        picker.triggerItemButton(parserItem);
        await flushAsync();

        assert.equal(webview.create.calledOnce, true);
        assert.equal(webview.reveal.calledOnce, true);
        assert.deepEqual(webview.reveal.firstCall.args, [vscode.ViewColumn.Beside, true]);
        assert.deepEqual(picker.quickPick.selectedItems, [selectedItem]);
        assert.equal(warning.called, false);
        assert.equal(memory.consolidate.called, false);

        const report = webview.html();
        assert.match(report, /Saved investigation experience/);
        assert.match(report, /Preview of existing history; no recheck has run on this page\./);
        assert.match(report, /Applicable situation/);
        assert.match(report, /Parser handbook conclusion/);
        assert.match(report, /Investigation route/);
        assert.match(report, /2 historical records · 2 independent snapshots/);
        assert.match(report, /Available investigation history/);
        assert.match(report, /Recorded investigation question/);
        assert.match(report, /Associated historical finding/);
        assert.match(report, /before parser excerpt/);
        assert.match(report, /after parser excerpt/);
        assert.match(report, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
        assert.doesNotMatch(report, /<script>alert/);
        assert.match(report, /Truncated result/);
        assert.match(report, /Repository snapshot/);
        assert.match(report, /Recorded arguments/);

        picker.accept();
        await pending;

        assert.equal(warning.calledOnce, true);
        assert.deepEqual(memory.consolidate.firstCall.args, ['r'.repeat(64), { model: 'memory-model' }, 'manual-recheck', [episodes[2].id]]);
        assert.equal(information.length, 1);
    });

    it('reports when an evidence group has no related Handbook entry', async () => {
        // A details report without a matching Handbook target explicitly states that no related Handbook entry exists.
        const report = await readRecheckDetailsHtml(sandbox, makeRecheckEpisodes(), []);

        assert.match(report, /Saved investigation experience/);
        assert.match(report, /Available investigation history/);
        assert.doesNotMatch(report, /Applicable situation/);
    });

    it('reports when a recorded evidence excerpt is empty', async () => {
        // An empty saved excerpt is represented explicitly while the report still uses the recorded evidence source.
        const episodes = makeRecheckEpisodes();
        const parserAfter = (episodes[1] as any).observations[0].evidence[0].source;
        parserAfter.excerpt = '';

        const report = await readRecheckDetailsHtml(sandbox, episodes, makeRecheckHandbook(episodes));

        assert.match(report, /<pre><code><\/code><\/pre>/);
    });

    it('reports when an investigation note is empty', async () => {
        // An empty observation summary is represented explicitly instead of leaving the evidence record unlabeled.
        const episodes = makeRecheckEpisodes();
        (episodes[0] as any).observations[0].summary = '';

        const report = await readRecheckDetailsHtml(sandbox, episodes, makeRecheckHandbook(episodes));

        assert.match(report, /<p><\/p>/);
    });

    it('cancels recheck without consolidation when the createQuickPick is hidden', async () => {
        // Hiding the recheck QuickPick resolves as cancellation and prevents both the paid confirmation and consolidation call.
        const store = makeStore();
        const episodes = makeRecheckEpisodes();
        const groups = buildConsolidationGroups(episodes as any, []);
        store.inspect.resolves({ epoch: 'epoch', generation: 1, episodes, handbook: [], consolidated: groups.map(group => group.fingerprint), organizedSeeds: groups.map(group => group.seedId) });
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'recheck');
        const picker = makeRecheckQuickPick();
        sandbox.stub(vscode.window, 'createQuickPick').returns(picker.quickPick as never);
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const information = stubInformation(sandbox);
        const pending = invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        await flushAsync();
        picker.hide();
        await pending;

        assert.equal(warning.called, false);
        assert.equal(memory.consolidate.called, false);
        assert.deepEqual(information, []);
    });

    it('deletes selected episodes after the exact destructive confirmation and reports the dependent cleanup', async () => {
        const store = makeStore();
        const episode = {
            id: 'episode-1', createdAt: 1, changedPaths: ['src/parser.ts'], status: 'complete',
            snapshot: { id: 's'.repeat(64) },
        };
        store.inspect.resolves({ epoch: 'epoch', generation: 1, episodes: [episode], handbook: [], consolidated: [] });
        store.deleteEpisodes.resolves(1);
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubDeleteSelection(sandbox);
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);
        let warningMessage = '';
        let warningButtons: readonly string[] = [];
        sandbox.stub(vscode.window, 'showWarningMessage').callsFake((async (
            message: string, _options: unknown, ...items: string[]
        ) => {
            warningMessage = message;
            warningButtons = items;
            return items[0] as never;
        }) as unknown as typeof vscode.window.showWarningMessage);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(warningMessage,
            'Permanently delete 1 selected episodes and their dependent handbook entries for this clone? This cannot be undone.');
        assert.equal(warningButtons[0], 'Delete selected episodes');
        assert.deepEqual(store.deleteEpisodes.firstCall.args, [['episode-1']]);
        assert.equal(memory.cancel.calledWith('r'.repeat(64)), true);
        assert.equal(information.length, 1);
        assert.match(information[0], /Permanently deleted 1 episodes and removed their dependent handbook entries/);
        assertSpinnersReleased(statuses);
    });

    it('reports empty memory for delete without opening a confirmation or mutating the store', async () => {
        const store = makeStore();
        store.inspect.resolves({ epoch: 'epoch', generation: 1, episodes: [], handbook: [], consolidated: [] });
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'delete');
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(warning.called, false);
        assert.equal(store.deleteEpisodes.called, false);
        assert.deepEqual(information, ['No episodes to delete.']);
        assertSpinnersReleased(statuses);
    });

    it('reports no consolidation task when cancellation has nothing to cancel', async () => {
        const result = await runCancelAction(sandbox, 'nothing-to-cancel');

        assert.match(result.message, /No consolidation task to cancel/);
        assert.equal(result.memory.cancel.firstCall.args[0], 'r'.repeat(64));
        assertSpinnersReleased(result.statuses);
    });

    it('reports cancellation of a waiting consolidation task', async () => {
        const result = await runCancelAction(sandbox, 'scheduled-cancelled');

        assert.match(result.message, /Cancelled the waiting consolidation task/);
        assert.equal(result.memory.cancel.firstCall.args[0], 'r'.repeat(64));
        assertSpinnersReleased(result.statuses);
    });

    it('reports a cancellation request for a running consolidation task', async () => {
        const result = await runCancelAction(sandbox, 'running-cancel-requested');

        assert.match(result.message, /Cancellation requested for running consolidation/);
        assert.equal(result.memory.cancel.firstCall.args[0], 'r'.repeat(64));
        assertSpinnersReleased(result.statuses);
    });

    it('pauses automatic consolidation globally and preserves manual memory operations', async () => {
        const result = await runSettingAction(sandbox, 'pause', 'consolidation.enabled', true);

        assert.equal(result.value, false);
        assert.match(result.message, /Automatic consolidation paused globally/);
        assert.equal(result.memory.cancel.calledOnce, true);
        assertSpinnersReleased(result.statuses);
    });

    it('resumes automatic consolidation globally', async () => {
        const result = await runSettingAction(sandbox, 'pause', 'consolidation.enabled', false);

        assert.equal(result.value, true);
        assert.match(result.message, /Automatic consolidation resumed globally/);
        assert.equal(result.memory.cancel.calledOnce, true);
        assertSpinnersReleased(result.statuses);
    });

    it('disables repository memory globally without deleting existing data', async () => {
        const result = await runSettingAction(sandbox, 'toggle', 'enabled', true);

        assert.equal(result.value, false);
        assert.match(result.message, /Repository Memory disabled globally/);
        assert.equal(result.memory.cancel.calledOnce, true);
        assertSpinnersReleased(result.statuses);
    });

    it('enables repository memory globally', async () => {
        const result = await runSettingAction(sandbox, 'toggle', 'enabled', false);

        assert.equal(result.value, true);
        assert.match(result.message, /Repository Memory enabled globally/);
        assert.equal(result.memory.cancel.calledOnce, true);
        assertSpinnersReleased(result.statuses);
    });

    it('surfaces every consolidation result and releases its spinner before notifying the user', async () => {
        // The management command forwards the short published description and preserves the notification lifecycle for every outcome.
        const outcomes: Array<{ result: any; expected: RegExp }> = [
            { result: {
                status: 'published', groupCount: 5, handbookCount: 2, noFindingCount: 1, failedGroupCount: 0,
                skippedGroups: 0, deferredPaths: [], retryCount: 0,
                groupOutcomes: [{ seedId: '00000000-0000-4000-8000-000000000001', status: 'published', entryIds: [], issues: [] }],
            }, expected: /^Consolidated 5 evidence groups into 2 handbook entries;$/ },
            { result: { status: 'partial', groupCount: 2, handbookCount: 1, noFindingCount: 0, failedGroupCount: 1,
                skippedGroups: 1, deferredPaths: ['src/deferred.ts'], retryCount: 1,
                groupOutcomes: [{ seedId: '00000000-0000-4000-8000-000000000001', status: 'published', entryIds: [], issues: [] }, { seedId: '00000000-0000-4000-8000-000000000002', status: 'failed', entryIds: [], issues: ['validation failed'] }] }, expected: /Partially consolidated 2 evidence groups/ },
            { result: { status: 'no-findings', groupCount: 1, skippedGroups: 1, deferredPaths: ['src/deferred.ts'], retryCount: 0,
                groupOutcomes: [{ seedId: '00000000-0000-4000-8000-000000000001', status: 'no-findings', entryIds: [], issues: [] }] }, expected: /Checked 1 evidence groups/ },
            { result: { status: 'not-ready', pendingCount: 3, threshold: 2 }, expected: /Consolidation not run:.*3\/2/ },
            { result: { status: 'budget-exhausted', limit: 2, resumesAt: Date.now() + 60_000 }, expected: /24-hour start allowance/ },
            { result: { status: 'memory-disabled' }, expected: /Repository Memory is disabled/ },
            { result: { status: 'foreground-busy' }, expected: /commit generation is active/ },
            { result: { status: 'already-running' }, expected: /another task holds/ },
            { result: { status: 'cancelled' }, expected: /Consolidation cancelled/ },
            { result: { status: 'automatic-paused' }, expected: /Automatic consolidation is paused/ },
        ];

        for (const outcome of outcomes) {
            sandbox.restore();
            sandbox = sinon.createSandbox();
            sandbox.stub(logger, 'logToolCall');
            const store = makeStore();
            const memory = makeMemoryService(store);
            memory.consolidate.resolves(outcome.result);
            const { context } = makeContext();
            stubIdentity(sandbox);
            stubAction(sandbox, 'consolidate');
            const statuses = stubStatusBar(sandbox);
            const information = stubInformation(sandbox);

            await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

            assert.equal(information.length, 1, outcome.result.status);
            assert.match(information[0], outcome.expected, outcome.result.status);
            assertSpinnersReleased(statuses);
        }
    });

    it('releases the consolidation spinner and shows a failed-operation error for a provider exception', async () => {
        const store = makeStore();
        const memory = makeMemoryService(store);
        memory.consolidate.rejects(new Error('provider unavailable'));
        const { context, subscriptions } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'consolidate');
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);
        const errors: string[] = [];
        sandbox.stub(vscode.window, 'showErrorMessage').callsFake((async (message: string) => {
            errors.push(message);
            return undefined;
        }) as unknown as typeof vscode.window.showErrorMessage);
        const registered = new Map<string, (...args: unknown[]) => unknown>();
        sandbox.stub(vscode.workspace, 'registerTextDocumentContentProvider').returns({ dispose() { /* no-op */ } });
        sandbox.stub(vscode.commands, 'registerCommand').callsFake(((id: string, handler: (...args: unknown[]) => unknown) => {
            registered.set(id, handler);
            return { dispose() { /* no-op */ } };
        }) as unknown as typeof vscode.commands.registerCommand);

        new MemoryCommands(context, makeRegistry(store, memory) as never).register();
        await registered.get('git-commit-genie.manageMemory')?.();

        assert.equal(subscriptions.length, 3);
        assert.deepEqual(information, []);
        assert.deepEqual(errors, ['Memory operation failed: provider unavailable']);
        assert.match(statuses[statuses.length - 1].message, /Memory operation failed: provider unavailable/);
        assertSpinnersReleased(statuses);
    });

    it('reports a successful index rebuild and releases its spinner', async () => {
        const store = makeStore();
        store.rebuildIndex.resolves(4);
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'rebuild');
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(store.rebuildIndex.calledOnce, true);
        assert.equal(information.length, 1);
        assert.match(information[0], /Rebuilt the index from 4 stored episodes/);
        assert.equal(statuses[0].disposed, true);
    });

    it('reports a successful clear while preserving the non-reset quota contract', async () => {
        const store = makeStore();
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'clear');
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Clear memory' as never);
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(warning.calledOnce, true);
        assert.equal(warning.firstCall.args[0], 'Delete all memory for this clone, including shared worktrees? This cannot be undone.');
        assert.equal(warning.firstCall.args[2], 'Clear memory');
        assert.equal(store.clear.calledOnce, true);
        assert.equal(memory.cancel.calledWith('r'.repeat(64)), true);
        assert.equal(information.length, 1);
        assert.match(information[0], /permanently cleared/);
        assert.match(information[0], /24-hour consolidation start allowance was not reset/);
        assert.equal(statuses[0].disposed, true);
    });

    it('reports management failures through the registered command handler', async () => {
        const store = makeStore();
        store.inspect.rejects(new Error('inspect failed'));
        const memory = makeMemoryService(store);
        const { context, subscriptions } = makeContext();
        const registry = makeRegistry(store, memory);
        stubIdentity(sandbox);
        stubAction(sandbox, 'inspect');
        const statuses = stubStatusBar(sandbox);
        const errors: string[] = [];
        sandbox.stub(vscode.window, 'showErrorMessage').callsFake((async (message: string) => {
            errors.push(message);
            return undefined;
        }) as unknown as typeof vscode.window.showErrorMessage);
        const registered = new Map<string, (...args: unknown[]) => unknown>();
        sandbox.stub(vscode.workspace, 'registerTextDocumentContentProvider').returns({ dispose() { /* no-op */ } });
        sandbox.stub(vscode.commands, 'registerCommand').callsFake(((id: string, handler: (...args: unknown[]) => unknown) => {
            registered.set(id, handler);
            return { dispose() { /* no-op */ } };
        }) as unknown as typeof vscode.commands.registerCommand);

        new MemoryCommands(context, registry as never).register();
        await registered.get('git-commit-genie.manageMemory')?.();

        assert.equal(subscriptions.length, 3);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Memory operation failed: inspect failed/);
        assert.equal(statuses[0].disposed, true, 'the operation spinner must be released on failure');
        assert.match(statuses[statuses.length - 1].message, /Memory operation failed: inspect failed/);
    });

    it('cancels clear confirmation silently without mutating memory', async () => {
        const store = makeStore();
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, 'clear');
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const information = stubInformation(sandbox);
        const statuses = stubStatusBar(sandbox);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(warning.calledOnce, true);
        assert.equal(store.clear.called, false);
        assert.equal(information.length, 0);
        assert.deepEqual(statuses, []);
    });

    it('cancels delete confirmation silently after selecting episodes', async () => {
        const store = makeStore();
        const episode = { id: 'episode-1', createdAt: 1, changedPaths: ['src/parser.ts'], status: 'complete', snapshot: { id: 's'.repeat(64) } };
        store.inspect.resolves({ epoch: 'epoch', generation: 1, episodes: [episode], handbook: [], consolidated: [] });
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        let quickPickCall = 0;
        sandbox.stub(vscode.window, 'showQuickPick').callsFake((async (
            items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
        ) => {
            quickPickCall += 1;
            const resolved = Array.isArray(items) ? items : await items;
            if (quickPickCall === 1) {
                return (resolved as Array<vscode.QuickPickItem & { id?: string }>).find(item => item.id === 'delete') as never;
            }
            return [resolved[0]] as never;
        }) as unknown as typeof vscode.window.showQuickPick);
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const information = stubInformation(sandbox);
        const statuses = stubStatusBar(sandbox);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(warning.calledOnce, true);
        assert.equal(warning.firstCall.args[0],
            'Permanently delete 1 selected episodes and their dependent handbook entries for this clone? This cannot be undone.');
        assert.equal(warning.firstCall.args[2], 'Delete selected episodes');
        assert.equal(store.deleteEpisodes.called, false);
        assert.deepEqual(information, []);
        assertSpinnersReleased(statuses);
    });
});

async function invokeManage(commands: MemoryCommands): Promise<void> {
    await (commands as unknown as { manage(): Promise<void> }).manage();
}

function stubDeleteSelection(sandbox: sinon.SinonSandbox): void {
    let quickPickCall = 0;
    sandbox.stub(vscode.window, 'showQuickPick').callsFake((async (
        items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
    ) => {
        quickPickCall += 1;
        const resolved = Array.isArray(items) ? items : await items;
        if (quickPickCall === 1) {
            return (resolved as Array<vscode.QuickPickItem & { id?: string }>).find(item => item.id === 'delete') as never;
        }
        return [resolved[0]] as never;
    }) as unknown as typeof vscode.window.showQuickPick);
}

async function runCancelAction(
    sandbox: sinon.SinonSandbox,
    outcome: 'nothing-to-cancel' | 'scheduled-cancelled' | 'running-cancel-requested',
): Promise<{ message: string; statuses: Array<{ message: string; disposed: boolean }>; memory: any }> {
    const store = makeStore();
    const memory = makeMemoryService(store);
    memory.cancel.returns(outcome);
    const { context } = makeContext();
    stubIdentity(sandbox);
    stubAction(sandbox, 'cancel');
    const statuses = stubStatusBar(sandbox);
    const information = stubInformation(sandbox);

    await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

    assert.equal(information.length, 1);
    return { message: information[0], statuses, memory };
}

async function runSettingAction(
    sandbox: sinon.SinonSandbox,
    action: 'pause' | 'toggle',
    key: 'consolidation.enabled' | 'enabled',
    initial: boolean,
): Promise<{ value: boolean; message: string; statuses: Array<{ message: string; disposed: boolean }>; memory: any }> {
    const config = vscode.workspace.getConfiguration('gitCommitGenie.memory');
    const previous = config.get<boolean>(key, false);
    await config.update(key, initial, vscode.ConfigurationTarget.Global);
    try {
        const store = makeStore();
        const memory = makeMemoryService(store);
        const { context } = makeContext();
        stubIdentity(sandbox);
        stubAction(sandbox, action);
        const statuses = stubStatusBar(sandbox);
        const information = stubInformation(sandbox);

        await invokeManage(new MemoryCommands(context, makeRegistry(store, memory) as never));

        assert.equal(information.length, 1);
        // WorkspaceConfiguration instances may retain a pre-update snapshot; read the post-command value from a fresh object.
        const value = vscode.workspace.getConfiguration('gitCommitGenie.memory').get<boolean>(key, false);
        return { value, message: information[0], statuses, memory };
    } finally {
        await config.update(key, previous, vscode.ConfigurationTarget.Global);
    }
}

function assertSpinnersReleased(statuses: Array<{ message: string; disposed: boolean }>): void {
    const spinners = statuses.filter(status => status.message.startsWith('$(sync~spin)'));
    assert.ok(spinners.length > 0, 'the operation must publish a spinner status');
    assert.equal(spinners.every(status => status.disposed), true, 'all operation spinners must be disposed');
}

function stubIdentity(sandbox: sinon.SinonSandbox): void {
    sandbox.stub(RepositorySnapshotReader, 'identify').resolves({
        repositoryId: 'r'.repeat(64),
        worktreeId: 'w'.repeat(64),
    });
}

function stubAction(sandbox: sinon.SinonSandbox, id: string): void {
    sandbox.stub(vscode.window, 'showQuickPick').callsFake((async (
        items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
    ) => {
        const resolved = Array.isArray(items) ? items : await items;
        const action = (resolved as Array<vscode.QuickPickItem & { id?: string }>).find(item => item.id === id);
        if (!action) {
            throw new Error(`Action '${id}' was not offered.`);
        }
        return action;
    }) as unknown as typeof vscode.window.showQuickPick);
}

type RecheckTestItem = vscode.QuickPickItem & { path?: string; group?: unknown };

interface RecheckQuickPickHarness {
    quickPick: vscode.QuickPick<RecheckTestItem>;
    accept(): void;
    hide(): void;
    triggerItemButton(item: RecheckTestItem): void;
}

function makeRecheckQuickPick(): RecheckQuickPickHarness {
    const acceptEmitter = new vscode.EventEmitter<void>();
    const hideEmitter = new vscode.EventEmitter<void>();
    const itemButtonEmitter = new vscode.EventEmitter<vscode.QuickPickItemButtonEvent<RecheckTestItem>>();
    const quickPick = {
        items: [] as readonly RecheckTestItem[],
        selectedItems: [] as readonly RecheckTestItem[],
        canSelectMany: false,
        matchOnDescription: false,
        matchOnDetail: false,
        placeholder: undefined,
        onDidAccept: acceptEmitter.event,
        onDidHide: hideEmitter.event,
        onDidTriggerItemButton: itemButtonEmitter.event,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
    } as unknown as vscode.QuickPick<RecheckTestItem>;
    return {
        quickPick,
        accept: () => acceptEmitter.fire(),
        hide: () => hideEmitter.fire(),
        triggerItemButton: item => itemButtonEmitter.fire({
            item,
            button: item.buttons?.[0] ?? { iconPath: new vscode.ThemeIcon('info') },
        }),
    };
}

function stubRecheckSelection(
    sandbox: sinon.SinonSandbox,
    onGroups?: (items: RecheckTestItem[]) => void,
    selectedLabels: string[] = [],
): RecheckQuickPickHarness {
    const picker = makeRecheckQuickPick();
    sandbox.stub(vscode.window, 'createQuickPick').returns(picker.quickPick as never);
    picker.quickPick.show = () => {
        const items = [...picker.quickPick.items] as RecheckTestItem[];
        onGroups?.(items);
        picker.quickPick.selectedItems = selectedLabels.length
            ? items.filter(item => selectedLabels.includes(item.label))
            : items.slice(0, 1);
        picker.accept();
    };
    return picker;
}

function stubRecheckWebview(sandbox: sinon.SinonSandbox): {
    panel: vscode.WebviewPanel;
    create: sinon.SinonStub;
    reveal: sinon.SinonStub;
    html(): string;
} {
    const disposeEmitter = new vscode.EventEmitter<void>();
    const messageEmitter = new vscode.EventEmitter<unknown>();
    const webview = {
        html: '',
        options: { enableScripts: false, retainContextWhenHidden: false },
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: async () => true,
        onDidReceiveMessage: messageEmitter.event,
    } as unknown as vscode.Webview;
    const reveal = sandbox.stub();
    const panel = {
        viewType: 'gitCommitGenie.memoryEvidence',
        title: '',
        webview,
        viewColumn: vscode.ViewColumn.Beside,
        active: true,
        visible: true,
        onDidDispose: disposeEmitter.event,
        reveal,
        dispose: () => disposeEmitter.fire(),
    } as unknown as vscode.WebviewPanel;
    sandbox.stub(vscode.workspace, 'registerTextDocumentContentProvider').returns({ dispose() { /* no-op */ } } as never);
    const create = sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
    return {
        panel,
        create,
        reveal,
        html: () => panel.webview.html,
    };
}

function stubCommandRegistration(sandbox: sinon.SinonSandbox): void {
    sandbox.stub(vscode.commands, 'registerCommand').callsFake((() => ({ dispose() { /* no-op */ } })) as unknown as typeof vscode.commands.registerCommand);
}

async function flushAsync(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

function assertHtmlSupportTrace(
    report: string,
    episodeId: string,
    evidenceId: string,
    createdAt: number,
    tool: string,
    sourcePath: string,
    startLine: number,
    endLine: number,
    snapshotId: string,
): void {
    const episodeMarker = `<dd><code>${episodeId}</code></dd>`;
    const markerIndex = report.indexOf(episodeMarker);
    assert.ok(markerIndex >= 0, `Missing support episode '${episodeId}'.`);
    const recordStart = report.lastIndexOf('<details class="evidence-record">', markerIndex);
    const nextRecord = report.indexOf('<details class="evidence-record">', markerIndex);
    const block = report.slice(recordStart, nextRecord >= 0 ? nextRecord : undefined);
    assert.match(block, new RegExp(escapeRegExp(formatTestRecordedAt(createdAt))));
    assert.match(block, new RegExp(escapeRegExp(`<dd><code>${evidenceId}</code></dd>`)));
    assert.match(block, new RegExp(escapeRegExp(tool)));
    assert.match(block, new RegExp(escapeRegExp(`${sourcePath}`)));
    assert.match(block, new RegExp(escapeRegExp(`lines ${startLine}-${endLine}`)));
    assert.match(block, new RegExp(escapeRegExp(snapshotId)));
}

async function readRecheckDetailsHtml(
    sandbox: sinon.SinonSandbox,
    episodes: Array<Record<string, unknown>>,
    handbook: Array<Record<string, unknown>>,
): Promise<string> {
    const store = makeStore();
    const groups = buildConsolidationGroups(episodes as any, []);
    store.inspect.resolves({ epoch: 'epoch', generation: 1, episodes, handbook, consolidated: groups.map(group => group.fingerprint), organizedSeeds: groups.map(group => group.seedId) });
    const memory = makeMemoryService(store);
    const { context } = makeContext();
    stubIdentity(sandbox);
    stubAction(sandbox, 'recheck');
    const picker = makeRecheckQuickPick();
    sandbox.stub(vscode.window, 'createQuickPick').returns(picker.quickPick as never);
    const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    const webview = stubRecheckWebview(sandbox);
    stubCommandRegistration(sandbox);
    const commands = new MemoryCommands(context, makeRegistry(store, memory) as never);
    commands.register();

    const pending = invokeManage(commands);
    await flushAsync();
    const parserItem = picker.quickPick.items.find(item => item.label === 'Where should src/parser.ts be investigated?');
    assert.ok(parserItem);
    picker.triggerItemButton(parserItem);
    await flushAsync();
    const report = webview.html();
    picker.hide();
    await pending;

    assert.equal(warning.called, false);
    assert.equal(memory.consolidate.called, false);
    return report;
}

function formatTestRecordedAt(createdAt: number): string {
    return new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(createdAt));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stubStatusBar(sandbox: sinon.SinonSandbox): Array<{ message: string; disposed: boolean }> {
    const statuses: Array<{ message: string; disposed: boolean }> = [];
    sandbox.stub(vscode.window, 'setStatusBarMessage').callsFake(((message: string) => {
        const status = { message, disposed: false };
        statuses.push(status);
        return { dispose: () => { status.disposed = true; } };
    }) as unknown as typeof vscode.window.setStatusBarMessage);
    return statuses;
}

function stubInformation(sandbox: sinon.SinonSandbox): string[] {
    const messages: string[] = [];
    sandbox.stub(vscode.window, 'showInformationMessage').callsFake((async (message: string) => {
        messages.push(message);
        return undefined;
    }) as unknown as typeof vscode.window.showInformationMessage);
    return messages;
}

function makeContext(): { context: vscode.ExtensionContext; subscriptions: { dispose(): void }[] } {
    const subscriptions: { dispose(): void }[] = [];
    return {
        context: {
            subscriptions,
            globalStorageUri: vscode.Uri.file('/tmp/git-commit-genie-memory-command-tests'),
        } as unknown as vscode.ExtensionContext,
        subscriptions,
    };
}

function makeStore(): any {
    return {
        repositoryId: 'r'.repeat(64),
        inspect: sinon.stub(),
        clear: sinon.stub().resolves(),
        deleteEpisodes: sinon.stub().resolves(1),
        rebuildIndex: sinon.stub().resolves(0),
    };
}

function makeMemoryService(store: any): any {
    return {
        storeFor: sinon.stub().returns(store),
        cancel: sinon.stub().returns('nothing-to-cancel'),
        consolidate: sinon.stub(),
        warn: sinon.stub(),
    };
}

function makeRecheckEpisodes(): Array<Record<string, unknown>> {
    const records: Array<{
        sourcePath: string;
        index: number;
        side: 'before' | 'after';
        tool: string;
        startLine: number;
        endLine: number;
        excerpt: string;
        truncated: boolean;
    }> = [
        { sourcePath: 'src/parser.ts', index: 1, side: 'before', tool: 'readFileContent', startLine: 10, endLine: 12, excerpt: 'before parser excerpt <script>alert("x")</script>', truncated: true },
        { sourcePath: 'src/parser.ts', index: 2, side: 'after', tool: 'searchCode', startLine: 20, endLine: 22, excerpt: 'after parser excerpt', truncated: false },
        { sourcePath: 'src/unorganized.ts', index: 3, side: 'before', tool: 'readFileContent', startLine: 30, endLine: 32, excerpt: 'before unorganized excerpt', truncated: false },
        { sourcePath: 'src/unorganized.ts', index: 4, side: 'after', tool: 'searchCode', startLine: 40, endLine: 42, excerpt: 'after unorganized excerpt', truncated: false },
    ];
    return records.map(({ sourcePath, index, side, tool: recordedTool, startLine, endLine, excerpt, truncated }) => ({
        version: 2,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        createdAt: index,
        status: 'complete',
        snapshot: { id: String(index).repeat(64) },
        observations: [{
            step: 0,
            tool: sourcePath === 'src/parser.ts' ? 'readFileContent' : recordedTool,
            arguments: { filePath: sourcePath },
            ok: true,
            summary: 'recorded evidence',
            durationMs: 1,
            truncated: false,
            evidence: [{ id: 'E1', source: {
                snapshotId: String(index).repeat(64), path: sourcePath, side,
                blobOid: String(index).repeat(40), startLine, endLine, excerpt,
                contentHash: hashContent(excerpt), truncated, sourceType: 'text',
            } }, ...(index === 1 ? [{ id: 'E2', source: {
                snapshotId: String(index).repeat(64), path: sourcePath, side,
                blobOid: String(index).repeat(40), startLine, endLine, excerpt: `${excerpt} second`,
                contentHash: hashContent(`${excerpt} second`), truncated, sourceType: 'text',
            } }] : [])],
        }],
        changedPaths: [sourcePath],
        changedSymbols: [],
        questions: [`Where should ${sourcePath} be investigated?`],
        claims: [{ claim: 'The recorded source is available for historical inspection.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        model: 'memory-test-model',
        promptVersion: 'memory-experience-1',
        toolsetVersion: 'snapshot-memory-experience-1',
    }));
}

function makeRecheckHandbook(episodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return [{
        id: '10000000-0000-4000-8000-000000000001',
        situation: 'Parser handbook conclusion',
        steps: [{
            path: 'src/parser.ts', symbol: null, purpose: 'Inspect the parser entry point before changing the consumer.', operation: 'readFileContent',
            supports: [
                { episodeId: episodes[0].id, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 },
                { episodeId: episodes[1].id, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 },
            ], snapshotCount: 2,
        }],
        lessons: [{
            observation: 'The historical parser record was captured before the current change.',
            implication: 'Use the parser entry point as the first investigation location.',
            limitation: 'The saved record is historical context and must be checked against current source.',
            supports: [
                { episodeId: episodes[0].id, observationIndex: 0 },
                { episodeId: episodes[1].id, observationIndex: 0 },
            ], snapshotCount: 2,
        }],
        triggers: ['src/parser.ts', 'parser entry point'],
        targetPaths: ['src/parser.ts'],
    }];
}

function makeRegistry(store: any, memory: any, model: unknown = { model: 'memory-model' }): any {
    const repository = { rootUri: vscode.Uri.file('/tmp/memory-command-repository') };
    const repoService = {
        getRepositories: () => [repository],
        getGitApi: () => ({ git: { path: '/usr/bin/git' } }),
        getRepositoryLabel: () => 'memory-command-repository',
    };
    return {
        getRepoService: () => repoService,
        getMemoryService: () => memory,
        getCurrentLLMService: () => model,
        store,
    };
}
