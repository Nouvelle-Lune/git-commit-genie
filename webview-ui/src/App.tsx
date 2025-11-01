import React, { useEffect, useState } from 'react';
import { QuickActions } from './components/QuickActions';
import { Statistics } from './components/Statistics';
import { ThemeColor } from './components/ThemeColor';
import './App.css';

declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

interface Message {
    type: string;
    [key: string]: any;
}

interface I18nTexts {
    repositoryList: string;
    switchRepo: string;
    quickActions: string;
    generateCommit: string;
    analyzeRepo: string;
    statistics: string;
    todayLabel: string;
    totalLabel: string;
    themeColor: string;
}

export const App: React.FC = () => {
    const [repositories, setRepositories] = useState<Array<{ name: string; path: string; cost: number }>>([]);
    const [todayCount, setTodayCount] = useState<number>(0);
    const [totalCount, setTotalCount] = useState<number>(0);
    const [i18n, setI18n] = useState<I18nTexts>({
        repositoryList: 'Repository List',
        switchRepo: 'Switch Repository',
        quickActions: 'Quick Actions',
        generateCommit: 'Generate Commit Message',
        analyzeRepo: 'Analyze Repository',
        statistics: 'Statistics',
        todayLabel: 'Today:',
        totalLabel: 'Total:',
        themeColor: 'Theme Color'
    });

    useEffect(() => {
        // Handle messages from the extension
        const messageHandler = (event: MessageEvent<Message>) => {
            const message = event.data;
            switch (message.type) {
                case 'updateStats':
                    setTodayCount(message.todayCount);
                    setTotalCount(message.totalCount);
                    break;
                case 'updateRepo':
                    if (message.repositories) {
                        setRepositories(message.repositories);
                    }
                    if (message.i18n) {
                        setI18n(message.i18n);
                    }
                    break;
            }
        };

        window.addEventListener('message', messageHandler);

        // Request initial data
        vscode.postMessage({ type: 'ready' });

        return () => {
            window.removeEventListener('message', messageHandler);
        };
    }, []);

    const handleGenerateCommit = () => {
        vscode.postMessage({ type: 'generateCommit' });
    };

    const handleAnalyzeRepo = () => {
        vscode.postMessage({ type: 'analyzeRepo' });
    };

    const handleColorSelected = (color: string) => {
        vscode.postMessage({ type: 'colorSelected', value: color });
    };

    return (
        <div className="container">
            <h2>🧞 Git Commit Genie</h2>

            {repositories.length > 0 && (
                <div className="section repo-section">
                    <h3>{i18n.repositoryList}</h3>
                    <div className="repo-list">
                        {repositories.map((repo, index) => (
                            <div key={index} className="repo-item">
                                <span className="repo-name">{repo.name}</span>
                                <span className="repo-cost">${repo.cost.toFixed(4)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <QuickActions
                onGenerateCommit={handleGenerateCommit}
                onAnalyzeRepo={handleAnalyzeRepo}
                i18n={{
                    title: i18n.quickActions,
                    generateCommit: i18n.generateCommit,
                    analyzeRepo: i18n.analyzeRepo
                }}
            />

            <Statistics
                todayCount={todayCount}
                totalCount={totalCount}
                i18n={{
                    title: i18n.statistics,
                    todayLabel: i18n.todayLabel,
                    totalLabel: i18n.totalLabel
                }}
            />

            <ThemeColor
                onColorSelected={handleColorSelected}
                i18n={{
                    title: i18n.themeColor
                }}
            />
        </div>
    );
};
