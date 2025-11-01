import React from 'react';
import './RepoSection.css';

interface RepoSectionProps {
    repoName: string;
    showSwitchButton: boolean;
    onSwitchRepo: () => void;
    i18n: {
        currentRepo: string;
        switchRepo: string;
    };
}

export const RepoSection: React.FC<RepoSectionProps> = ({
    repoName,
    showSwitchButton,
    onSwitchRepo,
    i18n
}) => {
    return (
        <div className="section repo-section">
            <div className="repo-info">
                <div className="repo-label">{i18n.currentRepo}</div>
                <div className="repo-name">{repoName}</div>
            </div>
            {showSwitchButton && (
                <button
                    className="switch-repo-button"
                    onClick={onSwitchRepo}
                    title={i18n.switchRepo}
                >
                    <span className="codicon codicon-git-branch"></span>
                    {i18n.switchRepo}
                </button>
            )}
        </div>
    );
};
