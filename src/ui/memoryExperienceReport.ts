import type { ConsolidationGroup, GroupOutcome } from '../services/memory/consolidator';
import { HandbookEntry, InvestigationEpisode, entrySupports } from '../services/memory/types';
import { html, renderEntry, renderReportDocument, renderSupport, t } from './memoryReportDocument';

/** An explicit outcome selects only entries published by this recheck, never old history. */
export function formatRecheckGroupReport(group: ConsolidationGroup, handbook: readonly HandbookEntry[], episodes: readonly InvestigationEpisode[], outcome?: GroupOutcome): string {
    const ids = new Set(group.episodes.map(episode => episode.id));
    const previous = handbook.filter(entry => entrySupports(entry).some(support => ids.has(support.episodeId)));
    const current = outcome ? handbook.filter(entry => outcome.entryIds.includes(entry.id)) : previous;
    if (outcome && current.length !== outcome.entryIds.length) { throw new Error('A published recheck experience is missing from the report.'); }
    const heading = !outcome ? t('Saved investigation experience') : outcome.status === 'failed' ? t('Recheck failed')
        : outcome.issues.length ? t('Recheck partially updated experience') : outcome.status === 'no-findings' ? t('Recheck found no new experience') : t('Experience updated by this recheck');
    const summary = !outcome ? t('Preview of existing history; no recheck has run on this page.')
        : outcome.status === 'no-findings' ? t('No new experience was published. Previously saved experience was preserved.')
        : outcome.status === 'failed' ? t('No successful result is shown for this recheck. Previously saved experience is not a new result.')
        : t('Only experience published by this recheck is shown below.');
    const body = `<header class="hero"><h1>${html(group.title)}</h1><p>${t('Historical experience guides investigation; current source must be checked before drawing conclusions.')}</p></header>
        <main><h2>${heading}</h2><p class="section-copy">${summary}</p>
        ${outcome?.issues.length ? `<ul class="error">${outcome.issues.map(issue => `<li>${html(issue)}</li>`).join('')}</ul>` : ''}
        <div class="memory-list">${current.map(entry => renderEntry(entry, episodes)).join('')}</div>
        <section><h2>${t('Available investigation history')}</h2><p>${t('{0} historical records · {1} independent snapshots', group.observations.length, new Set(group.episodes.map(episode => episode.snapshot.id)).size)}</p>
        <details><summary>${t('Show historical observations')}</summary>${group.observations.map(item => renderSupport(item.support, episodes)).join('')}</details></section>
        </main>`;
    return renderReportDocument(t('Repository investigation experience'), body);
}
