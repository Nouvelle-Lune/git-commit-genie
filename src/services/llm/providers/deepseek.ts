import * as vscode from 'vscode';
import { TemplateService } from '../../../template/templateService';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { OpenAIChatCompletionsService } from './openaiChatCompletionsService';

const DEEPSEEK_API_URL = 'https://api.deepseek.com';

/**
 * DeepSeek LLM service implementation using OpenAI-compatible chat completions.
 */
export class DeepSeekService extends OpenAIChatCompletionsService {
    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService, {
            providerName: 'DeepSeek',
            modelStateKey: 'gitCommitGenie.deepseekModel',
            secretKey: 'gitCommitGenie.secret.deepseekApiKey',
            baseURL: DEEPSEEK_API_URL
        });
    }

    public listSupportedModels(): string[] {
        return [
            'deepseek-v4-flash',
            'deepseek-v4-pro'
        ];
    }
}
