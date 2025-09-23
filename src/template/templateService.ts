import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { L10N_KEYS as I18N } from '../i18n/keys';

// Default starter template placed into new files
const DEFAULT_TEMPLATE = `Strongly Opinionated Conventional Commit Template\n\nHeader (must follow Conventional Commits):\n<type>(<scope>)!: <description>\n- type: feat | fix | docs | style | refactor | perf | test | build | ci | chore\n- scope: optional; keep short.\n- description: imperative, ≤ 72 chars.\n\nBody:\n- Summarize the changes with short bullets or short paragraphs.\n- Keep each bullet to one sentence.\n- Prefer active voice.\n- Mention risks/limitations if relevant.\n\nFooters:\n- Refs: <ticket or issue id> (optional)\n- Breaking-Change: <reason> (when applicable)\n`;

function ensureDir(dir: string, checkOnly?: boolean): boolean {
	if (checkOnly) {
		return fs.existsSync(dir);
	} else {
		if (!fs.existsSync(dir)) {
			try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }
		}
		return true;
	}
}

function sanitizeName(name: string): string {
	return name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '') || 'template';
}

export class TemplateService {
	constructor(private readonly context: vscode.ExtensionContext) { }

	private getGlobalTemplatesDir(): string {
		const base = this.context.globalStorageUri.fsPath;
		const dir = path.join(base, 'templates');
		ensureDir(dir);
		return dir;
	}

	private async getRepoIgnoreFilePath(targetFolder?: vscode.WorkspaceFolder): Promise<string | null> {
		const gitExtension = vscode.extensions.getExtension('vscode.git');
		if (!gitExtension || !gitExtension.isActive) {
			return null;
		}
		const gitExports = gitExtension.exports;
		const api = gitExports?.getAPI?.(1);
		if (!api || !api.repositories?.length) { return null; }

		let repo = api.repositories[0];
		if (targetFolder) {
			const folderPath = targetFolder.uri.fsPath;
			const matched = api.repositories.find((r: any) =>
				folderPath === r.rootUri.fsPath || folderPath.startsWith(r.rootUri.fsPath + path.sep)
			);
			if (matched) { repo = matched; }
		}

		const gitignorePath = path.join(repo.rootUri.fsPath, '.gitignore');
		if (!ensureDir(path.dirname(gitignorePath), true)) { return null; }
		return gitignorePath;
	}

	private async pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) { return undefined; }
		if (folders.length === 1) { return folders[0]; }
		const pick = await vscode.window.showQuickPick(
			folders.map(f => ({ label: f.name, description: f.uri.fsPath, value: f })),
			{ placeHolder: vscode.l10n.t(I18N.templates.pickWorkspaceFolder) }
		);
		return pick?.value;
	}

	private async getWorkspaceTemplatesDir(
		chosenFolder?: vscode.WorkspaceFolder,
		createIfMissing: boolean = true
	): Promise<string | undefined> {
		const folder = chosenFolder ?? await this.pickWorkspaceFolder();
		if (!folder) { return undefined; }
		const dir = path.join(folder.uri.fsPath, '.gitgenie', 'templates');

		if (!createIfMissing) {
			return ensureDir(dir, true) ? dir : undefined;
		}

		// Return directory if it already exists
		if (ensureDir(dir, true)) {
			return dir;
		}

		// Create directory
		if (!ensureDir(dir)) {
			return undefined;
		}

		// Update .gitignore only when creating directory for the first time
		await this.updateGitignoreForTemplates(folder);
		return dir;
	}

	private async updateGitignoreForTemplates(folder: vscode.WorkspaceFolder): Promise<void> {
		const gitignorePath = await this.getRepoIgnoreFilePath(folder);
		if (!gitignorePath) {
			return;
		}

		try {
			const ignoreEntry = '.gitgenie/**';
			const ignoreSection = `# Ignore Git Commit Genie templates\n${ignoreEntry}\n`;

			let existing = '';
			if (fs.existsSync(gitignorePath)) {
				existing = fs.readFileSync(gitignorePath, 'utf-8');
			}

			// More precise check: avoid duplicate entries
			if (existing.includes(ignoreEntry) || existing.includes('.gitgenie/')) {
				return;
			}

			// Add appropriate line breaks and ignore entry
			const content = existing.length > 0 && !existing.endsWith('\n')
				? `\n${ignoreSection}`
				: ignoreSection;

			fs.appendFileSync(gitignorePath, content, { encoding: 'utf-8' });
		} catch (error) {
			// Silent error handling, does not affect core functionality
			console.warn('Failed to update .gitignore:', error);
		}
	}

	private listTemplates(dir: string): Array<{ name: string; fsPath: string }> {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			return entries
				.filter(e => e.isFile())
				.map(e => ({ name: e.name, fsPath: path.join(dir, e.name) }));
		} catch {
			return [];
		}
	}

	private async setActiveTemplate(fsPath: string) {
		const cfg = vscode.workspace.getConfiguration();
		const target = vscode.workspace.workspaceFolders?.length
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;

		await cfg.update('gitCommitGenie.templatesPath', fsPath, target);
	}

	private async clearActiveTemplate() {
		const cfg = vscode.workspace.getConfiguration();
		await Promise.all([
			cfg.update('gitCommitGenie.templatesPath', '', vscode.ConfigurationTarget.Workspace),
			cfg.update('gitCommitGenie.templatesPath', '', vscode.ConfigurationTarget.Global)
		]);
	}

	async openQuickPicker() {
		const cfg = vscode.workspace.getConfiguration();

		const globalDir = this.getGlobalTemplatesDir();
		let wsDir = await this.getWorkspaceTemplatesDir(undefined, false);
		// Lists will be recomputed dynamically in buildItems so that delete / rename reflects immediately

		interface TemplatePick extends vscode.QuickPickItem {
			action: 'select';
			fsPath: string;
			storage: 'workspace' | 'global';
		}

		const qp = vscode.window.createQuickPick<TemplatePick | vscode.QuickPickItem>();
		qp.placeholder = vscode.l10n.t(I18N.templates.quickPickPlaceholder);
		qp.matchOnDescription = true;
		qp.matchOnDetail = true;
		qp.ignoreFocusOut = true;

		const renameButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: vscode.l10n.t(I18N.templates.buttonRename) };
		const deleteButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('remove-close'), tooltip: vscode.l10n.t(I18N.templates.buttonDelete) };
		const openButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: vscode.l10n.t(I18N.templates.buttonOpen) };

		const buildItems = () => {
			const currentPath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
			const globalList = this.listTemplates(globalDir);
			const wsList = wsDir ? this.listTemplates(wsDir) : [];
			const list: Array<TemplatePick | vscode.QuickPickItem> = [];

			// Add operation options
			list.push(
				{ label: vscode.l10n.t(I18N.templates.createNew), alwaysShow: true },
				{ label: vscode.l10n.t(I18N.templates.deactivate), alwaysShow: true }
			);

			// Helper function to add template list
			const addTemplateList = (templates: Array<{ name: string; fsPath: string }>, storage: 'workspace' | 'global') => {
				if (templates.length === 0) { return; }

				list.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

				const labelSuffix = storage === 'workspace'
					? vscode.l10n.t(I18N.templates.workspaceFolderLabel)
					: vscode.l10n.t(I18N.templates.userDataFolderLabel);

				templates.forEach(t => {
					const isActive = t.fsPath === currentPath;
					const description = isActive
						? `${labelSuffix} (${vscode.l10n.t(I18N.templates.activeSuffix)}) $(check)`
						: labelSuffix;

					list.push({
						label: t.name,
						description,
						action: 'select',
						fsPath: t.fsPath,
						storage,
						buttons: [openButton, renameButton, deleteButton]
					});
				});
			};

			addTemplateList(wsList, 'workspace');
			addTemplateList(globalList, 'global');

			qp.items = list;
		};

		buildItems();


		const configListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('gitCommitGenie.templatesPath')) {
				buildItems();
			}
		});
		qp.onDidHide(() => configListener.dispose());

		const createTemplateFlow = async () => {
			const location = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t(I18N.templates.locationWorkspace), value: 'workspace' as const },
					{ label: vscode.l10n.t(I18N.templates.locationUser), value: 'global' as const }
				],
				{ placeHolder: vscode.l10n.t(I18N.templates.chooseLocation) }
			);
			if (!location) { return; }

			const nameInput = await vscode.window.showInputBox({
				prompt: vscode.l10n.t(I18N.templates.enterName),
				value: 'commit-template'
			});
			if (!nameInput) { return; }

			const fileName = sanitizeName(nameInput).replace(/\.md$/i, '') + '.md';

			// Determine target directory
			const targetDir = location.value === 'workspace'
				? await this.getWorkspaceTemplatesDir(undefined, true)
				: this.getGlobalTemplatesDir();

			if (!targetDir) {
				vscode.window.showErrorMessage('Failed to create template directory');
				return;
			}

			// Update workspace directory reference
			if (location.value === 'workspace') {
				wsDir = targetDir;
			}

			const filePath = path.join(targetDir, fileName);

			// Create file if it doesn't exist
			if (!fs.existsSync(filePath)) {
				fs.writeFileSync(filePath, DEFAULT_TEMPLATE, 'utf-8');
			}

			// Set as active template and open
			await this.setActiveTemplate(filePath);
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc, { preview: false });

			vscode.window.showInformationMessage(vscode.l10n.t(I18N.templates.templateCreated, fileName));
			buildItems();
		};

		qp.onDidAccept(async () => {
			const sel = qp.selectedItems[0];
			if (!sel) { return; }
			if ('action' in sel && sel.action === 'select') {
				await this.setActiveTemplate(sel.fsPath);
				vscode.window.showInformationMessage(vscode.l10n.t(I18N.templates.templateSelected, sel.label));
				return;
			}
			// Non-action textual commands
			if (sel.label.includes(vscode.l10n.t(I18N.templates.createNew).replace(/\$\(add\)\s*/, '').split('…')[0].trim())) {
				await createTemplateFlow();
				return;
			}

			if (sel.label.includes(vscode.l10n.t(I18N.templates.deactivate).replace(/\$\(x\)\s*/, '').split('(')[0].trim())) {
				await this.clearActiveTemplate();
				vscode.window.showInformationMessage(vscode.l10n.t(I18N.templates.templateDeactivated));
				buildItems();
				return;
			}
		});

		qp.onDidTriggerItemButton(async e => {
			const item = e.item as TemplatePick;
			if (!('action' in item)) { return; }

			const tooltip = e.button.tooltip;
			const activePath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');

			try {
				if (tooltip === vscode.l10n.t(I18N.templates.buttonDelete)) {
					fs.unlinkSync(item.fsPath);
					if (activePath === item.fsPath) {
						await this.clearActiveTemplate();
					}
					buildItems();
				} else if (tooltip === vscode.l10n.t(I18N.templates.buttonRename)) {
					const newName = await vscode.window.showInputBox({
						prompt: vscode.l10n.t(I18N.templates.enterNewName),
						value: item.label.replace(/\.md$/i, '')
					});
					if (!newName) { return; }

					const fileName = sanitizeName(newName).replace(/\.md$/i, '') + '.md';
					const targetDir = item.storage === 'workspace'
						? (wsDir ?? (await this.getWorkspaceTemplatesDir())!)
						: globalDir;
					const newPath = path.join(targetDir, fileName);

					if (fs.existsSync(newPath)) {
						vscode.window.showWarningMessage(vscode.l10n.t(I18N.templates.renameExists));
						return;
					}

					fs.renameSync(item.fsPath, newPath);
					if (activePath === item.fsPath) {
						await this.setActiveTemplate(newPath);
					}
					buildItems();
				} else if (tooltip === vscode.l10n.t(I18N.templates.buttonOpen)) {
					const doc = await vscode.workspace.openTextDocument(item.fsPath);
					await vscode.window.showTextDocument(doc, { preview: false });
					qp.hide();
				}
			} catch (err) {
				const action = tooltip === vscode.l10n.t(I18N.templates.buttonDelete) ? 'deleteFailed' :
					tooltip === vscode.l10n.t(I18N.templates.buttonRename) ? 'renameFailed' : 'openFailed';
				vscode.window.showErrorMessage(vscode.l10n.t(I18N.templates[action], (err as Error).message));
			}
		});

		qp.show();
	}
}

