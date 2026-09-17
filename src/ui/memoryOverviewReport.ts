import type { MemoryView } from '../services/memory/store';
import type { InvestigationEpisode } from '../services/memory/types';
import { isEligibleEpisode } from '../services/memory/recorder';
import { createMemoryDateFormatter, dispositionLabel, html, renderEntry, renderReportDocument, renderSupport, t } from './memoryReportDocument';

/**
 * Read-only overview of everything one repository has stored.
 *
 * The page answers three questions a JSON dump cannot: what long-term memories
 * exist, which saved records back them, and why a given record has not become a
 * long-term memory yet. It shows stored history only; nothing here is presented
 * as the current state of the repository.
 */

export interface MemoryOverviewContext {
    repositoryLabel: string;
    repositoryRoot: string;
    storageDirectory: string;
    repositoryId: string;
}

const PAGE_CSS = `
        .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 18px; }
        .metric { padding: 18px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
        .metric strong { display: block; margin-bottom: 4px; font-size: 28px; line-height: 1; }
        .metric span { display: block; margin-bottom: 7px; font-weight: 650; }
        .metric p { margin: 0; color: var(--vscode-descriptionForeground); }
        .count-note { margin-top: 12px; padding-left: 14px; border-left: 3px solid var(--vscode-focusBorder); color: var(--vscode-descriptionForeground); }
        .empty-state { margin-top: 18px; padding: 16px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
        .empty-state p { margin: 0; color: var(--vscode-descriptionForeground); }
        .empty-state p + p { margin-top: 8px; }
        .record-list { margin-top: 18px; padding-left: 20px; }
        .record { position: relative; padding: 10px 0; }
        .record + .record { border-top: 1px solid var(--vscode-panel-border); }
        /* The rail is drawn per record so it can stop at the first and last dot
           instead of hanging past the entries it belongs to. */
        .record::after { content: ''; position: absolute; left: -22px; top: 0; bottom: 0; width: 2px; background: var(--vscode-gitDecoration-modifiedResourceForeground); }
        .record:first-child::after { top: 24px; }
        .record:last-child::after { bottom: auto; height: 24px; }
        .record::before { content: ''; position: absolute; left: -26px; top: 20px; width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); box-shadow: 0 0 0 4px var(--vscode-editor-background); }
        .record.status-complete::before { background: var(--vscode-gitDecoration-addedResourceForeground); }
        .record.status-partial::before { background: var(--vscode-gitDecoration-modifiedResourceForeground); }
        .record.status-failed::before { background: var(--vscode-errorForeground); }
        /* A grid summary loses the native disclosure marker, and display:list-item
           shifts every row off the rail, so the marker is its own grid cell. */
        .record > summary { display: block; padding: 6px 0; }
        .record-row { display: grid; grid-template-columns: max-content max-content minmax(0, 1fr); gap: 3px 10px; align-items: baseline; }
        .record-row::before { content: '▶'; color: var(--vscode-descriptionForeground); font-size: 9px; }
        details[open] > summary .record-row::before { content: '▼'; }
        .record-time { color: var(--vscode-descriptionForeground); white-space: nowrap; font-variant-numeric: tabular-nums; }
        .record-tags { display: flex; flex-wrap: wrap; gap: 6px; }
        .record-paths { grid-column: 3; color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
        .record-body { margin-top: 14px; }
        .record-body h4 { margin-top: 18px; }
        .tag { display: inline-flex; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
        .tag-muted { color: var(--vscode-descriptionForeground); }
        .tag.status-complete { color: var(--vscode-gitDecoration-addedResourceForeground); }
        .tag.status-partial { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
        .tag.status-inactive { color: var(--vscode-descriptionForeground); }
        .tag.status-failed { color: var(--vscode-errorForeground); }
        .technical-details { margin-top: 32px; color: var(--vscode-descriptionForeground); }
        .technical-details > summary { font-size: 12px; }
        .technical-details > dl { margin-top: 12px; }
        /* Narrow panels wrap the summary instead of holding the tag column, which
           would otherwise push the timestamp away from its marker. */
        @media (max-width: 620px) {
            .record-list { padding-left: 14px; }
            .record::before { left: -20px; }
            .record::after { left: -16px; }
            .record-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 10px; }
            .record-paths { flex-basis: 100%; }
        }`;

interface StatusReport {
    label: string;
    tone: 'complete' | 'partial' | 'inactive' | 'failed';
}

/** Plain-language status. A new stored status breaks this switch instead of being displayed raw. */
function statusReport(status: InvestigationEpisode['status']): StatusReport {
    switch (status) {
        case 'complete': return { label: t('Complete'), tone: 'complete' };
        case 'complete_diff_only': return { label: t('Diff only'), tone: 'complete' };
        case 'degraded': return { label: t('Partially degraded'), tone: 'partial' };
        case 'unavailable': return { label: t('Unavailable'), tone: 'inactive' };
        case 'cancelled': return { label: t('Cancelled'), tone: 'inactive' };
        case 'error': return { label: t('Failed'), tone: 'failed' };
    }
}

interface CategoryReport {
    tag: string;
    explanation: string;
}

/**
 * Why a record is not (yet) something the repository remembers. The distinction
 * matters to a reader: an unorganized record is simply waiting, while an
 * ineligible one can never become long-term memory because the investigation
 * left no usable observation.
 */
function categoryReport(episode: InvestigationEpisode, referenced: ReadonlySet<string>, organized: ReadonlySet<string>): CategoryReport {
    if (referenced.has(episode.id)) {
        return { tag: t('Used by long-term memory'), explanation: t('A long-term memory cites a record from this investigation.') };
    }
    if (organized.has(episode.id)) {
        return { tag: t('Organized with no conclusion'), explanation: t('Memory organized this investigation but kept no conclusion from it.') };
    }
    if (!isEligibleEpisode(episode)) {
        return { tag: t('Diagnostic only'), explanation: t('The investigation did not finish with usable observations, so it cannot become long-term memory.') };
    }
    return { tag: t('Waiting to be organized'), explanation: t('This investigation has not been organized yet.') };
}

function renderChangedPaths(paths: readonly string[]): string {
    if (!paths.length) { return `<span class="record-paths">${t('No change paths were recorded.')}</span>`; }
    const shown = paths.slice(0, 2).map(value => html(value)).join(', ');
    const rest = paths.length > 2 ? ` ${t('and {0} more files', paths.length - 2)}` : '';
    return `<span class="record-paths">${shown}${rest}</span>`;
}

function renderRecord(episode: InvestigationEpisode, episodes: readonly InvestigationEpisode[], referenced: ReadonlySet<string>, organized: ReadonlySet<string>, formatDate: (createdAt: number) => string): string {
    const status = statusReport(episode.status);
    const category = categoryReport(episode, referenced, organized);
    const observations = episode.observations.length
        ? episode.observations.map((_, observationIndex) => renderSupport({ episodeId: episode.id, observationIndex }, episodes)).join('')
        : `<p class="section-copy">${t('No observation was recorded for this investigation.')}</p>`;
    return `<details class="record status-${status.tone}"><summary>
        <span class="record-row"><span class="record-time">${html(formatDate(episode.createdAt))}</span>
        <span class="record-tags"><span class="tag status-${status.tone}">${status.label}</span><span class="tag tag-muted" title="${category.explanation}">${category.tag}</span></span>
        ${renderChangedPaths(episode.changedPaths)}</span></summary>
        <div class="record-body"><dl>
        <dt>${t('Record ID')}</dt><dd><code>${html(episode.id)}</code></dd>
        <dt>${t('Investigation status')}</dt><dd><code>${html(episode.status)}</code></dd>
        <dt>${t('Repository snapshot')}</dt><dd><code>${html(episode.snapshot.id)}</code></dd>
        <dt>${t('Recorded by model')}</dt><dd>${html(episode.model)}</dd>
        <dt>${t('Record protocol')}</dt><dd><code>${html(episode.promptVersion)}</code> · <code>${html(episode.toolsetVersion)}</code></dd>
        <dt>${t('Changed paths')}</dt><dd>${episode.changedPaths.length ? episode.changedPaths.map(value => `<code>${html(value)}</code>`).join(' ') : t('None')}</dd>
        </dl>
        ${episode.questions.length ? `<h4>${t('Investigation questions')}</h4><ol>${episode.questions.map(question => `<li>${html(question)}</li>`).join('')}</ol>` : ''}
        ${episode.claims.length ? `<h4>${t('Recorded conclusions')}</h4><ul>${episode.claims.map(claim =>
            `<li>${html(claim.claim)} <span class="tag tag-muted">${dispositionLabel(claim.disposition)}</span></li>`).join('')}</ul>` : ''}
        <h4>${t('Recorded observations')}</h4>${observations}</div></details>`;
}

function renderMetrics(view: MemoryView, formatDate: (createdAt: number) => string): string {
    const snapshotCount = new Set(view.episodes.map(episode => episode.snapshot.id)).size;
    const retired = view.handbook.filter(entry => entry.retirement).length;
    const referenced = new Set(view.representedSupports.map(support => support.episodeId));
    const unrepresented = view.episodes.filter(episode => !referenced.has(episode.id)).length;
    const newest = Math.max(...view.episodes.map(episode => episode.createdAt));
    return `<section><h2>${t('What is saved')}</h2><div class="metrics">
        <article class="metric"><strong>${view.handbook.length}</strong><span>${t('Long-term memory')}</span><p>${retired ? t('{0} retired', retired) : t('All are still in use')}</p></article>
        <article class="metric"><strong>${view.episodes.length}</strong><span>${t('Investigation records')}</span><p>${t('From {0} repository versions', snapshotCount)}</p></article>
        </div>
        ${unrepresented ? `<p class="count-note">${t('{0} records have no long-term memory yet.', unrepresented)} ${t('Newest record saved {0}.', formatDate(newest))}</p>` : `<p class="count-note">${t('Newest record saved {0}.', formatDate(newest))}</p>`}</section>`;
}

/** Build the complete read-only overview page for one repository. */
export function formatMemoryOverviewReport(view: MemoryView, context: MemoryOverviewContext): string {
    const formatDate = createMemoryDateFormatter();
    const referenced = new Set(view.representedSupports.map(support => support.episodeId));
    const organized = new Set(view.organizedSeeds);
    const records = [...view.episodes].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    // An empty store gets one explanation instead of two empty sections, which
    // would otherwise both say that nothing has been stored yet.
    const stored = records.length ? `${renderMetrics(view, formatDate)}
        <section><h2>${t('Long-term memory')}</h2>
        ${view.handbook.length
            ? `<p class="section-copy">${t('These long-term memories may be recalled when related files or topics appear.')}</p><div class="memory-list">${view.handbook.map(entry => renderEntry(entry, view.episodes)).join('')}</div>`
            : `<div class="empty-state"><p>${t('No long-term memory has been created for this repository yet.')}</p>
                <p>${t('Memory organizes saved records after several related investigations, while the editor is idle. Organization can also be started from the Memory menu.')}</p></div>`}</section>
        <section><h2>${t('Investigation records')}</h2>
        <p class="section-copy">${t('All {0} records, newest first. Each one is what an investigation saved at that moment; its excerpts come from the repository as it was then.', records.length)}</p>
        <div class="record-list">${records.map(episode => renderRecord(episode, view.episodes, referenced, organized, formatDate)).join('')}</div></section>`
        : `<div class="empty-state"><p>${t('No memory is saved for this repository yet.')}</p>
            <p>${t('While Repository Memory is enabled, every commit-message investigation saves a record. Records that finish with usable observations can later become long-term memory.')}</p></div>`;
    const body = `<header class="hero"><h1>${html(context.repositoryLabel)}</h1>
        <p>${t('These are records saved by earlier investigations, not the current repository. Check current source before relying on any conclusion.')}</p></header>
        <main>${stored}
        <details class="technical-details"><summary>${t('Technical information')}</summary><dl>
        <dt>${t('Repository ID')}</dt><dd><code>${html(context.repositoryId)}</code></dd>
        <dt>${t('Repository path')}</dt><dd><code>${html(context.repositoryRoot)}</code></dd>
        <dt>${t('Memory storage')}</dt><dd><code>${html(context.storageDirectory)}</code></dd>
        <dt>${t('Deletion epoch')}</dt><dd><code>${html(view.epoch)}</code></dd>
        <dt>${t('Published generation')}</dt><dd>${view.generation}</dd>
        <dt>${t('Organized batches')}</dt><dd>${view.consolidated.length}</dd>
        <dt>${t('Organized investigations')}</dt><dd>${view.organizedSeeds.length}</dd>
        <dt>${t('Records cited by long-term memory')}</dt><dd>${referenced.size}</dd>
        </dl><p class="section-copy">${t('This page is read-only. Records and long-term memories change only through Memory operations in the editor.')}</p></details>
        </main>`;
    return renderReportDocument(t('Repository Memory: {0}', context.repositoryLabel), body, PAGE_CSS);
}
