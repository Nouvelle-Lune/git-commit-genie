import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { LogEntry, LogType } from '../types/messages';
import { vscodeApi } from '../utils/vscode';
import './LogSection.css';
import { GenieCheckIcon, GenieCloudIcon, GenieReadIcon, GenieReasonIcon, GenieToolIcon, GenieWarningIcon } from './icons';
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
    const [showNewLogsIndicator, setShowNewLogsIndicator] = useState<boolean>(false);
    const logListRef = useRef<HTMLDivElement>(null);
    const bottomSentinelRef = useRef<HTMLDivElement>(null);
    const isAutoScrollingRef = useRef<boolean>(false);
    const lastLogCountRef = useRef<number>(0);
    const userHasManuallyScrolledRef = useRef<boolean>(false);
    const hasMountedRef = useRef<boolean>(false);
    const lastScrollHeightRef = useRef<number>(0);

    const BOTTOM_THRESHOLD = 24; // px tolerance for bottom detection

    const startSmoothGuardUntilBottom = (el: HTMLDivElement) => {
        // Keep ignoring scroll events while smooth animation is in progress
        // Ends when we reach bottom or a timeout occurs
        const start = Date.now();
        const check = () => {
            const atBottom = (el.scrollHeight - el.clientHeight - el.scrollTop) <= BOTTOM_THRESHOLD;
            if (atBottom) {
                isAutoScrollingRef.current = false;
                return;
            }
            if (Date.now() - start > 1200) {
                // safety release
                isAutoScrollingRef.current = false;
                return;
            }
            requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
    };

    useLayoutEffect(() => {
        const el = logListRef.current;
        if (!el) return;

        const prevCount = lastLogCountRef.current;
        const currCount = state.logs.length;
        const hasNewItems = currCount > prevCount;

        if (autoScroll) {
            isAutoScrollingRef.current = true;
            // Prefer sentinel for accurate bottom pinning
            if (bottomSentinelRef.current) {
                bottomSentinelRef.current.scrollIntoView({ block: 'end', behavior: 'smooth' });
            } else {
                el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }
            // Hold guard while smooth animation is in progress
            startSmoothGuardUntilBottom(el);
            if (showNewLogsIndicator) setShowNewLogsIndicator(false);
        } else if (userHasManuallyScrolledRef.current && hasNewItems) {
            if (!showNewLogsIndicator) setShowNewLogsIndicator(true);
        }

        // Update count after handling
        lastLogCountRef.current = currCount;
        lastScrollHeightRef.current = el.scrollHeight;
    }, [state.logs, autoScroll, showNewLogsIndicator]);

    // mark that initial mount has occurred so we don't animate initial batch
    useEffect(() => {
        hasMountedRef.current = true;
    }, []);

    // Detect user scroll to toggle auto-scroll based on proximity to bottom
    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const element = e.currentTarget;

        // Ignore scroll events initiated by our own auto-scrolling
        if (isAutoScrollingRef.current) {
            return;
        }

        const isScrolledToBottom = (element.scrollHeight - element.clientHeight - element.scrollTop) <= BOTTOM_THRESHOLD;

        // Track if user has manually scrolled away from bottom
        userHasManuallyScrolledRef.current = !isScrolledToBottom;

        // Toggle auto-scroll based on position
        if (isScrolledToBottom) {
            setAutoScroll(true);
            setShowNewLogsIndicator(false);
        } else {
            setAutoScroll(false);
        }
    };

    // Scroll to bottom when clicking the indicator
    const scrollToBottom = () => {
        if (logListRef.current) {
            isAutoScrollingRef.current = true;
            // Smooth for user-initiated jump
            logListRef.current.scrollTo({ top: logListRef.current.scrollHeight, behavior: 'smooth' });
            // Hold guard while smooth animation is in progress
            startSmoothGuardUntilBottom(logListRef.current);
            setAutoScroll(true);
            setShowNewLogsIndicator(false);
            userHasManuallyScrolledRef.current = false;
        }
    };

    // While auto-scroll is enabled, keep pinned if scrollHeight grows (e.g., async content sizing)
    useEffect(() => {
        if (!autoScroll) return;
        const el = logListRef.current;
        if (!el) return;
        let rafId: number | null = null;
        const interval = window.setInterval(() => {
            if (!autoScroll) return; // extra guard inside interval
            const current = el.scrollHeight;
            if (current !== lastScrollHeightRef.current) {
                isAutoScrollingRef.current = true;
                el.scrollTo({ top: current, behavior: 'auto' });
                lastScrollHeightRef.current = current;
                // release guard next frame
                rafId = requestAnimationFrame(() => { isAutoScrollingRef.current = false; });
            }
        }, 150);
        return () => {
            window.clearInterval(interval);
            if (rafId) cancelAnimationFrame(rafId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoScroll]);

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

    const isCommitStageDone = (log: LogEntry) => {
        if (log.type !== LogType.ToolCall) return false;
        const title = (log.title || '').toLowerCase();
        return title.includes('commit stage:') && title.includes('done');
    };

    const isFailureLog = (log: LogEntry) => {
        if (isSchemaValidationLog(log)) return true;
        const t = (log.title || '').toLowerCase();
        const r = (log.reason || '').toLowerCase();
        return t.includes('error') || t.includes('failed') || t.includes('retry') || r.includes('error') || r.includes('failed') || r.includes('retry');
    };

    const isSuccessLog = (log: LogEntry) => {
        return log.type === LogType.FinalResult || isCommitStageDone(log);
    };

    const renderLogIcon = (log: LogEntry) => {
        if (isSchemaValidationLog(log)) {
            return <GenieWarningIcon size={14} />;
        }
        switch (log.type) {
            case LogType.FileRead:
                return <GenieReadIcon size={14} />;
            case LogType.ApiRequest:
                return <GenieCloudIcon size={14} />;
            case LogType.ToolCall:
                return isCommitStageDone(log) ? <GenieCheckIcon size={14} /> : <GenieToolIcon size={14} />;
            case LogType.AnalysisStart:
                // restore play button for started
                return <i className="codicon codicon-debug-start"></i>;
            case LogType.GenerationStart:
                // restore play button for started
                return <i className="codicon codicon-debug-start"></i>;
            case LogType.FinalResult:
                return <GenieCheckIcon size={14} />;
            case LogType.Reason:
                return <GenieReasonIcon size={14} />;
            default:
                return <GenieToolIcon size={14} />;
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

        // Prefer resolving from filePath
        let resolvedPath: string | undefined;
        if (log.filePath) {
            const fp = norm(log.filePath);
            let best: string | undefined;
            for (const r of repos) {
                const rp = norm(r.path);
                if (fp === rp || fp.startsWith(rp + '/')) {
                    if (!best || rp.length > best.length) { best = rp; }
                }
            }
            resolvedPath = best;
        }

        // Fallback to explicit repoPath when it maps to a known repo
        if (!resolvedPath && (log as any)?.repoPath) {
            const rp = norm((log as any).repoPath as string);
            const match = repos.find(rr => norm(rr.path) === rp);
            if (match) {
                resolvedPath = match.path;
            }
        }

        // If still unknown, bail
        if (!resolvedPath) { return null; }

        const r = repos.find(rr => norm(rr.path) === norm(resolvedPath!));
        const name = r?.name || resolvedPath.split('/').filter(Boolean).pop() || 'repo';
        // small hash for color index
        let h = 0; const str = resolvedPath;
        for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
        const colorIdx = h % 6; // 6 color variants
        return { name, colorIdx };
    };

    const getStageBadge = (log: LogEntry): { label: string; className: string } | null => {
        const type = log.type;

        // For ToolCall, extract specific stage from title or content
        if (type === LogType.ToolCall) {
            const title = log.title || '';

            // Commit generation stages
            if (title.includes('Commit stage:')) {
                const stage = title.replace('Commit stage:', '').trim().toLowerCase();
                if (stage.includes('summarize')) return { label: 'Sum', className: 'stage-badge-summarize' };
                if (stage.includes('classify')) return { label: 'Draft', className: 'stage-badge-classify' };
                if (stage.includes('validate')) return { label: 'Vld', className: 'stage-badge-validate' };
                if (stage.includes('strict')) return { label: 'Fix', className: 'stage-badge-strict' };
                if (stage.includes('enforce')) return { label: 'Lang', className: 'stage-badge-language' };
                if (stage.includes('done')) return { label: 'Done', className: 'stage-badge-done' };
                // Capitalize first letter for display
                return { label: stage.charAt(0).toUpperCase() + stage.slice(1), className: 'stage-badge-tool' };
            }

            // Schema validation
            if (title.includes('Schema validation')) {
                return { label: 'FAILED', className: 'stage-badge-validation' };
            }

            // Repository analysis tools
            if (title.includes('wants to read:')) return { label: 'Read', className: 'stage-badge-read' };
            if (title.includes('wants to search')) return { label: 'Search', className: 'stage-badge-search' };
            if (title.includes('wants to explore:')) return { label: 'Explore', className: 'stage-badge-explore' };
            if (title.includes('compressed context')) return { label: 'Analyze', className: 'stage-badge-analyze' };

            // Default for other tool calls
            return { label: 'Tool', className: 'stage-badge-tool' };
        }

        // For other types
        switch (type) {
            case LogType.FileRead:
                return { label: 'Read', className: 'stage-badge-read' };
            case LogType.ApiRequest:
                return { label: 'API', className: 'stage-badge-api' };
            case LogType.Reason:
                return { label: 'Think', className: 'stage-badge-reason' };
            case LogType.FinalResult:
                return { label: 'Result', className: 'stage-badge-result' };
            default:
                return null;
        }
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
                <div className="log-title">{state.i18n.logs}</div>
                <button className="log-clear-btn" onClick={handleClearLogs} title={state.i18n.clearLogs}>
                    <i className="codicon codicon-trash"></i>
                </button>
            </div>
            <div className="log-box">
                {state.logs.length === 0 ? (
                    <div className="log-empty">{state.i18n.noLogsYet}</div>
                ) : (
                    <>
                        <div className={`log-list ${autoScroll ? 'auto-scroll' : ''}`} ref={logListRef} onScroll={handleScroll}>
                            {state.logs.map((log: LogEntry, idx: number) => {
                                const isNew = hasMountedRef.current && idx >= lastLogCountRef.current;
                                const success = isSuccessLog(log);
                                const failure = isFailureLog(log);
                                return (
                                    <div key={log.id} className={`log-item ${(log.type === LogType.AnalysisStart || log.type === LogType.GenerationStart) ? 'log-divider' : ''} ${failure ? 'log-error' : ''} ${success ? 'log-success' : ''} ${isNew ? 'log-item-new' : ''}`}>
                                        {(log.type === LogType.AnalysisStart || log.type === LogType.GenerationStart) ? (
                                            <div className="analysis-start">
                                                <span className="log-icon">{renderLogIcon(log)}</span>
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
                                                    <span className="log-icon">{renderLogIcon(log)}</span>
                                                    <div className="log-main-content">
                                                        <span className="log-title-text">
                                                            {(() => { const info = getRepoInfoForLog(log); return info ? (<span className={`log-repo-badge repo-badge-c${info.colorIdx}`}>{info.name}</span>) : null; })()}
                                                            {(() => { const badge = getStageBadge(log); return badge ? (<span className={`stage-badge ${badge.className}`}>{badge.label}</span>) : null; })()}
                                                        </span>
                                                        {/* inline reason removed; reason is a separate log */}
                                                    </div>
                                                    <div className="log-trailing">
                                                        {log.cost !== undefined && log.cost > 0 && !log.cancelled && (
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
                                                            <span className="log-file-icon" title="Open file"><GenieReadIcon size={12} /></span>
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
                                );
                            })}
                            <div ref={bottomSentinelRef} />
                        </div>
                        {showNewLogsIndicator && (
                            <button className="new-logs-indicator" onClick={scrollToBottom} title="Scroll to latest logs">
                                <i className="codicon codicon-arrow-down"></i>
                                <span>New logs</span>
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
