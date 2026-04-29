import { DiffData, DiffStatus } from '../git/gitTypes';
import { RepoService } from '../repo/repo';
import { Commit, Repository } from '../git/git';
import { ChangeSetSummary, FileSummary, RetrievalFeatures } from '../chain/chainTypes';
import { RagRuntimeService } from './ragRuntimeService';
import { logger } from '../logger';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { L10N_KEYS as I18N } from '../../i18n/keys';

const execFileAsync = promisify(execFile);
const GIT_SHOW_MAX_BUFFER = 32 * 1024 * 1024;

type CommitFileEntry = { path: string; status: string };

type PreparedCommitRagDocument = {
    commit_hash: string;
    parent_hashes: string[];
    committed_at: string;
    subject: string;
    body: string;
    message: string;
    files: Array<{ path: string; status: DiffStatus }>;
    file_summaries: FileSummary[];
    change_set_summary: ChangeSetSummary;
    retrieval_features: RetrievalFeatures;
    document_text: string;
    embedding_text: string;
};

type PendingGeneratedCommit = {
    commitMessage: string;
    diffs: DiffData[];
    fileSummaries: FileSummary[];
    changeSetSummary: ChangeSetSummary;
    retrievalFeatures: RetrievalFeatures;
    paths: string[];
    recordedAt: number;
};

const PENDING_GENERATED_TTL_MS = 30 * 60 * 1000;

function normalizePathSet(paths: string[]): string[] {
    return Array.from(new Set(paths.map(p => p.trim()).filter(Boolean))).sort();
}

function pathSetsEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.join('\0') === right.join('\0');
}

// Map a git --name-status short code (e.g. 'A', 'M', 'D', 'R100', 'C75', 'T', 'U')
// to the project's DiffStatus literal. DiffStatus only models a subset; codes outside
// that subset (C/T/U/X) collapse to 'modified', matching parseCommitNameStatus in diff.ts.
function mapGitStatus(raw: string): DiffStatus {
    const token = (raw || '').toUpperCase();
    if (token.startsWith('A')) { return 'added'; }
    if (token.startsWith('D')) { return 'deleted'; }
    if (token.startsWith('R')) { return 'renamed'; }
    return 'modified';
}

export class RagHistoricalIndexService {
    private static readonly COMMIT_PAGE_SIZE = 128;
    private static readonly UPSERT_BATCH_SIZE = 16;
    private readonly inFlight = new Map<string, { cancelled: boolean }>();
    private readonly pendingGenerated = new Map<string, PendingGeneratedCommit>();

    constructor(
        private readonly repoService: RepoService,
        private readonly ragRuntimeService: RagRuntimeService,
    ) { }

    private importedCommitCounter = 0;

    public async ensureRepositoryIndexed(repo: Repository, reason: string): Promise<void> {
        const repoPath = repo.rootUri.fsPath;
        this.importedCommitCounter = 0;
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

    public async repairRepositoryEmbeddings(repo: Repository): Promise<void> {
        const repoPath = repo.rootUri.fsPath;
        const repoLabel = this.repoService.getRepositoryLabel(repo) || repoPath;
        if (this.inFlight.has(repoPath)) {
            // Mirror the indexing-in-progress behavior so repair cannot race with import.
            void vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.indexingAlreadyRunning, repoLabel));
            return;
        }
        this.inFlight.set(repoPath, { cancelled: false });
        try {
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t(I18N.rag.statusEmbedding),
                cancellable: true,
            }, async (_progress, token) => {
                token.onCancellationRequested(() => this.cancelRepositoryIndexing(repoPath));
                return await this.ragRuntimeService.repairMissingEmbeddings(repo, {
                    isCancellationRequested: () => this.isCancellationRequested(repoPath),
                });
            });
            void vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.embeddingRepairCompleted, String(result.repaired)));
            logger.info(
                `[Genie][RAG] Repair embeddings command finished for ${repoPath}: repaired=${result.repaired}, remaining=${result.remaining}.`
            );
        } catch (error) {
            if (this.isCancellationError(error)) {
                logger.info(`[Genie][RAG] Repair embeddings cancelled for ${repoPath}.`);
                this.ragRuntimeService.updateRepositoryStatus(repoPath, 'idle', vscode.l10n.t(I18N.rag.statusIndexingCancelled));
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[Genie][RAG] Repair embeddings failed for ${repoPath}`, error as any);
            void vscode.window.showErrorMessage(vscode.l10n.t(I18N.rag.embeddingRepairFailed, message));
            throw error;
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
            paths: normalizePathSet(diffs.map(diff => diff.fileName)),
            recordedAt: Date.now(),
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
        const repoPath = repo.rootUri.fsPath;
        this.evictExpiredPending(repoPath);
        const pending = this.pendingGenerated.get(repoPath);
        const trimmedMessage = commit.message.trim();

        // Strongest match: exact commit message identity. Always honored.
        if (pending && pending.commitMessage === trimmedMessage) {
            this.pendingGenerated.delete(repoPath);
            logger.info(`[Genie][RAG] Using cached generated RAG context (message match) for committed HEAD ${commit.hash} in ${repoPath}.`);
            return this.buildPendingDocument(commit, pending);
        }

        const startedAt = Date.now();
        const files = await this.loadCommitFiles(repo, commit.hash);
        this.importedCommitCounter += 1;
        if (this.importedCommitCounter % 100 === 0) {
            logger.info(`[Genie][RAG] Imported ${this.importedCommitCounter} commits so far for ${repoPath}; last git show took ${Date.now() - startedAt}ms.`);
        }

        // Fallback match: same file-path set within TTL — survives user edits to the message.
        if (pending && files) {
            const commitPaths = normalizePathSet(files.map(file => file.path));
            const withinTtl = Date.now() - pending.recordedAt < PENDING_GENERATED_TTL_MS;
            if (withinTtl && pathSetsEqual(commitPaths, pending.paths)) {
                this.pendingGenerated.delete(repoPath);
                logger.info(`[Genie][RAG] Using cached generated RAG context (paths match) for committed HEAD ${commit.hash} in ${repoPath}.`);
                return this.buildPendingDocument(commit, pending);
            }
        }

        return this.buildHistoricalDocumentFromMessage(commit, files);
    }

    private evictExpiredPending(repoPath: string): void {
        const pending = this.pendingGenerated.get(repoPath);
        if (pending && Date.now() - pending.recordedAt >= PENDING_GENERATED_TTL_MS) {
            this.pendingGenerated.delete(repoPath);
        }
    }

    private async loadCommitFiles(repo: Repository, hash: string): Promise<CommitFileEntry[] | null> {
        // Use NUL-separated output to safely handle paths with whitespace/newlines.
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['show', '--name-status', '-z', '--format=', hash],
                { cwd: repo.rootUri.fsPath, maxBuffer: GIT_SHOW_MAX_BUFFER }
            );
            return this.parseNameStatusZ(stdout);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[Genie][RAG] git show failed for commit ${hash} in ${repo.rootUri.fsPath}: ${message}. Falling back to message-only feature extraction.`);
            return null;
        }
    }

    private parseNameStatusZ(stdout: string): CommitFileEntry[] {
        // git show --name-status -z emits records as: STATUS\0PATH\0 (or for renames/copies: Rxxx\0OLD\0NEW\0)
        // The leading --format= keeps the message empty, so the buffer starts with the first status token.
        const tokens = stdout.split('\0').filter(token => token.length > 0);
        const files: CommitFileEntry[] = [];
        let i = 0;
        while (i < tokens.length) {
            const status = tokens[i];
            // Status tokens are short (1-4 chars) like A/M/D/R100/C75/T. Anything longer is likely a path leak.
            if (!/^[A-Z][0-9]{0,3}$/.test(status)) {
                i += 1;
                continue;
            }
            const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
            if (isRenameOrCopy) {
                const newPath = tokens[i + 2];
                if (newPath) {
                    files.push({ path: newPath, status });
                }
                i += 3;
            } else {
                const filePath = tokens[i + 1];
                if (filePath) {
                    files.push({ path: filePath, status });
                }
                i += 2;
            }
        }
        return files;
    }

    private buildPendingDocument(commit: Commit, pending: PendingGeneratedCommit): PreparedCommitRagDocument {
        const message = commit.message.trim();
        const [subject, ...bodyLines] = message.split('\n');
        const body = bodyLines.join('\n').trim();
        const subjectText = (subject || message).trim();
        return {
            commit_hash: commit.hash,
            parent_hashes: [...(commit.parents || [])],
            committed_at: (commit.commitDate || commit.authorDate || new Date()).toISOString(),
            subject: subjectText,
            body,
            message,
            files: pending.diffs.map(diff => ({ path: diff.fileName, status: diff.status })),
            file_summaries: pending.fileSummaries,
            change_set_summary: pending.changeSetSummary,
            retrieval_features: pending.retrievalFeatures,
            document_text: this.buildDocumentText(message, pending.changeSetSummary, pending.retrievalFeatures),
            embedding_text: this.buildEmbeddingText(subjectText, pending.changeSetSummary.text, body),
        };
    }

    private buildHistoricalDocumentFromMessage(commit: Commit, files: CommitFileEntry[] | null): PreparedCommitRagDocument {
        const message = commit.message.trim();
        const [subject, ...bodyLines] = message.split('\n');
        const body = bodyLines.join('\n').trim();
        const parsed = this.parseCommitMessage(message);
        const fileFeatures = this.deriveFileFeatures(files || []);

        const changeSetSummary: ChangeSetSummary = {
            text: [parsed.summary, body].filter(Boolean).join('\n\n').trim() || subject.trim(),
            dominantType: parsed.type,
            dominantScope: parsed.scope ?? null,
            areas: this.dedupeJoin(fileFeatures.areas, parsed.scope ? [parsed.scope] : []),
            fileKinds: fileFeatures.fileKinds,
            changeActions: parsed.type ? [parsed.type] : [],
            entities: parsed.entities,
        };
        const retrievalFeatures: RetrievalFeatures = {
            predictedType: parsed.type,
            predictedScope: parsed.scope ?? null,
            areas: this.dedupeJoin(fileFeatures.areas, parsed.scope ? [parsed.scope] : []),
            fileKinds: fileFeatures.fileKinds,
            changeActions: parsed.type ? [parsed.type] : [],
            entities: parsed.entities,
            touchedPaths: fileFeatures.touchedPaths,
            fileExtensions: fileFeatures.fileExtensions,
            statusMix: fileFeatures.statusMix,
            fileCount: fileFeatures.fileCount,
            hasDocs: fileFeatures.hasDocs,
            hasTests: fileFeatures.hasTests,
            hasConfig: fileFeatures.hasConfig,
            hasRenames: fileFeatures.hasRenames,
            isCrossLayer: fileFeatures.isCrossLayer,
            breakingLike: parsed.breaking,
        };

        const subjectText = (subject || message).trim();
        return {
            commit_hash: commit.hash,
            parent_hashes: [...(commit.parents || [])],
            committed_at: (commit.commitDate || commit.authorDate || new Date()).toISOString(),
            subject: subjectText,
            body,
            message,
            files: (files || []).map(file => ({ path: file.path, status: this.mapGitStatus(file.status) })),
            file_summaries: [],
            change_set_summary: changeSetSummary,
            retrieval_features: retrievalFeatures,
            document_text: this.buildDocumentText(message, changeSetSummary, retrievalFeatures),
            embedding_text: this.buildEmbeddingText(subjectText, changeSetSummary.text, body),
        };
    }

    private buildEmbeddingText(subject: string, summary: string, body: string): string {
        // Embedding input keeps only natural-language signal so the vector
        // is not dominated by structured tags (Type/Scope/Areas/...).
        const parts: string[] = [];
        const seen = new Set<string>();
        for (const part of [subject, summary, body]) {
            const trimmed = (part || '').trim();
            if (!trimmed || seen.has(trimmed)) {
                continue;
            }
            seen.add(trimmed);
            parts.push(trimmed);
        }
        return parts.join('\n\n');
    }

    private dedupeJoin(...lists: string[][]): string[] {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const list of lists) {
            for (const item of list) {
                const value = (item || '').trim();
                if (!value || seen.has(value)) {
                    continue;
                }
                seen.add(value);
                out.push(value);
            }
        }
        return out;
    }

    private mapGitStatus(raw: string): DiffStatus {
        return mapGitStatus(raw);
    }

    private deriveFileFeatures(files: CommitFileEntry[]): {
        touchedPaths: string[];
        fileExtensions: string[];
        fileKinds: string[];
        fileCount: number;
        statusMix: DiffStatus[];
        hasRenames: boolean;
        hasDocs: boolean;
        hasTests: boolean;
        hasConfig: boolean;
        isCrossLayer: boolean;
        areas: string[];
    } {
        if (!files.length) {
            return {
                touchedPaths: [], fileExtensions: [], fileKinds: [], fileCount: 0,
                statusMix: [], hasRenames: false, hasDocs: false, hasTests: false,
                hasConfig: false, isCrossLayer: false, areas: [],
            };
        }

        const touchedPaths: string[] = [];
        const extensions = new Set<string>();
        const fileKinds = new Set<string>();
        const statusSet = new Set<DiffStatus>();
        const areaSet = new Set<string>();
        let hasRenames = false;
        let hasDocs = false;
        let hasTests = false;
        let hasConfig = false;
        let hasFrontend = false;
        let hasNonFrontend = false;

        const docsPathRe = /(^|\/)(docs?|documentation|README|CHANGELOG)/i;
        const docsExtRe = /\.(md|mdx|rst)$/i;
        const testsPathRe = /(^|\/)(tests?|__tests__|spec)\b/i;
        const testsFileRe = /\.(test|spec)\./i;
        const configFileRe = /(^|\/)(package\.json|tsconfig[^/]*\.json|[^/]+\.ya?ml|[^/]+\.toml|Dockerfile|\.eslintrc[^/]*|\.prettierrc[^/]*|vite\.config\.[^/]+|webpack\.config\.[^/]+|tailwind\.config\.[^/]+|\.gitignore|\.env[^/]*)$/i;
        const frontendRe = /(^|\/)(webview-ui|src\/ui|components|pages)\//;
        const nonFrontendRe = /(^|\/)(src\/services|src\/commands|src\/core|src\/utils)\//;

        for (const file of files) {
            const filePath = file.path;
            touchedPaths.push(filePath);
            const mappedStatus = mapGitStatus(file.status);
            statusSet.add(mappedStatus);
            if (mappedStatus === 'renamed') {
                hasRenames = true;
            }

            const lastSlash = filePath.lastIndexOf('/');
            const baseName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
            const dotIdx = baseName.lastIndexOf('.');
            if (dotIdx > 0 && dotIdx < baseName.length - 1) {
                const ext = baseName.slice(dotIdx + 1).toLowerCase();
                if (ext) {
                    extensions.add(ext);
                    fileKinds.add(ext);
                }
            }

            const isDocs = docsPathRe.test(filePath) || docsExtRe.test(filePath);
            const isTests = testsPathRe.test(filePath) || testsFileRe.test(filePath);
            const isConfig = configFileRe.test(filePath);
            if (isDocs) { hasDocs = true; fileKinds.add('docs'); }
            if (isTests) { hasTests = true; fileKinds.add('test'); }
            if (isConfig) { hasConfig = true; fileKinds.add('config'); }

            if (frontendRe.test(filePath)) { hasFrontend = true; }
            if (nonFrontendRe.test(filePath)) { hasNonFrontend = true; }

            const segments = filePath.split('/').filter(Boolean);
            const dirs = segments.slice(0, -1);
            if (dirs.length >= 2) {
                areaSet.add(`${dirs[0]}/${dirs[1]}`);
            } else if (dirs.length === 1) {
                areaSet.add(dirs[0]);
            } else if (segments.length === 1) {
                areaSet.add(segments[0]);
            }
        }

        const areas = Array.from(areaSet).slice(0, 8);
        return {
            touchedPaths,
            fileExtensions: Array.from(extensions),
            fileKinds: Array.from(fileKinds),
            fileCount: files.length,
            statusMix: Array.from(statusSet),
            hasRenames,
            hasDocs,
            hasTests,
            hasConfig,
            isCrossLayer: hasFrontend && hasNonFrontend,
            areas,
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
