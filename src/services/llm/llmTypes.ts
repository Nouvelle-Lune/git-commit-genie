import * as vscode from 'vscode';
import * as fs from 'fs';
import { z } from "zod";
import { DiffData } from '../git/gitTypes';
import { TemplateService } from '../../template/templateService';
import { IRepositoryAnalysisService } from '../analysis/analysisTypes';
import { LLMAnalysisResponse, AnalysisPromptParts } from '../analysis/analysisTypes';


/**
 * The following schema is to support strict JSON output validation from LLMs.
 */

export const commitMessageSchema = z.object({
	commitMessage: z.string().min(1)
});

export const fileSummarySchema = z.object({
	file: z.string().min(1),
	status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored']),
	summary: z.string().min(1).max(200),
	breaking: z.boolean()
});

export const templatePolicySchema = z.object({
	header: z.object({
		requireScope: z.boolean(),
		scopeDerivation: z.enum(['directory', 'repo', 'none']),
		preferBangForBreaking: z.boolean(),
		alsoRequireBreakingFooter: z.boolean()
	}),
	types: z.object({
		allowed: z.array(z.string().min(1)),
		preferred: z.string().min(1).nullable(),
		useStandardTypes: z.boolean()
	}),
	body: z.object({
		alwaysInclude: z.boolean(),
		orderedSections: z.array(z.string().min(1)),
		bulletRules: z.array(z.object({
			section: z.string().min(1),
			maxBullets: z.number().min(1).optional(),
			style: z.enum(['dash', 'asterisk']).optional()
		})),
		bulletContentMode: z.enum(['plain', 'file-prefixed', 'type-prefixed']).optional()
	}),
	footers: z.object({
		required: z.array(z.string().min(1)).nullable(),
		defaults: z.array(z.object({
			token: z.string().min(1),
			value: z.string().min(1)
		}).nullable()),
	}),
	lexicon: z.object({
		prefer: z.array(z.string().min(1)),
		avoid: z.array(z.string().min(1)),
		tone: z.enum(['imperative', 'neutral', 'friendly'])
	})
});

export const classifyAndDraftResponseSchema = z.object({
	type: z.string().min(1),
	scope: z.string().min(1).nullable(),
	breaking: z.boolean(),
	description: z.string().min(1),
	body: z.string().min(1).nullable(),
	footers: z.array(z.object({
		token: z.string().min(1),
		value: z.string().min(1)
	})),
	commitMessage: z.string().min(1),
	notes: z.string().min(1)
});

export const validateAndFixResponseSchema = z.object({
	status: z.enum(['valid', 'fixed']),
	commitMessage: z.string().min(1),
	violations: z.array(z.string()),
	notes: z.string().nullable()
});



export const repoAnalysisResponseSchema = z.object({
	summary: z.string().min(1).describe("Brief but comprehensive summary of the repository purpose and architecture"),
	projectType: z.string().min(1).describe("Main project type (e.g., Web App, Library, CLI Tool, etc.)"),
	technologies: z.array(z.string().min(1)).describe("Array of main technologies used"),
	insights: z.array(z.string().min(1)).describe("Key architectural insights about the project")
});

export type ChatRole = 'system' | 'user' | 'assistant' | 'developer';

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export type RequestType = 'commitMessage' | 'summary' | 'templatePolicy' | 'draft' | 'fix' | 'repoAnalysis';

export type ChatFn = (
	messages: ChatMessage[],
	options?: {
		model?: string
		temperature?: number
		requestType: RequestType
	}
) => Promise<any>;

/**
 * Represents the response from the LLM service.
 */
export interface LLMResponse {
	content: string;
}

/**
 * Represents an error from the LLM service.
 */
export interface LLMError {
	message: string;
	statusCode?: number;
}

/**
 * Interface for an LLM service provider.
 */
export interface LLMService {

	refreshFromSettings(): Promise<void>;

	validateApiKeyAndListModels(apiKey: string): Promise<string[]>;

	setApiKey(apiKey: string): Promise<void>;

	clearApiKey(): Promise<void>;

	generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError>;

	generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options?: { token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError>;
}

export abstract class BaseLLMService implements LLMService {
	protected context: vscode.ExtensionContext;
	protected templateService: TemplateService;
	protected analysisService?: IRepositoryAnalysisService;

	constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
		this.context = context;
		this.templateService = templateService;
		this.analysisService = analysisService;
	}

	abstract refreshFromSettings(): Promise<void>;
	abstract validateApiKeyAndListModels(apiKey: string): Promise<string[]>;
	abstract setApiKey(apiKey: string): Promise<void>;
	abstract clearApiKey(): Promise<void>;
	abstract generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError>;
	abstract generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options?: { token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError>;

	protected async buildJsonMessage(diffs: DiffData[]): Promise<string> {
		const time = new Date().toISOString();

		// Get repository analysis instead of workspace files
		const cfg = vscode.workspace.getConfiguration();
		const templatesPath = this.templateService.getActiveTemplate();

		// Get repository analysis
		let repositoryAnalysis = '';
		if (this.analysisService) {
			try {
				const workspaceFolders = vscode.workspace.workspaceFolders;
				if (workspaceFolders && workspaceFolders.length > 0) {
					const repositoryPath = workspaceFolders[0].uri.fsPath;
					repositoryAnalysis = await this.analysisService.getAnalysisForPrompt(repositoryPath);
					repositoryAnalysis = JSON.parse(repositoryAnalysis);
				}
			} catch (error) {
				console.error('Failed to get repository analysis:', error);
				repositoryAnalysis = '';
			}
		}

		let userTemplateContent = '';
		if (templatesPath && typeof templatesPath === 'string' && templatesPath.trim()) {
			try {
				if (fs.existsSync(templatesPath)) {
					const stat = fs.statSync(templatesPath);
					if (stat.isFile() && stat.size > 0) {
						const content = fs.readFileSync(templatesPath, 'utf-8');
						if (content && content.trim().length > 0) {
							userTemplateContent = content;
						}
					}
				}
			} catch {
				userTemplateContent = '';
			}
		}

		// Preferred output language for generated commit message
		let targetLanguage = cfg.get<string>('gitCommitGenie.commitLanguage', 'auto') || 'auto';
		if (!targetLanguage || targetLanguage === 'auto') {
			try { targetLanguage = (vscode.env.language || 'en'); } catch { targetLanguage = 'en'; }
		}

		const data = {
			"diffs": diffs.map(diff => ({
				fileName: diff.fileName,
				rawDiff: diff.rawDiff,
				status: diff.status
			})),
			"current-time": time,
			"repository-analysis": repositoryAnalysis,
			"user-template": userTemplateContent,
			"target-language": targetLanguage
		};
		return JSON.stringify(data, null, 2);
	}
}
