import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import { ExtensionMessage, RepositoryInfo, I18nTexts, LogEntry } from '../types/messages';
import { vscodeApi } from '../utils/vscode';

// State Types
export interface AppState {
    repositories: RepositoryInfo[];
    i18n: I18nTexts;
    logs: LogEntry[];
}

// Action Types
type AppAction =
    | { type: 'SET_REPOSITORIES'; payload: { repositories: RepositoryInfo[]; i18n: I18nTexts } }
    | { type: 'ADD_LOG'; payload: LogEntry }
    | { type: 'UPDATE_LOG'; payload: LogEntry }
    | { type: 'CLEAR_LOGS' }
    | { type: 'CANCEL_PENDING_LOGS' };

// Initial State
const initialState: AppState = {
    repositories: [],
    i18n: {
        repositoryList: 'Repository List'
    },
    logs: []
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
        case 'ADD_LOG': {
            const next = [...state.logs, action.payload];
            const capped = next.length > 99 ? next.slice(next.length - 99) : next;
            return { ...state, logs: capped };
        }
        case 'UPDATE_LOG':
            // Check if log exists, if so update it, otherwise add it
            const existingIndex = state.logs.findIndex(log => log.id === action.payload.id);
            if (existingIndex >= 0) {
                const newLogs = [...state.logs];
                newLogs[existingIndex] = action.payload;
                return {
                    ...state,
                    logs: newLogs
                };
            } else {
                const next = [...state.logs, action.payload];
                const capped = next.length > 99 ? next.slice(next.length - 99) : next;
                return { ...state, logs: capped };
            }
        case 'CLEAR_LOGS':
            return {
                ...state,
                logs: []
            };
        case 'CANCEL_PENDING_LOGS':
            return {
                ...state,
                logs: state.logs.map(log => log.pending ? { ...log, pending: false, cancelled: true } : log)
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
            } else if (message.type === 'addLog') {
                dispatch({
                    type: 'UPDATE_LOG',
                    payload: message.log
                });
            } else if (message.type === 'clearLogs') {
                dispatch({
                    type: 'CLEAR_LOGS'
                });
            } else if (message.type === 'cancelPendingLogs') {
                dispatch({ type: 'CANCEL_PENDING_LOGS' });
            }
        };

        window.addEventListener('message', handleMessage);
        vscodeApi.postMessage({ type: 'ready' });

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, []); // Remove state.logs dependency to prevent infinite loop

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
