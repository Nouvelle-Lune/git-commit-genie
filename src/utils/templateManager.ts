import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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

export class TemplateManager {
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
      { placeHolder: 'Pick a workspace folder' }
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

  private async setActiveTemplate(fsPath: string, scope: 'workspace' | 'global') {
    const cfg = vscode.workspace.getConfiguration();
    await cfg.update(
      'gitCommitGenie.templatesPath',
      fsPath,
      scope === 'global' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace
    );
  }

  private async clearWorkspaceOverride() {
    const cfg = vscode.workspace.getConfiguration();
    // undefined removes the value from the scope so global can apply
    await cfg.update('gitCommitGenie.templatesPath', undefined, vscode.ConfigurationTarget.Workspace);
  }

  async openQuickPicker() {
    const cfg = vscode.workspace.getConfiguration();
    const current = cfg.get<string>('gitCommitGenie.templatesPath', '');

    const globalDir = this.getGlobalTemplatesDir();
    const wsDir = await this.getWorkspaceTemplatesDir();
    // Lists will be recomputed dynamically in buildItems so that delete / rename reflects immediately

    interface TemplatePick extends vscode.QuickPickItem {
      action: 'select';
      fsPath: string;
      scope: 'workspace' | 'global';
    }

    const qp = vscode.window.createQuickPick<TemplatePick | vscode.QuickPickItem>();
    qp.placeholder = 'Select / manage templates';
    qp.matchOnDescription = true;
    qp.ignoreFocusOut = true;

    const renameButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename template' };
    const deleteButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete template' };

    const buildItems = () => {
      const currentPath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
      const globalList = this.listTemplates(globalDir);
      const wsList = wsDir ? this.listTemplates(wsDir) : [];
      const list: Array<TemplatePick | vscode.QuickPickItem> = [];
      list.push({ label: '$(add) Create new template…', description: 'Create', alwaysShow: true });
      if (currentPath && fs.existsSync(currentPath)) {
        list.push({ label: '$(go-to-file) Open current template', description: 'Open active', detail: currentPath });
        list.push({ label: '$(trash) Clear workspace template override', description: 'Clear workspace override' });
      }
      if (wsList.length) {
        list.push({ label: 'Workspace templates', kind: vscode.QuickPickItemKind.Separator });
        for (const t of wsList) {
          list.push({
            label: t.name,
            description: '.gitgenie/templates',
            action: 'select',
            fsPath: t.fsPath,
            scope: 'workspace',
            buttons: [renameButton, deleteButton]
          });
        }
      }
      if (globalList.length) {
        list.push({ label: 'User data folder templates', kind: vscode.QuickPickItemKind.Separator });
        for (const t of globalList) {
          list.push({
            label: t.name,
            description: 'User data folder',
            action: 'select',
            fsPath: t.fsPath,
            scope: 'global',
            buttons: [renameButton, deleteButton]
          });
        }
      }
      qp.items = list;
    };

    buildItems();

    const createTemplateFlow = async () => {
      const location = await vscode.window.showQuickPick(
        [
          { label: 'Workspace (.gitgenie/templates)', value: 'workspace' as const },
          { label: 'User data folder (Global)', value: 'global' as const }
        ],
        { placeHolder: 'Where to create the template?' }
      );
      if (!location) { return; }
      const nameInput = await vscode.window.showInputBox({
        prompt: 'Enter template name (file will be <name>.md)',
        value: 'commit-template'
      });
      if (!nameInput) { return; }
      const fileName = sanitizeName(nameInput).replace(/\.md$/i, '') + '.md';
      const dir = location.value === 'workspace' ? (await this.getWorkspaceTemplatesDir()) : this.getGlobalTemplatesDir();
      const finalDir = dir ?? this.getGlobalTemplatesDir();
      ensureDir(finalDir);
      const filePath = path.join(finalDir, fileName);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, DEFAULT_TEMPLATE, 'utf-8');
      }
      await this.setActiveTemplate(filePath, location.value === 'workspace' && dir ? 'workspace' : 'global');
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(`Template created: ${fileName}`);
      buildItems();
    };

    qp.onDidAccept(async () => {
      const sel = qp.selectedItems[0];
      if (!sel) { return; }
      if ('action' in sel && sel.action === 'select') {
        await this.setActiveTemplate(sel.fsPath, sel.scope);
        vscode.window.showInformationMessage(`Template selected: ${sel.label}`);
        qp.hide();
        return;
      }
      // Non-action textual commands
      if (sel.label.includes('Create new template')) {
        await createTemplateFlow();
        return;
      }
      const currentPath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
      if (sel.label.includes('Open current template') && currentPath) {
        const doc = await vscode.workspace.openTextDocument(currentPath);
        await vscode.window.showTextDocument(doc, { preview: false });
        qp.hide();
        return;
      }
      if (sel.label.includes('Clear workspace template override')) {
        await this.clearWorkspaceOverride();
        vscode.window.showInformationMessage('Workspace template cleared. Falling back to global setting if present.');
        buildItems();
        return;
      }
    });

    qp.onDidTriggerItemButton(async e => {
      const item = e.item as TemplatePick;
      if (!('action' in item)) { return; }
      if (e.button.tooltip === 'Delete template') {
        let activePath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
        try {
          fs.unlinkSync(item.fsPath);
          if (activePath === item.fsPath) {
            await this.clearWorkspaceOverride();

            const cfg = vscode.workspace.getConfiguration();
            const globalTarget = cfg.get<string>('gitCommitGenie.templatesPath');
            if (globalTarget === item.fsPath) {
              await cfg.update('gitCommitGenie.templatesPath', undefined, vscode.ConfigurationTarget.Global);
            }
          }
        } catch (err) {
          vscode.window.showErrorMessage('Failed to delete template: ' + (err as Error).message);
        }
        buildItems();
        return;
      }
      if (e.button.tooltip === 'Rename template') {
        const newName = await vscode.window.showInputBox({
          prompt: 'Enter new template name (no extension)',
          value: item.label.replace(/\.md$/i, '')
        });
        if (!newName) { return; }
        const safe = sanitizeName(newName).replace(/\.md$/i, '') + '.md';
        const targetDir = item.scope === 'workspace' ? (wsDir ?? (await this.getWorkspaceTemplatesDir())!) : globalDir;
        const newPath = path.join(targetDir, safe);
        if (fs.existsSync(newPath)) {
          vscode.window.showWarningMessage('A template with that name already exists.');
          return;
        }
        try {
          fs.renameSync(item.fsPath, newPath);
          const activePath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
          if (activePath === item.fsPath) { await this.setActiveTemplate(newPath, item.scope); }
        } catch (err) {
          vscode.window.showErrorMessage('Rename failed: ' + (err as Error).message);
        }
        buildItems();
      }
    });

    qp.show();
  }
}

