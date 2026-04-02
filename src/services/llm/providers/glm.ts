import * as vscode from 'vscode';
import { TemplateService } from '../../../template/templateService';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { OpenAIChatCompletionsService } from './openaiChatCompletionsService';

const GLM_API_URL_CHINA = 'https://open.bigmodel.cn/api/paas/v4';
const GLM_API_URL_INTL_ALIAS = 'https://open.bigmodel.cn/api/paas/v4/';

/**
 * GLM provider implementation via OpenAI-compatible chat completions.
 */
export class GLMService extends OpenAIChatCompletionsService {
    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService, {
            providerName: 'GLM',
            modelStateKey: 'gitCommitGenie.glmModel',
            secretKey: 'gitCommitGenie.secret.glmApiKey',
            baseURL: GLM_API_URL_CHINA,
            endpointStateKey: 'gitCommitGenie.glmRegion',
            endpointCandidates: {
                china: GLM_API_URL_CHINA,
                intl: GLM_API_URL_INTL_ALIAS
            }
        });
    }

    public listSupportedModels(): string[] {
        return [
            'glm-5',
            'glm-5-turbo',
            'glm-4.7',
            'glm-4.7-flashx',
            'glm-4.7-flash',
            'glm-4.5',
            'glm-4.5-air'
        ];
    }
}
