import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseLLMService, LLMError, LLMResponse } from "../services/llm/llm_types";
import { L10N_KEYS as I18N } from '../i18n/keys';
import { DiffData } from "../services/git/git_types";
import { generateCommitMessageChain, ChatFn, ChatMessage } from "../services/llm/utils/chainPrompts";

const SECRET_GEMINI_API_KEY = 'gitCommitGenie.secret.geminiApiKey';

export class GeminiService extends BaseLLMService {
    private client: any | null = null;
    protected context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        super(context);
        this.context = context;
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_GEMINI_API_KEY);
        this.client = null;
        if (apiKey) {
            try {
                const { GoogleGenAI } = require('@google/genai');
                this.client = new GoogleGenAI({ apiKey });
            } catch (e) {
                console.warn('Gemini SDK not available. Please install @google/genai.');
                this.client = null;
            }
        }
    }

    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const curated = [
            'gemini-2.5-flash',
            'gemini-2.5-pro'
        ];
        try {
            const { GoogleGenAI } = require('@google/genai');
            const ai = new GoogleGenAI({ apiKey });
            await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'ping' });
            return curated;
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate Gemini API key.');
        }
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_GEMINI_API_KEY, apiKey);
        await this.refreshFromSettings();
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_GEMINI_API_KEY);
        this.client = null;
    }

    private buildGeminiInputs(messages: ChatMessage[]): { system?: string; contents: string } {
        const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        const contents = messages.filter(m => m.role !== 'system').map(m => `(${m.role.toUpperCase()})\n${m.content}`).join('\n\n');
        return { system: system || undefined, contents };
    }

    private safeExtractJson<T = any>(text: string): T | null {
        if (!text) {
            return null;
        }
        let trimmed = text.trim();
        // Strip code fences if present
        const fenceMatch = trimmed.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
        if (fenceMatch && fenceMatch[1]) {
            trimmed = fenceMatch[1].trim();
        }
        try {
            return JSON.parse(trimmed) as T;
        } catch {}
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            const slice = trimmed.slice(start, end + 1);
            try { return JSON.parse(slice) as T; } catch {}
        }
        return null;
    }

    private async sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

    private getRetryDelayMs(err: any): number {
        const def = 9000;
        const msg: string = err?.message || '';
        const m = msg.match(/retry in\s+([0-9.]+)s/i);
        if (m) {
            const sec = parseFloat(m[1]);
            if (!isNaN(sec)) {
                return Math.max(1000, Math.floor(sec * 1000));
            }
        }
        const details = err?.error?.details;
        const retry = Array.isArray(details) ? details.find((d: any) => d['@type']?.includes('RetryInfo')) : undefined;
        const nanos = retry?.retryDelay?.nanos ?? 0;
        const seconds = retry?.retryDelay?.seconds ?? 0;
        if (seconds || nanos) {
            return Math.max(1000, seconds * 1000 + Math.floor(nanos / 1e6));
        }
        return def;
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

    async generateCommitMessage(diffs: DiffData[]): Promise<LLMResponse | LLMError> {
        if (!this.client) {
            return { message: 'Gemini API key is not set or SDK unavailable.', statusCode: 401 };
        }
        try {
            const templatesPath = vscode.workspace.getConfiguration().get<string>('gitCommitGenie.templatesPath', '');
            const rulesPath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'baseRules.md'));
            const baseRule = fs.readFileSync(rulesPath, 'utf-8');
            const modelId = this.context.globalState.get<string>('gitCommitGenie.geminiModel', '');
            if (!modelId) {
                return { message: 'Gemini model is not selected. Please configure it via Manage Models.', statusCode: 400 };
            }
            // Prefer new chain.enabled key, fallback to legacy useChainPrompts
            const cfg = vscode.workspace.getConfiguration();
            const useChain = ((): boolean => {
                const v = cfg.get<boolean>('gitCommitGenie.chain.enabled');
                if (typeof v === 'boolean') { return v; }
                return cfg.get<boolean>('gitCommitGenie.useChainPrompts', false);
            })();

            // Gemini-specific throttle aligned to public limits (configurable soft limits)
            const rpmLimit = Math.max(1, vscode.workspace.getConfiguration().get<number>('gitCommitGenie.gemini.rpmLimit', 8));
            const tpmLimit = Math.max(1000, vscode.workspace.getConfiguration().get<number>('gitCommitGenie.gemini.tpmLimit', 200000));
            const expectedTokensPerCall = Math.max(512, vscode.workspace.getConfiguration().get<number>('gitCommitGenie.gemini.expectedTokensPerCall', 8000));

            const windowMs = 60_000;
            const reqTimes: number[] = [];
            const tokenEvents: Array<{ t: number; n: number }> = [];
            const prune = (now: number) => {
                while (reqTimes.length && now - reqTimes[0] >= windowMs) {
                    reqTimes.shift();
                }
                while (tokenEvents.length && now - tokenEvents[0].t >= windowMs) {
                    tokenEvents.shift();
                }
            };
            const tokensUsed = () => tokenEvents.reduce((s, e) => s + e.n, 0);
            const nowMs = () => Date.now();
            const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
            let mutex = Promise.resolve();
            const runExclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
                const p = mutex.then(fn);
                mutex = p.then(() => {}, () => {});
                return p;
            };
            const acquireSlot = async () => {
                while (true) {
                    const now = nowMs();
                    prune(now);
                    const rpmOk = reqTimes.length < rpmLimit;
                    const tpmOk = tokensUsed() + expectedTokensPerCall <= tpmLimit;
                    if (rpmOk && tpmOk) {
                        reqTimes.push(now);
                        return;
                    }
                    const waitReq = reqTimes.length ? Math.max(1, windowMs - (now - reqTimes[0])) : 250;
                    const waitTok = tokenEvents.length ? Math.max(1, windowMs - (now - tokenEvents[0].t)) : 250;
                    await sleep(Math.max(waitReq, waitTok));
                }
            };
            const recordUsage = (u: any) => {
                const total = u?.totalTokenCount ?? ((u?.promptTokenCount || 0) + (u?.candidatesTokenCount || 0));
                if (total && Number.isFinite(total)) {
                    tokenEvents.push({ t: nowMs(), n: total });
                }
            };

            if (useChain) {
                const jsonDiff = await super.buildJsonDiff(diffs, templatesPath);
                const parsed = JSON.parse(jsonDiff);
                const usages: Array<{ prompt?: number; candidates?: number; total?: number }> = [];
                let callCount = 0;
                const chat: ChatFn = async (messages, options) => {
                    const { system, contents } = this.buildGeminiInputs(messages);
                    let lastErr: any;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            const res = await runExclusive(async () => {
                                await acquireSlot();
                                return await this.client.models.generateContent({
                                    model: modelId,
                                    contents,
                                    config: { systemInstruction: system, temperature: options?.temperature ?? 0 }
                                });
                            });
                            callCount += 1;
                            const u = (res as any)?.usageMetadata || (res as any)?.response?.usageMetadata;
                            if (u) {
                                usages.push({ prompt: u.promptTokenCount, candidates: u.candidatesTokenCount, total: u.totalTokenCount });
                                recordUsage(u);
                                console.log(`[Genie][Gemini] Chain call #${callCount} tokens: prompt=${u.promptTokenCount ?? 0}, completion=${u.candidatesTokenCount ?? 0}, total=${u.totalTokenCount ?? 0}`);
                            } else {
                                console.log(`[Genie][Gemini] Chain call #${callCount} tokens: (usage not provided)`);
                            }
                            const textOut = (res as any)?.text || (res as any)?.response?.text?.() || '';
                            return textOut;
                        } catch (e: any) {
                            lastErr = e;
                            const code = e?.status || e?.code || e?.error?.code;
                            if (code === 429) {
                                await this.maybeWarnRateLimit('Gemini', modelId);
                                const wait = this.getRetryDelayMs(e);
                                console.warn(`[Genie][Gemini] 429 rate-limited. Retrying in ${wait}ms (attempt ${attempt + 1}/3).`);
                                await this.sleep(wait);
                                continue;
                            }
                            throw e;
                        }
                    }
                    throw lastErr || new Error('Gemini chain chat failed after retries');
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
                    type UsageAgg = { prompt: number; completion: number; total: number };
                    const sum = usages.reduce<UsageAgg>((acc, u) => ({
                        prompt: acc.prompt + (u.prompt ?? 0),
                        completion: acc.completion + (u.candidates ?? 0),
                        total: acc.total + (u.total ?? 0)
                    }), { prompt: 0, completion: 0, total: 0 });
                    console.log(`[Genie][Gemini] Chain total tokens: prompt=${sum.prompt}, completion=${sum.completion}, total=${sum.total}`);
                }
                return { content: out.commitMessage };
            }

            // Legacy single-shot prompt
            const jsonDiff = await super.buildJsonDiff(diffs, templatesPath);
            let legacyRes: any;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    legacyRes = await runExclusive(async () => {
                        await acquireSlot();
                        return await this.client.models.generateContent({
                            model: modelId,
                            contents: jsonDiff,
                            config: { systemInstruction: baseRule, temperature: 0 }
                        });
                    });
                    break;
                } catch (e: any) {
                    const code = e?.status || e?.code || e?.error?.code;
                    if (code === 429) {
                        await this.maybeWarnRateLimit('Gemini', modelId);
                        const wait = this.getRetryDelayMs(e);
                        console.warn(`[Genie][Gemini] Legacy 429 rate-limited. Retrying in ${wait}ms.`);
                        await this.sleep(wait);
                        continue;
                    }
                    throw e;
                }
            }
            const res = legacyRes;
            const u = (res as any)?.usageMetadata || (res as any)?.response?.usageMetadata;
            if (u) {
                recordUsage(u);
                console.log(`[Genie][Gemini] Legacy call tokens: prompt=${u.promptTokenCount ?? 0}, completion=${u.candidatesTokenCount ?? 0}, total=${u.totalTokenCount ?? 0}`);
            }
            const textOut = (res as any)?.text || (res as any)?.response?.text?.() || '';
            if (textOut) {
                const json = this.safeExtractJson<any>(textOut);
                if (json?.commit_message) {
                    return { content: json.commit_message };
                }
                return { content: textOut };
            }
            return { message: 'Failed to generate commit message from Gemini.', statusCode: 500 };
        } catch (error: any) {
            return {
                message: error?.message || 'An unknown error occurred with the Gemini API.',
                statusCode: error?.status,
            };
        }
    }
}
