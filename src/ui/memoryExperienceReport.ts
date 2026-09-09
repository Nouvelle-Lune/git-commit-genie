import * as vscode from 'vscode';
import type { ConsolidationGroup, GroupOutcome } from '../services/memory/consolidator';
import { HandbookEntry, InvestigationEpisode, MemorySupport, entrySupports } from '../services/memory/types';

function html(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
const t = (value: string, ...args: Array<string | number>) => html(vscode.l10n.t(value, ...args));

/** Render saved observations, including failures without source code, without claiming current evidence. */
function renderSupport(support: MemorySupport, episodes: readonly InvestigationEpisode[]): string {
    const episode = episodes.find(item => item.id === support.episodeId);
    const observation = episode?.observations[support.observationIndex];
    if (!episode || !observation) { throw new Error('Experience report references a missing historical observation.'); }
    const evidence = observation.evidence.filter(item => !support.evidenceId || item.id === support.evidenceId);
    if (support.evidenceId && !evidence.length) { throw new Error('Experience report references missing source evidence.'); }
    const used = episode.claims.filter(claim => evidence.some(item => claim.evidenceRefs.includes(item.id)));
    return `<details class="evidence-record"><summary>${html(observation.tool)} · ${t('Recorded step {0}', observation.step)} · ${html(episode.status)}</summary>
        <div class="evidence-body"><p>${html(observation.summary)}</p>
        ${support.questionIndex !== undefined ? `<h4>${t('Recorded investigation question')}</h4><p>${html(episode.questions[support.questionIndex])}</p>` : ''}
        ${support.claimIndex !== undefined ? `<h4>${t('Associated historical finding')}</h4><p>${html(episode.claims[support.claimIndex].claim)}</p>` : ''}
        <dl><dt>${t('Tool execution')}</dt><dd>${observation.ok ? t('Completed tool call') : t('Failed tool call')}</dd>
        <dt>${t('Truncated result')}</dt><dd>${html(String(observation.truncated))}</dd>
        <dt>${t('Repository snapshot')}</dt><dd><code>${html(episode.snapshot.id)}</code></dd>
        <dt>${t('Recorded arguments')}</dt><dd><pre>${html(JSON.stringify(observation.arguments, null, 2))}</pre></dd></dl>
        ${observation.error ? `<p class="error">${html(observation.error)}</p>` : ''}
        ${evidence.length ? evidence.map(item => `<h4>${html(item.source.path)}:${item.source.startLine}–${item.source.endLine} · ${html(item.source.side)}</h4><pre><code>${html(item.source.excerpt)}</code></pre>`).join('') : `<p>${t('This historical observation returned no source code.')}</p>`}
        <h4>${t('Used by historical claims, not proof of correctness')}</h4>
        ${used.length ? `<ul>${used.map(claim => `<li>${html(claim.claim)} · ${html(claim.disposition)}</li>`).join('')}</ul>` : `<p>${t('No recorded claim used this source.')}</p>`}
        </div></details>`;
}
function renderSupports(supports: MemorySupport[], episodes: readonly InvestigationEpisode[]): string {
    const snapshots = new Set(supports.map(support => {
        const episode = episodes.find(item => item.id === support.episodeId);
        if (!episode) { throw new Error('Experience support episode is unavailable.'); }
        return episode.snapshot.id;
    }));
    return `<details class="support-section"><summary>${t('{0} historical records · {1} independent snapshots', supports.length, snapshots.size)}</summary>
        ${supports.map(support => renderSupport(support, episodes)).join('')}</details>`;
}
function renderEntry(entry: HandbookEntry, episodes: readonly InvestigationEpisode[]): string {
    return `<article class="memory-card"><h3>${t('Applicable situation')}</h3><p class="situation">${html(entry.situation)}</p>
        ${entry.retirement ? `<section class="experience-item retirement"><h3>${t('Retired historical experience')}</h3>
            <p>${html(entry.retirement.reason)}</p>${entry.retirement.replacementEntryId
                ? `<p class="section-copy">${t('Replacement experience')}: <code>${html(entry.retirement.replacementEntryId)}</code></p>` : ''}
            ${renderSupports(entry.retirement.supports, episodes)}</section>` : ''}
        ${entry.steps.length ? `<h3>${t('Investigation route')}</h3><ol>${entry.steps.map(step => `<li class="experience-item">
            <code>${html(step.path)}${step.symbol ? ` → ${html(step.symbol)}` : ''}</code><p>${html(step.purpose)}</p>
            <p class="section-copy">${t('Historical tool')}: ${html(step.operation)}</p>${renderSupports(step.supports, episodes)}</li>`).join('')}</ol>` : ''}
        ${entry.lessons.length ? `<h3>${t('Historical lessons')}</h3>${entry.lessons.map(lesson => `<section class="experience-item">
            <h4>${t('Historical observation')}</h4><p>${html(lesson.observation)}</p><h4>${t('Implication for investigation')}</h4><p>${html(lesson.implication)}</p>
            <h4>${t('Limits of reuse')}</h4><p>${html(lesson.limitation)}</p>${renderSupports(lesson.supports, episodes)}</section>`).join('')}` : ''}</article>`;
}

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
    return `<!DOCTYPE html><html lang="${html(vscode.env.language)}"><head><meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${t('Repository investigation experience')}</title><style>

        * { box-sizing: border-box; }
        body { max-width: 980px; margin: 0 auto; padding: 32px 28px 64px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.6; }
        h1, h2, h3, h4, p { margin-top: 0; }
        h1 { margin-bottom: 10px; font-size: clamp(24px, 4vw, 38px); line-height: 1.18; overflow-wrap: anywhere; }
        h2 { margin: 0 0 8px; font-size: 22px; }
        h3 { margin-bottom: 10px; font-size: 16px; }
        h4 { margin-bottom: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .06em; }
        code, pre { font-family: var(--vscode-editor-font-family); }
        .hero { padding: 4px 0 28px; border-bottom: 1px solid var(--vscode-panel-border); }
        .eyebrow { display: inline-block; margin-bottom: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
        .hero-copy, .section-copy { color: var(--vscode-descriptionForeground); max-width: 760px; }
        section { padding-top: 32px; }
        .memory-list { display: grid; gap: 18px; margin-top: 18px; }
        .memory-card { padding: 20px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 10px; }
        .memory-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 18px; }
        .memory-index { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
        .kind-tag, .version-tag, .trigger { display: inline-flex; align-items: center; border: 1px solid var(--vscode-badge-background); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
        .kind-tag { color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
        .conclusions { margin: 0; padding-left: 22px; font-size: 15px; }
        .conclusions li + li { margin-top: 8px; }
        .recall-context { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
        .recall-context > span { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600; }
        .triggers { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .trigger { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
        details > summary { cursor: pointer; }
        details > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
        .support-section { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); }
        .support-section > summary { color: var(--vscode-textLink-foreground); font-weight: 650; }
        .support-intro { margin: 14px 0; color: var(--vscode-descriptionForeground); }
        .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 18px; }
        .metric { padding: 18px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
        .metric strong { display: block; margin-bottom: 4px; font-size: 28px; line-height: 1; }
        .metric span { display: block; margin-bottom: 7px; font-weight: 650; }
        .metric p { margin: 0; color: var(--vscode-descriptionForeground); }
        .count-note { margin-top: 12px; padding-left: 14px; border-left: 3px solid var(--vscode-focusBorder); color: var(--vscode-descriptionForeground); }
        .evidence-thread { position: relative; padding-left: 20px; border-left: 2px solid var(--vscode-gitDecoration-modifiedResourceForeground); }
        .evidence-record { position: relative; padding: 12px 0; }
        .evidence-record + .evidence-record { border-top: 1px solid var(--vscode-panel-border); }
        .evidence-record > summary { overflow-wrap: anywhere; padding: 8px 0; }
        .timeline-dot { position: absolute; left: -26px; top: 21px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-gitDecoration-modifiedResourceForeground); box-shadow: 0 0 0 4px var(--vscode-editor-background); }
        .evidence-number { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
        .evidence-summary { min-width: 0; }
        .evidence-summary strong, .evidence-summary span { display: block; }
        .evidence-summary strong { overflow-wrap: anywhere; }
        .evidence-summary span { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
        .version-tag { color: var(--vscode-descriptionForeground); white-space: nowrap; }
        .evidence-body { margin: 12px 0 0 34px; }
        pre { max-height: 420px; margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
        .warning, .missing-support { color: var(--vscode-notificationsWarningIcon-foreground); }
        .warning { margin: 8px 0 0; }
        .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
        .technical-details { margin-top: 12px; color: var(--vscode-descriptionForeground); }
        .technical-details > summary { font-size: 12px; }
        dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin-bottom: 0; font-size: 12px; }
        dt { font-weight: 650; }
        dd { margin: 0; overflow-wrap: anywhere; }
        .empty-state, .missing-support { padding: 16px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
        .empty-state p, .missing-support span { margin: 0; color: var(--vscode-descriptionForeground); }
        .missing-support strong, .missing-support span { display: block; }
        .all-evidence { margin-top: 18px; }
        .all-evidence > summary { font-weight: 650; }
        .all-evidence .evidence-thread { margin-top: 16px; }
        @media (max-width: 620px) {
            body { padding: 24px 16px 48px; }
            .evidence-record > summary { grid-template-columns: 24px minmax(0, 1fr); }
            .version-tag { grid-column: 2; justify-self: start; }
            dl { grid-template-columns: 1fr; }
        }
        .experience-item { margin: 18px 0; padding: 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
        .retirement { border-color: var(--vscode-notificationsWarningIcon-foreground); }
        .situation { font-size: 18px; } .error { color: var(--vscode-errorForeground); } code, pre, p { overflow-wrap: anywhere; }
        </style></head><body><header class="hero"><h1>${html(group.title)}</h1><p>${t('Historical experience guides investigation; current source must be checked before drawing conclusions.')}</p></header>
        <main><h2>${heading}</h2><p class="section-copy">${summary}</p>
        ${outcome?.issues.length ? `<ul class="error">${outcome.issues.map(issue => `<li>${html(issue)}</li>`).join('')}</ul>` : ''}
        <div class="memory-list">${current.map(entry => renderEntry(entry, episodes)).join('')}</div>
        <section><h2>${t('Available investigation history')}</h2><p>${t('{0} historical records · {1} independent snapshots', group.observations.length, new Set(group.episodes.map(episode => episode.snapshot.id)).size)}</p>
        <details><summary>${t('Show historical observations')}</summary>${group.observations.map(item => renderSupport(item.support, episodes)).join('')}</details></section>
        </main></body></html>`;
}
