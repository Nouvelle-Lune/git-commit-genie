import React from 'react';
import { useAppContext } from '../context/AppContext';
import './RepoSection.css';

/**
 * Repository section component
 * Displays list of repositories with their costs
 */
export const RepoSection: React.FC = () => {
    const { state } = useAppContext();

    if (state.repositories.length === 0) {
        return null;
    }

    return (
        <div className="repo-section">
            <h3 className="repo-title">{state.i18n.repositoryList}</h3>
            <div className="repo-box">
                <div className="repo-list">
                    {state.repositories.map((repo, index) => (
                        <div key={index} className="repo-item">
                            <span className="repo-name">{repo.name}</span>
                            <span className="repo-cost">${repo.cost.toFixed(4)}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
