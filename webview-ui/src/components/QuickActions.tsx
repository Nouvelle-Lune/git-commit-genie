import React from 'react';
import './QuickActions.css';

interface QuickActionsProps {
    onGenerateCommit: () => void;
    onAnalyzeRepo: () => void;
    i18n: {
        title: string;
        generateCommit: string;
        analyzeRepo: string;
    };
}

export const QuickActions: React.FC<QuickActionsProps> = ({
    onGenerateCommit,
    onAnalyzeRepo,
    i18n
}) => {
    return (
        <div className="section">
            <h3>{i18n.title}</h3>
            <button className="action-button" onClick={onGenerateCommit}>
                <span className="codicon codicon-sparkle"></span>
                {i18n.generateCommit}
            </button>
            <button className="action-button" onClick={onAnalyzeRepo}>
                <span className="codicon codicon-search"></span>
                {i18n.analyzeRepo}
            </button>
        </div>
    );
};
