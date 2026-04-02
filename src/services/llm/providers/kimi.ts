import * as vscode from 'vscode';
import { TemplateService } from '../../../template/templateService';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { OpenAIChatCompletionsService } from './openaiChatCompletionsService';

const KIMI_API_URL_CHINA = 'https://api.moonshot.cn/v1';
const KIMI_API_URL_INTL = 'https://api.moonshot.ai/v1';

/**
 * Kimi provider implementation via OpenAI-compatible chat completions.
 */
export class KimiService extends OpenAIChatCompletionsService {
    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService, {
            providerName: 'Kimi',
            modelStateKey: 'gitCommitGenie.kimiModel',
            secretKey: 'gitCommitGenie.secret.kimiApiKey',
            baseURL: KIMI_API_URL_CHINA,
            endpointStateKey: 'gitCommitGenie.kimiRegion',
            endpointCandidates: {
                china: KIMI_API_URL_CHINA,
                intl: KIMI_API_URL_INTL
            }
        });
    }

    public listSupportedModels(): string[] {
        return [
            'kimi-k2.5',
            'kimi-k2',
            'kimi-k2-thinking'
        ];
    }
}
