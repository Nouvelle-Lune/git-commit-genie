import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { LLMError, LLMResponse } from '../services/llm/llm_types';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { BaseLLMService } from "../services/llm/llm_types";
import { DiffData } from '../services/git/git_types';
import { generateCommitMessageChain, ChatFn } from "../services/llm/utils/chainPrompts";

const SECRET_OPENAI_API_KEY = 'gitCommitGenie.secret.openaiApiKey';

export class OpenAIService extends BaseLLMService {
    private openai: OpenAI | null = null;
    protected context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        super(context);
        this.context = context;
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_OPENAI_API_KEY);
        this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    }

    /**
     * Validate an API key by calling OpenAI and, if successful, return a curated list
     * of available chat models (intersecting with our supported set).
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = [
            'gpt-5',
            'gpt-5-mini',
            'gpt-5-nano',
            'gpt-4.1',
            'gpt-4.1-mini',
            'gpt-4o',
            'gpt-4o-mini',
            'o4-mini',
            'gpt-3.5-turbo',
            'o3-mini',
            'o3',
        ];
        try {
            const client = new OpenAI({ apiKey });
            const list = await client.models.list();
            const ids = list.data?.map(m => m.id) || [];
            const available = preferred.filter(id => ids.includes(id));

            return available.length ? available : preferred;
        } catch (err: any) {
            // Re-throw to let caller show a friendly message.
            throw new Error(err?.message || 'Failed to validate OpenAI API key.');
        }
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_OPENAI_API_KEY, apiKey);
        this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_OPENAI_API_KEY);
        this.openai = null;
    }

    private async sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

    private getRetryDelayMs(err: any): number {
        const def = 2500;
        // Prefer explicit Retry-After header if available
        const headers: any = (err as any)?.response?.headers || (err as any)?.headers;
        const retryAfter = headers?.['retry-after'] || headers?.['Retry-After'];
        if (retryAfter) {
            const asSeconds = parseFloat(String(retryAfter));
            if (!isNaN(asSeconds)) { return Math.max(500, Math.floor(asSeconds * 1000)); }
        }
        // OpenAI rate headers (best effort)
        const resetReq = headers?.['x-ratelimit-reset-requests']; // e.g., '1s'
        const resetTok = headers?.['x-ratelimit-reset-tokens'];   // e.g., '6m0s'
        const parseDur = (s: string): number => {
            if (!s || typeof s !== 'string') { return 0; }
            const ms = s.match(/([0-9]+)ms/); if (ms) { return parseInt(ms[1], 10); }
            const sec = s.match(/([0-9.]+)s/); if (sec) { return Math.floor(parseFloat(sec[1]) * 1000); }
            const min = s.match(/([0-9.]+)m/); if (min) { return Math.floor(parseFloat(min[1]) * 60_000); }
            return 0;
        };
        const fromHeaders = Math.max(parseDur(resetReq || ''), parseDur(resetTok || ''));
    if (fromHeaders > 0) { return Math.max(500, fromHeaders); }
        // Fallback textual hints
        const msg: string = err?.message || '';
        const m = msg.match(/retry in\s+([0-9.]+)s/i);
        if (m) {
            const sec = parseFloat(m[1]);
            if (!isNaN(sec)) { return Math.max(1000, Math.floor(sec * 1000)); }
        }
        return def;
    }

    private getResponseOutputText(resp: any): string {
    if (!resp) { return ''; }
        // SDK helper if available
        const direct = (resp as any).output_text;
    if (typeof direct === 'string' && direct.trim()) { return direct; }
        // Aggregate from output array
        const out = (resp as any).output;
        if (Array.isArray(out)) {
            const texts: string[] = [];
            for (const item of out) {
                const content = item?.content;
                if (Array.isArray(content)) {
                    for (const c of content) {
                        if (typeof c?.text === 'string') { texts.push(c.text); }
                        if (c?.type === 'output_text' && typeof c?.text === 'string') { texts.push(c.text); }
                    }
                }
            }
            if (texts.length) { return texts.join('\n'); }
        }
        // Fallback to choices[0] if present (chat compat)
        return (resp as any)?.choices?.[0]?.message?.content || '';
    }

    private getResponseUsage(resp: any): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
        const u = (resp as any)?.usage;
    if (!u) { return undefined; }
        const prompt_tokens = u.input_tokens ?? u.prompt_tokens;
        const completion_tokens = u.output_tokens ?? u.completion_tokens;
        const total_tokens = u.total_tokens ?? ((prompt_tokens || 0) + (completion_tokens || 0));
        return { prompt_tokens, completion_tokens, total_tokens };
    }

    private async maybeWarnRateLimit(provider: string, model: string) {
        const key = 'gitCommitGenie.rateLimitWarned';
        const last = this.context.globalState.get<number>(key, 0) ?? 0;
        const now = Date.now();
    if (now - last < 60_000) { return; } // show at most once per minute
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

    private safeExtractJson<T = any>(text: string): T | null {
    if (!text) { return null; }
        let trimmed = text.trim();
        const fenceMatch = trimmed.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
    if (fenceMatch && fenceMatch[1]) { trimmed = fenceMatch[1].trim(); }
        try { return JSON.parse(trimmed) as T; } catch {}
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            const slice = trimmed.slice(start, end + 1);
            try { return JSON.parse(slice) as T; } catch {}
        }
        return null;
    }

    async generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError> {
        if (!this.openai) {
            return {
                message: 'OpenAI API key is not set. Please set it in the settings.',
                statusCode: 401,
            };
        }

        try {
            const cfg = vscode.workspace.getConfiguration();
            // Prefer new key, fallback to legacy
            const useChain = ((): boolean => {
                const v = cfg.get<boolean>('gitCommitGenie.chain.enabled');
                if (typeof v === 'boolean') { return v; }
                return cfg.get<boolean>('gitCommitGenie.useChainPrompts', false);
            })();
            const rulesPath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'baseRules.md'));
            const baseRule = fs.readFileSync(rulesPath, 'utf-8');
            const model = this.context.globalState.get<string>('gitCommitGenie.openaiModel', '');
            if (!model) {
                return { message: 'OpenAI model is not selected. Please configure it via Manage Models.', statusCode: 400 };
            }

            const templatesPath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');

            if (useChain) {
                const jsonDiff = await super.buildJsonDiff(diffs, templatesPath);
                const parsed = JSON.parse(jsonDiff);
                const usages: Array<{ prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }> = [];
                let callCount = 0;
                const chat: ChatFn = async (messages, _options) => {
                    if (options?.token?.isCancellationRequested) { throw new Error('Cancelled'); }
                    const controller = new AbortController();
                    options?.token?.onCancellationRequested(() => controller.abort());
                    let lastErr: any;
                    for (let attempt = 0; attempt < 4; attempt++) {
                        try {
                            const input = messages.map(m => ({ role: m.role === 'system' ? 'developer' : 'user', content: m.content }));
                            const resp = await this.openai!.responses.create({ model, input } as any, { signal: controller.signal });
                            callCount += 1;
                            const u = this.getResponseUsage(resp);
                            if (u) {
                                usages.push(u);
                                console.log(`[Genie][OpenAI] Chain call #${callCount} tokens: prompt=${u.prompt_tokens ?? 0}, completion=${u.completion_tokens ?? 0}, total=${u.total_tokens ?? 0}`);
                            } else {
                                console.log(`[Genie][OpenAI] Chain call #${callCount} tokens: (usage not provided)`);
                            }
                            const text = this.getResponseOutputText(resp);
                            return text || '';
                        } catch (e: any) {
                            lastErr = e;
                            const code = e?.status || e?.code;
                            if (controller.signal.aborted) { throw new Error('Cancelled'); }
                            if (code === 429) {
                                await this.maybeWarnRateLimit('OpenAI', model);
                                // Exponential backoff with jitter
                                const base = this.getRetryDelayMs(e) || 1000;
                                const factor = Math.pow(2, attempt);
                                const jitter = Math.floor(Math.random() * 300);
                                const wait = Math.min(60_000, base * factor + jitter);
                                console.warn(`[Genie][OpenAI] 429 rate-limited. Retrying in ${wait}ms (attempt ${attempt + 1}/4).`);
                                await this.sleep(wait);
                                continue;
                            }
                            throw e;
                        }
                    }
                    throw lastErr || new Error('OpenAI chain chat failed after retries');
                };

                const chainMaxParallel = Math.max(1, ((): number => {
                    const v = cfg.get<number>('gitCommitGenie.chain.maxParallel');
                    if (typeof v === 'number' && !isNaN(v)) { return v; }
                    return cfg.get<number>('gitCommitGenie.chainMaxParallel', 4);
                })());
                const out = await generateCommitMessageChain(
                    {
                        diffs,
                        baseRulesMarkdown: baseRule,
                        currentTime: parsed?.["current-time"],
                        workspaceFilesTree: parsed?.["workspace-files"],
                        userTemplate: parsed?.["user-template"],
                        targetLanguage: parsed?.["target-language"]
                    },
                    chat,
                    { maxParallel: chainMaxParallel }
                );
                if (usages.length) {
                    const sum = usages.reduce((acc, u) => ({
                        prompt: acc.prompt + (u.prompt_tokens || 0),
                        completion: acc.completion + (u.completion_tokens || 0),
                        total: acc.total + (u.total_tokens || 0)
                    }), { prompt: 0, completion: 0, total: 0 });
                    console.log(`[Genie][OpenAI] Chain total tokens: prompt=${sum.prompt}, completion=${sum.completion}, total=${sum.total}`);
                }
                return { content: out.commitMessage };
            }

            // Legacy single-shot using Responses API (no Chat Completions fallback)
            const jsonDiff = await super.buildJsonDiff(diffs, templatesPath);
            if (options?.token?.isCancellationRequested) { return { message: 'Cancelled', statusCode: 499 }; }
            const controller = new AbortController();
            options?.token?.onCancellationRequested(() => controller.abort());
            let resp: any;
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    resp = await this.openai!.responses.create({
                        model,
                        input: [
                            { role: 'developer', content: baseRule },
                            { role: 'user', content: jsonDiff }
                        ]
                    } as any, { signal: controller.signal });
                    break;
                } catch (e: any) {
                    const code = e?.status || e?.code;
                    if (controller.signal.aborted) { return { message: 'Cancelled', statusCode: 499 }; }
                    if (code === 429) {
                        await this.maybeWarnRateLimit('OpenAI', model);
                        const base = this.getRetryDelayMs(e) || 1000;
                        const factor = Math.pow(2, attempt);
                        const jitter = Math.floor(Math.random() * 300);
                        const wait = Math.min(60_000, base * factor + jitter);
                        console.warn(`[Genie][OpenAI] Legacy 429 rate-limited. Retrying in ${wait}ms.`);
                        await this.sleep(wait);
                        continue;
                    }
                    throw e;
                }
            }
            const usage = this.getResponseUsage(resp);
            if (usage) {
                console.log(`[Genie][OpenAI] Legacy call tokens: prompt=${usage.prompt_tokens ?? 0}, completion=${usage.completion_tokens ?? 0}, total=${usage.total_tokens ?? 0}`);
            } else {
                console.log('[Genie][OpenAI] Legacy call tokens: (usage not provided)');
            }

            const outText = this.getResponseOutputText(resp);
            if (outText) {
                const jsonResponse = this.safeExtractJson<any>(outText);
                if (jsonResponse?.commit_message) { return { content: jsonResponse.commit_message }; }
                return { content: outText };
            }
            return { message: 'Failed to generate commit message from OpenAI.', statusCode: 500 };
        } catch (error: any) {
            return {
                message: error.message || 'An unknown error occurred with the OpenAI API.',
                statusCode: error.status,
            };
        }
    }

}
