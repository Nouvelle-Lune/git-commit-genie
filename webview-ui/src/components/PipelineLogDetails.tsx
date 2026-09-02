import React from 'react';
import { PipelineEventDetails, PipelineTextCatalog, CommitMessageSource } from '../../../src/ui/pipelineDisplay';
import './PipelineLogDetails.css';

export interface PipelineLogDetailsProps {
    details: PipelineEventDetails;
    text: PipelineTextCatalog;
}

function formatInteger(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

function SemanticTag({ value }: { value: string }) {
    return <span className="pipeline-details-tag">{value}</span>;
}

function CommitMessageBlock({ message }: { message: string }) {
    return (
        <pre className="pipeline-details-commit"><code>{message}</code></pre>
    );
}

function DetailSection({ title, children }: { title?: string; children: React.ReactNode }) {
    return (
        <section className="pipeline-details-section">
            {title ? <h4 className="pipeline-details-section-title">{title}</h4> : null}
            {children}
        </section>
    );
}

function DetailProse({ children }: { children: React.ReactNode }) {
    return <div className="pipeline-details-prose">{children}</div>;
}

function DetailMetrics({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
    const visible = items.filter(item => item.value !== undefined && item.value !== null && item.value !== '');
    if (!visible.length) {
        return null;
    }
    return (
        <dl className="pipeline-details-metrics">
            {visible.map(item => (
                <div key={item.label} className="pipeline-details-metric">
                    <dt className="pipeline-details-metric-label">{item.label}</dt>
                    <dd className="pipeline-details-metric-value">{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}

function DetailFields({ rows }: { rows: Array<{ label: string; value: React.ReactNode }> }) {
    const visible = rows.filter(row => row.value !== undefined && row.value !== null && row.value !== '');
    if (!visible.length) {
        return null;
    }
    return (
        <dl className="pipeline-details-fields">
            {visible.map(row => (
                <div key={row.label} className="pipeline-details-field">
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                </div>
            ))}
        </dl>
    );
}

function StringList({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
    if (!items.length) {
        return <span className="pipeline-details-empty">{emptyLabel}</span>;
    }
    return (
        <ul className="pipeline-details-list">
            {items.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
            ))}
        </ul>
    );
}

function sourceLabel(source: CommitMessageSource, text: PipelineTextCatalog): string {
    switch (source) {
        case 'draft':
            return text.sourceDraft;
        case 'validation':
            return text.sourceValidation;
        case 'strictFix':
            return text.sourceStrictFix;
        case 'languageEnforcement':
            return text.sourceLanguageEnforcement;
        case 'final':
            return text.sourceFinal;
    }
}

function renderDetails(details: PipelineEventDetails, text: PipelineTextCatalog): React.ReactNode {
    switch (details.kind) {
        case 'evidenceReady':
            return (
                <>
                    <DetailSection title={text.detailFiles}>
                        <StringList items={details.files.map(file => `${file.file} (${file.status})`)} emptyLabel={text.detailEmptyList} />
                    </DetailSection>
                    <DetailMetrics items={[
                        { label: text.metricFiles, value: String(details.fileCount) },
                        { label: text.metricRaw, value: String(details.rawFiles) },
                        { label: text.metricSummary, value: String(details.summarizedFiles) },
                        { label: text.metricInput, value: formatInteger(details.initialEstimatedInputTokens) },
                        { label: text.metricBudget, value: formatInteger(details.maxInputTokens) },
                        { label: text.metricContext, value: formatInteger(details.contextWindowTokens) },
                        { label: text.metricOutput, value: formatInteger(details.maxOutputTokens) },
                        { label: text.metricTrigger, value: formatInteger(details.compressionTriggerTokens) },
                        { label: text.detailHardInput, value: formatInteger(details.hardInputTokens) },
                        ...(details.safetyTokens !== undefined ? [{ label: text.detailSafetyTokens, value: formatInteger(details.safetyTokens) }] : []),
                    ]} />
                </>
            );
        case 'summarizeProgress':
            return (
                <DetailFields rows={[
                    { label: text.detailFile, value: details.file },
                    { label: text.detailSummary, value: <DetailProse>{details.summary}</DetailProse> },
                    { label: text.detailBreaking, value: details.breaking ? text.detailYes : text.detailNo },
                    { label: text.detailProgress, value: `${details.current}/${details.total}` },
                ]} />
            );
        case 'summarizeFailed':
            return (
                <DetailFields rows={[
                    { label: text.detailTarget, value: details.target },
                    { label: text.detailError, value: <span className="pipeline-details-warning">{details.error}</span> },
                ]} />
            );
        case 'evidenceRouted':
            return (
                <>
                    <DetailMetrics items={[
                        { label: text.detailTarget, value: details.target },
                        { label: text.metricRaw, value: String(details.rawFiles) },
                        { label: text.metricSummary, value: String(details.summarizedFiles) },
                        { label: text.metricInput, value: `${formatInteger(details.estimatedInputTokens)} / ${formatInteger(details.maxInputTokens)}` },
                        { label: text.detailDidSummarize, value: details.didSummarize ? text.detailYes : text.detailNo },
                        ...(details.forced !== undefined ? [{ label: text.detailForced, value: details.forced ? text.detailYes : text.detailNo }] : []),
                    ]} />
                </>
            );
        case 'changeExtracted':
            return (
                <>
                    <DetailSection title={text.detailSymbols}>
                        <StringList items={details.symbols} emptyLabel={text.detailEmptyList} />
                    </DetailSection>
                    <DetailMetrics items={[
                        { label: text.metricSymbols, value: String(details.symbolCount) },
                        { label: text.detailConfigs, value: String(details.configCount) },
                        { label: text.detailTypes, value: String(details.typeCount) },
                        { label: text.detailDependencies, value: String(details.dependencyCount) },
                    ]} />
                </>
            );
        case 'investigationPlanned':
            return (
                <>
                    <DetailSection title={text.detailInvestigationTargets}>
                        <StringList items={details.targets} emptyLabel={text.detailEmptyList} />
                    </DetailSection>
                    <DetailMetrics items={[
                        { label: text.metricTargets, value: String(details.targetCount) },
                        { label: text.detailQuestions, value: String(details.questionCount) },
                    ]} />
                </>
            );
        case 'investigationStart':
            return <DetailMetrics items={[{ label: text.detailMaxSteps, value: String(details.maxSteps) }]} />;
        case 'investigationStep':
            return (
                <DetailFields rows={[
                    { label: text.detailTool, value: <SemanticTag value={details.tool} /> },
                    { label: text.detailProgress, value: `${details.current}/${details.total}` },
                    { label: text.detailSuccess, value: details.ok ? text.detailYes : text.detailNo },
                    ...(details.reason ? [{ label: text.detailReason, value: details.reason }] : []),
                    ...(details.summary ? [{ label: text.detailSummary, value: <DetailProse>{details.summary}</DetailProse> }] : []),
                    ...(details.evidenceCount !== undefined ? [{ label: text.detailEvidence, value: String(details.evidenceCount) }] : []),
                ]} />
            );
        case 'investigationComplete':
            return (
                <>
                    <DetailMetrics items={[
                        { label: text.detailSteps, value: String(details.steps) },
                        { label: text.detailEvidence, value: String(details.evidenceCount) },
                        { label: text.detailFindings, value: String(details.findingCount) },
                        ...(details.unresolvedCount !== undefined ? [{ label: text.detailUnresolved, value: String(details.unresolvedCount) }] : []),
                    ]} />
                    <DetailFields rows={[{ label: text.detailReason, value: details.reason }]} />
                </>
            );
        case 'investigationSkipped':
            return <DetailFields rows={[{ label: text.detailReason, value: details.reason }]} />;
        case 'analysisDegraded':
            return (
                <DetailFields rows={[
                    { label: text.detailStatus, value: <SemanticTag value={details.status} /> },
                    { label: text.detailIssueCount, value: String(details.issueCount) },
                    { label: text.detailReason, value: <span className="pipeline-details-warning">{details.reason}</span> },
                ]} />
            );
        case 'contextCompacted':
            return (
                <DetailFields rows={[
                    { label: text.detailEpoch, value: String(details.epoch) },
                    { label: text.detailReason, value: details.reason },
                    ...(details.estimatedTokens !== undefined ? [{ label: text.metricInput, value: formatInteger(details.estimatedTokens) }] : []),
                ]} />
            );
        case 'semanticAnalysisComplete':
            return (
                <>
                    {details.primaryIntent ? (
                        <DetailSection title={text.detailPrimaryIntent}>
                            <DetailProse>{details.primaryIntent}</DetailProse>
                        </DetailSection>
                    ) : null}
                    {details.observableEffect ? (
                        <DetailSection title={text.detailObservableEffect}>
                            <DetailProse>{details.observableEffect}</DetailProse>
                        </DetailSection>
                    ) : null}
                    <DetailMetrics items={[
                        ...(details.recommendedType ? [{ label: text.detailRecommendedType, value: <SemanticTag value={details.recommendedType} /> }] : []),
                        ...(details.confidence ? [{ label: text.metricConfidence, value: <SemanticTag value={details.confidence} /> }] : []),
                        { label: text.detailFacts, value: String(details.factCount) },
                        { label: text.detailUncertainties, value: String(details.uncertaintyCount) },
                    ]} />
                </>
            );
        case 'informationSelected':
            return (
                <>
                    <DetailSection title={text.detailMustExpress}>
                        <StringList items={details.mustExpress} emptyLabel={text.detailEmptyList} />
                    </DetailSection>
                    <DetailSection title={text.detailOptional}>
                        <StringList items={details.optional} emptyLabel={text.detailEmptyList} />
                    </DetailSection>
                    <DetailMetrics items={[
                        { label: text.detailOmitted, value: String(details.omitCount) },
                        ...(details.suggestedScope ? [{ label: text.detailSuggestedScope, value: <SemanticTag value={details.suggestedScope} /> }] : []),
                        ...(details.recommendedType ? [{ label: text.detailRecommendedType, value: <SemanticTag value={details.recommendedType} /> }] : []),
                    ]} />
                </>
            );
        case 'ragPrepared':
            return (
                <>
                    <DetailSection title={text.detailMustExpress}>
                        <StringList items={details.mustExpress} emptyLabel={text.detailEmptyList} />
                    </DetailSection>
                    <DetailMetrics items={[
                        ...(details.type ? [{ label: text.metricType, value: <SemanticTag value={details.type} /> }] : []),
                        ...(details.scope ? [{ label: text.metricScope, value: <SemanticTag value={details.scope} /> }] : []),
                    ]} />
                    <DetailFields rows={[
                        { label: text.detailChangeSetSummary, value: details.changeSetSummary || text.detailEmptyList },
                    ]} />
                    <DetailSection title={text.detailRetrievalFeatures}>
                        <StringList items={details.retrievalFeatures} emptyLabel={text.detailEmptyList} />
                    </DetailSection>
                </>
            );
        case 'ragRetrieved':
            return (
                <>
                    <DetailMetrics items={[{ label: text.detailReferences, value: String(details.count) }]} />
                    <div className="pipeline-details-reference-list">
                        {details.references.map((reference, index) => (
                            <article key={`${reference.commitHash || reference.subject || index}`} className="pipeline-details-reference">
                                {reference.subject ? <div className="pipeline-details-reference-subject">{reference.subject}</div> : null}
                                <CommitMessageBlock message={reference.message} />
                                <DetailFields rows={[
                                    { label: text.detailStyleReason, value: reference.styleReason },
                                    { label: text.detailMatchedBy, value: <StringList items={reference.matchedBy} emptyLabel={text.detailEmptyList} /> },
                                ]} />
                            </article>
                        ))}
                    </div>
                </>
            );
        case 'ragRetrievalSkipped':
            return <DetailFields rows={[{ label: text.detailError, value: <span className="pipeline-details-warning">{details.error}</span> }]} />;
        case 'commitMessage':
            return (
                <>
                    <DetailMetrics items={[{ label: text.detailSource, value: <SemanticTag value={sourceLabel(details.source, text)} /> }]} />
                    <DetailSection title={text.detailCompleteCommitMessage}>
                        <CommitMessageBlock message={details.message} />
                    </DetailSection>
                </>
            );
        case 'strictFixStart':
            return (
                <DetailSection title={text.detailProblems}>
                    <StringList items={details.problems} emptyLabel={text.detailEmptyList} />
                </DetailSection>
            );
        case 'structuredValidation':
            return (
                <DetailFields rows={[
                    { label: text.detailStage, value: details.stage },
                    { label: text.detailStatus, value: <SemanticTag value={details.status === 'failed' ? text.stateFailed : text.stateRetrying} /> },
                    { label: text.detailFailureKind, value: <span className="pipeline-details-warning">{details.failureKind === 'missingOutput' ? text.detailMissingStructuredOutput : text.detailSchemaMismatch}</span> },
                    ...(details.attempt !== undefined ? [{ label: text.detailAttempt, value: String(details.attempt) }] : []),
                    ...(details.totalAttempts !== undefined ? [{ label: text.detailTotalAttempts, value: String(details.totalAttempts) }] : []),
                    ...(details.error ? [{ label: text.detailError, value: <span className="pipeline-details-warning">{details.error}</span> }] : []),
                ]} />
            );
    }
}

export const PipelineLogDetails: React.FC<PipelineLogDetailsProps> = ({ details, text }) => (
    <div className="pipeline-log-details">
        {renderDetails(details, text)}
    </div>
);
