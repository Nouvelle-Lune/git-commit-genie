import * as vscode from 'vscode';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { safeRun } from '../utils/safeRun';

export type StageEventType =
  | 'summarizeStart'
  | 'summarizeProgress'
  | 'classifyDraft'
  | 'validateFix'
  | 'strictFix'
  | 'enforceLanguage'
  | 'ragPreparationSkipped'
  | 'ragRetrieved'
  | 'ragRetrievalSkipped'
  | 'done'
  | 'cancelled';

export interface StageEventData {
  current?: number;
  total?: number;
  file?: string;
  summary?: string;
  breaking?: boolean;
  draft?: unknown;
  validMessage?: string;
  message?: string;
  finalMessage?: string;
  error?: string;
  [extra: string]: unknown;
}

export interface StageEvent {
  type: StageEventType;
  data?: StageEventData;
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
          safeRun('StageNotifications.onCancel', () => this.onCancel?.());
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
    // Respect configuration toggle (default true). The configuration read
    // can fail when the extension host is shutting down; treat that as
    // "enabled" so notifications still surface during the shutdown window.
    this.enabled = safeRun('StageNotifications.readConfig', () =>
      vscode.workspace.getConfiguration('gitCommitGenie').get<boolean>('ui.stageNotifications.enabled', true)
    ) ?? true;

    if (!this.enabled) { return; }
    // End any previous session before starting a new one.
    this.active?.complete();
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
    this.active?.complete();
    this.active = undefined;
  }
}

export const stageNotifications = StageNotificationManager.instance;
