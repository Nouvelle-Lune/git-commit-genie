import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Repository } from '../git/git';
import { RepoService } from '../repo/repo';
import { buildRagRerankMessages } from '../chain/chainChatPrompts';
import { ChangeSetSummary, RagStyleReference, RetrievalFeatures } from '../chain/chainTypes';
import { logger } from '../logger';
import { RAG_DOCUMENTS_FILE, RAG_STATE_FILE, RagEmbeddingConfig, normalizeVector, readEmbeddingConfig } from './ragShared';

// Recency boost half-life. 90 days matches typical commit-style relevance decay.
const RECENCY_HALF_LIFE_DAYS = 90;
const MILLIS_PER_DAY = 86_400_000;

const HYBRID_DENSE_WEIGHT = 0.72;
const HYBRID_BM25_WEIGHT = 0.28;
const HYBRID_RECALL_LIMIT = 18;
const TYPE_SCOPE_RECALL_LIMIT = 12;
const RERANK_CANDIDATE_LIMIT = 20;
const DEFAULT_RERANK_TOP_K = 5;

type IndexedCommitRow = {
    commitHash: string;
    message: string;
    subject: string;
    body: string;
    committedAt: string;
    changeSetSummary: Partial<ChangeSetSummary>;
    retrievalFeatures: Partial<RetrievalFeatures>;
    documentText: string;
    embeddingText: string;
    searchText: string;
    embedding?: number[];
};

type Bm25CorpusStats = {
    documentFrequencies: Map<string, number>;
    avgDocLength: number;
    documentTokens: string[][];
};

type IndexCacheEntry = {
    mtimeMs: number;
    rows: IndexedCommitRow[];
    bm25: Bm25CorpusStats;
};

type RecallCandidate = IndexedCommitRow & {
    hybridScore: number;
    denseScore: number;
    bm25Score: number;
    featureScore: number;
    recencyBoost: number;
    matchedBy: Set<'hybrid' | 'typeScope'>;
};

type RagRerankResponse = {
    selected?: Array<{
        id?: string;
        reason?: string;
    }>;
};

export class RagRetrievalService {
    // Per-repo in-memory cache keyed by storage directory. Reused across
    // retrieval calls and invalidated by ndjson mtime change.
    private readonly indexCache = new Map<string, IndexCacheEntry>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly repoService: RepoService,
    ) { }

    public async retrieveStyleReferences(params: {
        repo: Repository;
        changeSetSummary: ChangeSetSummary;
        retrievalFeatures: RetrievalFeatures;
        chat: (messages: any[], options?: { requestType: 'ragRerank'; model?: string; temperature?: number; }) => Promise<any>;
        maxResults?: number;
    }): Promise<RagStyleReference[]> {
        const { repo, changeSetSummary, retrievalFeatures, chat } = params;
        const maxResults = Math.max(1, params.maxResults ?? DEFAULT_RERANK_TOP_K);
        const loaded = await this.loadIndexedRows(repo);

        if (!loaded || !loaded.rows.length) {
            logger.info(`[Genie][RAG] Retrieval skipped for ${repo.rootUri.fsPath}; no indexed rows found.`);
            return [];
        }

        const { rows, bm25 } = loaded;
        const hybrid = await this.hybridRecall(rows, bm25, changeSetSummary.text || '');
        const typeScope = this.typeScopeRecall(rows, retrievalFeatures);
        const mergedCandidates = this.mergeCandidates(hybrid, typeScope);
        // Apply recency boost before final sort so newer commits get a small
        // ranking lift (and older ones a small penalty), capped at +/-30%.
        const now = Date.now();
        for (const candidate of mergedCandidates) {
            candidate.recencyBoost = this.computeRecencyBoost(candidate.committedAt, now);
        }
        const merged = mergedCandidates
            .sort((left, right) => {
                const leftPrimary = Math.max(left.featureScore, left.hybridScore) * (0.7 + 0.3 * left.recencyBoost);
                const rightPrimary = Math.max(right.featureScore, right.hybridScore) * (0.7 + 0.3 * right.recencyBoost);
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

    private async hybridRecall(rows: IndexedCommitRow[], bm25: Bm25CorpusStats, queryText: string): Promise<RecallCandidate[]> {
        const cleanQuery = (queryText || '').trim();
        if (!cleanQuery) {
            return [];
        }

        const { scores: denseScores, available: denseAvailable } = await this.computeDenseScores(rows, cleanQuery);
        const bm25Scores = this.computeBm25Scores(bm25, cleanQuery);
        const denseNormalized = this.normalizeScores(denseScores);
        const bm25Normalized = this.normalizeScores(bm25Scores);

        const weighted = rows.map((row, index) => {
            // Per-row decision: rows without an embedding fall back to BM25-only,
            // so legacy rows are not systematically suppressed by dense weighting.
            const hybridScore = denseAvailable[index]
                ? (denseNormalized[index] * HYBRID_DENSE_WEIGHT) + (bm25Normalized[index] * HYBRID_BM25_WEIGHT)
                : bm25Normalized[index];

            return {
                ...row,
                hybridScore,
                denseScore: denseScores[index] ?? 0,
                bm25Score: bm25Scores[index] ?? 0,
                featureScore: 0,
                recencyBoost: 0,
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
                    recencyBoost: 0,
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
        // Use compact c1..cN ids in the rerank prompt to save tokens versus
        // sending 40-char commit hashes; map back to real hashes after parsing.
        const idToHash = new Map<string, string>();
        const promptCandidates = candidates.map((candidate, index) => {
            const id = `c${index + 1}`;
            idToHash.set(id, candidate.commitHash);
            return {
                id,
                message: candidate.message,
                matchedBy: Array.from(candidate.matchedBy),
                type: candidate.retrievalFeatures.predictedType || candidate.changeSetSummary.dominantType || null,
                scope: candidate.retrievalFeatures.predictedScope || candidate.changeSetSummary.dominantScope || null,
                hybridScore: Number(candidate.hybridScore.toFixed(4)),
                featureScore: Number(candidate.featureScore.toFixed(4)),
            };
        });

        const messages = buildRagRerankMessages(changeSetSummary, retrievalFeatures, promptCandidates, maxResults);
        const parsed = await chat(messages, { requestType: 'ragRerank' }) as RagRerankResponse;
        const selected = Array.isArray(parsed?.selected) ? parsed.selected : [];
        const candidateMap = new Map(candidates.map(candidate => [candidate.commitHash, candidate]));
        const out: RagStyleReference[] = [];
        const seen = new Set<string>();

        for (const item of selected) {
            const id = String(item?.id || '').trim();
            const commitHash = idToHash.get(id);
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

    private computeRecencyBoost(committedAt: string, nowMs: number): number {
        const parsed = Date.parse(committedAt || '');
        if (!Number.isFinite(parsed)) {
            // Neutral boost when timestamp is missing/malformed so it does not
            // skew ordering relative to entries with valid timestamps.
            return 0.5;
        }
        const ageDays = Math.max(0, (nowMs - parsed) / MILLIS_PER_DAY);
        return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
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

    private async computeDenseScores(rows: IndexedCommitRow[], queryText: string): Promise<{ scores: number[]; available: boolean[] }> {
        const emptyAvailable = new Array(rows.length).fill(false);
        const emptyScores = new Array(rows.length).fill(0);

        if (!rows.some(row => Array.isArray(row.embedding) && row.embedding.length)) {
            return { scores: emptyScores, available: emptyAvailable };
        }

        const config = await readEmbeddingConfig(this.context);
        if (!config.apiKey || !config.baseUrl || !config.model) {
            return { scores: emptyScores, available: emptyAvailable };
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
        const queryVector = normalizeVector(response.data[0]?.embedding?.map(value => Number(value)) || []);
        if (!queryVector.length) {
            return { scores: emptyScores, available: emptyAvailable };
        }

        const scores: number[] = new Array(rows.length).fill(0);
        const available: boolean[] = new Array(rows.length).fill(false);
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            const hasEmbedding = Array.isArray(row.embedding)
                && row.embedding.length > 0
                && row.embedding.length === queryVector.length;
            if (!hasEmbedding) {
                continue;
            }
            available[index] = true;
            scores[index] = Math.max(0, this.dotProduct(queryVector, row.embedding!));
        }
        return { scores, available };
    }

    private computeBm25Scores(bm25: Bm25CorpusStats, queryText: string): number[] {
        const documents = bm25.documentTokens;
        const queryTerms = this.tokenize(queryText);
        if (!queryTerms.length || !documents.length) {
            return new Array(documents.length).fill(0);
        }

        const documentFrequencies = bm25.documentFrequencies;
        const avgDocLength = bm25.avgDocLength;
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
        // CJK ranges kept in sync with estimateTokens() in src/services/analysis/tools/modelContext.ts.
        // isCjkBoundary mirrors that full set so any CJK code point flushes the ASCII buffer.
        // isCjkWordChar is the narrower subset of actual ideographic/syllabic characters that
        // contribute as BM25 tokens; CJK Symbols/Punctuation (U+3000-U+303F) and Fullwidth Forms
        // (U+FF00-U+FFEF) are excluded because they are mostly punctuation/full-width symbols
        // and should act as separators rather than tokens.
        const lowered = String(text || '').toLowerCase();
        if (!lowered) {
            return [];
        }

        const isCjkBoundary = (code: number): boolean => (
            (code >= 0x3000 && code <= 0x303f) ||
            (code >= 0x3040 && code <= 0x309f) ||
            (code >= 0x30a0 && code <= 0x30ff) ||
            (code >= 0x3400 && code <= 0x4dbf) ||
            (code >= 0x4e00 && code <= 0x9fff) ||
            (code >= 0xac00 && code <= 0xd7af) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xff00 && code <= 0xffef)
        );
        const isCjkWordChar = (code: number): boolean => (
            (code >= 0x3040 && code <= 0x309f) ||
            (code >= 0x30a0 && code <= 0x30ff) ||
            (code >= 0x3400 && code <= 0x4dbf) ||
            (code >= 0x4e00 && code <= 0x9fff) ||
            (code >= 0xac00 && code <= 0xd7af) ||
            (code >= 0xf900 && code <= 0xfaff)
        );
        const isAsciiWord = (code: number): boolean => (
            (code >= 0x30 && code <= 0x39) ||
            (code >= 0x61 && code <= 0x7a) ||
            code === 0x5f || code === 0x2e || code === 0x2d || code === 0x2f
        );
        const stripTrim = (token: string): string => token.replace(/^[._\-/]+|[._\-/]+$/g, '');

        const tokens: string[] = [];
        let asciiBuf = '';
        let cjkBuf = '';

        const flushAscii = () => {
            const trimmed = stripTrim(asciiBuf);
            if (trimmed.length >= 2) {
                tokens.push(trimmed);
            }
            asciiBuf = '';
        };
        const flushCjk = () => {
            if (cjkBuf.length === 0) {
                return;
            }
            // Emit each char and adjacent 2-grams.
            for (let i = 0; i < cjkBuf.length; i++) {
                tokens.push(cjkBuf[i]);
                if (i + 1 < cjkBuf.length) {
                    tokens.push(cjkBuf.slice(i, i + 2));
                }
            }
            cjkBuf = '';
        };

        for (let i = 0; i < lowered.length; i++) {
            const ch = lowered[i];
            const code = ch.charCodeAt(0);
            if (isCjkWordChar(code)) {
                flushAscii();
                cjkBuf += ch;
            } else if (isCjkBoundary(code)) {
                // CJK punctuation / fullwidth symbols act as separators.
                flushAscii();
                flushCjk();
            } else if (isAsciiWord(code)) {
                flushCjk();
                asciiBuf += ch;
            } else {
                flushAscii();
                flushCjk();
            }
        }
        flushAscii();
        flushCjk();

        return tokens.filter(token => token.length > 0);
    }

    private dotProduct(left: number[], right: number[]): number {
        let sum = 0;
        for (let index = 0; index < left.length; index += 1) {
            sum += (left[index] || 0) * (right[index] || 0);
        }
        return sum;
    }

    private async loadIndexedRows(repo: Repository): Promise<{ rows: IndexedCommitRow[]; bm25: Bm25CorpusStats } | null> {
        const gitDir = await this.repoService.getRepositoryGitDir(repo);
        if (!gitDir) {
            return null;
        }

        const storageDir = path.join(gitDir, 'git-commit-genie', 'rag');
        const state = await this.readState(storageDir);
        if (!state?.commitCount) {
            this.indexCache.delete(storageDir);
            return null;
        }

        const file = path.join(storageDir, RAG_DOCUMENTS_FILE);
        let mtimeMs: number;
        try {
            const stat = await fs.stat(file);
            mtimeMs = stat.mtimeMs;
        } catch {
            this.indexCache.delete(storageDir);
            return null;
        }

        const cached = this.indexCache.get(storageDir);
        if (cached && cached.mtimeMs === mtimeMs) {
            return { rows: cached.rows, bm25: cached.bm25 };
        }

        const raw = await fs.readFile(file, 'utf8');
        // Surface ndjson corruption: log per-line warnings so commitCount drift
        // becomes visible instead of being silently dropped.
        const parsed: Record<string, unknown>[] = [];
        const lines = raw.split('\n');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const trimmed = lines[lineIndex].trim();
            if (!trimmed) {
                continue;
            }
            let row: Record<string, unknown>;
            try {
                row = JSON.parse(trimmed) as Record<string, unknown>;
            } catch (error) {
                const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
                logger.warn(
                    `[Genie][RAG] Skipping unparseable ndjson row at ${file}:${lineIndex + 1}; ` +
                    `preview="${preview}"; error=${(error as Error)?.message || error}`
                );
                continue;
            }
            parsed.push(row);
        }

        const rows: IndexedCommitRow[] = [];
        for (let i = 0; i < parsed.length; i += 1) {
            const row = parsed[i];
            const indexed = this.toIndexedRow(row);
            if (!indexed) {
                const hash = String(row.commit_hash || '').trim();
                const message = String(row.message || '').trim();
                logger.warn(
                    `[Genie][RAG] Skipping ndjson row missing required fields at ${file} (entry #${i + 1}): ` +
                    `commit_hash=${hash ? 'present' : 'missing'}, message=${message ? 'present' : 'missing'}`
                );
                continue;
            }
            rows.push(indexed);
        }

        const bm25 = this.buildBm25Corpus(rows);
        this.indexCache.set(storageDir, { mtimeMs, rows, bm25 });
        return { rows, bm25 };
    }

    private buildBm25Corpus(rows: IndexedCommitRow[]): Bm25CorpusStats {
        const documentTokens = rows.map(row => this.tokenize(row.searchText));
        const documentFrequencies = new Map<string, number>();
        let totalLength = 0;
        for (const tokens of documentTokens) {
            totalLength += tokens.length;
            for (const term of new Set(tokens)) {
                documentFrequencies.set(term, (documentFrequencies.get(term) || 0) + 1);
            }
        }
        const avgDocLength = totalLength / Math.max(documentTokens.length, 1);
        return { documentTokens, documentFrequencies, avgDocLength };
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
        // Backward compat: older ndjson rows have no embedding_text; fall back to document_text.
        const embeddingText = String(row.embedding_text || '').trim() || documentText;
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
            embeddingText,
            searchText: searchText || documentText || message,
            embedding: Array.isArray(row.embedding)
                ? normalizeVector(row.embedding.map(value => Number(value)).filter(value => Number.isFinite(value)))
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

}
