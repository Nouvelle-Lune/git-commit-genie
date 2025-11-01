import React from 'react';
import './RepoSection.css';

interface RepoSectionProps {
    repoName: string;
    onSwitchRepo: () => void;
}

export const RepoSection: React.FC<RepoSectionProps> = ({ repoName, onSwitchRepo }) => {
    return (
        <div className="section repo-section">
            <div className="repo-info">
                <div className="repo-label">Current Repository</div>
                <div className="repo-name">{repoName}</div>
            </div>
            <button
                className="switch-repo-button"
                onClick={onSwitchRepo}
                title="Switch Repository"
            >
                <span className="codicon codicon-git-branch"></span>
                Switch Repository
            </button>
        </div>
    );
};
