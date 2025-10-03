import * as vscode from 'vscode';
import { L10N_KEYS as I18N } from '../i18n/keys';

export type StageEventType =
  | 'summarizeStart'
  | 'summarizeProgress'
  | 'classifyDraft'
  | 'validateFix'
  | 'strictFix'
  | 'enforceLanguage'
  | 'done'
  | 'cancelled';

export interface StageEvent {
  type: StageEventType;
  data?: any;
}

class ProgressSession {
  private done = false;
  private resolver!: () => void;
  private waitPromise: Promise<void>;
  private progress?: vscode.Progress<{ message?: string; increment?: number }>;

  constructor(private onCancel?: () => void) {
    this.waitPromise = new Promise<void>((resolve) => (this.resolver = resolve));
  }

  start(): void {
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
      },
      async (progress, token) => {
        this.progress = progress;
        // Not cancellable for now; keep token hook available for future use
        token.onCancellationRequested(() => {
          try { this.onCancel?.(); } catch { /* ignore */ }
        });
        await this.waitPromise;
      }
    );
  }

  updateMessage(msg: string): void {
    this.progress?.report({ message: msg });
  }

  complete(): void {
    if (!this.done) {
      this.done = true;
      this.resolver();
    }
  }
}

export class StageNotificationManager {
  private static _instance: StageNotificationManager | undefined;
  private active?: ProgressSession;
  private enabled = true;

  static get instance(): StageNotificationManager {
    if (!this._instance) {
      this._instance = new StageNotificationManager();
    }
    return this._instance;
  }

  begin(onCancel?: () => void): void {
    // Respect configuration toggle (default true)
    try {
      const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
      this.enabled = cfg.get<boolean>('ui.stageNotifications.enabled', true);
    } catch { this.enabled = true; }

    if (!this.enabled) { return; }
    // End any previous session quietly
    try { this.active?.complete(); } catch { /* ignore */ }
    const session = new ProgressSession(onCancel);
    this.active = session;
    session.start();
  }

  update(event: StageEvent): void {
    if (!this.enabled || !this.active) { return; }
    const t = vscode.l10n.t;
    switch (event.type) {
      case 'summarizeStart':
        this.active.updateMessage(t(I18N.stages.summarizingStart));
        break;
      case 'summarizeProgress': {
        const cur = Number(event.data?.current ?? 0);
        const total = Number(event.data?.total ?? 0);
        this.active.updateMessage(t(I18N.stages.summarizingProgress, cur, total));
        break;
      }
      case 'classifyDraft':
        this.active.updateMessage(t(I18N.stages.classifyDraft));
        break;
      case 'validateFix':
        this.active.updateMessage(t(I18N.stages.validateFix));
        break;
      case 'strictFix':
        this.active.updateMessage(t(I18N.stages.strictFix));
        break;
      case 'enforceLanguage':
        this.active.updateMessage(t(I18N.stages.enforceLanguage));
        break;
      case 'cancelled':
        this.active.updateMessage(t(I18N.stages.cancelled));
        break;
      case 'done':
        this.active.updateMessage(t(I18N.stages.done));
        break;
      default:
        break;
    }
  }

  end(): void {
    if (!this.enabled) { return; }
    try { this.active?.complete(); } catch { /* ignore */ }
    this.active = undefined;
  }
}

export const stageNotifications = StageNotificationManager.instance;
