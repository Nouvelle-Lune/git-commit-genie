import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import OpenAI from 'openai';
import { RepoService } from '../repo/repo';
import { logger } from '../logger';
import { L10N_KEYS as I18N } from '../../i18n/keys';
import { Repository } from '../git/git';

const RAG_EMBEDDING_API_KEY_SECRET = 'gitCommitGenie.secret.ragEmbeddingApiKey';
const RAG_STATE_FILE = 'state.json';
const RAG_DOCUMENTS_FILE = 'documents.ndjson';
const STORAGE_VERSION = 3;
const TS_RAG_PIPELINE_VERSION = 1;

type RagEmbeddingConfig = {
    enabled: boolean;
    baseUrl: string;
    model: string;
    dimensions: number;
    batchSize: number;
    apiKey?: string;
};

type HealthResponse = {
    ok: boolean;
    service: string;
    version: string;
};

type ValidateConfigResponse = {
    ok: boolean;
    provider_family: string;
    model: string;
    dimensions?: number | null;
    message: string;
};

type EnsureIndexResponse = {
    ok: boolean;
    repo_path: string;
    git_dir?: string | null;
    storage_dir?: string | null;
    status: string;
    rebuild_required?: boolean | null;
    indexed_count?: number | null;
    vector_count_added?: number | null;
    commit_count?: number | null;
    vector_count?: number | null;
    history_import_complete?: boolean | null;
    fingerprint_hash?: string | null;
    message?: string | null;
};

type KnownCommitsResponse = {
    ok: boolean;
    repo_path: string;
    commit_hashes: string[];
};

type UpsertDocumentsResponse = {
    ok: boolean;
    repo_path: string;
    stored_count: number;
    vector_count_added: number;
    commit_count: number;
    vector_count: number;
};

type UpsertPreparedDocumentsOptions = {
    isCancellationRequested?: () => boolean;
    skipStatusUpdates?: boolean;
};

type RagState = {
    storageVersion: number;
    fingerprintHash: string;
    fingerprintPayload: Record<string, unknown>;
    knownCommitHashes: string[];
    commitCount: number;
    vectorCount: number;
    historyImportComplete?: boolean;
    indexedAt?: string;
    embeddingDimensions?: number | null;
};

type EmbeddedDocument = Record<string, unknown> & {
    commit_hash: string;
    embedding?: number[];
};

export type RagRepositoryStatusKind = 'disabled' | 'idle' | 'preparing' | 'importing' | 'embedding' | 'ready' | 'error';

export type RagRepositoryStatus = {
    kind: RagRepositoryStatusKind;
    text: string;
    detail?: string;
    updatedAt: string;
};

export class RagRuntimeService {
    private disposed = false;
    private backgroundEnsureCallback: ((reason: string) => Promise<void>) | null = null;
    private readonly repositoryStatuses = new Map<string, RagRepositoryStatus>();
    private readonly _onDidRepositoryStatusChange = new vscode.EventEmitter<{ repoPath: string; status: RagRepositoryStatus }>();
    public readonly onDidRepositoryStatusChange = this._onDidRepositoryStatusChange.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly repoService: RepoService
    ) { }

    public async initialize(): Promise<void> {
        void vscode.commands.executeCommand('setContext', 'gitCommitGenie.ragIndexing', false);
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(async (e) => {
                if (
                    e.affectsConfiguration('gitCommitGenie.rag.enabled') ||
                    e.affectsConfiguration('gitCommitGenie.rag.embedding.baseUrl') ||
                    e.affectsConfiguration('gitCommitGenie.rag.embedding.model') ||
                    e.affectsConfiguration('gitCommitGenie.rag.embedding.apiKey') ||
                    e.affectsConfiguration('gitCommitGenie.rag.embedding.dimensions') ||
                    e.affectsConfiguration('gitCommitGenie.rag.embedding.batchSize')
                ) {
                    await this.refreshFromSettings();
                }
            }),
            this.context.secrets.onDidChange(async (e) => {
                if (e.key === RAG_EMBEDDING_API_KEY_SECRET) {
                    await this.refreshFromSettings();
                }
            })
        );

        await this.repoService.whenReady();
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        this._onDidRepositoryStatusChange.dispose();
    }

    public getSecretStorageKey(): string {
        return RAG_EMBEDDING_API_KEY_SECRET;
    }

    public setBackgroundEnsureCallback(callback: (reason: string) => Promise<void>): void {
        this.backgroundEnsureCallback = callback;
    }

    public async setEmbeddingApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(RAG_EMBEDDING_API_KEY_SECRET, apiKey);
        await this.refreshFromSettings();
    }

    public async clearEmbeddingApiKey(): Promise<void> {
        await this.context.secrets.delete(RAG_EMBEDDING_API_KEY_SECRET);
        await this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        if (this.disposed) {
            return;
        }

        const cfg = await this.readConfig();
        if (!cfg.enabled) {
            for (const repo of this.repoService.getRepositories()) {
                this.updateRepositoryStatus(repo.rootUri.fsPath, 'disabled', vscode.l10n.t(I18N.rag.statusDisabled));
            }
        }
        if (!cfg.enabled || !this.backgroundEnsureCallback) {
            logger.info(`[Genie][RAG] Skipping settings refresh trigger: enabled=${cfg.enabled}, callbackReady=${!!this.backgroundEnsureCallback}`);
            return;
        }

        try {
            logger.info(`[Genie][RAG] Settings changed. Triggering background indexing refresh. embeddingConfigured=${this.isConfigured(cfg)}`);
            await this.backgroundEnsureCallback('settings-refresh');
        } catch (error) {
            logger.warn('[Genie][RAG] Failed to trigger background reindex on settings refresh', error as any);
        }
    }

    public async getHealth(): Promise<HealthResponse> {
        return {
            ok: true,
            service: 'local-rag-store',
            version: '1',
        };
    }

    public async validateEmbeddingConfiguration(): Promise<ValidateConfigResponse> {
        const cfg = await this.readConfig();
        if (!this.isConfigured(cfg)) {
            throw new Error(vscode.l10n.t(I18N.rag.backendNotConfigured));
        }

        const client = new OpenAI({
            apiKey: cfg.apiKey,
            baseURL: cfg.baseUrl,
        });

        const request: Record<string, unknown> = {
            model: cfg.model,
            input: ['git-commit-genie-rag-healthcheck'],
        };
        if (cfg.dimensions > 0) {
            request.dimensions = cfg.dimensions;
        }

        const result = await client.embeddings.create(request as any);
        const dimensions = cfg.dimensions > 0
            ? cfg.dimensions
            : (Array.isArray(result.data) && result.data[0]?.embedding ? result.data[0].embedding.length : null);

        return {
            ok: true,
            provider_family: 'openai-compatible',
            model: cfg.model,
            dimensions,
            message: `Validated ${cfg.model} with ${result.data.length} embedding vector(s).`,
        };
    }

    public async isEmbeddingConfigured(): Promise<boolean> {
        const cfg = await this.readConfig();
        return this.isConfigured(cfg);
    }

    public async getRepositoryGitStorageDir(repo?: vscode.Uri): Promise<string | null> {
        const targetRepo = repo ? this.repoService.getRepositoryByUri(repo) : this.repoService.getActiveRepository();
        if (!targetRepo) {
            return null;
        }
        return await this.getStorageDirForRepository(targetRepo);
    }

    public async hasExistingRepositoryIndex(repo: Repository): Promise<boolean> {
        const storageDir = await this.getStorageDirForRepository(repo);
        if (!storageDir) {
            return false;
        }
        const stats = await this.readDocumentStats(storageDir);
        if (stats.commitCount > 0 || stats.vectorCount > 0) {
            return true;
        }
        const state = await this.readState(storageDir);
        return !!state && (state.commitCount > 0 || state.vectorCount > 0 || state.knownCommitHashes.length > 0);
    }

    public getRepositoryStatus(repoPath: string): RagRepositoryStatus | null {
        return this.repositoryStatuses.get(repoPath) || null;
    }

    public updateRepositoryStatus(repoPath: string, kind: RagRepositoryStatusKind, text: string, detail?: string): void {
        const previous = this.repositoryStatuses.get(repoPath);
        if (previous && previous.kind === kind && previous.text === text && previous.detail === detail) {
            return;
        }
        const status: RagRepositoryStatus = {
            kind,
            text,
            detail,
            updatedAt: new Date().toISOString(),
        };
        this.repositoryStatuses.set(repoPath, status);
        this._onDidRepositoryStatusChange.fire({ repoPath, status });
        void vscode.commands.executeCommand('setContext', 'gitCommitGenie.ragIndexing', this.hasActiveIndexingWork());
    }

    public async ensureAllRepositoriesIndexed(reason: string = 'manual'): Promise<void> {
        const cfg = await this.readConfig();
        if (!cfg.enabled) {
            logger.info(`[Genie][RAG] Skipping ensureAllRepositoriesIndexed: rag.enabled=false (${reason})`);
            return;
        }
        const repos = this.repoService.getRepositories();
        logger.info(`[Genie][RAG] Scheduling index ensure for ${repos.length} repositories (${reason}), embeddingConfigured=${this.isConfigured(cfg)}`);
        for (const repo of repos) {
            void this.ensureRepositoryIndexed(repo, reason).catch((error) => {
                logger.warn(`[Genie][RAG] Failed to ensure index for ${repo.rootUri.fsPath} (${reason})`, error as any);
            });
        }
    }

    public async ensureRepositoryIndexed(repo: Repository, reason: string = 'manual'): Promise<EnsureIndexResponse> {
        const cfg = await this.readConfig();
        if (!cfg.enabled) {
            this.updateRepositoryStatus(repo.rootUri.fsPath, 'disabled', vscode.l10n.t(I18N.rag.statusDisabled));
            throw new Error('RAG is disabled.');
        }

        this.updateRepositoryStatus(repo.rootUri.fsPath, 'preparing', vscode.l10n.t(I18N.rag.statusPreparingStore));
        logger.info(`[Genie][RAG] Ensuring repository storage for ${repo.rootUri.fsPath} (${reason}), embeddingConfigured=${this.isConfigured(cfg)}`);

        const gitDir = await this.repoService.getRepositoryGitDir(repo);
        if (!gitDir) {
            throw new Error(`Failed to resolve git dir for ${repo.rootUri.fsPath}`);
        }

        const storageDir = path.join(gitDir, 'git-commit-genie', 'rag');
        await fs.mkdir(storageDir, { recursive: true });

        const fingerprint = this.buildFingerprint(cfg);
        const state = await this.readState(storageDir);
        const storedStats = await this.readDocumentStats(storageDir);
        let rebuildRequired = !state || state.fingerprintHash !== fingerprint.hash;
        if (!rebuildRequired && state && this.isConfigured(cfg) && storedStats.commitCount > 0) {
            const vectorCountBehind = storedStats.vectorCount < storedStats.commitCount;
            if (vectorCountBehind && this.shouldAutoRepairEmbeddings(reason)) {
                rebuildRequired = true;
                logger.info(
                    `[Genie][RAG] Forcing rebuild for ${repo.rootUri.fsPath} because historical embeddings are incomplete: ` +
                    `commitCount=${storedStats.commitCount}, vectorCount=${storedStats.vectorCount}`
                );
            } else if (vectorCountBehind) {
                logger.info(
                    `[Genie][RAG] Detected incomplete historical embeddings for ${repo.rootUri.fsPath} but deferring rebuild ` +
                    `for passive trigger (${reason}). User-initiated reindex is required to backfill dense vectors.`
                );
            }
        }
        if (rebuildRequired) {
            logger.info(`[Genie][RAG] Rebuilding local RAG store for ${repo.rootUri.fsPath}. fingerprintChanged=${!state || state.fingerprintHash !== fingerprint.hash}`);
            await this.resetStorage(storageDir);
        }

        const nextState: RagState = {
            storageVersion: STORAGE_VERSION,
            fingerprintHash: fingerprint.hash,
            fingerprintPayload: fingerprint.payload,
            knownCommitHashes: rebuildRequired ? [] : storedStats.commitHashes,
            commitCount: rebuildRequired ? 0 : storedStats.commitCount,
            vectorCount: rebuildRequired ? 0 : storedStats.vectorCount,
            historyImportComplete: rebuildRequired ? false : (state?.historyImportComplete === true),
            indexedAt: new Date().toISOString(),
            embeddingDimensions: rebuildRequired ? null : (storedStats.embeddingDimensions ?? state?.embeddingDimensions ?? null),
        };
        await this.writeState(storageDir, nextState);

        logger.info(`[Genie][RAG] Local RAG file store ready for ${repo.rootUri.fsPath} (${reason}); rebuildRequired=${rebuildRequired}, commitCount=${nextState.commitCount}, vectorCount=${nextState.vectorCount}`);
        this.updateRepositoryStatus(
            repo.rootUri.fsPath,
            'idle',
            rebuildRequired
                ? vscode.l10n.t(I18N.rag.statusStoreRebuilt)
                : vscode.l10n.t(I18N.rag.statusStoreReady, String(nextState.commitCount))
        );
        return {
            ok: true,
            repo_path: repo.rootUri.fsPath,
            git_dir: gitDir,
            storage_dir: storageDir,
            status: rebuildRequired ? 'rebuilt' : 'ready',
            rebuild_required: rebuildRequired,
            commit_count: nextState.commitCount,
            vector_count: nextState.vectorCount,
            history_import_complete: nextState.historyImportComplete === true,
            fingerprint_hash: fingerprint.hash,
        };
    }

    public async setHistoryImportComplete(repo: Repository, complete: boolean): Promise<void> {
        const storageDir = await this.requireStorageDir(repo);
        const state = await this.readState(storageDir);
        if (!state) {
            return;
        }
        if (state.historyImportComplete === complete) {
            return;
        }
        await this.writeState(storageDir, {
            ...state,
            historyImportComplete: complete,
            indexedAt: new Date().toISOString(),
        });
    }

    public async getKnownCommitHashes(repo: Repository): Promise<Set<string>> {
        const storageDir = await this.requireStorageDir(repo);
        const stats = await this.readDocumentStats(storageDir);
        const response: KnownCommitsResponse = {
            ok: true,
            repo_path: repo.rootUri.fsPath,
            commit_hashes: stats.commitHashes,
        };
        logger.info(`[Genie][RAG] Loaded ${response.commit_hashes.length} known commit hashes for ${repo.rootUri.fsPath}`);
        return new Set(response.commit_hashes);
    }

    public async upsertPreparedDocuments(repo: Repository, documents: unknown[], options?: UpsertPreparedDocumentsOptions): Promise<UpsertDocumentsResponse> {
        const storageDir = await this.requireStorageDir(repo);
        const cfg = await this.readConfig();
        const state = await this.readState(storageDir);
        if (!state) {
            throw new Error('RAG state is missing. Call ensureRepositoryIndexed first.');
        }

        const existingRows = await this.readDocumentRows(storageDir);
        const knownHashes = new Set(existingRows.map(row => row.commit_hash));
        const existingVectorCount = existingRows.filter(row => Array.isArray(row.embedding) && row.embedding.length > 0).length;
        const incomingDocs = (Array.isArray(documents) ? documents : []) as Record<string, unknown>[];
        const newDocs = incomingDocs.filter(doc => {
            const hash = String(doc.commit_hash || '').trim();
            return !!hash && !knownHashes.has(hash);
        });

        logger.info(`[Genie][RAG] Upsert request for ${repo.rootUri.fsPath}: incoming=${incomingDocs.length}, new=${newDocs.length}, known=${knownHashes.size}, embeddingConfigured=${this.isConfigured(cfg)}`);

        if (!newDocs.length) {
            if (!options?.skipStatusUpdates) {
                this.updateRepositoryStatus(repo.rootUri.fsPath, 'ready', this.getReadyStatusText(existingRows.length, existingVectorCount));
            }
            return {
                ok: true,
                repo_path: repo.rootUri.fsPath,
                stored_count: 0,
                vector_count_added: 0,
                commit_count: existingRows.length,
                vector_count: existingVectorCount,
            };
        }

        if (!options?.skipStatusUpdates) {
            this.updateRepositoryStatus(repo.rootUri.fsPath, 'ready', this.getReadyStatusText(existingRows.length, existingVectorCount));
        }
        this.throwIfCancelled(options?.isCancellationRequested);
        const embeddings = this.isConfigured(cfg)
            ? await this.embedDocuments(repo.rootUri.fsPath, cfg, newDocs, options?.isCancellationRequested, options?.skipStatusUpdates)
            : new Map<string, number[]>();
        const rowsWithEmbeddings: EmbeddedDocument[] = newDocs.map((doc) => this.toStoredRow(doc, embeddings.get(String(doc.commit_hash))));
        const rows = rowsWithEmbeddings;

        this.throwIfCancelled(options?.isCancellationRequested);
        await this.appendRows(storageDir, rows);

        const nextRows = existingRows.concat(rows);
        const nextState: RagState = {
            ...state,
            knownCommitHashes: nextRows.map(row => row.commit_hash),
            commitCount: nextRows.length,
            vectorCount: nextRows.filter(row => Array.isArray(row.embedding) && row.embedding.length > 0).length,
            indexedAt: new Date().toISOString(),
            embeddingDimensions: nextRows.find(row => Array.isArray(row.embedding) && row.embedding.length > 0)?.embedding?.length ?? state.embeddingDimensions ?? null,
        };
        await this.writeState(storageDir, nextState);

        logger.info(`[Genie][RAG] Upsert completed for ${repo.rootUri.fsPath}: stored=${rows.length}, vectorsAdded=${rows.filter(row => Array.isArray(row.embedding)).length}, commitCount=${nextState.commitCount}, vectorCount=${nextState.vectorCount}`);
        if (!options?.skipStatusUpdates) {
            this.updateRepositoryStatus(
                repo.rootUri.fsPath,
                'ready',
                this.getReadyStatusText(nextState.commitCount, nextState.vectorCount)
            );
        }

        return {
            ok: true,
            repo_path: repo.rootUri.fsPath,
            stored_count: rows.length,
            vector_count_added: rows.filter(row => Array.isArray(row.embedding)).length,
            commit_count: nextState.commitCount,
            vector_count: nextState.vectorCount,
        };
    }

    private async readConfig(): Promise<RagEmbeddingConfig> {
        const ragConfig = vscode.workspace.getConfiguration('gitCommitGenie.rag');
        const configApiKey = (ragConfig.get<string>('embedding.apiKey', '') || '').trim();
        const secretApiKey = await this.context.secrets.get(RAG_EMBEDDING_API_KEY_SECRET);

        return {
            enabled: ragConfig.get<boolean>('enabled', false),
            baseUrl: (ragConfig.get<string>('embedding.baseUrl', '') || '').trim(),
            model: (ragConfig.get<string>('embedding.model', '') || '').trim(),
            dimensions: ragConfig.get<number>('embedding.dimensions', 0) || 0,
            batchSize: ragConfig.get<number>('embedding.batchSize', 10) || 10,
            apiKey: configApiKey || secretApiKey?.trim()
        };
    }

    private isConfigured(config: RagEmbeddingConfig): boolean {
        return !!config.baseUrl && !!config.model && !!config.apiKey;
    }

    private async getStorageDirForRepository(repo: Repository): Promise<string | null> {
        const gitDir = await this.repoService.getRepositoryGitDir(repo);
        return gitDir ? path.join(gitDir, 'git-commit-genie', 'rag') : null;
    }

    private async requireStorageDir(repo: Repository): Promise<string> {
        const storageDir = await this.getStorageDirForRepository(repo);
        if (!storageDir) {
            throw new Error(`Failed to resolve local RAG storage dir for ${repo.rootUri.fsPath}`);
        }
        await fs.mkdir(storageDir, { recursive: true });
        return storageDir;
    }

    private buildFingerprint(config: RagEmbeddingConfig): { hash: string; payload: Record<string, unknown>; } {
        const embeddingEnabled = this.isConfigured(config);
        const payload = {
            storage_version: STORAGE_VERSION,
            ts_rag_pipeline_version: TS_RAG_PIPELINE_VERSION,
            backend: 'local-js-index',
            embedding: {
                enabled: embeddingEnabled,
                provider_family: embeddingEnabled ? 'openai-compatible' : null,
                base_url: embeddingEnabled ? config.baseUrl : null,
                model: embeddingEnabled ? config.model : null,
                dimensions: embeddingEnabled && config.dimensions > 0 ? config.dimensions : null,
            },
        };
        const encoded = JSON.stringify(payload);
        let hash = 0;
        for (let i = 0; i < encoded.length; i++) {
            hash = ((hash << 5) - hash) + encoded.charCodeAt(i);
            hash |= 0;
        }
        return {
            hash: `f${Math.abs(hash)}`,
            payload,
        };
    }

    private async readState(storageDir: string): Promise<RagState | null> {
        const file = path.join(storageDir, RAG_STATE_FILE);
        try {
            const raw = await fs.readFile(file, 'utf8');
            return JSON.parse(raw) as RagState;
        } catch {
            return null;
        }
    }

    private async writeState(storageDir: string, state: RagState): Promise<void> {
        const file = path.join(storageDir, RAG_STATE_FILE);
        await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
    }

    private async resetStorage(storageDir: string): Promise<void> {
        await fs.rm(path.join(storageDir, RAG_DOCUMENTS_FILE), { force: true });
        await fs.rm(path.join(storageDir, 'lancedb'), { recursive: true, force: true });
    }

    private shouldAutoRepairEmbeddings(reason: string): boolean {
        return reason === 'command-start' || reason === 'settings-refresh';
    }

    private async readDocumentRows(storageDir: string): Promise<EmbeddedDocument[]> {
        const file = path.join(storageDir, RAG_DOCUMENTS_FILE);
        try {
            const raw = await fs.readFile(file, 'utf8');
            return raw
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .map((line) => JSON.parse(line) as EmbeddedDocument)
                .filter((row) => !!row && typeof row.commit_hash === 'string' && row.commit_hash.trim().length > 0);
        } catch {
            return [];
        }
    }

    private async readDocumentStats(storageDir: string): Promise<{
        commitCount: number;
        vectorCount: number;
        commitHashes: string[];
        embeddingDimensions: number | null;
    }> {
        const rows = await this.readDocumentRows(storageDir);
        const vectorRows = rows.filter(row => Array.isArray(row.embedding) && row.embedding.length > 0);
        return {
            commitCount: rows.length,
            vectorCount: vectorRows.length,
            commitHashes: rows.map(row => row.commit_hash),
            embeddingDimensions: vectorRows[0]?.embedding?.length ?? null,
        };
    }

    private async appendRows(storageDir: string, rows: EmbeddedDocument[]): Promise<void> {
        if (!rows.length) {
            return;
        }
        const file = path.join(storageDir, RAG_DOCUMENTS_FILE);
        const payload = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
        await fs.appendFile(file, payload, 'utf8');
        logger.info(`[Genie][RAG] Appended ${rows.length} rows to local RAG document store '${RAG_DOCUMENTS_FILE}'.`);
    }

    private async embedDocuments(
        repoPath: string,
        config: RagEmbeddingConfig,
        documents: Record<string, unknown>[],
        isCancellationRequested?: () => boolean,
        skipStatusUpdates?: boolean
    ): Promise<Map<string, number[]>> {
        const client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
        });

        const out = new Map<string, number[]>();
        const batchSize = Math.max(1, config.batchSize || 10);
        logger.info(`[Genie][RAG] Generating embeddings for ${documents.length} documents with batchSize=${batchSize}, model=${config.model}`);
        const totalBatches = Math.ceil(documents.length / batchSize);
        for (let start = 0; start < documents.length; start += batchSize) {
            this.throwIfCancelled(isCancellationRequested);
            const batch = documents.slice(start, start + batchSize);
            const batchNumber = Math.floor(start / batchSize) + 1;
            if (!skipStatusUpdates) {
                this.updateRepositoryStatus(repoPath, 'embedding', vscode.l10n.t(I18N.rag.statusEmbedding));
            }
            const request: Record<string, unknown> = {
                model: config.model,
                input: batch.map(doc => String(doc.document_text || '')),
            };
            if (config.dimensions > 0) {
                request.dimensions = config.dimensions;
            }
            const response = await client.embeddings.create(request as any);
            this.throwIfCancelled(isCancellationRequested);
            logger.info(`[Genie][RAG] Embedded batch ${batchNumber}/${totalBatches} (${batch.length} documents).`);
            response.data.forEach((item, index) => {
                const hash = String(batch[index]?.commit_hash || '');
                if (!hash || !Array.isArray(item.embedding)) {
                    return;
                }
                const vector = this.normalizeVector(item.embedding.map(value => Number(value)));
                out.set(hash, vector);
            });
        }
        return out;
    }

    private throwIfCancelled(isCancellationRequested?: () => boolean): void {
        if (isCancellationRequested?.()) {
            throw new Error('RAG_INDEXING_CANCELLED');
        }
    }

    private normalizeVector(vector: number[]): number[] {
        const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
        if (!magnitude) {
            return vector;
        }
        return vector.map(value => value / magnitude);
    }

    private getReadyStatusText(commitCount: number, vectorCount: number): string {
        if (vectorCount > 0) {
            return vscode.l10n.t(I18N.rag.statusReadyWithVectors, String(commitCount), String(vectorCount));
        }
        return vscode.l10n.t(I18N.rag.statusReady, String(commitCount));
    }

    private toStoredRow(document: Record<string, unknown>, embedding?: number[]): EmbeddedDocument {
        const row: EmbeddedDocument = {
            commit_hash: String(document.commit_hash),
            parent_hashes_json: JSON.stringify(document.parent_hashes || []),
            committed_at: String(document.committed_at || ''),
            subject: String(document.subject || ''),
            body: String(document.body || ''),
            message: String(document.message || ''),
            files_json: JSON.stringify(document.files || []),
            file_summaries_json: JSON.stringify(document.file_summaries || []),
            change_set_summary_json: JSON.stringify(document.change_set_summary || {}),
            retrieval_features_json: JSON.stringify(document.retrieval_features || {}),
            document_text: String(document.document_text || ''),
            indexed_at: new Date().toISOString(),
        };
        if (embedding) {
            row.embedding = embedding;
        }
        return row;
    }

    private hasActiveIndexingWork(): boolean {
        for (const status of this.repositoryStatuses.values()) {
            if (status.kind === 'preparing' || status.kind === 'importing' || status.kind === 'embedding') {
                return true;
            }
        }
        return false;
    }
}
