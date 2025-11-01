import React, { useEffect, useState } from 'react';
import { RepoSection } from './components/RepoSection';
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

export const App: React.FC = () => {
    const [repoName, setRepoName] = useState<string>('');
    const [showSwitchButton, setShowSwitchButton] = useState<boolean>(false);
    const [todayCount, setTodayCount] = useState<number>(0);
    const [totalCount, setTotalCount] = useState<number>(0);

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
                    setRepoName(message.repoName);
                    setShowSwitchButton(message.showSwitchButton);
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

    const handleSwitchRepo = () => {
        vscode.postMessage({ type: 'switchRepo' });
    };

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

            {showSwitchButton && (
                <RepoSection
                    repoName={repoName}
                    onSwitchRepo={handleSwitchRepo}
                />
            )}

            <QuickActions
                onGenerateCommit={handleGenerateCommit}
                onAnalyzeRepo={handleAnalyzeRepo}
            />

            <Statistics
                todayCount={todayCount}
                totalCount={totalCount}
            />

            <ThemeColor onColorSelected={handleColorSelected} />
        </div>
    );
};
