// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { DiffService } from './services/git/diff';
import { OpenAIService } from './providers/openai';
import { DeepSeekService } from './providers/deepseek';
import { AnthropicService } from './providers/anthropic';
import { GeminiService } from './providers/gemini';
import { SidebarView } from './webviews/SidebarView';
import { L10N_KEYS as I18N } from './i18n/keys';

export function activate(context: vscode.ExtensionContext) {

	const diffService = new DiffService();
	const openAIService = new OpenAIService(context);
	const deepseekService = new DeepSeekService(context);
	const anthropicService = new AnthropicService(context);
	const geminiService = new GeminiService(context);

	// A map to hold different LLM services
	const llmServices = new Map<string, any>([
		['openai', openAIService],
		['deepseek', deepseekService],
		['anthropic', anthropicService],
		['gemini', geminiService],
	]);

	const getProvider = (): string => (context.globalState.get<string>('gitCommitGenie.provider', 'openai'));
	
	const getModel = (provider: string): string => {
		switch (provider) {
			case 'deepseek':
				return context.globalState.get<string>('gitCommitGenie.deepseekModel', '');
			case 'anthropic':
				return context.globalState.get<string>('gitCommitGenie.anthropicModel', '');
			case 'gemini':
				return context.globalState.get<string>('gitCommitGenie.geminiModel', '');
			default:
				return context.globalState.get<string>('gitCommitGenie.openaiModel', '');
		}
	};

	const pickService = (): any => {
		const provider = getProvider();
		const service = llmServices.get(provider || 'openai') || openAIService;
		return service;
	};

	let llmService = pickService();

	// Status bar: show active provider & model and allow quick change
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'git-commit-genie.manageModels';
	const readChainEnabled = (): boolean => {
		const cfg = vscode.workspace.getConfiguration();
		// New key
		const newVal = cfg.get<boolean>('gitCommitGenie.chain.enabled');
		if (typeof newVal === 'boolean') {
			// Mirror to legacy global state for any leftover reads elsewhere
			context.globalState.update('gitCommitGenie.useChainPrompts', newVal);
			return newVal;
		}
		// Fallback to legacy key or globalState
		const legacyVal = cfg.get<boolean>('gitCommitGenie.useChainPrompts');
		if (typeof legacyVal === 'boolean') {
			return legacyVal;
		}
		return context.globalState.get<boolean>('gitCommitGenie.useChainPrompts', false);
	};

	const updateStatusBar = () => {
		const provider = getProvider().toLowerCase();
		const model = getModel(provider);
		const providerLabel = provider === 'deepseek' ? 'DeepSeek' : provider === 'anthropic' ? 'Anthropic' : provider === 'gemini' ? 'Gemini' : 'OpenAI';
		const chain = readChainEnabled();
		const chainBadge = chain ? ' · Chain' : '';
		// Shorten model display: remove trailing date/version suffix like -20250219 or -20250219-v1
		const shortenModelName = (m: string): string => {
			if (!m) { return m; }
			// Common patterns we want to strip:
			// -YYYYMMDD
			// -YYYYMMDDv?N (rare)
			// -YYYYMMDD-vN
			// Keep the core part before the date if it matches.
			const datePattern = /(.*?)-(20\d{6})(?:[-]?v?\d+)?$/; // captures prefix and a 4-digit year starting with 20 plus MMDD
			const match = m.match(datePattern);
			if (match) {
				return match[1];
			}
			return m;
		};
		const modelLabel = model && model.trim() ? shortenModelName(model.trim()) : vscode.l10n.t('gitCommitGenie.statusBar.selectModel', 'Select Model');
		statusBarItem.text = `$(chat-sparkle) Genie: ${providerLabel} ${modelLabel}${chainBadge}`;
		statusBarItem.tooltip = model && model.trim()
			? vscode.l10n.t(I18N.statusBar.tooltipConfigured, providerLabel, model)
			: vscode.l10n.t(I18N.statusBar.tooltipNeedConfig, providerLabel);
		statusBarItem.show();
	};
	updateStatusBar();
	context.subscriptions.push(statusBarItem);

	// TODO: Feature flag: temporarily disable sidebar registration
	const ENABLE_SIDEBAR = false;
	if (ENABLE_SIDEBAR) {
		const sidebarView = new SidebarView(context.extensionUri, diffService, llmService);
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebarView)
		);
	}

	// No config watchers: provider/model are now stored in globalState and API keys in SecretStorage

	// Manage Models: provider -> API key -> model selection
	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.manageModels', async () => {
		const providerPick = await vscode.window.showQuickPick([
			{ label: 'OpenAI', value: 'openai' },
			{ label: 'DeepSeek', value: 'deepseek' },
			{ label: 'Anthropic', value: 'anthropic' },
			{ label: 'Gemini', value: 'gemini' },
		], { placeHolder: vscode.l10n.t(I18N.manageModels.selectProvider) });
		if (!providerPick) { return; }

		const secretName = providerPick.value === 'deepseek'
			? 'gitCommitGenie.secret.deepseekApiKey'
			: providerPick.value === 'anthropic'
				? 'gitCommitGenie.secret.anthropicApiKey'
				: providerPick.value === 'gemini'
					? 'gitCommitGenie.secret.geminiApiKey'
					: 'gitCommitGenie.secret.openaiApiKey';

		const modelStateKey = providerPick.value === 'deepseek'
			? 'gitCommitGenie.deepseekModel'
			: providerPick.value === 'anthropic'
				? 'gitCommitGenie.anthropicModel'
				: providerPick.value === 'gemini'
					? 'gitCommitGenie.geminiModel'
					: 'gitCommitGenie.openaiModel';

		let existingKey = await context.secrets.get(secretName);
		let apiKeyToUse: string | undefined = existingKey || undefined;

		if (existingKey) {
			const masked = existingKey.length > 8
				? existingKey.slice(0, 4) + '…' + existingKey.slice(-4)
				: 'hidden';
			const action = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t(I18N.manageModels.reuseSavedKey, masked), value: 'reuse' },
				{ label: vscode.l10n.t(I18N.manageModels.replaceKey), value: 'replace' },
				{ label: vscode.l10n.t(I18N.manageModels.clearReenter), value: 'clear' },
				{ label: vscode.l10n.t(I18N.manageModels.cancel), value: 'cancel' }
			], { placeHolder: vscode.l10n.t(I18N.manageModels.savedKeyDetected, providerPick.label) });
			if (!action || action.value === 'cancel') { return; }
			if (action.value === 'clear') {
				await context.secrets.delete(secretName);
				existingKey = undefined;
				apiKeyToUse = undefined;
			}
			if (action.value === 'replace' || action.value === 'clear') {
				const newKey = await vscode.window.showInputBox({
					title: vscode.l10n.t(I18N.manageModels.enterNewKeyTitle, providerPick.label),
					prompt: `${providerPick.label} API Key`,
					placeHolder: `${providerPick.label} API Key`,
					password: true,
					ignoreFocusOut: true,
				});
				if (!newKey) { return; }
				apiKeyToUse = newKey;
			} else if (action.value === 'reuse') {
				apiKeyToUse = existingKey; // 重用
			}
		}

		if (!apiKeyToUse) {
			// First time input
			const entered = await vscode.window.showInputBox({
				title: vscode.l10n.t(I18N.manageModels.enterKeyTitle, providerPick.label),
				prompt: `${providerPick.label} API Key`,
				placeHolder: `${providerPick.label} API Key`,
				password: true,
				ignoreFocusOut: true,
			});
			if (!entered) { return; }
			apiKeyToUse = entered;
		}

		let models: string[] = [];
		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: existingKey && apiKeyToUse === existingKey
					? vscode.l10n.t(I18N.manageModels.listingModels, providerPick.label)
					: vscode.l10n.t(I18N.manageModels.validatingKey, providerPick.label),
			}, async () => {
				if (providerPick.value === 'openai') {
					models = await openAIService.validateApiKeyAndListModels(apiKeyToUse!);
				} else if (providerPick.value === 'deepseek') {
					models = await deepseekService.validateApiKeyAndListModels(apiKeyToUse!);
				} else if (providerPick.value === 'anthropic') {
					models = await anthropicService.validateApiKeyAndListModels(apiKeyToUse!);
				} else {
					models = await geminiService.validateApiKeyAndListModels(apiKeyToUse!);
				}
			});
		} catch (err: any) {
			vscode.window.showErrorMessage(err?.message || vscode.l10n.t(I18N.manageModels.validatingKey, providerPick.label));
			return;
		}

		if (!models.length) {
			vscode.window.showErrorMessage(vscode.l10n.t(I18N.manageModels.noModels));
			return;
		}

		const currentModel = context.globalState.get<string>(modelStateKey, '');
		const modelPick = await vscode.window.showQuickPick(
			models.map(m => ({ label: m + (m === currentModel ? vscode.l10n.t(' (current)') : ''), value: m })),
			{ placeHolder: vscode.l10n.t(I18N.manageModels.selectModel, providerPick.label) }
		);
		if (!modelPick) { return; }

		await context.globalState.update('gitCommitGenie.provider', providerPick.value);
		// Only store the key if it actually changed (avoid unnecessary SecretStorage writes)
		if (!existingKey || apiKeyToUse !== existingKey) {
			if (providerPick.value === 'openai') {
				await openAIService.setApiKey(apiKeyToUse!);
				llmService = openAIService;
			} else if (providerPick.value === 'deepseek') {
				await deepseekService.setApiKey(apiKeyToUse!);
				llmService = deepseekService;
			} else if (providerPick.value === 'anthropic') {
				await anthropicService.setApiKey(apiKeyToUse!);
				llmService = anthropicService;
			} else {
				await geminiService.setApiKey(apiKeyToUse!);
				llmService = geminiService;
			}
		} else {
			// Key unchanged: just switch active provider/model reference
			llmService = pickService();
		}

		await context.globalState.update(modelStateKey, modelPick.value);
		updateStatusBar();
		vscode.window.showInformationMessage(vscode.l10n.t(I18N.manageModels.configured, providerPick.label, modelPick.value));
	}));

	let currentCancelSource: vscode.CancellationTokenSource | undefined;

	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.cancelGeneration', async () => {
		currentCancelSource?.cancel();
	}));

	const generateCommitMessageCommand = vscode.commands.registerCommand('git-commit-genie.generateCommitMessage', async () => {
		// First-time UX: if provider or model not configured, jump to Manage Models instead of erroring
		const provider = getProvider().toLowerCase();
		const secretKeyName = provider === 'deepseek'
			? 'gitCommitGenie.secret.deepseekApiKey'
			: provider === 'anthropic'
				? 'gitCommitGenie.secret.anthropicApiKey'
				: provider === 'gemini'
					? 'gitCommitGenie.secret.geminiApiKey'
					: 'gitCommitGenie.secret.openaiApiKey';
		const existingKey = await context.secrets.get(secretKeyName);
		if (!existingKey) {
			await vscode.commands.executeCommand('git-commit-genie.manageModels');
			return;
		}

		const selectedModel = getModel(provider);
		if (!selectedModel || !selectedModel.trim()) {
			await vscode.commands.executeCommand('git-commit-genie.manageModels');
			return;
		}

		await vscode.commands.executeCommand('setContext', 'gitCommitGenie.generating', true);
		const cts = new vscode.CancellationTokenSource();
		currentCancelSource = cts;
		vscode.window.withProgress({
			location: vscode.ProgressLocation.SourceControl,
			title: 'AI Generating Commit Message...',
			cancellable: true,
		}, async (progress, token) => {
			token.onCancellationRequested(() => cts.cancel());
			try {
				const diffs = await diffService.getDiff();
				if (diffs.length === 0) {
					vscode.window.showInformationMessage('No staged changes found.');
					return;
				}

				const result = await llmService.generateCommitMessage(diffs, { token: cts.token });

				if ('content' in result) {
					const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
					const api = gitExtension.getAPI(1);
					const repo = api.repositories[0];
					if (repo) {
						repo.inputBox.value = result.content;
					}
				} else {
					if (result.statusCode === 401) {
						await vscode.commands.executeCommand('git-commit-genie.manageModels');
						return;
					}
					if (result.statusCode === 499 || /Cancelled/i.test(result.message)) {
						vscode.window.showInformationMessage('AI generation cancelled.');
					} else {
						vscode.window.showErrorMessage(`Error generating commit message: ${result.message}`);
					}
				}
			} catch (error: any) {
				if (cts.token.isCancellationRequested) {
					vscode.window.showInformationMessage('AI generation cancelled.');
				} else {
					vscode.window.showErrorMessage(`Failed to generate commit message: ${error.message}`);
				}
			} finally {
				cts.dispose();
				currentCancelSource = undefined;
				await vscode.commands.executeCommand('setContext', 'gitCommitGenie.generating', false);
			}
		});
	});

	context.subscriptions.push(generateCommitMessageCommand);

	// Toggle chain prompting mode
	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.toggleChainMode', async () => {
		const currentCfg = vscode.workspace.getConfiguration();
		// Prefer new key if present or previously set
		let current = currentCfg.get<boolean>('gitCommitGenie.chain.enabled');
		if (typeof current !== 'boolean') {
			current = currentCfg.get<boolean>('gitCommitGenie.useChainPrompts', false);
		}
		await currentCfg.update('gitCommitGenie.chain.enabled', !current, vscode.ConfigurationTarget.Global);
		// Also keep legacy key in sync for a few versions to avoid breaking older code paths
		await currentCfg.update('gitCommitGenie.useChainPrompts', !current, vscode.ConfigurationTarget.Global);
		await context.globalState.update('gitCommitGenie.useChainPrompts', !current);
		updateStatusBar();
		vscode.window.showInformationMessage(vscode.l10n.t(I18N.chain.toggled, !current ? 'enabled' : 'disabled'));
	}));

	// Listen to configuration changes for useChainPrompts to refresh UI
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('gitCommitGenie.useChainPrompts') || e.affectsConfiguration('gitCommitGenie.chain.enabled')) {
			updateStatusBar();
		}
	}));
}

// This method is called when extension is deactivated
export function deactivate() {
	console.log('"git-commit-genie" is now deactivated.');
}
