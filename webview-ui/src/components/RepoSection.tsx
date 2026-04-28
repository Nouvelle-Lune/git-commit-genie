import React from 'react';
import { useAppContext } from '../context/AppContext';
import { vscodeApi } from '../utils/vscode';
import './RepoSection.css';
import { GenieCheckIcon, GenieWarningIcon, GenieKillIcon } from './icons';

/**
 * Repository section component
 * Displays list of repositories with their costs and analysis status
 */
export const RepoSection: React.FC = () => {
    const { state } = useAppContext();

    if (state.repositories.length === 0) {
        return null;
    }

    // Check if any repository is currently being analyzed
    const isAnyRepoAnalyzing = state.repositories.some(repo => repo.analysisStatus === 'analyzing');

    const handleRefreshAnalysis = (repoPath: string) => {
        vscodeApi.postMessage({
            type: 'refreshAnalysis',
            repoPath
        });
    };

    const handleCancelAnalysis = () => {
        vscodeApi.postMessage({
            type: 'cancelAnalysis'
        });
    };

    const handleViewAnalysis = (analysisPath: string | undefined) => {
        if (analysisPath) {
            vscodeApi.postMessage({
                type: 'openFile',
                filePath: analysisPath
            });
        }
    };

    const handleOpenMenu = () => {
        vscodeApi.postMessage({
            type: 'openGenieMenu'
        });
    };

    const handleRepairEmbeddings = (repoPath: string) => {
        vscodeApi.postMessage({
            type: 'repairRagEmbeddings',
            repoPath
        });
    };

    const getStatusBadge = (status: 'missing' | 'analyzing' | 'idle') => {
        switch (status) {
            case 'analyzing':
                return (
                    <span className="status-badge status-analyzing" title={state.i18n.analysisStatusAnalyzing}>
                        <i className="codicon codicon-loading codicon-modifier-spin"></i>
                    </span>
                );
            case 'missing':
                return (
                    <span className="status-badge status-missing" title={state.i18n.analysisStatusMissing}>
                        <GenieWarningIcon size={12} />
                    </span>
                );
            case 'idle':
                return (
                    <span className="status-badge status-idle" title={state.i18n.analysisStatusIdle}>
                        <GenieCheckIcon size={12} />
                    </span>
                );
        }
    };

    const getRagBadge = (repo: typeof state.repositories[number]) => {
        if (!repo.ragStatus || repo.ragStatus.kind === 'disabled') {
            return null;
        }

        const detail = repo.ragStatus.detail || repo.ragStatus.text;
        const progressMatch = detail.match(/(\d+\s*\/\s*\d+)/);
        const progressText = progressMatch ? progressMatch[1].replace(/\s+/g, '') : null;

        let badgeContent: React.ReactNode = repo.ragStatus.text;
        let extraClass = '';

        switch (repo.ragStatus.kind) {
            case 'ready':
                badgeContent = <i className="codicon codicon-check"></i>;
                extraClass = ' rag-status-icon-only';
                break;
            case 'error':
                badgeContent = <i className="codicon codicon-error"></i>;
                extraClass = ' rag-status-icon-only';
                break;
            case 'preparing':
                badgeContent = <i className="codicon codicon-loading codicon-modifier-spin"></i>;
                extraClass = ' rag-status-icon-only';
                break;
            case 'embedding':
            case 'importing':
                badgeContent = progressText || <i className="codicon codicon-loading codicon-modifier-spin"></i>;
                if (!progressText) {
                    extraClass = ' rag-status-icon-only';
                }
                break;
            case 'idle':
                return null;
        }

        return (
            <span className="rag-tooltip-anchor" data-tooltip={detail}>
                <span
                    className={`rag-status-badge rag-status-${repo.ragStatus.kind}${extraClass}`}
                    aria-label={detail}
                >
                    {badgeContent}
                </span>
            </span>
        );
    };

    return (
        <div className="repo-section">
            <div className="section-header">
                <h3 className="section-title">{state.i18n.repositoryList}</h3>
                <button
                    className="icon-btn"
                    onClick={handleOpenMenu}
                    aria-label={state.i18n.openSettings}
                    title={state.i18n.openSettings}
                >
                    <i className="codicon codicon-settings-gear"></i>
                </button>
            </div>
            <div className="panel-box repo-panel">
                <div className="repo-list">
                    {state.repositories.map((repo) => (
                        <div key={repo.path} className="repo-item">
                            <div className="repo-info">
                                {getStatusBadge(repo.analysisStatus)}
                                <span
                                    className={`repo-name ${repo.analysisPath ? 'clickable' : ''}`}
                                    onClick={() => handleViewAnalysis(repo.analysisPath)}
                                    title={repo.analysisPath ? state.i18n.viewAnalysis : repo.name}
                                >
                                    {repo.name}
                                </span>
                                {getRagBadge(repo)}
                            </div>
                            <div className="repo-actions">
                                <span className="repo-cost">${repo.cost.toFixed(4)}</span>
                                {repo.ragStatus?.repairNeeded ? (
                                    <button
                                        className="icon-btn"
                                        onClick={() => handleRepairEmbeddings(repo.path)}
                                        aria-label={state.i18n.repairRagEmbeddings}
                                        title={state.i18n.repairRagEmbeddings}
                                    >
                                        <i className="codicon codicon-tools"></i>
                                    </button>
                                ) : null}
                                {repo.analysisStatus === 'analyzing' ? (
                                    <button
                                        className="icon-btn repo-cancel-btn"
                                        onClick={handleCancelAnalysis}
                                        aria-label={state.i18n.cancelAnalysis}
                                        title={state.i18n.cancelAnalysis}
                                    >
                                        <GenieKillIcon size={12} />
                                    </button>
                                ) : (
                                    <button
                                        className="icon-btn"
                                        onClick={() => handleRefreshAnalysis(repo.path)}
                                        aria-label={state.i18n.refreshAnalysis}
                                        title={state.i18n.refreshAnalysis}
                                        disabled={isAnyRepoAnalyzing}
                                    >
                                        <i className="codicon codicon-refresh"></i>
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
