import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Repository } from '../git/git';
import { buildRagRerankMessages } from '../chain/chainChatPrompts';
import { ChangeSetSummary, RagStyleReference, RetrievalFeatures } from '../chain/chainTypes';
import { logger } from '../logger';

const RAG_EMBEDDING_API_KEY_SECRET = 'gitCommitGenie.secret.ragEmbeddingApiKey';
const RAG_STATE_FILE = 'state.json';
const RAG_DOCUMENTS_FILE = 'documents.ndjson';
const HYBRID_DENSE_WEIGHT = 0.72;
const HYBRID_BM25_WEIGHT = 0.28;
const HYBRID_RECALL_LIMIT = 18;
const TYPE_SCOPE_RECALL_LIMIT = 12;
const RERANK_CANDIDATE_LIMIT = 20;
const DEFAULT_RERANK_TOP_K = 5;

type RagEmbeddingConfig = {
    baseUrl: string;
    model: string;
    dimensions: number;
    apiKey?: string;
};

type IndexedCommitRow = {
    commitHash: string;
    message: string;
    subject: string;
    body: string;
    committedAt: string;
    changeSetSummary: Partial<ChangeSetSummary>;
    retrievalFeatures: Partial<RetrievalFeatures>;
    documentText: string;
    searchText: string;
    embedding?: number[];
};

type RecallCandidate = IndexedCommitRow & {
    hybridScore: number;
    denseScore: number;
    bm25Score: number;
    featureScore: number;
    matchedBy: Set<'hybrid' | 'typeScope'>;
};

type RagRerankResponse = {
    selected?: Array<{
        commitHash?: string;
        reason?: string;
    }>;
};

export class RagRetrievalService {
    constructor(private readonly context: vscode.ExtensionContext) { }

    public async retrieveStyleReferences(params: {
        repo: Repository;
        changeSetSummary: ChangeSetSummary;
        retrievalFeatures: RetrievalFeatures;
        chat: (messages: any[], options?: { requestType: 'ragRerank'; model?: string; temperature?: number; }) => Promise<any>;
        maxResults?: number;
    }): Promise<RagStyleReference[]> {
        const { repo, changeSetSummary, retrievalFeatures, chat } = params;
        const maxResults = Math.max(1, params.maxResults ?? DEFAULT_RERANK_TOP_K);
        const rows = await this.loadIndexedRows(repo);

        if (!rows.length) {
            logger.info(`[Genie][RAG] Retrieval skipped for ${repo.rootUri.fsPath}; no indexed rows found.`);
            return [];
        }

        const hybrid = await this.hybridRecall(rows, changeSetSummary.text || '');
        const typeScope = this.typeScopeRecall(rows, retrievalFeatures);
        const merged = this.mergeCandidates(hybrid, typeScope)
            .sort((left, right) => {
                const leftPrimary = Math.max(left.featureScore, left.hybridScore);
                const rightPrimary = Math.max(right.featureScore, right.hybridScore);
                return rightPrimary - leftPrimary;
            })
            .slice(0, RERANK_CANDIDATE_LIMIT);

        if (!merged.length) {
            logger.info(`[Genie][RAG] Retrieval produced no candidates for ${repo.rootUri.fsPath}.`);
            return [];
        }

        try {
            const reranked = await this.rerankCandidates(chat, changeSetSummary, retrievalFeatures, merged, maxResults);
            if (reranked.length) {
                logger.info(`[Genie][RAG] Reranked ${merged.length} candidates down to ${reranked.length} style references for ${repo.rootUri.fsPath}.`);
                return reranked;
            }
        } catch (error) {
            logger.warn('[Genie][RAG] Candidate reranking failed; falling back to retrieval order.', error as any);
        }

        return merged.slice(0, maxResults).map(candidate => this.toStyleReference(candidate, this.buildFallbackStyleReason(candidate)));
    }

    private async hybridRecall(rows: IndexedCommitRow[], queryText: string): Promise<RecallCandidate[]> {
        const cleanQuery = (queryText || '').trim();
        if (!cleanQuery) {
            return [];
        }

        const denseScores = await this.computeDenseScores(rows, cleanQuery);
        const bm25Scores = this.computeBm25Scores(rows, cleanQuery);
        const denseAvailable = denseScores.some(score => score > 0);
        const denseNormalized = this.normalizeScores(denseScores);
        const bm25Normalized = this.normalizeScores(bm25Scores);

        const weighted = rows.map((row, index) => {
            const hybridScore = denseAvailable
                ? (denseNormalized[index] * HYBRID_DENSE_WEIGHT) + (bm25Normalized[index] * HYBRID_BM25_WEIGHT)
                : bm25Normalized[index];

            return {
                ...row,
                hybridScore,
                denseScore: denseScores[index] ?? 0,
                bm25Score: bm25Scores[index] ?? 0,
                featureScore: 0,
                matchedBy: new Set<'hybrid' | 'typeScope'>(hybridScore > 0 ? ['hybrid'] : []),
            };
        });

        return weighted
            .filter(candidate => candidate.hybridScore > 0)
            .sort((left, right) => right.hybridScore - left.hybridScore)
            .slice(0, HYBRID_RECALL_LIMIT);
    }

    private typeScopeRecall(rows: IndexedCommitRow[], retrievalFeatures: RetrievalFeatures): RecallCandidate[] {
        const targetType = this.normalizeLabel(retrievalFeatures.predictedType);
        const targetScope = this.normalizeLabel(retrievalFeatures.predictedScope);

        if (!targetType && !targetScope) {
            return [];
        }

        return rows
            .map((row) => {
                const rowType = this.normalizeLabel(row.retrievalFeatures.predictedType || row.changeSetSummary.dominantType);
                const rowScope = this.normalizeLabel(row.retrievalFeatures.predictedScope || row.changeSetSummary.dominantScope);
                const typeScore = targetType && rowType === targetType ? 0.62 : 0;
                const scopeScore = this.computeScopeScore(targetScope, rowScope);
                const featureScore = Math.min(1, typeScore + scopeScore);

                return {
                    ...row,
                    hybridScore: 0,
                    denseScore: 0,
                    bm25Score: 0,
                    featureScore,
                    matchedBy: new Set<'hybrid' | 'typeScope'>(featureScore > 0 ? ['typeScope'] : []),
                };
            })
            .filter(candidate => candidate.featureScore > 0)
            .sort((left, right) => right.featureScore - left.featureScore)
            .slice(0, TYPE_SCOPE_RECALL_LIMIT);
    }

    private mergeCandidates(...candidateGroups: RecallCandidate[][]): RecallCandidate[] {
        const merged = new Map<string, RecallCandidate>();

        for (const group of candidateGroups) {
            for (const candidate of group) {
                const existing = merged.get(candidate.commitHash);
                if (!existing) {
                    merged.set(candidate.commitHash, {
                        ...candidate,
                        matchedBy: new Set(candidate.matchedBy),
                    });
                    continue;
                }

                existing.hybridScore = Math.max(existing.hybridScore, candidate.hybridScore);
                existing.denseScore = Math.max(existing.denseScore, candidate.denseScore);
                existing.bm25Score = Math.max(existing.bm25Score, candidate.bm25Score);
                existing.featureScore = Math.max(existing.featureScore, candidate.featureScore);
                candidate.matchedBy.forEach(source => existing.matchedBy.add(source));
            }
        }

        return Array.from(merged.values());
    }

    private async rerankCandidates(
        chat: (messages: any[], options?: { requestType: 'ragRerank'; model?: string; temperature?: number; }) => Promise<any>,
        changeSetSummary: ChangeSetSummary,
        retrievalFeatures: RetrievalFeatures,
        candidates: RecallCandidate[],
        maxResults: number
    ): Promise<RagStyleReference[]> {
        const promptCandidates = candidates.map(candidate => ({
            commitHash: candidate.commitHash,
            message: candidate.message,
            matchedBy: Array.from(candidate.matchedBy),
            type: candidate.retrievalFeatures.predictedType || candidate.changeSetSummary.dominantType || null,
            scope: candidate.retrievalFeatures.predictedScope || candidate.changeSetSummary.dominantScope || null,
            hybridScore: Number(candidate.hybridScore.toFixed(4)),
            featureScore: Number(candidate.featureScore.toFixed(4)),
        }));

        const messages = buildRagRerankMessages(changeSetSummary, retrievalFeatures, promptCandidates, maxResults);
        const parsed = await chat(messages, { requestType: 'ragRerank' }) as RagRerankResponse;
        const selected = Array.isArray(parsed?.selected) ? parsed.selected : [];
        const candidateMap = new Map(candidates.map(candidate => [candidate.commitHash, candidate]));
        const out: RagStyleReference[] = [];
        const seen = new Set<string>();

        for (const item of selected) {
            const commitHash = String(item?.commitHash || '').trim();
            if (!commitHash || seen.has(commitHash)) {
                continue;
            }
            const candidate = candidateMap.get(commitHash);
            if (!candidate) {
                continue;
            }
            seen.add(commitHash);
            out.push(this.toStyleReference(candidate, String(item?.reason || '').trim() || this.buildFallbackStyleReason(candidate)));
            if (out.length >= maxResults) {
                break;
            }
        }

        return out;
    }

    private toStyleReference(candidate: RecallCandidate, styleReason: string): RagStyleReference {
        return {
            commitHash: candidate.commitHash,
            message: candidate.message,
            subject: candidate.subject,
            body: candidate.body,
            committedAt: candidate.committedAt,
            matchedBy: Array.from(candidate.matchedBy),
            styleReason,
            type: this.normalizeNullable(candidate.retrievalFeatures.predictedType || candidate.changeSetSummary.dominantType),
            scope: this.normalizeNullable(candidate.retrievalFeatures.predictedScope || candidate.changeSetSummary.dominantScope),
        };
    }

    private buildFallbackStyleReason(candidate: RecallCandidate): string {
        const reasons: string[] = [];
        if (candidate.matchedBy.has('typeScope')) {
            reasons.push('type/scope pattern aligns with the current change');
        }
        if (candidate.matchedBy.has('hybrid')) {
            reasons.push('summary is semantically close to the current change');
        }
        if (!reasons.length) {
            reasons.push('historical style is broadly compatible with the current change');
        }
        return reasons.join('; ');
    }

    private computeScopeScore(targetScope: string | null, rowScope: string | null): number {
        if (!targetScope || !rowScope) {
            return 0;
        }
        if (targetScope === rowScope) {
            return 0.38;
        }

        const targetTokens = new Set(this.tokenize(targetScope));
        const rowTokens = new Set(this.tokenize(rowScope));
        if (!targetTokens.size || !rowTokens.size) {
            return 0;
        }

        let overlap = 0;
        for (const token of targetTokens) {
            if (rowTokens.has(token)) {
                overlap += 1;
            }
        }
        if (!overlap) {
            return 0;
        }

        return 0.18 * (overlap / Math.max(targetTokens.size, rowTokens.size));
    }

    private normalizeLabel(value?: string | null): string | null {
        const normalized = String(value || '').trim().toLowerCase();
        return normalized || null;
    }

    private normalizeNullable(value?: string | null): string | null {
        const normalized = String(value || '').trim();
        return normalized || null;
    }

    private async computeDenseScores(rows: IndexedCommitRow[], queryText: string): Promise<number[]> {
        if (!rows.some(row => Array.isArray(row.embedding) && row.embedding.length)) {
            return new Array(rows.length).fill(0);
        }

        const config = await this.readEmbeddingConfig();
        if (!config.apiKey || !config.baseUrl || !config.model) {
            return new Array(rows.length).fill(0);
        }

        const client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
        });

        const request: Record<string, unknown> = {
            model: config.model,
            input: [queryText],
        };
        if (config.dimensions > 0) {
            request.dimensions = config.dimensions;
        }

        const response = await client.embeddings.create(request as any);
        const queryVector = this.normalizeVector(response.data[0]?.embedding?.map(value => Number(value)) || []);
        if (!queryVector.length) {
            return new Array(rows.length).fill(0);
        }

        return rows.map((row) => {
            if (!row.embedding?.length || row.embedding.length !== queryVector.length) {
                return 0;
            }
            return Math.max(0, this.dotProduct(queryVector, row.embedding));
        });
    }

    private computeBm25Scores(rows: IndexedCommitRow[], queryText: string): number[] {
        const queryTerms = this.tokenize(queryText);
        if (!queryTerms.length || !rows.length) {
            return new Array(rows.length).fill(0);
        }

        const documents = rows.map(row => this.tokenize(row.searchText));
        const avgDocLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(documents.length, 1);
        const documentFrequencies = new Map<string, number>();

        for (const tokens of documents) {
            for (const term of new Set(tokens)) {
                documentFrequencies.set(term, (documentFrequencies.get(term) || 0) + 1);
            }
        }

        const totalDocuments = documents.length;
        const k1 = 1.2;
        const b = 0.75;

        return documents.map((tokens) => {
            const termFrequencies = new Map<string, number>();
            for (const token of tokens) {
                termFrequencies.set(token, (termFrequencies.get(token) || 0) + 1);
            }

            let score = 0;
            for (const term of queryTerms) {
                const df = documentFrequencies.get(term) || 0;
                const tf = termFrequencies.get(term) || 0;
                if (!df || !tf) {
                    continue;
                }

                const idf = Math.log(1 + ((totalDocuments - df + 0.5) / (df + 0.5)));
                const numerator = tf * (k1 + 1);
                const denominator = tf + (k1 * (1 - b + (b * (tokens.length / Math.max(avgDocLength, 1)))));
                score += idf * (numerator / denominator);
            }
            return score;
        });
    }

    private normalizeScores(scores: number[]): number[] {
        const positiveScores = scores.filter(score => score > 0);
        if (!positiveScores.length) {
            return scores.map(() => 0);
        }

        const max = Math.max(...positiveScores);
        const min = Math.min(...positiveScores);
        if (max === min) {
            return scores.map(score => score > 0 ? 1 : 0);
        }

        return scores.map(score => score > 0 ? (score - min) / (max - min) : 0);
    }

    private tokenize(text: string): string[] {
        return String(text || '')
            .toLowerCase()
            .split(/[^a-z0-9_.-]+/)
            .map(token => token.trim())
            .filter(token => token.length >= 2);
    }

    private dotProduct(left: number[], right: number[]): number {
        let sum = 0;
        for (let index = 0; index < left.length; index += 1) {
            sum += (left[index] || 0) * (right[index] || 0);
        }
        return sum;
    }

    private normalizeVector(vector: number[]): number[] {
        if (!vector.length) {
            return [];
        }
        const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
        if (!magnitude) {
            return vector;
        }
        return vector.map(value => value / magnitude);
    }

    private async loadIndexedRows(repo: Repository): Promise<IndexedCommitRow[]> {
        const repoPath = repo.rootUri.fsPath;
        const gitDir = await this.resolveGitDir(repoPath);
        if (!gitDir) {
            return [];
        }

        const storageDir = path.join(gitDir, 'git-commit-genie', 'rag');
        const state = await this.readState(storageDir);
        if (!state?.commitCount) {
            return [];
        }

        const file = path.join(storageDir, RAG_DOCUMENTS_FILE);
        try {
            await fs.access(file);
        } catch {
            return [];
        }

        const raw = await fs.readFile(file, 'utf8');
        const rows = raw
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line) as Record<string, unknown>;
                } catch {
                    return null;
                }
            })
            .filter((row): row is Record<string, unknown> => !!row);

        return rows
            .map((row: Record<string, unknown>) => this.toIndexedRow(row))
            .filter((row: IndexedCommitRow | null): row is IndexedCommitRow => !!row);
    }

    private toIndexedRow(row: Record<string, unknown>): IndexedCommitRow | null {
        const commitHash = String(row.commit_hash || '').trim();
        const message = String(row.message || '').trim();
        if (!commitHash || !message) {
            return null;
        }

        const changeSetSummary = this.safeParseJson<Partial<ChangeSetSummary>>(row.change_set_summary_json);
        const retrievalFeatures = this.safeParseJson<Partial<RetrievalFeatures>>(row.retrieval_features_json);
        const documentText = String(row.document_text || '').trim();
        const searchText = [
            message,
            changeSetSummary?.text || '',
            retrievalFeatures?.predictedType || '',
            retrievalFeatures?.predictedScope || '',
            ...(changeSetSummary?.areas || []),
            ...(retrievalFeatures?.entities || []),
        ].filter(Boolean).join(' ');

        return {
            commitHash,
            message,
            subject: String(row.subject || message.split('\n')[0] || '').trim(),
            body: String(row.body || '').trim(),
            committedAt: String(row.committed_at || '').trim(),
            changeSetSummary: changeSetSummary || {},
            retrievalFeatures: retrievalFeatures || {},
            documentText,
            searchText: searchText || documentText || message,
            embedding: Array.isArray(row.embedding)
                ? this.normalizeVector(row.embedding.map(value => Number(value)).filter(value => Number.isFinite(value)))
                : undefined,
        };
    }

    private safeParseJson<T>(value: unknown): T | null {
        if (typeof value !== 'string' || !value.trim()) {
            return null;
        }
        try {
            return JSON.parse(value) as T;
        } catch {
            return null;
        }
    }

    private async readState(storageDir: string): Promise<{ commitCount?: number } | null> {
        try {
            const raw = await fs.readFile(path.join(storageDir, RAG_STATE_FILE), 'utf8');
            return JSON.parse(raw) as { commitCount?: number };
        } catch {
            return null;
        }
    }

    private async resolveGitDir(repoPath: string): Promise<string | null> {
        return await new Promise<string | null>((resolve) => {
            execFile('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoPath, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }
                resolve(String(stdout || '').trim() || null);
            });
        });
    }

    private async readEmbeddingConfig(): Promise<RagEmbeddingConfig> {
        const ragConfig = vscode.workspace.getConfiguration('gitCommitGenie.rag');
        const configApiKey = (ragConfig.get<string>('embedding.apiKey', '') || '').trim();
        const secretApiKey = await this.context.secrets.get(RAG_EMBEDDING_API_KEY_SECRET);

        return {
            baseUrl: (ragConfig.get<string>('embedding.baseUrl', '') || '').trim(),
            model: (ragConfig.get<string>('embedding.model', '') || '').trim(),
            dimensions: ragConfig.get<number>('embedding.dimensions', 0) || 0,
            apiKey: configApiKey || secretApiKey?.trim(),
        };
    }
}
