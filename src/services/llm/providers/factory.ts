import { AIProvider, ProviderKind } from './types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GoogleProvider } from './google';
import { CustomProvider } from './custom';

export interface ProviderFactoryConfig {
    readonly kind: ProviderKind;
    readonly apiKey: string;
    readonly baseUrl?: string;
}

export function createAIProvider(config: ProviderFactoryConfig): AIProvider {
    switch (config.kind) {
        case 'openai':
            return new OpenAIProvider({ apiKey: config.apiKey });
        case 'anthropic':
            return new AnthropicProvider({ apiKey: config.apiKey });
        case 'google':
            return new GoogleProvider({ apiKey: config.apiKey });
        case 'custom':
            if (!config.baseUrl) {
                throw new Error('Custom provider requires a base URL.');
            }
            return new CustomProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    }
}
