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
            <div className="repo-header">
                <h3 className="repo-title">{state.i18n.repositoryList}</h3>
                <button
                    className="menu-button"
                    onClick={handleOpenMenu}
                    aria-label={state.i18n.openSettings}
                    title={state.i18n.openSettings}
                >
                    <i className="codicon codicon-settings-gear"></i>
                </button>
            </div>
            <div className="repo-box">
                <div className="repo-list">
                    {state.repositories.map((repo, index) => (
                        <div key={index} className="repo-item">
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
                                {repo.analysisStatus === 'analyzing' ? (
                                    <button
                                        className="icon-button cancel-button"
                                        onClick={handleCancelAnalysis}
                                        aria-label={state.i18n.cancelAnalysis}
                                        title={state.i18n.cancelAnalysis}
                                    >
                                        <GenieKillIcon size={12} />
                                    </button>
                                ) : (
                                    <button
                                        className="icon-button"
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
