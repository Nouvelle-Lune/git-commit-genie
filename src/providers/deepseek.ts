import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LLMError, LLMResponse } from '../services/llm/llm_types';
import { BaseLLMService } from "../services/llm/llm_types";
import { L10N_KEYS as I18N } from '../i18n/keys';
import { DiffData } from '../services/git/git_types';
import OpenAI from 'openai';
import { generateCommitMessageChain, ChatFn } from "../services/llm/utils/chainPrompts";

const DEEPSEEK_API_URL = 'https://api.deepseek.com';
const SECRET_DEEPSEEK_API_KEY = 'gitCommitGenie.secret.deepseekApiKey';

export class DeepSeekService extends BaseLLMService {
    protected context: vscode.ExtensionContext;
    private openai: OpenAI | null = null;

    constructor(context: vscode.ExtensionContext) {
        super(context);
        this.context = context;
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_DEEPSEEK_API_KEY);
        this.openai = apiKey ? new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL }) : null;
    }

    /**
     * Validate an API key by calling DeepSeek (OpenAI-compatible) and list models.
     * Returns a curated list intersected with our supported DeepSeek models.
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = [
            'deepseek-chat',
            'deepseek-reasoner'
        ];
        try {
            const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL });
            // Many OpenAI-compatible providers implement models.list; if not, we will
            // still consider the key valid if a lightweight request succeeds.
            try {
                const list = await client.models.list();
                const ids = list.data?.map(m => (m as any).id) || [];
                const available = preferred.filter(id => ids.includes(id));
                return available.length ? available : preferred;
            } catch (inner: any) {
                // If listing models isn't supported, attempt a trivial request to validate.
                await client.chat.completions.create({
                    model: 'deepseek-chat',
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1,
                });
                return preferred;
            }
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate DeepSeek API key.');
        }
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_DEEPSEEK_API_KEY, apiKey);
        this.openai = apiKey ? new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL }) : null;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_DEEPSEEK_API_KEY);
        this.openai = null;
    }

    private async sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
    private getRetryDelayMs(err: any): number {
        const def = 2000;
        const msg: string = err?.message || '';
        const m = msg.match(/retry in\s+([0-9.]+)s/i);
        if (m) {
            const sec = parseFloat(m[1]);
            if (!isNaN(sec)) return Math.max(1000, Math.floor(sec * 1000));
        }
        return def;
    }

    private async maybeWarnRateLimit(provider: string, model: string) {
        const key = 'gitCommitGenie.rateLimitWarned';
        const last = this.context.globalState.get<number>(key, 0) ?? 0;
        const now = Date.now();
        if (now - last < 60_000) return;
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
        if (!text) return null;
        let trimmed = text.trim();
        const fenceMatch = trimmed.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
        if (fenceMatch && fenceMatch[1]) trimmed = fenceMatch[1].trim();
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
                message: 'DeepSeek API key is not set. Please set it in the settings.',
                statusCode: 401,
            };
        }

        try {
            const cfg = vscode.workspace.getConfiguration();
            const useChain = ((): boolean => {
                const v = cfg.get<boolean>('gitCommitGenie.chain.enabled');
                if (typeof v === 'boolean') { return v; }
                return cfg.get<boolean>('gitCommitGenie.useChainPrompts', false);
            })();
            const rulesPath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'baseRules.md'));
            const baseRule = fs.readFileSync(rulesPath, 'utf-8');
            const model = this.context.globalState.get<string>('gitCommitGenie.deepseekModel', '');
            if (!model) {
                return { message: 'DeepSeek model is not selected. Please configure it via Manage Models.', statusCode: 400 };
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
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            const res = await this.openai!.chat.completions.create({
                                model,
                                messages,
                                temperature: 0
                            }, { signal: controller.signal });
                            callCount += 1;
                            const u: any = (res as any).usage;
                            if (u) {
                                usages.push(u);
                                console.log(`[Genie][DeepSeek] Chain call #${callCount} tokens: prompt=${u.prompt_tokens ?? 0}, completion=${u.completion_tokens ?? 0}, total=${u.total_tokens ?? 0}`);
                            } else {
                                console.log(`[Genie][DeepSeek] Chain call #${callCount} tokens: (usage not provided)`);
                            }
                            return res.choices[0]?.message?.content ?? '';
                        } catch (e: any) {
                            lastErr = e;
                            const code = e?.status || e?.code;
                            if (controller.signal.aborted) { throw new Error('Cancelled'); }
                            if (code === 429) {
                                await this.maybeWarnRateLimit('DeepSeek', model);
                                const wait = this.getRetryDelayMs(e);
                                console.warn(`[Genie][DeepSeek] 429 rate-limited. Retrying in ${wait}ms (attempt ${attempt + 1}/2).`);
                                await this.sleep(wait);
                                continue;
                            }
                            throw e;
                        }
                    }
                    throw lastErr || new Error('DeepSeek chain chat failed after retries');
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
                        userTemplate: parsed?.["user-template"] // now actual content
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
                    console.log(`[Genie][DeepSeek] Chain total tokens: prompt=${sum.prompt}, completion=${sum.completion}, total=${sum.total}`);
                }
                return { content: out.commitMessage };
            }

            // Legacy single-shot prompt (system: rules, user: json data)
            const jsonDiff = await super.buildJsonDiff(diffs, templatesPath);
            if (options?.token?.isCancellationRequested) { return { message: 'Cancelled', statusCode: 499 }; }
            const controller = new AbortController();
            options?.token?.onCancellationRequested(() => controller.abort());
            let response: any;
            // attempt twice
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    response = await this.openai.chat.completions.create({
                        model,
                        messages: [
                            { role: 'system', content: baseRule },
                            { role: 'user', content: jsonDiff }
                        ],
                        temperature: 0.0
                    }, { signal: controller.signal });
                    break;
                } catch (e: any) {
                    const code = e?.status || e?.code;
                    if (controller.signal.aborted) { return { message: 'Cancelled', statusCode: 499 }; }
                    if (code === 429) {
                        await this.maybeWarnRateLimit('DeepSeek', model);
                        const wait = this.getRetryDelayMs(e);
                        console.warn(`[Genie][DeepSeek] Legacy 429 rate-limited. Retrying in ${wait}ms.`);
                        await this.sleep(wait);
                        continue;
                    }
                    throw e;
                }
            }
            const usageLegacy: any = (response as any).usage;
            if (usageLegacy) {
                console.log(`[Genie][DeepSeek] Legacy call tokens: prompt=${usageLegacy.prompt_tokens ?? 0}, completion=${usageLegacy.completion_tokens ?? 0}, total=${usageLegacy.total_tokens ?? 0}`);
            } else {
                console.log('[Genie][DeepSeek] Legacy call tokens: (usage not provided)');
            }

            const content = response.choices[0]?.message?.content;
            if (content) {
                const jsonResponse = this.safeExtractJson<any>(content);
                if (jsonResponse?.commit_message) {
                    return { content: jsonResponse.commit_message };
                }
                return { content };
            } else {
                return { message: 'Failed to generate commit message from DeepSeek.', statusCode: 500 };
            }
        } catch (error: any) {
            return {
                message: error.message || 'An unknown error occurred with the DeepSeek API.',
                statusCode: error.status,
            };
        }
    }

}
