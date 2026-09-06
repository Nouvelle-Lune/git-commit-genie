import React from 'react';
import { useAppContext } from '../context/AppContext';
import { vscodeApi } from '../utils/vscode';
import { formatCostDisplayShort } from '../types/messages';
import './RepoSection.css';

/**
 * Repository section component
 * Displays list of repositories with their costs and analysis status
 */
export const RepoSection: React.FC = () => {
    const { state } = useAppContext();

    if (state.repositories.length === 0) {
        return null;
    }

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
                                <span className="repo-name">
                                    {repo.name}
                                </span>
                                {getRagBadge(repo)}
                            </div>
                            <div className="repo-actions">
                                <span className="repo-cost">{formatCostDisplayShort(repo.cost, 4)}</span>
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
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
