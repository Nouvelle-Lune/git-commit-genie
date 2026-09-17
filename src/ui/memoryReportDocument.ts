import * as vscode from 'vscode';
import { HandbookEntry, InvestigationEpisode, MemorySupport } from '../services/memory/types';

/**
 * Shared rendering for read-only Repository Memory reports.
 *
 * Both the recheck report and the repository overview describe the same stored
 * history, so they must keep one vocabulary and one stylesheet: a reader who
 * learns how a record is displayed on one page must not have to relearn it on
 * the other. Reports stay script-free (the hosting webview disables scripts) and
 * limit disclosure to native <details> elements.
 */

/** Escape one value for interpolation into element text or a quoted attribute. */
export function html(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

/** Localize and escape in one step so translated copy can never inject markup. */
export const t = (value: string, ...args: Array<string | number>) => html(vscode.l10n.t(value, ...args));

/**
 * Localized record timestamps. The formatter is built once per report because a
 * store can hold thousands of records and each construction re-resolves locale
 * data.
 */
export function createMemoryDateFormatter(): (createdAt: number) => string {
    const formatter = new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'short' });
    return createdAt => formatter.format(new Date(createdAt));
}

/** Element and layout rules both reports rely on. Page-specific rules are appended by the caller. */
const CORE_CSS = `
        * { box-sizing: border-box; }
        body { max-width: 980px; margin: 0 auto; padding: 32px 28px 64px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.6; }
        h1, h2, h3, h4, p { margin-top: 0; }
        h1 { margin-bottom: 10px; font-size: clamp(24px, 4vw, 38px); line-height: 1.18; overflow-wrap: anywhere; }
        h2 { margin: 0 0 8px; font-size: 22px; }
        h3 { margin-bottom: 10px; font-size: 16px; }
        h4 { margin-bottom: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .06em; }
        code, pre { font-family: var(--vscode-editor-font-family); }
        .hero { padding: 4px 0 28px; border-bottom: 1px solid var(--vscode-panel-border); }
        .section-copy { color: var(--vscode-descriptionForeground); max-width: 760px; }
        section { padding-top: 32px; }
        .memory-list { display: grid; gap: 18px; margin-top: 18px; }
        .memory-card { padding: 20px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 10px; }
        details > summary { cursor: pointer; }
        details > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
        .support-section { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); }
        .support-section > summary { color: var(--vscode-textLink-foreground); font-weight: 650; }
        .experience-item { margin: 18px 0; padding: 16px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
        .retirement { border-color: var(--vscode-notificationsWarningIcon-foreground); }
        .situation { font-size: 18px; } .error { color: var(--vscode-errorForeground); }
        code, pre, p { overflow-wrap: anywhere; }
        pre { max-height: 420px; margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
        dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin-bottom: 0; font-size: 12px; }
        dt { font-weight: 650; }
        dd { margin: 0; overflow-wrap: anywhere; }
        .evidence-record { position: relative; padding: 12px 0; }
        .evidence-record + .evidence-record { border-top: 1px solid var(--vscode-panel-border); }
        .evidence-record > summary { overflow-wrap: anywhere; padding: 8px 0; }
        .evidence-source { text-transform: none; letter-spacing: normal; font-family: var(--vscode-editor-font-family); }
        .evidence-body { margin: 12px 0 0 34px; }
        @media (max-width: 620px) {
            body { padding: 24px 16px 48px; }
            dl { grid-template-columns: 1fr; }
        }`;

/**
 * Wrap report content in the shared document shell. The Content-Security-Policy
 * denies every resource except inline styles, so a report can never load remote
 * or local content on behalf of the stored history.
 *
 * `escapedTitle` is inserted into <title> verbatim, so callers must pass the
 * output of `t(...)` or `html(...)`: a repository label comes from a directory
 * name and is not trusted markup. `body` and `pageCss` are pre-built HTML/CSS.
 */
export function renderReportDocument(escapedTitle: string, body: string, pageCss = ''): string {
    return `<!DOCTYPE html><html lang="${html(vscode.env.language)}"><head><meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapedTitle}</title><style>${CORE_CSS}${pageCss}
        </style></head><body>${body}</body></html>`;
}

/**
 * Localized verdict for one recorded conclusion. Exhaustive on purpose: a new
 * stored disposition must break the build rather than be rendered as a raw enum
 * value or silently fall back to another verdict. Both reports label conclusions
 * through this function so they cannot drift apart.
 */
export function dispositionLabel(disposition: InvestigationEpisode['claims'][number]['disposition']): string {
    switch (disposition) {
        case 'must_express': return t('Must express');
        case 'optional': return t('Optional');
        case 'omit': return t('Omitted');
    }
}

/** Render saved observations, including failures without source code, without claiming current evidence. */
export function renderSupport(support: MemorySupport, episodes: readonly InvestigationEpisode[]): string {
    const episode = episodes.find(item => item.id === support.episodeId);
    const observation = episode?.observations[support.observationIndex];
    if (!episode || !observation) { throw new Error('Memory report references a missing historical observation.'); }
    const evidence = observation.evidence.filter(item => !support.evidenceId || item.id === support.evidenceId);
    if (support.evidenceId && !evidence.length) { throw new Error('Memory report references missing source evidence.'); }
    const used = episode.claims.filter(claim => evidence.some(item => claim.evidenceRefs.includes(item.id)));
    return `<details class="evidence-record"><summary>${html(observation.tool)} · ${t('Recorded step {0}', observation.step)} · ${html(episode.status)}</summary>
        <div class="evidence-body"><p>${html(observation.summary)}</p>
        ${support.questionIndex !== undefined ? `<h4>${t('Recorded investigation question')}</h4><p>${html(episode.questions[support.questionIndex])}</p>` : ''}
        ${support.claimIndex !== undefined ? `<h4>${t('Associated historical finding')}</h4><p>${html(episode.claims[support.claimIndex].claim)}</p>` : ''}
        <dl><dt>${t('Tool execution')}</dt><dd>${observation.ok ? t('Completed tool call') : t('Failed tool call')}</dd>
        <dt>${t('Truncated result')}</dt><dd>${observation.truncated ? t('Yes') : t('No')}</dd>
        <dt>${t('Repository snapshot')}</dt><dd><code>${html(episode.snapshot.id)}</code></dd>
        <dt>${t('Recorded arguments')}</dt><dd><pre>${html(JSON.stringify(observation.arguments, null, 2))}</pre></dd></dl>
        ${observation.error ? `<p class="error">${html(observation.error)}</p>` : ''}
        ${evidence.length ? evidence.map(item => `<h4 class="evidence-source">${html(item.source.path)}:${item.source.startLine}–${item.source.endLine} · ${item.source.side === 'before' ? t('Recorded before the change') : t('Recorded after the change')}</h4><pre><code>${html(item.source.excerpt)}</code></pre>`).join('') : `<p>${t('This historical observation returned no source code.')}</p>`}
        <h4>${t('Used by historical claims, not proof of correctness')}</h4>
        ${used.length ? `<ul>${used.map(claim => `<li>${html(claim.claim)} · ${dispositionLabel(claim.disposition)}</li>`).join('')}</ul>` : `<p>${t('No recorded claim used this source.')}</p>`}
        </div></details>`;
}

export function renderSupports(supports: MemorySupport[], episodes: readonly InvestigationEpisode[]): string {
    const snapshots = new Set(supports.map(support => {
        const episode = episodes.find(item => item.id === support.episodeId);
        if (!episode) { throw new Error('Memory support episode is unavailable.'); }
        return episode.snapshot.id;
    }));
    return `<details class="support-section"><summary>${t('{0} historical records · {1} independent snapshots', supports.length, snapshots.size)}</summary>
        ${supports.map(support => renderSupport(support, episodes)).join('')}</details>`;
}

/** One long-term memory. Every step and lesson keeps its own recorded provenance. */
export function renderEntry(entry: HandbookEntry, episodes: readonly InvestigationEpisode[]): string {
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
