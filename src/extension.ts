// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DiffService } from './services/git/diff';
import { Repository } from './services/git/git';
import { OpenAIService } from './services/llm/providers/openai';
import { DeepSeekService } from './services/llm/providers/deepseek';
import { AnthropicService } from './services/llm/providers/anthropic';
import { GeminiService } from './services/llm/providers/gemini';
import { L10N_KEYS as I18N } from './i18n/keys';
import { TemplateService } from './template/templateService';
import { logger, LogLevel } from './services/logger';
import { RepositoryAnalysisService } from './services/analysis';

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
	const templateService = new TemplateService(context);

	// Initialize repository analysis service - we'll pass a placeholder LLM service initially
	const analysisService = new RepositoryAnalysisService(context, null as any);

	const openAIService = new OpenAIService(context, templateService, analysisService);
	const deepseekService = new DeepSeekService(context, templateService, analysisService);
	const anthropicService = new AnthropicService(context, templateService, analysisService);
	const geminiService = new GeminiService(context, templateService, analysisService);

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
	analysisService.setLLMService(llmService);

	// Status bar: single item (model + analysis state)
	// Use Right alignment and a very low priority so it sits at the far-right edge.
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
	statusBarItem.command = 'git-commit-genie.genieMenu';

	let repoAnalysisRunning = false;
	let repoAnalysisMissing = false;
	let hasGitRepo = false;

	const detectGitRepo = (): boolean => {
		try {
			const wf = vscode.workspace.workspaceFolders;
			if (!wf || wf.length === 0) { return false; }
			const repoPath = wf[0].uri.fsPath;
			// Simple and reliable: check for .git folder at root
			const exists = fs.existsSync(path.join(repoPath, '.git'));
			return exists;
		} catch { return false; }
	};
	const setRepoAnalysisRunning = (running: boolean) => {
		repoAnalysisRunning = running;
		// Expose a context key so commands/menus can hide the refresh action while running
		vscode.commands.executeCommand('setContext', 'gitCommitGenie.analysisRunning', running);
		updateStatusBar();
	};

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

	const isRepoAnalysisEnabled = (): boolean => {
		try {
			return vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis').get<boolean>('enabled', true);
		} catch { return true; }
	};

	// Set initial context for gating repo-analysis commands/menus
	vscode.commands.executeCommand('setContext', 'gitCommitGenie.repositoryAnalysisEnabled', isRepoAnalysisEnabled());

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
		// Update Git repo presence and set context for menus
		hasGitRepo = detectGitRepo();
		vscode.commands.executeCommand('setContext', 'gitCommitGenie.hasGitRepo', hasGitRepo);

		// Determine if repo analysis markdown exists (only when enabled and when git repo exists)
		try {
			if (isRepoAnalysisEnabled() && hasGitRepo) {
				const wf = vscode.workspace.workspaceFolders;
				if (wf && wf.length > 0) {
					const repoPath = wf[0].uri.fsPath;
					const mdPath = analysisService.getAnalysisMarkdownFilePath(repoPath);
					repoAnalysisMissing = !fs.existsSync(mdPath);
				} else {
					repoAnalysisMissing = false;
				}
			} else {
				repoAnalysisMissing = false;
			}
		} catch {
			repoAnalysisMissing = false;
		}

		const modelLabel = model && model.trim() ? shortenModelName(model.trim()) : vscode.l10n.t(I18N.statusBar.selectModel);
		const analysisIcon = isRepoAnalysisEnabled() ? (!hasGitRepo ? '$(search-stop)' : (repoAnalysisRunning ? '$(sync~spin)' : (repoAnalysisMissing ? '$(refresh)' : '$(check)'))) : '';
		statusBarItem.text = `$(chat-sparkle) Genie: ${modelLabel}${chainBadge} ${analysisIcon}`;
		const baseTooltip = model && model.trim()
			? vscode.l10n.t(I18N.statusBar.tooltipConfigured, providerLabel, model)
			: vscode.l10n.t(I18N.statusBar.tooltipNeedConfig, providerLabel);
		const repoTooltip = isRepoAnalysisEnabled()
			? (!hasGitRepo
				? vscode.l10n.t(I18N.repoAnalysis.initGitToEnable)
				: (repoAnalysisRunning ? vscode.l10n.t(I18N.repoAnalysis.running) : (repoAnalysisMissing ? vscode.l10n.t(I18N.repoAnalysis.missing) : vscode.l10n.t(I18N.repoAnalysis.idle))))
			: '';
		statusBarItem.tooltip = repoTooltip ? `${baseTooltip}\n${repoTooltip}` : baseTooltip;
		// Click action: when no Git repo, jump to official initialize command; otherwise open Genie menu
		statusBarItem.command = !hasGitRepo ? 'git.init' : 'git-commit-genie.genieMenu';
		statusBarItem.show();
	};
	updateStatusBar();
	context.subscriptions.push(statusBarItem);

	// Watch for repository-analysis.md changes to refresh the status icon (only when enabled)
	try {
		if (isRepoAnalysisEnabled()) {
			// Specific file watcher
			const mdWatcher = vscode.workspace.createFileSystemWatcher('**/.gitgenie/repository-analysis.md');
			const repoFromMdUri = (uri: vscode.Uri): string | null => {
				try {
					const mdPath = uri.fsPath;
					const dir = path.dirname(mdPath); // .../.gitgenie
					const repo = path.dirname(dir);
					return repo;
				} catch {
					return null;
				}
			};
			mdWatcher.onDidCreate(async (uri) => {
				const repo = repoFromMdUri(uri);
				if (repo) { await analysisService.syncAnalysisFromMarkdown(repo).catch(() => { }); }
				updateStatusBar();
			});
			mdWatcher.onDidChange(async (uri) => {
				const repo = repoFromMdUri(uri);
				if (repo) { await analysisService.syncAnalysisFromMarkdown(repo).catch(() => { }); }
				updateStatusBar();
			});
			mdWatcher.onDidDelete(async (uri) => {
				const repo = repoFromMdUri(uri);
				if (repo) { await analysisService.clearAnalysis(repo).catch(() => { }); }
				updateStatusBar();
			});
			context.subscriptions.push(mdWatcher);

			// Directory-level watchers to handle full folder deletion/creation and any changes inside
			const dirWatcher = vscode.workspace.createFileSystemWatcher('**/.gitgenie');
			dirWatcher.onDidCreate(() => updateStatusBar());
			dirWatcher.onDidDelete(async (uri) => {
				// If the whole .gitgenie folder is deleted, clear the JSON too
				try { const repo = path.dirname(uri.fsPath); await analysisService.clearAnalysis(repo); } catch { }
				updateStatusBar();
			});
			context.subscriptions.push(dirWatcher);

			const anyInDirWatcher = vscode.workspace.createFileSystemWatcher('**/.gitgenie/**');
			anyInDirWatcher.onDidCreate(() => updateStatusBar());
			anyInDirWatcher.onDidDelete(() => updateStatusBar());
			anyInDirWatcher.onDidChange(() => updateStatusBar());
			context.subscriptions.push(anyInDirWatcher);
		}
	} catch { }

	// Toggle via menu only (single layout)

	// Single-layout menu for combined item
	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.genieMenu', async () => {
		const wf = vscode.workspace.workspaceFolders;
		const items: Array<vscode.QuickPickItem & { action: string }> = [];
		items.push({ label: vscode.l10n.t(I18N.genieMenu.manageModels), action: 'models' });
		if (isRepoAnalysisEnabled() && hasGitRepo) {
			if (repoAnalysisRunning) {
				items.push({ label: vscode.l10n.t(I18N.genieMenu.cancelAnalysis), action: 'cancel' });
			} else {
				items.push({ label: vscode.l10n.t(I18N.genieMenu.refreshAnalysis), action: 'refresh' });
			}
			items.push({ label: vscode.l10n.t(I18N.genieMenu.openMarkdown), action: 'open' });
		}
		const pick = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t(I18N.genieMenu.placeholder) });
		if (!pick) { return; }
		if (pick.action === 'models') {
			vscode.commands.executeCommand('git-commit-genie.manageModels');
			return;
		}
		if (!wf || wf.length === 0) { return; }
		const repositoryPath = wf[0].uri.fsPath;
		if (pick.action === 'cancel') {
			analysisService.cancelCurrentAnalysis();
			setRepoAnalysisRunning(false);
			return;
		}
		if (pick.action === 'refresh') {
			vscode.commands.executeCommand('git-commit-genie.refreshRepositoryAnalysis');
			return;
		}
		if (pick.action === 'open') {
			const mdPath = analysisService.getAnalysisMarkdownFilePath(repositoryPath);
			if (fs.existsSync(mdPath)) {
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
				await vscode.window.showTextDocument(doc);
			} else {
				vscode.window.showInformationMessage(vscode.l10n.t(I18N.repoAnalysis.mdNotFound));
			}
		}
	}));

	// Developer: view internal analysis JSON (from VS Code storage)
	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.openAnalysisJson', async () => {
		const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
		const dev = cfg.get<boolean>('developerMode', false);
		if (!dev) {
			const choice = await vscode.window.showInformationMessage('Developer mode required.', vscode.l10n.t(I18N.actions.openSettings));
			if (choice === vscode.l10n.t(I18N.actions.openSettings)) {
				vscode.commands.executeCommand('workbench.action.openSettings', 'gitCommitGenie.developerMode');
			}
			return;
		}
		const wf = vscode.workspace.workspaceFolders;
		if (!wf || wf.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t(I18N.common.noWorkspace));
			return;
		}
		const repositoryPath = wf[0].uri.fsPath;
		const analysis = await analysisService.getAnalysis(repositoryPath);
		if (!analysis) {
			vscode.window.showInformationMessage('No analysis data found.');
			return;
		}
		const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(analysis, null, 2) });
		await vscode.window.showTextDocument(doc, { preview: false });
	}));

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
				analysisService.setLLMService(llmService);
			} else if (providerPick.value === 'deepseek') {
				await deepseekService.setApiKey(apiKeyToUse!);
				llmService = deepseekService;
				analysisService.setLLMService(llmService);
			} else if (providerPick.value === 'anthropic') {
				await anthropicService.setApiKey(apiKeyToUse!);
				llmService = anthropicService;
				analysisService.setLLMService(llmService);
			} else {
				await geminiService.setApiKey(apiKeyToUse!);
				llmService = geminiService;
				analysisService.setLLMService(llmService);
			}
		} else {
			// Key unchanged: just switch active provider/model reference
			llmService = pickService();
			analysisService.setLLMService(llmService);
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
						let typingSpeed: number = vscode.workspace.getConfiguration('gitCommitGenie').get<number>('typingAnimationSpeed', -1);
						typingSpeed = Math.min(typingSpeed, 100);
						if (typingSpeed <= 0) {
							// Instant fill
							repo.inputBox.value = result.content;
							return;
						} else {
							// Animated typing
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
							}, typingSpeed); // typing speed
						}

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

	// Repository Analysis Commands
	// Expose a dedicated Cancel command while analysis is running
	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.cancelRepositoryAnalysis', async () => {
		try {
			analysisService.cancelCurrentAnalysis();
			setRepoAnalysisRunning(false);
			logger.warn('[Genie][RepoAnalysis] Refresh cancelled by user.');
		} catch { /* ignore */ }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.viewRepositoryAnalysis', async () => {
		if (!isRepoAnalysisEnabled()) { return; }
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t(I18N.common.noWorkspace));
			return;
		}

		try {
			const repositoryPath = workspaceFolders[0].uri.fsPath;
			const analysis = await analysisService.getAnalysis(repositoryPath);

			if (!analysis) {
				const initialize = await vscode.window.showInformationMessage(
					vscode.l10n.t(I18N.repoAnalysis.promptInitialize),
					vscode.l10n.t(I18N.repoAnalysis.initialize),
					vscode.l10n.t(I18N.manageModels.cancel)
				);
				if (initialize === 'Initialize') {
					await vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: vscode.l10n.t(I18N.repoAnalysis.initializingTitle),
						cancellable: false
					}, async () => {
						setRepoAnalysisRunning(true);
						try {
							await analysisService.initializeRepository(repositoryPath);
						} finally {
							setRepoAnalysisRunning(false);
						}
					});

					// After initialization, ensure markdown exists and open it for editing
					const newAnalysis = await analysisService.getAnalysis(repositoryPath);
					if (newAnalysis) {
						const mdPath = await analysisService.saveAnalysisMarkdown(repositoryPath, newAnalysis, { overwrite: false });
						const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
						await vscode.window.showTextDocument(doc);
					}
				}
				return;
			}

			// Ensure markdown exists and open it for editing
			const mdPath = await analysisService.saveAnalysisMarkdown(repositoryPath, analysis, { overwrite: false });
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
			await vscode.window.showTextDocument(doc);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to view repository analysis: ${error}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('git-commit-genie.refreshRepositoryAnalysis', async () => {
		if (!isRepoAnalysisEnabled()) { return; }
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t(I18N.common.noWorkspace));
			return;
		}

		try {
			const repositoryPath = workspaceFolders[0].uri.fsPath;

			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t(I18N.repoAnalysis.refreshingTitle),
				cancellable: false
			}, async () => {
				setRepoAnalysisRunning(true);
				try {
					await analysisService.updateAnalysis(repositoryPath);
				} finally {
					setRepoAnalysisRunning(false);
				}
			});

			vscode.window.showInformationMessage(vscode.l10n.t(I18N.repoAnalysis.refreshed));
		} catch (error: any) {
			const msg = String(error?.message || error || '');
			const cancelled = /abort|cancel/i.test(msg);
			if (cancelled) {
				logger.warn('[Genie][RepoAnalysis] Refresh cancelled by user.');
			} else {
				logger.error('[Genie][RepoAnalysis] Failed to refresh repository analysis', error);
			}
		}
	}));



	// Initialize repository analysis when workspace opens
	const initializeRepositoryAnalysis = async () => {
		const enabled = isRepoAnalysisEnabled();
		if (!enabled) { return; }

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			try {
				const repositoryPath = workspaceFolders[0].uri.fsPath;
				// If no Git repository yet, do nothing now; a watcher will trigger once initialized
				if (!fs.existsSync(path.join(repositoryPath, '.git'))) {
					logger.info('[Genie][RepoAnalysis] Git repository not initialized. Skipping analysis init.');
					return;
				}

				// Check if analysis already exists
				const existingAnalysis = await analysisService.getAnalysis(repositoryPath);
				if (!existingAnalysis) {
					logger.info('Initializing repository analysis for new workspace...');
					// Initialize in the background
					setRepoAnalysisRunning(true);
					analysisService.initializeRepository(repositoryPath).catch(error => {
						logger.error('Failed to initialize repository analysis:', error);
					}).finally(() => {
						setRepoAnalysisRunning(false);
					});
				}
			} catch (error) {
				logger.error('Error during repository analysis initialization:', error);
			}
		}
	};

	// Initialize analysis on startup
	setTimeout(initializeRepositoryAnalysis, 2000); // Delay to let workspace fully load

	// Hook into Git changes to drive analysis updates
	try {
		const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
		if (gitExtension) {
			const api = gitExtension.getAPI(1);
			// Track last seen HEAD per repository to detect external commits
			const lastHeadByRepo = new Map<string, string | undefined>();

			const runCheck = async (repo: Repository, reason: string) => {
				try {
					const repoPath = repo.rootUri?.fsPath;
					if (!repoPath) { return; }
					if (!isRepoAnalysisEnabled()) { return; }
					const should = await analysisService.shouldUpdateAnalysis(repoPath);
					if (should) {
						logger.info(`[Genie][RepoAnalysis] Triggered by ${reason}; updating analysis...`);
						setRepoAnalysisRunning(true);
						analysisService.updateAnalysis(repoPath).catch(err => {
							logger.error('Failed to update repository analysis on Git change:', err);
						}).finally(() => setRepoAnalysisRunning(false));
					}
				} catch (err) {
					logger.error('Error handling Git change:', err);
				}
			};

			const attachRepoListeners = (repo: Repository) => {
				// Seed last known HEAD
				const repoPath = repo.rootUri?.fsPath;
				if (repoPath) {
					lastHeadByRepo.set(repoPath, repo.state.HEAD?.commit);
				}

				// Any repository state change (detect HEAD commit changes from all sources)
				const d = repo.state.onDidChange(() => {
					try {
						if (!repoPath) { return; }
						const prev = lastHeadByRepo.get(repoPath);
						const next = repo.state.HEAD?.commit;
						if (next && next !== prev) {
							lastHeadByRepo.set(repoPath, next);
							runCheck(repo, 'HEADChanged');
						}
					} catch { /* noop */ }
				});
				context.subscriptions.push(d);
			};

			// Attach to existing and future repositories
			for (const r of api.repositories) { attachRepoListeners(r); }
			api.onDidOpenRepository((repo: Repository) => attachRepoListeners(repo));
		}
	} catch { }

	// Watch for Git repository initialization (creation/deletion of .git)
	try {
		const gitFolderWatcher = vscode.workspace.createFileSystemWatcher('**/.git');
		gitFolderWatcher.onDidCreate(async (uri) => {
			updateStatusBar();
			// Trigger analysis automatically once Git repo is initialized
			await initializeRepositoryAnalysis();
		});
		gitFolderWatcher.onDidDelete(() => {
			updateStatusBar();
		});
		context.subscriptions.push(gitFolderWatcher);
	} catch { }

	// Listen to configuration changes to refresh UI and contexts
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		const chainChanged = e.affectsConfiguration('gitCommitGenie.useChainPrompts') || e.affectsConfiguration('gitCommitGenie.chain.enabled');
		const repoAnalysisChanged = e.affectsConfiguration('gitCommitGenie.repositoryAnalysis.enabled');
		const logLevelChanged = e.affectsConfiguration('gitCommitGenie.logLevel');

		if (logLevelChanged) {
			try {
				const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
				const logLevel = (cfg.get<string>('logLevel', 'info') || 'info').toLowerCase();
				const level = logLevel === 'debug' ? LogLevel.Debug : logLevel === 'warn' ? LogLevel.Warning : logLevel === 'error' ? LogLevel.Error : LogLevel.Info;
				logger.setLogLevel(level);
				logger.info(`Log level changed to ${logLevel}`);
			} catch { }
		}
		if (repoAnalysisChanged) {
			vscode.commands.executeCommand('setContext', 'gitCommitGenie.repositoryAnalysisEnabled', isRepoAnalysisEnabled());
		}
		if (chainChanged || repoAnalysisChanged) { updateStatusBar(); }
	}));
}

// This method is called when extension is deactivated
export function deactivate() {
	logger.info('"git-commit-genie" is now deactivated.');
	logger.dispose();
}
