import * as vscode from 'vscode';

export const RAG_EMBEDDING_API_KEY_SECRET = 'gitCommitGenie.secret.ragEmbeddingApiKey';
export const RAG_STATE_FILE = 'state.json';
export const RAG_DOCUMENTS_FILE = 'documents.ndjson';

export type RagEmbeddingConfig = {
    enabled: boolean;
    baseUrl: string;
    model: string;
    dimensions: number;
    batchSize: number;
    apiKey: string;
};

export async function readEmbeddingConfig(context: vscode.ExtensionContext): Promise<RagEmbeddingConfig> {
    const ragConfig = vscode.workspace.getConfiguration('gitCommitGenie.rag');
    const secretApiKey = (await context.secrets.get(RAG_EMBEDDING_API_KEY_SECRET))?.trim() || '';

    return {
        enabled: ragConfig.get<boolean>('enabled', false),
        baseUrl: (ragConfig.get<string>('embedding.baseUrl', '') || '').trim(),
        model: (ragConfig.get<string>('embedding.model', '') || '').trim(),
        dimensions: ragConfig.get<number>('embedding.dimensions', 0) || 0,
        batchSize: ragConfig.get<number>('embedding.batchSize', 10) || 10,
        apiKey: secretApiKey,
    };
}

export function normalizeVector(vector: number[]): number[] {
    if (!vector.length) {
        return [];
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
    if (!magnitude) {
        return vector;
    }
    return vector.map(value => value / magnitude);
}
