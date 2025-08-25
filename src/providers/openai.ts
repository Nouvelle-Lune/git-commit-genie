import * as vscode from 'vscode';
import OpenAI from 'openai';
import {LLMError, LLMProvider, LLMResponse } from '../services/llm/llm_types';
import { DiffData } from "../services/git/git_types";

const OPENAI_API_KEY_SECRET_KEY = 'git-commit-genie.openaiApiKey';

export class OpenAIService implements LLMProvider {
	private openai: OpenAI | null = null;
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.initialize();
	}

	private async initialize(): Promise<void> {
		const apiKey = await this.getApiKey();
		if (apiKey) {
			this.openai = new OpenAI({ apiKey });
		}
	}

	private async getApiKey(): Promise<string | undefined> {
		return await this.context.secrets.get(OPENAI_API_KEY_SECRET_KEY);
	}

	public async setApiKey(apiKey: string): Promise<void> {
		await this.context.secrets.store(OPENAI_API_KEY_SECRET_KEY, apiKey);
		this.openai = new OpenAI({ apiKey });
	}

	public async clearApiKey(): Promise<void> {
		await this.context.secrets.delete(OPENAI_API_KEY_SECRET_KEY);
		this.openai = null;
	}

	async generateCommitMessage(diff: DiffData): Promise<LLMResponse | LLMError> {
		if (!this.openai) {
			return {
				message: 'OpenAI API key is not set. Please set it in the settings.',
				statusCode: 401,
			};
		}

		try {
			const prompt = this.buildPrompt(diff);
			const response = await this.openai.chat.completions.create({
				model: 'gpt-3.5-turbo',
				messages: [{ role: 'user', content: prompt }],
			});

			const content = response.choices[0]?.message?.content;

			if (content) {
				return { content };
			} else {
				return { message: 'Failed to generate commit message from OpenAI.', statusCode: 500 };
			}
		} catch (error: any) {
			return {
				message: error.message || 'An unknown error occurred with the OpenAI API.',
				statusCode: error.status,
			};
		}
	}

	private buildPrompt(diff: DiffData): string {
		// Simple prompt for now, will be improved later
		return `Generate a concise commit message based on the following diff:\n\n${diff.rawDiff}`;
	}
}