import React from 'react';
import './QuickActions.css';

interface QuickActionsProps {
    onGenerateCommit: () => void;
    onAnalyzeRepo: () => void;
}

export const QuickActions: React.FC<QuickActionsProps> = ({
    onGenerateCommit,
    onAnalyzeRepo
}) => {
    return (
        <div className="section">
            <h3>Quick Actions</h3>
            <button className="action-button" onClick={onGenerateCommit}>
                <span className="codicon codicon-sparkle"></span>
                Generate Commit Message
            </button>
            <button className="action-button" onClick={onAnalyzeRepo}>
                <span className="codicon codicon-search"></span>
                Analyze Repository
            </button>
        </div>
    );
};
