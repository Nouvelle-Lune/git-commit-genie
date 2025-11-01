import React from 'react';
import { AppProvider } from './context/AppContext';
import { RepoSection } from './components/RepoSection';
import './App.css';

/**
 * Main App component
 */
export const App: React.FC = () => {
    return (
        <AppProvider>
            <RepoSection />
        </AppProvider>
    );
};
