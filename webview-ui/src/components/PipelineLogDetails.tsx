import React from 'react';
import {
    CommitMessageSource,
    PipelineEventDetails,
    PipelineTextCatalog,
    formatStructuredFieldIssue,
    structuredFailureKindLabel,
} from '../../../src/ui/pipelineDisplay';
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

/**
 * Split a commit message so the subject can be a section title and the body
 * can be prose, matching semantic-analysis cards. Only peel the heading when
 * it is literally the start of `message`; otherwise keep the full text as body
 * to avoid inventing a duplicate title.
 */
function splitCommitHeading(message: string, subject?: string): { heading: string; body: string } {
    const heading = (subject || message.split('\n')[0] || '').trim();
    if (heading && (message === heading || message.startsWith(`${heading}\n`))) {
        return {
            heading,
            body: message.slice(heading.length).replace(/^\n+/, ''),
        };
    }
    return { heading: '', body: message };
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
        case 'memoryStep':
            return (
                <DetailFields rows={[
                    { label: text.detailTool, value: <SemanticTag value={details.tool} /> },
                    ...(details.total !== undefined ? [{ label: text.detailProgress, value: `${details.current}/${details.total}` }] : []),
                    ...(details.kind === 'memoryStep' && details.trigger ? [
                        { label: text.metricTrigger, value: <SemanticTag value={details.trigger} /> },
                        { label: text.detailStatus, value: <SemanticTag value={details.status!} /> },
                    ] : []),
                    ...(details.kind === 'memoryStep' && details.attempt !== undefined ? [
                        { label: text.detailAttempt, value: String(details.attempt) },
                        { label: text.detailTotalAttempts, value: String(details.totalAttempts) },
                    ] : []),
                    { label: text.detailSuccess, value: details.ok ? text.detailYes : text.detailNo },
                    ...(details.reason ? [{ label: text.detailReason, value: details.reason }] : []),
                    ...(details.summary ? [{ label: text.detailSummary, value: <DetailProse>{details.summary}</DetailProse> }] : []),
                    ...(details.evidenceCount !== undefined ? [{ label: text.detailEvidence, value: String(details.evidenceCount) }] : []),
                    ...(details.kind === 'memoryStep' && details.issues?.length ? [
                        { label: text.detailFieldIssues, value: <StringList items={details.issues} emptyLabel={text.detailEmptyList} /> },
                    ] : []),
                    ...(details.kind === 'memoryStep' && details.sourceStatuses?.length
                        ? [{ label: text.detailStatus, value: details.sourceStatuses.map((status, index) => (
                            <React.Fragment key={`${status}-${index}`}>
                                {index > 0 ? ' ' : null}
                                <SemanticTag value={status} />
                            </React.Fragment>
                        )) }]
                        : []),
                ]} />
            );
        case 'investigationComplete':
            // Reported when repository lookups stop. Findings do not exist yet at
            // this point; they arrive with investigationResolved.
            return (
                <DetailMetrics items={[
                    { label: text.detailSteps, value: String(details.steps) },
                    { label: text.detailEvidence, value: String(details.evidenceCount) },
                ]} />
            );
        case 'investigationResolved':
            return (
                <>
                    <DetailMetrics items={[
                        { label: text.detailFindings, value: String(details.findingCount) },
                        { label: text.detailUnresolved, value: String(details.unresolvedCount) },
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
                    <div className="pipeline-details-reference-list">
                        {details.references.map((reference, index) => {
                            const { heading, body } = splitCommitHeading(reference.message, reference.subject);
                            return (
                                <article key={`${reference.commitHash || reference.subject || index}`} className="pipeline-details-reference">
                                    <DetailSection title={heading || undefined}>
                                        {body ? <DetailProse>{body}</DetailProse> : null}
                                    </DetailSection>
                                    <DetailFields rows={[
                                        { label: text.detailStyleReason, value: reference.styleReason },
                                        { label: text.detailMatchedBy, value: <StringList items={reference.matchedBy} emptyLabel={text.detailEmptyList} /> },
                                    ]} />
                                </article>
                            );
                        })}
                    </div>
                    <DetailMetrics items={[{ label: text.detailReferences, value: String(details.count) }]} />
                </>
            );
        case 'ragRetrievalSkipped':
            return <DetailFields rows={[{ label: text.detailError, value: <span className="pipeline-details-warning">{details.error}</span> }]} />;
        case 'commitMessage':
            return (
                <>
                    <DetailSection title={text.detailCompleteCommitMessage}>
                        <DetailProse>{details.message}</DetailProse>
                    </DetailSection>
                    <DetailMetrics items={[{ label: text.detailSource, value: <SemanticTag value={sourceLabel(details.source, text)} /> }]} />
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
                <>
                    <DetailFields rows={[
                        { label: text.detailStage, value: details.stage },
                        ...(details.profile ? [{ label: text.detailProfile, value: details.profile }] : []),
                        { label: text.detailStatus, value: <SemanticTag value={details.status === 'failed' ? text.stateFailed : text.stateRetrying} /> },
                        {
                            label: text.detailFailureKind,
                            value: (
                                <span className="pipeline-details-warning">
                                    {structuredFailureKindLabel(details.failureKind, text)}
                                </span>
                            ),
                        },
                        { label: text.detailAttempt, value: String(details.attempt) },
                        { label: text.detailTotalAttempts, value: String(details.totalAttempts) },
                        ...(details.error ? [{ label: text.detailError, value: <span className="pipeline-details-warning">{details.error}</span> }] : []),
                    ]} />
                    {details.fieldIssues.length ? (
                        <DetailSection title={text.detailFieldIssues}>
                            <StringList
                                items={details.fieldIssues.map(issue => formatStructuredFieldIssue(issue, text))}
                                emptyLabel={text.detailEmptyList}
                            />
                        </DetailSection>
                    ) : null}
                </>
            );
    }
}

export const PipelineLogDetails: React.FC<PipelineLogDetailsProps> = ({ details, text }) => (
    <div className="pipeline-log-details">
        {renderDetails(details, text)}
    </div>
);
