import React from 'react';
import { LogEntry } from '../types/messages';
import { deriveLatestPipelineSnapshot, formatPipelineText, PipelineTextCatalog } from '../../../src/ui/pipelineDisplay';
import './PipelineFlow.css';

interface PipelineFlowProps {
    logs: LogEntry[];
    repositoryName?: string;
    text: PipelineTextCatalog;
}

function formatTokens(value: number): string {
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
    }
    return String(Math.round(value));
}

export const PipelineFlow: React.FC<PipelineFlowProps> = ({ logs, repositoryName, text }) => {
    const snapshot = deriveLatestPipelineSnapshot(logs, text);
    if (!snapshot) {
        return null;
    }

    const stateLabel = snapshot.state === 'ready'
        ? text.stateReady
        : snapshot.state === 'degraded'
            ? text.stateDegraded
            : text.stateRunning;
    const handoff = snapshot.latestHandoff;
    const contextName = repositoryName
        || snapshot.repoPath?.replace(/\\/g, '/').split('/').filter(Boolean).pop()
        || text.currentRepository;
    const tokenRatio = handoff
        ? Math.min(100, Math.round((handoff.estimatedInputTokens / handoff.maxInputTokens) * 100))
        : undefined;

    return (
        <section className={`pipeline-flow pipeline-flow-${snapshot.state}`} aria-live="polite">
            <div className="pipeline-flow-header">
                <div>
                    <div className="pipeline-flow-eyebrow">{text.flowTitle}</div>
                    <div className="pipeline-flow-context">
                        {contextName}
                    </div>
                </div>
                <span className={`pipeline-flow-state pipeline-flow-state-${snapshot.state}`}>
                    {snapshot.state === 'running' && <span className="codicon codicon-circle-filled" />}
                    {snapshot.state === 'ready' && <span className="codicon codicon-check" />}
                    {snapshot.state === 'degraded' && <span className="codicon codicon-warning" />}
                    {stateLabel}
                </span>
            </div>

            <ol className="pipeline-steps" aria-label={text.stagesLabel}>
                {snapshot.steps.map((step, index) => (
                    <li key={step.id} className={`pipeline-step pipeline-step-${step.state}`}>
                        <span className="pipeline-step-node" aria-hidden="true">
                            {step.state === 'complete' && <span className="codicon codicon-check" />}
                            {step.state === 'warning' && <span className="codicon codicon-warning" />}
                            {step.state === 'skipped' && <span className="codicon codicon-remove" />}
                            {step.state === 'active' && <span className="pipeline-step-active-dot" />}
                        </span>
                        <span className="pipeline-step-label">{step.label}</span>
                        {index < snapshot.steps.length - 1 && <span className="pipeline-step-link" aria-hidden="true" />}
                    </li>
                ))}
            </ol>

            <div className="pipeline-current">
                <div className={`pipeline-current-marker pipeline-current-marker-${snapshot.latest.tone}`} />
                <div className="pipeline-current-copy">
                    <div className="pipeline-current-phase">{snapshot.latest.phase}</div>
                    <div className="pipeline-current-title">{snapshot.latest.title}</div>
                </div>
            </div>

            {(handoff || snapshot.referenceCount !== undefined) && (
                <div className="pipeline-payload-compact">
                    {handoff && (
                        <>
                            <span className="pipeline-payload-target">
                                {handoff.target === 'draft' ? text.draftInput : text.ragInput}
                            </span>
                            <strong title={formatPipelineText(text.tokenUsage, tokenRatio!)}>
                                {formatTokens(handoff.estimatedInputTokens)}/{formatTokens(handoff.maxInputTokens)}
                            </strong>
                            <span className="pipeline-payload-separator">·</span>
                            <span>{text.metricRaw} {handoff.rawFiles}</span>
                            <span className="pipeline-payload-separator">·</span>
                            <span>{text.metricSummary} {handoff.summarizedFiles}</span>
                        </>
                    )}
                    {snapshot.referenceCount !== undefined && (
                        <>
                            {handoff && <span className="pipeline-payload-separator">·</span>}
                            <span>RAG {snapshot.referenceCount} {text.payloadRefs}</span>
                        </>
                    )}
                </div>
            )}
        </section>
    );
};
