import * as vscode from 'vscode';
import { LLMError, LLMProvider, LLMResponse } from '../services/llm/llm_types';
import { DiffData } from "../services/git/git_types";

const DEEPSEEK_API_KEY_SECRET_KEY = 'git-commit-genie.deepseekApiKey';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';

export class DeepSeekService implements LLMProvider {
    private apiKey: string | undefined;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.initialize();
    }

    private async initialize(): Promise<void> {
        this.apiKey = await this.getApiKey();
    }

    private async getApiKey(): Promise<string | undefined> {
        return await this.context.secrets.get(DEEPSEEK_API_KEY_SECRET_KEY);
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(DEEPSEEK_API_KEY_SECRET_KEY, apiKey);
        this.apiKey = apiKey;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(DEEPSEEK_API_KEY_SECRET_KEY);
        this.apiKey = undefined;
    }

    async generateCommitMessage(diff: DiffData): Promise<LLMResponse | LLMError> {
        if (!this.apiKey) {
            return {
                message: 'DeepSeek API key is not set. Please set it in the settings.',
                statusCode: 401,
            };
        }

        try {
            const prompt = this.buildPrompt(diff);
            const response = await fetch(DEEPSEEK_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: DEFAULT_MODEL,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            if (!response.ok) {
                const errorData = await response.json() as any;
                const errorMessage = errorData.error?.message || `DeepSeek API error: ${response.statusText}`;
                return {
                    message: errorMessage,
                    statusCode: response.status
                };
            }

            const data = await response.json() as any;
            const content = data.choices?.[0]?.message?.content;

            if (content) {
                return { content };
            } else {
                return { message: 'Failed to generate commit message from DeepSeek.', statusCode: 500 };
            }
        } catch (error: any) {
            return {
                message: error.message || 'An unknown error occurred with the DeepSeek API.',
                statusCode: error.status || 500
            };
        }
    }

    private buildPrompt(diff: DiffData): string {
        // Simple prompt for now, will be improved later
        return `Generate a concise commit message based on the following diff:\n\n${diff.rawDiff}`;
    }
}
