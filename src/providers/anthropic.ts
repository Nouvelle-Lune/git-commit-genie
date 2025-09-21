import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseLLMService, LLMError, LLMResponse } from "../services/llm/llm_types";
import { L10N_KEYS as I18N } from '../i18n/keys';
import { DiffData } from "../services/git/git_types";
import { generateCommitMessageChain, ChatFn } from "../services/llm/utils/chainPrompts";

const SECRET_ANTHROPIC_API_KEY = 'gitCommitGenie.secret.anthropicApiKey';

export class AnthropicService extends BaseLLMService {
    private client: any | null = null;
    protected context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        super(context);
        this.context = context;
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_ANTHROPIC_API_KEY);
        this.client = null;
        if (apiKey) {
            try {
                let AnthropicSdk: any;
                try { AnthropicSdk = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'); }
                catch { AnthropicSdk = require('anthropic').default || require('anthropic'); }
                this.client = new AnthropicSdk({ apiKey });
            } catch (e) {
                console.warn('Anthropic SDK not available. Please install @anthropic-ai/sdk.');
                this.client = null;
            }
        }
    }

    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const stableModels = [
            // Ordered from newest / most capable to older
            'claude-opus-4-1-20250805',
            'claude-opus-4-20250514',
            'claude-sonnet-4-20250514',
            'claude-3-7-sonnet-20250219',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-sonnet-20240620'
        ];
        try {
            let AnthropicSdk: any;
            try { AnthropicSdk = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'); }
            catch { AnthropicSdk = require('anthropic').default || require('anthropic'); }
            const c = new AnthropicSdk({ apiKey });
            await c.messages.create({ model: stableModels[0], max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
            return stableModels;
        } catch (e: any) {
            throw new Error(e?.message || 'Failed to validate Anthropic API key.');
        }
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_ANTHROPIC_API_KEY, apiKey);
        await this.refreshFromSettings();
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_ANTHROPIC_API_KEY);
        this.client = null;
    }

    private async sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
    private getRetryDelayMs(err: any): number {
        const def = 2500;
        const headers: any = (err as any)?.response?.headers || (err as any)?.headers;
        const retryAfter = headers?.['retry-after'] || headers?.['Retry-After'];
        if (retryAfter) {
            const asSeconds = parseFloat(String(retryAfter));
            if (!isNaN(asSeconds)) {
                return Math.max(500, Math.floor(asSeconds * 1000));
            }
        }
        const msg: string = err?.message || '';
        const m = msg.match(/retry in\s+([0-9.]+)s/i);
        if (m) {
            const sec = parseFloat(m[1]);
            if (!isNaN(sec)) {
                return Math.max(1000, Math.floor(sec * 1000));
            }
        }
        // Analyze Anthropic structured error RetryInfo
        const details = err?.error?.details;
        const retry = Array.isArray(details) ? details.find((d: any) => d['@type']?.includes('RetryInfo')) : undefined;
        const nanos = retry?.retryDelay?.nanos ?? 0;
        const seconds = retry?.retryDelay?.seconds ?? 0;
        if (seconds || nanos) {
            return Math.max(1000, seconds * 1000 + Math.floor(nanos / 1e6));
        }
        return def;
    }

    private getResponseUsage(resp: any): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
        const u = resp?.usage;
        if (!u) {
            return undefined;
        }
        const prompt_tokens = u.input_tokens;
        const completion_tokens = u.output_tokens;
        const total_tokens = (prompt_tokens || 0) + (completion_tokens || 0);
        return { prompt_tokens, completion_tokens, total_tokens };
    }

    private extractText(resp: any): string {
        if (!resp) {
            return '';
        }
        if (Array.isArray(resp.content)) {
            return resp.content.map((b: any) => (b?.text || '')).filter(Boolean).join('\n');
        }
        return '';
    }

    private safeExtractJson<T = any>(text: string): T | null {
        if (!text) {
            return null;
        }
        let trimmed = text.trim();
        const fenceMatch = trimmed.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
        if (fenceMatch && fenceMatch[1]) {
            trimmed = fenceMatch[1].trim();
        }
        try { return JSON.parse(trimmed) as T; } catch {}
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            const slice = trimmed.slice(start, end + 1);
            try { return JSON.parse(slice) as T; } catch {}
        }
        return null;
    }

    private async maybeWarnRateLimit(provider: string, model: string) {
        const key = 'gitCommitGenie.rateLimitWarned';
        const last = this.context.globalState.get<number>(key, 0) ?? 0;
        const now = Date.now();
        if (now - last < 60_000) {
            return;
        }
        await this.context.globalState.update(key, now);
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(I18N.rateLimit.hit, provider, model, vscode.l10n.t(I18N.settings.chainMaxParallelLabel)),
            vscode.l10n.t(I18N.actions.openSettings),
            vscode.l10n.t(I18N.actions.dismiss)
        );
        if (choice === vscode.l10n.t(I18N.actions.openSettings)) {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gitCommitGenie.chain.maxParallel');
        }
    }

    async generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError> {
        if (!this.client) {
            return { message: 'Anthropic API key is not set or SDK unavailable.', statusCode: 401 };
        }
        try {
            const templatesPath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
            const rulesPath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'baseRules.md'));
            const baseRule = fs.readFileSync(rulesPath, 'utf-8');
            const model = this.context.globalState.get<string>('gitCommitGenie.anthropicModel', '');
            if (!model) {
                return { message: 'Anthropic model is not selected. Please configure it via Manage Models.', statusCode: 400 };
            }
            const cfg = vscode.workspace.getConfiguration();
            const useChain = ((): boolean => {
                const v = cfg.get<boolean>('gitCommitGenie.chain.enabled');
                if (typeof v === 'boolean') { return v; }
                return cfg.get<boolean>('gitCommitGenie.useChainPrompts', false);
            })();

            if (useChain) {
                const jsonDiff = await super.buildJsonDiff(diffs, templatesPath);
                const parsed = JSON.parse(jsonDiff);
                const usages: Array<{ prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }> = [];
                let callCount = 0;
                const chat: ChatFn = async (messages, _o) => {
                    if (options?.token?.isCancellationRequested) {
                        throw new Error('Cancelled');
                    }
                    const controller = new AbortController();
                    options?.token?.onCancellationRequested(() => controller.abort());
                    const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
                    const conversation = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
                    let lastErr: any;
                    for (let attempt = 0; attempt < 4; attempt++) {
                        try {
                            const resp = await this.client.messages.create({
                                model,
                                max_tokens: 2048,
                                temperature: 0,
                                system: systemText || undefined,
                                messages: conversation
                            }, { signal: (controller as any).signal });
                            callCount += 1;
                            const usage = this.getResponseUsage(resp);
                            if (usage) {
                                usages.push(usage);
                                console.log(`[Genie][Anthropic] Chain call #${callCount} tokens: prompt=${usage.prompt_tokens ?? 0}, completion=${usage.completion_tokens ?? 0}, total=${usage.total_tokens ?? 0}`);
                            } else {
                                console.log(`[Genie][Anthropic] Chain call #${callCount} tokens: (usage not provided)`);
                            }
                            return this.extractText(resp) || '';
                        } catch (e: any) {
                            lastErr = e;
                            const code = e?.status || e?.code || e?.error?.status;
                            if (controller.signal.aborted) {
                                throw new Error('Cancelled');
                            }
                            if (code === 429) {
                                await this.maybeWarnRateLimit('Anthropic', model);
                                const base = this.getRetryDelayMs(e) || 1000;
                                const factor = Math.pow(2, attempt);
                                const jitter = Math.floor(Math.random() * 300);
                                const wait = Math.min(60_000, base * factor + jitter);
                                console.warn(`[Genie][Anthropic] 429 rate-limited. Retrying in ${wait}ms (attempt ${attempt + 1}/4).`);
                                await this.sleep(wait);
                                continue;
                            }
                            throw e;
                        }
                    }
                    throw lastErr || new Error('Anthropic chain chat failed after retries');
                };
                const chainMaxParallel = Math.max(1, ((): number => {
                    const v = cfg.get<number>('gitCommitGenie.chain.maxParallel');
                    if (typeof v === 'number' && !isNaN(v)) {
                        return v;
                    }
                    return cfg.get<number>('gitCommitGenie.chainMaxParallel', 4);
                })());
                const out = await generateCommitMessageChain({
                    diffs,
                    baseRulesMarkdown: baseRule,
                    currentTime: parsed?.["current-time"],
                    workspaceFilesTree: parsed?.["workspace-files"],
                    userTemplate: parsed?.["user-template"]
                }, chat, { maxParallel: chainMaxParallel });
                if (usages.length) {
                    const sum = usages.reduce((acc, u) => ({
                        prompt: acc.prompt + (u.prompt_tokens || 0),
                        completion: acc.completion + (u.completion_tokens || 0),
                        total: acc.total + (u.total_tokens || 0)
                    }), { prompt: 0, completion: 0, total: 0 });
                    console.log(`[Genie][Anthropic] Chain total tokens: prompt=${sum.prompt}, completion=${sum.completion}, total=${sum.total}`);
                }
                return { content: out.commitMessage };
            }

            // Legacy single-shot prompt
            const jsonDiff = await super.buildJsonDiff(diffs, templatesPath);
            if (options?.token?.isCancellationRequested) {
                return { message: 'Cancelled', statusCode: 499 };
            }
            let resp: any;
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    resp = await this.client.messages.create({
                        model,
                        max_tokens: 1024,
                        system: baseRule,
                        messages: [{ role: 'user', content: jsonDiff }],
                        temperature: 0
                    });
                    break;
                } catch (e: any) {
                    const code = e?.status || e?.code || e?.error?.status;
                    if (options?.token?.isCancellationRequested) {
                        return { message: 'Cancelled', statusCode: 499 };
                    }
                    if (code === 429) {
                        await this.maybeWarnRateLimit('Anthropic', model);
                        const base = this.getRetryDelayMs(e) || 1000;
                        const factor = Math.pow(2, attempt);
                        const jitter = Math.floor(Math.random() * 300);
                        const wait = Math.min(60_000, base * factor + jitter);
                        console.warn(`[Genie][Anthropic] Legacy 429 rate-limited. Retrying in ${wait}ms.`);
                        await this.sleep(wait);
                        continue;
                    }
                    throw e;
                }
            }
            const usage = this.getResponseUsage(resp);
            if (usage) {
                console.log(`[Genie][Anthropic] Legacy call tokens: prompt=${usage.prompt_tokens ?? 0}, completion=${usage.completion_tokens ?? 0}, total=${usage.total_tokens ?? 0}`);
            } else {
                console.log('[Genie][Anthropic] Legacy call tokens: (usage not provided)');
            }
            const text = this.extractText(resp);
            if (text) {
                const json = this.safeExtractJson<any>(text);
                if (json?.commit_message) {
                    return { content: json.commit_message };
                }
                return { content: text };
            }
            return { message: 'Failed to generate commit message from Anthropic.', statusCode: 500 };
        } catch (error: any) {
            return {
                message: error?.message || 'An unknown error occurred with the Anthropic API.',
                statusCode: error?.status,
            };
        }
    }
}
