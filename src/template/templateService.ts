import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { L10N_KEYS as I18N } from '../i18n/keys';

// Default starter template placed into new files
const DEFAULT_TEMPLATE = `Strongly Opinionated Conventional Commit Template\n\nHeader (must follow Conventional Commits):\n<type>(<scope>)!: <description>\n- type: feat | fix | docs | style | refactor | perf | test | build | ci | chore\n- scope: optional; keep short.\n- description: imperative, ≤ 72 chars.\n\nBody:\n- Summarize the changes with short bullets or short paragraphs.\n- Keep each bullet to one sentence.\n- Prefer active voice.\n- Mention risks/limitations if relevant.\n\nFooters:\n- Refs: <ticket or issue id> (optional)\n- Breaking-Change: <reason> (when applicable)\n`;

function ensureDir(dir: string) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function sanitizeName(name: string): string {
	const base = name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
	return base || 'template';
}

export class TemplateService {
	constructor(private readonly context: vscode.ExtensionContext) { }

	private getGlobalTemplatesDir(): string {
		const base = this.context.globalStorageUri.fsPath;
		const dir = path.join(base, 'templates');
		ensureDir(dir);
		return dir;
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

	private async getWorkspaceTemplatesDir(): Promise<string | undefined> {
		const folder = await this.pickWorkspaceFolder();
		if (!folder) { return undefined; }
		const dir = path.join(folder.uri.fsPath, '.gitgenie', 'templates');
		ensureDir(dir);
		return dir;
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
		const hasWorkspace = !!vscode.workspace.workspaceFolders?.length;
		await cfg.update(
			'gitCommitGenie.templatesPath',
			fsPath,
			hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
		);
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
		const wsDir = await this.getWorkspaceTemplatesDir();
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

			list.push({ label: vscode.l10n.t(I18N.templates.createNew), alwaysShow: true });
			list.push({ label: vscode.l10n.t(I18N.templates.deactivate), alwaysShow: true });

			if (wsList.length) {
				list.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

				for (const t of wsList) {
					const isActive: boolean = t.fsPath === currentPath;
					list.push({
						label: t.name,
						description: isActive ? `${vscode.l10n.t(I18N.templates.workspaceFolderLabel)} (${vscode.l10n.t(I18N.templates.activeSuffix)}) $(check)` : vscode.l10n.t(I18N.templates.workspaceFolderLabel),
						action: 'select',
						fsPath: t.fsPath,
						storage: 'workspace',
						buttons: [openButton, renameButton, deleteButton]
					});
				}
			}
			if (globalList.length) {
				list.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
				for (const t of globalList) {
					const isActive: boolean = t.fsPath === currentPath;
					list.push({
						label: t.name,
						description: isActive ? `${vscode.l10n.t(I18N.templates.userDataFolderLabel)} (${vscode.l10n.t(I18N.templates.activeSuffix)}) $(check)` : vscode.l10n.t(I18N.templates.userDataFolderLabel),
						action: 'select',
						fsPath: t.fsPath,
						storage: 'global',
						buttons: [openButton, renameButton, deleteButton]
					});
				}
			}
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
			if (!nameInput) {
				return;
			}
			const fileName = sanitizeName(nameInput).replace(/\.md$/i, '') + '.md';
			const dir = location.value === 'workspace' ? (await this.getWorkspaceTemplatesDir()) : this.getGlobalTemplatesDir();
			const finalDir = dir ?? this.getGlobalTemplatesDir();
			ensureDir(finalDir);
			const filePath = path.join(finalDir, fileName);
			if (!fs.existsSync(filePath)) {
				fs.writeFileSync(filePath, DEFAULT_TEMPLATE, 'utf-8');
			}
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
			if (!('action' in item)) {
				return;
			}
			if (e.button.tooltip === vscode.l10n.t(I18N.templates.buttonDelete)) {
				const activePath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
				try {
					fs.unlinkSync(item.fsPath);
					if (activePath === item.fsPath) {
						await this.clearActiveTemplate();
					}
				} catch (err) {
					vscode.window.showErrorMessage(vscode.l10n.t(I18N.templates.deleteFailed, (err as Error).message));
				}
				buildItems();
				return;
			}
			if (e.button.tooltip === vscode.l10n.t(I18N.templates.buttonRename)) {
				const newName = await vscode.window.showInputBox({
					prompt: vscode.l10n.t(I18N.templates.enterNewName),
					value: item.label.replace(/\.md$/i, '')
				});
				if (!newName) { return; }
				const safe = sanitizeName(newName).replace(/\.md$/i, '') + '.md';
				const targetDir = item.storage === 'workspace' ? (wsDir ?? (await this.getWorkspaceTemplatesDir())!) : globalDir;
				const newPath = path.join(targetDir, safe);
				if (fs.existsSync(newPath)) {
					vscode.window.showWarningMessage(vscode.l10n.t(I18N.templates.renameExists));
					return;
				}
				try {
					fs.renameSync(item.fsPath, newPath);
					const activePath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
					if (activePath === item.fsPath) { await this.setActiveTemplate(newPath); }
				} catch (err) {
					vscode.window.showErrorMessage(vscode.l10n.t(I18N.templates.renameFailed, (err as Error).message));
				}
				buildItems();
			}
			if (e.button.tooltip === vscode.l10n.t(I18N.templates.buttonOpen)) {
				try {
					const doc = await vscode.workspace.openTextDocument(item.fsPath);
					await vscode.window.showTextDocument(doc, { preview: false });
					qp.hide();
				} catch (err) {
					vscode.window.showErrorMessage(vscode.l10n.t(I18N.templates.openFailed, (err as Error).message));
				}
				return;
			}
		});

		qp.show();
	}
}

