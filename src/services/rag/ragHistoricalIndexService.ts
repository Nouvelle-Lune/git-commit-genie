import { DiffData } from '../git/gitTypes';
import { RepoService } from '../repo/repo';
import { Commit, Repository } from '../git/git';
import { ChangeSetSummary, FileSummary, RetrievalFeatures } from '../chain/chainTypes';
import { RagRuntimeService } from './ragRuntimeService';
import { logger } from '../logger';
import * as vscode from 'vscode';
import { L10N_KEYS as I18N } from '../../i18n/keys';

type PreparedCommitRagDocument = {
    commit_hash: string;
    parent_hashes: string[];
    committed_at: string;
    subject: string;
    body: string;
    message: string;
    files: Array<{ path: string; status: string }>;
    file_summaries: FileSummary[];
    change_set_summary: ChangeSetSummary;
    retrieval_features: RetrievalFeatures;
    document_text: string;
};

type PendingGeneratedCommit = {
    commitMessage: string;
    diffs: DiffData[];
    fileSummaries: FileSummary[];
    changeSetSummary: ChangeSetSummary;
    retrievalFeatures: RetrievalFeatures;
};

export class RagHistoricalIndexService {
    private static readonly COMMIT_PAGE_SIZE = 128;
    private static readonly UPSERT_BATCH_SIZE = 16;
    private readonly inFlight = new Map<string, { cancelled: boolean }>();
    private readonly pendingGenerated = new Map<string, PendingGeneratedCommit>();

    constructor(
        private readonly repoService: RepoService,
        private readonly ragRuntimeService: RagRuntimeService,
    ) { }

    public async ensureRepositoryIndexed(repo: Repository, reason: string): Promise<void> {
        const repoPath = repo.rootUri.fsPath;
        if (this.inFlight.has(repoPath)) {
            logger.info(`[Genie][RAG] Historical import already in progress for ${repoPath}; skipping duplicate trigger (${reason})`);
            return;
        }
        this.inFlight.set(repoPath, { cancelled: false });
        try {
            this.ragRuntimeService.updateRepositoryStatus(repoPath, 'importing', vscode.l10n.t(I18N.rag.statusImporting));
            logger.info(`[Genie][RAG] Historical import started for ${repoPath} (${reason})`);
            const ensureResult = await this.ragRuntimeService.ensureRepositoryIndexed(repo, reason);
            this.throwIfCancelled(repoPath);
            const knownHashes = ensureResult.rebuild_required
                ? new Set<string>()
                : await this.ragRuntimeService.getKnownCommitHashes(repo);
            const historyImportComplete = ensureResult.history_import_complete === true;
            const totalCommitCount = await this.repoService.getRepositoryCommitCount(repoPath);
            const targetCommitCount = ensureResult.rebuild_required
                ? totalCommitCount
                : Math.max(0, totalCommitCount - knownHashes.size);
            let latestVectorCount = ensureResult.vector_count || 0;

            const batch: PreparedCommitRagDocument[] = [];
            let page = 0;
            let skip = 0;
            let totalFetched = 0;
            let totalMissing = 0;
            let storedCount = 0;

            logger.info(
                `[Genie][RAG] Historical import plan for ${repoPath}: totalCommits=${totalCommitCount}, alreadyIndexed=${knownHashes.size}, ` +
                `toIndex=${targetCommitCount}, rebuildRequired=${!!ensureResult.rebuild_required}, historyImportComplete=${historyImportComplete}`
            );

            if (targetCommitCount <= 0) {
                logger.info(`[Genie][RAG] Historical import skipped for ${repoPath}; no commits need indexing.`);
                await this.ragRuntimeService.setHistoryImportComplete(repo, true);
                this.ragRuntimeService.updateRepositoryStatus(
                    repoPath,
                    'ready',
                    this.getReadyStatusText(knownHashes.size, latestVectorCount)
                );
                return;
            }

            this.updateIndexingProgress(repoPath, 0, targetCommitCount);

            while (true) {
                this.throwIfCancelled(repoPath);
                const commits = await this.repoService.getRepositoryCommits({ maxEntries: RagHistoricalIndexService.COMMIT_PAGE_SIZE, skip }, repoPath);
                if (!commits.length) {
                    break;
                }

                page += 1;
                skip += commits.length;
                totalFetched += commits.length;

                const missingCommits = commits.filter(commit => !knownHashes.has(commit.hash));
                totalMissing += missingCommits.length;
                logger.info(
                    `[Genie][RAG] Historical import page ${page} for ${repoPath}: fetched=${commits.length}, missing=${missingCommits.length}, ` +
                    `indexed=${storedCount}/${targetCommitCount}, remaining=${Math.max(0, targetCommitCount - storedCount)}, known=${knownHashes.size}, ` +
                    `rebuildRequired=${!!ensureResult.rebuild_required}`
                );

                if (!ensureResult.rebuild_required && historyImportComplete && missingCommits.length === 0) {
                    logger.info(`[Genie][RAG] Historical import reached an already-indexed page for ${repoPath}; stopping lazy scan at page ${page}.`);
                    break;
                }

                for (const commit of missingCommits) {
                    this.throwIfCancelled(repoPath);
                    const prepared = await this.prepareHistoricalCommitDocument(repo, commit);
                    if (!prepared) {
                        continue;
                    }
                    batch.push(prepared);
                    if (batch.length >= RagHistoricalIndexService.UPSERT_BATCH_SIZE) {
                        logger.info(
                            `[Genie][RAG] Indexing batch for ${repoPath}: currentBatch=${batch.length}, indexed=${storedCount}/${targetCommitCount}, ` +
                            `remaining=${Math.max(0, targetCommitCount - storedCount)}`
                        );
                        const result = await this.ragRuntimeService.upsertPreparedDocuments(repo, batch, {
                            isCancellationRequested: () => this.isCancellationRequested(repoPath),
                            skipStatusUpdates: true
                        });
                        storedCount += result.stored_count;
                        latestVectorCount = result.vector_count;
                        this.updateIndexingProgress(repoPath, storedCount, targetCommitCount);
                        logger.info(
                            `[Genie][RAG] Stored batch for ${repoPath}: batchSize=${batch.length}, stored=${result.stored_count}, ` +
                            `vectorsAdded=${result.vector_count_added}, indexed=${storedCount}/${targetCommitCount}, ` +
                            `remaining=${Math.max(0, targetCommitCount - storedCount)}, totalCommits=${result.commit_count}, vectorCount=${result.vector_count}`
                        );
                        batch.length = 0;
                    }
                }
            }

            logger.info(`[Genie][RAG] Historical import summary for ${repoPath}: fetched=${totalFetched}, missing=${totalMissing}, rebuildRequired=${!!ensureResult.rebuild_required}`);
            this.throwIfCancelled(repoPath);

            if (!totalMissing) {
                logger.info(`[Genie][RAG] Historical import skipped for ${repoPath}; no missing commits.`);
                await this.ragRuntimeService.setHistoryImportComplete(repo, true);
                this.ragRuntimeService.updateRepositoryStatus(
                    repoPath,
                    'ready',
                    this.getReadyStatusText(knownHashes.size, ensureResult.vector_count || 0)
                );
                return;
            }

            if (batch.length) {
                logger.info(
                    `[Genie][RAG] Indexing final batch for ${repoPath}: currentBatch=${batch.length}, indexed=${storedCount}/${targetCommitCount}, ` +
                    `remaining=${Math.max(0, targetCommitCount - storedCount)}`
                );
                const result = await this.ragRuntimeService.upsertPreparedDocuments(repo, batch, {
                    isCancellationRequested: () => this.isCancellationRequested(repoPath),
                    skipStatusUpdates: true
                });
                storedCount += result.stored_count;
                latestVectorCount = result.vector_count;
                this.updateIndexingProgress(repoPath, storedCount, targetCommitCount);
                logger.info(
                    `[Genie][RAG] Stored final batch for ${repoPath}: batchSize=${batch.length}, stored=${result.stored_count}, ` +
                    `vectorsAdded=${result.vector_count_added}, indexed=${storedCount}/${targetCommitCount}, ` +
                    `remaining=${Math.max(0, targetCommitCount - storedCount)}, totalCommits=${result.commit_count}, vectorCount=${result.vector_count}`
                );
            }
            logger.info(
                `[Genie][RAG] Historical import completed for ${repoPath}: stored=${storedCount}, requestedMissing=${totalMissing}, ` +
                `indexed=${storedCount}/${targetCommitCount}, remaining=${Math.max(0, targetCommitCount - storedCount)}, vectorCount=${latestVectorCount}`
            );
            await this.ragRuntimeService.setHistoryImportComplete(repo, true);
            const finalKnownCount = knownHashes.size + storedCount;
            this.ragRuntimeService.updateRepositoryStatus(repoPath, 'ready', this.getReadyStatusText(finalKnownCount, latestVectorCount));
        } catch (error) {
            if (this.isCancellationError(error)) {
                logger.info(`[Genie][RAG] Historical import cancelled for ${repoPath}.`);
                this.ragRuntimeService.updateRepositoryStatus(repoPath, 'idle', vscode.l10n.t(I18N.rag.statusIndexingCancelled));
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            const repoLabel = this.repoService.getRepositoryLabel(repo) || repoPath;
            this.ragRuntimeService.updateRepositoryStatus(
                repoPath,
                'error',
                vscode.l10n.t(I18N.rag.statusImportFailedShort),
                vscode.l10n.t(I18N.rag.statusImportFailed, message)
            );
            logger.warn(`[Genie][RAG] Historical import failed for ${repoPath}`, error as any);
            void vscode.window.showErrorMessage(vscode.l10n.t(I18N.rag.indexingFailed, repoLabel, message));
        } finally {
            this.inFlight.delete(repoPath);
        }
    }

    public cancelRepositoryIndexing(repoPath?: string): void {
        if (!repoPath) {
            for (const state of this.inFlight.values()) {
                state.cancelled = true;
            }
            return;
        }
        const state = this.inFlight.get(repoPath);
        if (state) {
            state.cancelled = true;
        }
    }

    public isRepositoryIndexing(repoPath: string): boolean {
        return this.inFlight.has(repoPath);
    }

    public getIndexingRepositoryPaths(): string[] {
        return Array.from(this.inFlight.keys());
    }

    public async recordPendingGeneratedCommit(
        repo: Repository,
        commitMessage: string,
        diffs: DiffData[],
        metadata: {
            fileSummaries?: FileSummary[];
            changeSetSummary?: ChangeSetSummary;
            retrievalFeatures?: RetrievalFeatures;
        }
    ): Promise<void> {
        if (!metadata.changeSetSummary || !metadata.retrievalFeatures) {
            return;
        }

        this.pendingGenerated.set(repo.rootUri.fsPath, {
            commitMessage: commitMessage.trim(),
            diffs,
            fileSummaries: metadata.fileSummaries || [],
            changeSetSummary: metadata.changeSetSummary,
            retrievalFeatures: metadata.retrievalFeatures,
        });
        logger.info(`[Genie][RAG] Cached pending generated commit context for ${repo.rootUri.fsPath}.`);
    }

    public async ensureAllRepositoriesIndexed(reason: string): Promise<void> {
        const repos = this.repoService.getRepositories();
        logger.info(`[Genie][RAG] ensureAllRepositoriesIndexed invoked (${reason}) for ${repos.length} repositories.`);
        for (const repo of repos) {
            void this.ensureRepositoryIndexed(repo, reason);
        }
    }

    private isCancellationRequested(repoPath: string): boolean {
        return this.inFlight.get(repoPath)?.cancelled === true;
    }

    private throwIfCancelled(repoPath: string): void {
        if (this.isCancellationRequested(repoPath)) {
            throw new Error('RAG_INDEXING_CANCELLED');
        }
    }

    private isCancellationError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return message === 'RAG_INDEXING_CANCELLED';
    }

    private async prepareHistoricalCommitDocument(repo: Repository, commit: Commit): Promise<PreparedCommitRagDocument | null> {
        const pending = this.pendingGenerated.get(repo.rootUri.fsPath);
        if (pending && pending.commitMessage === commit.message.trim()) {
            this.pendingGenerated.delete(repo.rootUri.fsPath);
            logger.info(`[Genie][RAG] Using cached generated RAG context for committed HEAD ${commit.hash} in ${repo.rootUri.fsPath}.`);
            return this.buildPendingDocument(commit, pending);
        }

        return this.buildHistoricalDocumentFromMessage(commit);
    }

    private buildPendingDocument(commit: Commit, pending: PendingGeneratedCommit): PreparedCommitRagDocument {
        const message = commit.message.trim();
        const [subject, ...bodyLines] = message.split('\n');
        const body = bodyLines.join('\n').trim();
        return {
            commit_hash: commit.hash,
            parent_hashes: [...(commit.parents || [])],
            committed_at: (commit.commitDate || commit.authorDate || new Date()).toISOString(),
            subject: (subject || message).trim(),
            body,
            message,
            files: pending.diffs.map(diff => ({ path: diff.fileName, status: diff.status })),
            file_summaries: pending.fileSummaries,
            change_set_summary: pending.changeSetSummary,
            retrieval_features: pending.retrievalFeatures,
            document_text: this.buildDocumentText(message, pending.changeSetSummary, pending.retrievalFeatures),
        };
    }

    private buildHistoricalDocumentFromMessage(commit: Commit): PreparedCommitRagDocument {
        const message = commit.message.trim();
        const [subject, ...bodyLines] = message.split('\n');
        const body = bodyLines.join('\n').trim();
        const parsed = this.parseCommitMessage(message);
        const changeSetSummary: ChangeSetSummary = {
            text: [parsed.summary, body].filter(Boolean).join('\n\n').trim() || subject.trim(),
            dominantType: parsed.type,
            dominantScope: parsed.scope ?? null,
            areas: parsed.scope ? [parsed.scope] : [],
            fileKinds: [],
            changeActions: parsed.type ? [parsed.type] : [],
            entities: parsed.entities,
        };
        const retrievalFeatures: RetrievalFeatures = {
            predictedType: parsed.type,
            predictedScope: parsed.scope ?? null,
            areas: parsed.scope ? [parsed.scope] : [],
            fileKinds: [],
            changeActions: parsed.type ? [parsed.type] : [],
            entities: parsed.entities,
            touchedPaths: [],
            fileExtensions: [],
            statusMix: [],
            fileCount: 0,
            hasDocs: false,
            hasTests: false,
            hasConfig: false,
            hasRenames: false,
            isCrossLayer: false,
            breakingLike: parsed.breaking,
        };

        return {
            commit_hash: commit.hash,
            parent_hashes: [...(commit.parents || [])],
            committed_at: (commit.commitDate || commit.authorDate || new Date()).toISOString(),
            subject: (subject || message).trim(),
            body,
            message,
            files: [],
            file_summaries: [],
            change_set_summary: changeSetSummary,
            retrieval_features: retrievalFeatures,
            document_text: this.buildDocumentText(message, changeSetSummary, retrievalFeatures),
        };
    }

    private parseCommitMessage(message: string): { type?: string; scope?: string | null; breaking: boolean; summary: string; entities: string[] } {
        const [header = '', ...bodyLines] = message.trim().split('\n');
        const body = bodyLines.join(' ').trim();
        const match = header.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i);
        const type = match?.[1]?.toLowerCase();
        const scope = match?.[2]?.trim() || null;
        const breaking = !!match?.[3] || /BREAKING CHANGE/i.test(message);
        const summary = (match?.[4] || header).trim();
        const entitySource = `${summary} ${body}`.toLowerCase();
        const entities = Array.from(new Set(
            entitySource
                .split(/[^a-z0-9_.-]+/)
                .map(token => token.trim())
                .filter(token => token.length >= 3)
                .filter(token => !['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'merge', 'pull', 'request', 'from', 'into', 'with', 'update'].includes(token))
        )).slice(0, 12);
        return { type, scope, breaking, summary, entities };
    }

    private buildDocumentText(message: string, changeSetSummary: ChangeSetSummary, retrievalFeatures: RetrievalFeatures): string {
        return [
            `Commit: ${message.split('\n')[0] || message}`,
            `Summary: ${changeSetSummary.text}`,
            `Type: ${changeSetSummary.dominantType || ''}`,
            `Scope: ${changeSetSummary.dominantScope || ''}`,
            `Areas: ${retrievalFeatures.areas.join(', ')}`,
            `Actions: ${retrievalFeatures.changeActions.join(', ')}`,
            `Entities: ${retrievalFeatures.entities.join(', ')}`,
            `Message: ${message}`
        ].join('\n');
    }

    private getReadyStatusText(commitCount: number, vectorCount: number): string {
        if (vectorCount > 0) {
            return vscode.l10n.t(I18N.rag.statusReadyWithVectors, String(commitCount), String(vectorCount));
        }
        return vscode.l10n.t(I18N.rag.statusReady, String(commitCount));
    }

    private updateIndexingProgress(repoPath: string, indexedCount: number, totalCount: number): void {
        const safeIndexed = Math.min(Math.max(0, indexedCount), Math.max(0, totalCount));
        const remaining = Math.max(0, totalCount - safeIndexed);
        this.ragRuntimeService.updateRepositoryStatus(
            repoPath,
            'importing',
            vscode.l10n.t(I18N.rag.statusIndexingProgress, String(safeIndexed), String(totalCount)),
            vscode.l10n.t(I18N.rag.statusIndexingProgressDetail, String(safeIndexed), String(totalCount), String(remaining))
        );
    }
}
