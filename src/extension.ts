// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { DiffService } from './services/git/diff';
import { OpenAIService } from './services/llm/providers/openai';
import { DeepSeekService } from './services/llm/providers/deepseek';
import { AnthropicService } from './services/llm/providers/anthropic';
import { GeminiService } from './services/llm/providers/gemini';
import { L10N_KEYS as I18N } from './i18n/keys';
import { TemplateService } from './template/templateService';
import { logger, LogLevel } from './services/logger';

export function activate(context: vscode.ExtensionContext) {

	// Initialize OutputChannel and Logger
	const outputChannel = vscode.window.createOutputChannel('Git Commit Genie');
	const config = vscode.workspace.getConfiguration('gitCommitGenie');
	const logLevel = config.get<string>('logLevel', 'info');
	const level = logLevel === 'debug' ? LogLevel.Debug :
		logLevel === 'warn' ? LogLevel.Warning :
			logLevel === 'error' ? LogLevel.Error : LogLevel.Info;
	logger.initialize(outputChannel, level);
	context.subscriptions.push(outputChannel);

	logger.info('Git Commit Genie is activating...');

	const diffService = new DiffService();
	const openAIService = new OpenAIService(context);
	const deepseekService = new DeepSeekService(context);
	const anthropicService = new AnthropicService(context);
	const geminiService = new GeminiService(context);

	const templateService = new TemplateService(context);

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

	const pickService = (): OpenAIService | DeepSeekService | AnthropicService | GeminiService => {
		const provider = getProvider();
		const service = llmServices.get(provider || 'openai') || openAIService;
		return service;
	};

	let llmService = pickService();

	// Status bar: show active provider & model and allow quick change
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	statusBarItem.command = 'git-commit-genie.manageModels';

	function readChainEnabled(): boolean {
		const cfg: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
		// New key
		const newVal = cfg.get<boolean>('gitCommitGenie.chain.enabled');
		if (typeof newVal === 'boolean') {
			context.globalState.update('gitCommitGenie.useChainPrompts', newVal);
			return newVal;
		} else {
			// newVal is undefined
			return false;
		}
	}

	const updateStatusBar = () => {
		const provider = getProvider().toLowerCase();
		const model = getModel(provider);
		const providerLabel = provider === 'deepseek' ? 'DeepSeek' : provider === 'anthropic' ? 'Anthropic' : provider === 'gemini' ? 'Gemini' : 'OpenAI';
		const chain = readChainEnabled();
		const chainBadge = chain ? vscode.l10n.t(I18N.statusBar.chainBadge) : '';
		// Shorten model display: remove trailing date/version suffix like -20250219 or -20250219-v1
		const shortenModelName = (m: string): string => {
			if (!m) { return m; }
			const datePattern = /(.*?)-(20\d{6})(?:[-]?v?\d+)?$/; // captures prefix and a 4-digit year starting with 20 plus MMDD
			const match = m.match(datePattern);
			if (match) {
				return match[1];
			}
			return m;
		};
		const modelLabel = model && model.trim() ? shortenModelName(model.trim()) : vscode.l10n.t(I18N.statusBar.selectModel);
		statusBarItem.text = `$(chat-sparkle) Genie: ${modelLabel}${chainBadge}`;
		statusBarItem.tooltip = model && model.trim()
			? vscode.l10n.t(I18N.statusBar.tooltipConfigured, providerLabel, model)
			: vscode.l10n.t(I18N.statusBar.tooltipNeedConfig, providerLabel);
		statusBarItem.show();
	};
	updateStatusBar();
	context.subscriptions.push(statusBarItem);

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
		const activeProvider = getProvider().toLowerCase();
		const isActiveProvider = providerPick.value.toLowerCase() === activeProvider;
		const modelItems: Array<vscode.QuickPickItem & { value: string }> = models.map(m => ({
			label: m,
			value: m,
			description: isActiveProvider && m === currentModel ? vscode.l10n.t(I18N.manageModels.currentLabel) : undefined,
			picked: isActiveProvider && m === currentModel
		}));
		const modelPick = await vscode.window.showQuickPick(
			modelItems,
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
			title: vscode.l10n.t(I18N.generation.progressTitle),
			cancellable: true,
		}, async (progress, token) => {
			token.onCancellationRequested(() => cts.cancel());
			try {
				const diffs = await diffService.getDiff();
				if (diffs.length === 0) {
					vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.noStagedChanges));
					return;
				}

				const result = await llmService.generateCommitMessage(diffs, { token: cts.token });

				if ('content' in result) {
					const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
					const api = gitExtension.getAPI(1);
					const repo = api.repositories[0];
					if (repo) {
						// Simulate typing effect
						const fullText = result.content;
						repo.inputBox.value = '';
						let i = 0;
						const interval = setInterval(() => {
							if (i <= fullText.length) {
								repo.inputBox.value = fullText.slice(0, i);
								i++;
							} else {
								clearInterval(interval);
							}
						}, 15); // typing speed
					}
				} else {
					if (result.statusCode === 401) {
						await vscode.commands.executeCommand('git-commit-genie.manageModels');
						return;
					}
					if (result.statusCode === 499 || /Cancelled/i.test(result.message)) {
						vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.cancelled));
					} else {
						vscode.window.showErrorMessage(vscode.l10n.t(I18N.generation.errorGenerating, result.message));
					}
				}
			} catch (error: any) {
				if (cts.token.isCancellationRequested) {
					vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.cancelled));
				} else {
					vscode.window.showErrorMessage(vscode.l10n.t(I18N.generation.failedToGenerate, error.message));
				}
			} finally {
				cts.dispose();
				currentCancelSource = undefined;
				await vscode.commands.executeCommand('setContext', 'gitCommitGenie.generating', false);
			}
		});
	});

	context.subscriptions.push(generateCommitMessageCommand);

	// Template selection / creation
	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.selectTemplate', async () => {
		await templateService.openQuickPicker();
	}));

	// Toggle chain prompting mode
	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.toggleChainMode', async () => {
		const currentCfg = vscode.workspace.getConfiguration();
		// Prefer new key if present or previously set
		let current = currentCfg.get<boolean>('gitCommitGenie.chain.enabled');
		if (typeof current !== 'boolean') {
			current = currentCfg.get<boolean>('gitCommitGenie.useChainPrompts', false);
		}
		await currentCfg.update('gitCommitGenie.chain.enabled', !current, vscode.ConfigurationTarget.Global);

		updateStatusBar();
		vscode.window.showInformationMessage(
			vscode.l10n.t(
				I18N.chain.toggled,
				!current ? vscode.l10n.t(I18N.chain.enabled) : vscode.l10n.t(I18N.chain.disabled)
			)
		);
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
	logger.info('"git-commit-genie" is now deactivated.');
	logger.dispose();
}
