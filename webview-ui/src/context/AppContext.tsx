import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import { ExtensionMessage, RepositoryInfo, I18nTexts, LogEntry } from '../types/messages';
import { vscodeApi } from '../utils/vscode';

// State Types
export interface AppState {
    repositories: RepositoryInfo[];
    i18n: I18nTexts;
    logs: LogEntry[];
    analysisRunning: boolean;
    runningRepoLabel?: string;
}

// Action Types
type AppAction =
    | { type: 'SET_REPOSITORIES'; payload: { repositories: RepositoryInfo[]; i18n: I18nTexts } }
    | { type: 'ADD_LOG'; payload: LogEntry }
    | { type: 'UPDATE_LOG'; payload: LogEntry }
    | { type: 'CLEAR_LOGS' }
    | { type: 'CANCEL_PENDING_LOGS' }
    | { type: 'SET_ANALYSIS_RUNNING'; payload: { running: boolean; label?: string } };

// Initial State
const initialState: AppState = {
    repositories: [],
    i18n: {
        repositoryList: 'Repository List'
    },
    logs: [],
    analysisRunning: false
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
                const prev = state.logs[existingIndex];
                // Merge to preserve cancellation state unless explicitly overridden
                const merged: LogEntry = {
                    ...prev,
                    ...action.payload,
                    cancelled: (action.payload as any).cancelled !== undefined ? (action.payload as any).cancelled : prev.cancelled
                } as LogEntry;
                newLogs[existingIndex] = merged;
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
        case 'SET_ANALYSIS_RUNNING':
            return {
                ...state,
                analysisRunning: action.payload.running,
                runningRepoLabel: action.payload.label
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
    // Keep a ref to the latest repositories to avoid stale closure issues
    const repositoriesRef = React.useRef<RepositoryInfo[]>([]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
            const message = event.data;
            const shouldIncludeLog = (log: LogEntry): boolean => {
                try {
                    const repos = repositoriesRef.current || [];
                    // If repositories are not loaded yet, skip including to avoid cross-workspace leakage
                    if (repos.length === 0) { return false; }
                    const norm = (s: string) => s.replace(/\\\\/g, '/');
                    if ((log as any).repoPath) {
                        const rp = norm((log as any).repoPath as string);
                        return repos.some(r => norm(r.path) === rp);
                    }
                    if (log.filePath) {
                        const fp = norm(log.filePath);
                        return repos.some(r => {
                            const rp = norm(r.path);
                            return fp.startsWith(rp + '/') || fp === rp;
                        });
                    }
                } catch { /* ignore */ }
                return false;
            };
            if (message.type === 'updateRepo') {
                // Update repositories ref first, then state
                repositoriesRef.current = message.repositories;
                dispatch({
                    type: 'SET_REPOSITORIES',
                    payload: {
                        repositories: message.repositories,
                        i18n: message.i18n
                    }
                });
                // Ask extension to flush logs after repositories are set to avoid cross-workspace leakage
                try { vscodeApi.postMessage({ type: 'requestFlushLogs' } as any); } catch { /* ignore */ }
            } else if (message.type === 'addLog') {
                if (shouldIncludeLog(message.log)) {
                    dispatch({
                        type: 'UPDATE_LOG',
                        payload: message.log
                    });
                }
            } else if (message.type === 'clearLogs') {
                dispatch({
                    type: 'CLEAR_LOGS'
                });
            } else if (message.type === 'cancelPendingLogs') {
                dispatch({ type: 'CANCEL_PENDING_LOGS' });
            } else if (message.type === 'analysisRunning') {
                const running = (message as any).running === true;
                const label = (message as any).repoLabel as string | undefined;
                dispatch({ type: 'SET_ANALYSIS_RUNNING', payload: { running, label } });
            }
        };

        window.addEventListener('message', handleMessage);
        vscodeApi.postMessage({ type: 'ready' });

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, []); // Intentional empty deps: use repositoriesRef to avoid stale state

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
