import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import { ExtensionMessage, RepositoryInfo, I18nTexts } from '../types/messages';
import { vscodeApi } from '../utils/vscode';

// State Types
export interface AppState {
    repositories: RepositoryInfo[];
    i18n: I18nTexts;
}

// Action Types
type AppAction =
    | { type: 'SET_REPOSITORIES'; payload: { repositories: RepositoryInfo[]; i18n: I18nTexts } };

// Initial State
const initialState: AppState = {
    repositories: [],
    i18n: {
        repositoryList: 'Repository List'
    }
};

// Reducer
function appReducer(state: AppState, action: AppAction): AppState {
    switch (action.type) {
        case 'SET_REPOSITORIES':
            return {
                ...state,
                repositories: action.payload.repositories,
                i18n: action.payload.i18n
            };
        default:
            return state;
    }
}

// Context
interface AppContextType {
    state: AppState;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Provider
interface AppProviderProps {
    children: ReactNode;
}

export const AppProvider: React.FC<AppProviderProps> = ({ children }) => {
    const [state, dispatch] = useReducer(appReducer, initialState);

    useEffect(() => {
        const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
            const message = event.data;
            if (message.type === 'updateRepo') {
                dispatch({
                    type: 'SET_REPOSITORIES',
                    payload: {
                        repositories: message.repositories,
                        i18n: message.i18n
                    }
                });
            }
        };

        window.addEventListener('message', handleMessage);
        vscodeApi.postMessage({ type: 'ready' });

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, []);

    return (
        <AppContext.Provider value={{ state }}>
            {children}
        </AppContext.Provider>
    );
};

// Hook
export const useAppContext = (): AppContextType => {
    const context = useContext(AppContext);
    if (!context) {
        throw new Error('useAppContext must be used within AppProvider');
    }
    return context;
};
