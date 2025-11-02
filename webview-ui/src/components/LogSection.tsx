import React, { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { LogEntry, LogType } from '../types/messages';
import { vscodeApi } from '../utils/vscode';
import './LogSection.css';
// @ts-ignore - react-markdown types
import ReactMarkdown from 'react-markdown';

/**
 * Log section component
 * Displays logs from repository analysis
 */
export const LogSection: React.FC = () => {
    const { state } = useAppContext();
    const [expandedLog, setExpandedLog] = useState<string | null>(null);
    const [autoScroll, setAutoScroll] = useState<boolean>(true);
    const logListRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when new logs are added
    useEffect(() => {
        if (autoScroll && logListRef.current) {
            logListRef.current.scrollTop = logListRef.current.scrollHeight;
        }
    }, [state.logs, autoScroll]);

    // Detect user scroll to disable auto-scroll
    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const element = e.currentTarget;
        const isScrolledToBottom = Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight) < 10;
        setAutoScroll(isScrolledToBottom);
    };

    const toggleExpand = (logId: string) => {
        setExpandedLog(expandedLog === logId ? null : logId);
    };

    const handleClearLogs = () => {
        vscodeApi.postMessage({ type: 'clearLogs' });
    };

    const handleFileClick = (filePath: string) => {
        vscodeApi.postMessage({ type: 'openFile', filePath });
    };

    const formatTime = (timestamp: number) => {
        const date = new Date(timestamp);
        return date.toLocaleTimeString();
    };

    const getLogIcon = (type: LogType) => {
        switch (type) {
            case LogType.FileRead:
                return 'file';
            case LogType.ApiRequest:
                return 'cloud';
            case LogType.ToolCall:
                return 'tools';
            case LogType.AnalysisStart:
                return 'debug-start';
            case LogType.FinalResult:
                return 'check';
            case LogType.Reason:
                return 'comment-discussion';
            default:
                return 'info';
        }
    };

    const isSchemaValidationLog = (log: LogEntry) => {
        const t = (log.title || '').toLowerCase();
        const r = (log.reason || '').toLowerCase();
        return log.type === LogType.ToolCall && (t.includes('schema validation') || r.includes('schema validation'));
    };

    const getRepoInfoForLog = (log: LogEntry): { name: string; colorIdx: number } | null => {
        const repos = state.repositories || [];
        const norm = (s: string) => s.replace(/\\/g, '/');
        let repoPath: string | undefined = (log as any).repoPath as any;
        if (!repoPath && log.filePath) {
            const fp = norm(log.filePath);
            // choose the longest matching repo path
            let best: string | undefined;
            for (const r of repos) {
                const rp = norm(r.path);
                if (fp === rp || fp.startsWith(rp + '/')) {
                    if (!best || rp.length > best.length) { best = rp; }
                }
            }
            repoPath = best;
        }
        if (!repoPath) { return null; }
        const r = repos.find(rr => norm(rr.path) === norm(repoPath!));
        const name = r?.name || repoPath.split('/').filter(Boolean).pop() || 'repo';
        // small hash for color index
        let h = 0; const str = repoPath;
        for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
        const colorIdx = h % 6; // 6 color variants
        return { name, colorIdx };
    };

    const formatFunctionCallContent = (content: string): string => {
        try {
            const data = JSON.parse(content);

            // Format as structured markdown
            let markdown = '';

            // For tool calls, show the arguments we're passing
            if (data.action === 'tool' && data.args) {
                markdown += `**Tool: ${data.toolName || 'unknown'}**\n\n`;
                if (data.reason) {
                    markdown += `**Reason:** ${data.reason}\n\n`;
                }
                markdown += `**Arguments:**\n`;
                Object.entries(data.args).forEach(([key, value]) => {
                    markdown += `- **${key}:** \`${String(value)}\`\n`;
                });
            } else if (data.final) {
                markdown += `**Final Result:**\n\n`;
                Object.entries(data.final).forEach(([key, value]) => {
                    if (typeof value === 'string') {
                        markdown += `**${key}:**\n${value}\n\n`;
                    } else if (Array.isArray(value)) {
                        markdown += `**${key}:**\n`;
                        value.forEach(item => {
                            markdown += `- ${String(item)}\n`;
                        });
                        markdown += '\n';
                    } else {
                        markdown += `**${key}:** ${JSON.stringify(value)}\n\n`;
                    }
                });
            } else {
                // Generic formatting for other structures
                markdown += '```json\n' + JSON.stringify(data, null, 2) + '\n```';
            }

            return markdown || content;
        } catch {
            return content;
        }
    };

    return (
        <div className="log-section">
            <div className="log-header-bar">
                <h3 className="log-title">Analysis Logs</h3>
                <button className="log-clear-btn codicon codicon-clear-all" onClick={handleClearLogs} title="Clear logs" />
            </div>
            <div className="log-box">
                {state.analysisRunning && (
                    <div className="running-banner" title={state.runningRepoLabel ? `Analyzing ${state.runningRepoLabel}…` : 'Repository analysis in progress…'}>
                        <span className="codicon codicon-sync codicon-modifier-spin"></span>
                        <span className="running-text">{state.runningRepoLabel ? `Analyzing ${state.runningRepoLabel}…` : 'Repository analysis in progress…'}</span>
                    </div>
                )}
                {state.logs.length === 0 ? (
                    <div className="log-empty">No analysis logs yet</div>
                ) : (
                    <div className="log-list" ref={logListRef} onScroll={handleScroll}>
                        {state.logs.map((log: LogEntry) => (
                            <div key={log.id} className={`log-item ${log.type === LogType.AnalysisStart ? 'log-divider' : ''} ${isSchemaValidationLog(log) ? 'log-error' : ''}`}>
                                {log.type === LogType.AnalysisStart ? (
                                    <div className="analysis-start">
                                        <span className={`codicon codicon-${getLogIcon(log.type)}`}></span>
                                        <span className="analysis-start-text">{log.title}</span>
                                        <span className="log-time">{formatTime(log.timestamp)}</span>
                                    </div>
                                ) : (
                                    <>
                                        <div
                                            className="log-header"
                                            onClick={() => {
                                                // Reason logs are not expandable
                                                if (log.type === LogType.Reason) { return; }
                                                // Allow expanding even when pending/cancelled if there is content
                                                if ((log.pending || log.cancelled) && !(log.content || log.fileContent)) { return; }
                                                
                                                // For file reads with content, allow expanding instead of opening
                                                if (log.type === LogType.FileRead && log.fileContent) {
                                                    toggleExpand(log.id);
                                                } else if (log.type === LogType.FileRead && log.filePath) {
                                                    handleFileClick(log.filePath);
                                                } else if (log.content) {
                                                    toggleExpand(log.id);
                                                }
                                            }}
                                            style={{ cursor: (log.type === LogType.Reason || ((log.pending || log.cancelled) && !(log.content || log.fileContent))) ? 'default' : 'pointer' }}
                                        >
                                            <span className={`codicon codicon-${isSchemaValidationLog(log) ? 'error' : getLogIcon(log.type)} log-icon`}></span>
                                            <div className="log-main-content">
                                                <span className="log-title-text">
                                                    {(() => { const info = getRepoInfoForLog(log); return info ? (<span className={`log-repo-badge repo-badge-c${info.colorIdx}`}>{info.name}</span>) : null; })()}
                                                    {log.title}
                                                </span>
                                                {/* inline reason removed; reason is a separate log */}
                                            </div>
                                            <div className="log-trailing">
                                                {log.cost !== undefined && log.cost > 0 && (
                                                    <span className="log-cost">${log.cost.toFixed(6)}</span>
                                                )}
                                                {log.pending === true ? (
                                                    <span className="log-loading">
                                                        <span className="codicon codicon-loading codicon-modifier-spin"></span>
                                                    </span>
                                                ) : log.cancelled ? (
                                                    <span className="log-cancelled">Cancelled</span>
                                                ) : null}
                                                {log.type === LogType.FileRead && log.filePath && !log.fileContent && (
                                                    <span className="codicon codicon-go-to-file log-file-icon" title="Open file"></span>
                                                )}
                                                {(log.content || log.fileContent) && log.type !== LogType.Reason && (
                                                    <span className={`codicon codicon-chevron-${expandedLog === log.id ? 'down' : 'right'} log-expand-icon`}></span>
                                                )}
                                            </div>
                                        </div>
                                        {/* Submeta: timestamp small under header (no icon) */}
                                        {!log.pending && (
                                            <div className="log-submeta">{formatTime(log.timestamp)}</div>
                                        )}
                                        {/* Reason inline content (no expand icon) */}
                                        {log.type === LogType.Reason && log.content && (
                                            <div className="log-reason-block">{log.content}</div>
                                        )}
                                        {(log.content || log.fileContent) && expandedLog === log.id && log.type !== LogType.Reason && (
                                            <div className="log-content">
                                                {log.fileContent ? (
                                                    <pre className="file-content-preview">
                                                        <code>{log.fileContent}</code>
                                                    </pre>
                                                ) : (
                                                    log.type === LogType.ToolCall ? (
                                                        <pre><code>{(() => { try { return JSON.stringify(JSON.parse(log.content!), null, 2); } catch { return String(log.content || ''); } })()}</code></pre>
                                                    ) : (
                                                        <ReactMarkdown>
                                                            {log.type === LogType.ApiRequest || log.type === LogType.FinalResult
                                                                ? formatFunctionCallContent(log.content!)
                                                                : log.content!
                                                            }
                                                        </ReactMarkdown>
                                                    )
                                                )}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
