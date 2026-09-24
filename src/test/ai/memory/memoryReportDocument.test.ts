import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { HandbookEntry, InvestigationEpisode, MemorySupport } from '../../../services/memory/types';
import { createMemoryDateFormatter, html, renderEntry, renderReportDocument, renderSupport, renderSupports, t } from '../../../ui/memoryReportDocument';

const FIRST_EPISODE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_EPISODE_ID = '22222222-2222-4222-8222-222222222222';
const ENTRY_ID = '10000000-0000-4000-8000-000000000001';

describe('Memory report document rendering', () => {
    it('escapes stored values and localized copy before interpolation', () => {
        // Escaping covers every markup-significant character, and localized copy is escaped in the same step so translated text can never inject markup.
        assert.equal(html(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
        const localized = t('Repository Memory: {0}', '<script>alert("x")</script>');
        assert.match(localized, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
        assert.doesNotMatch(localized, /<script>/);
    });

    it('states a truncated tool result as a localized yes or no', () => {
        // The stored boolean is shown as Yes/No copy rather than a raw true/false value, in both directions.
        const truncated = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0 }, [makeEpisode({ observations: [makeObservation({ truncated: true })] })]);
        assert.match(truncated, /<dt>Truncated result<\/dt><dd>Yes<\/dd>/);
        assert.doesNotMatch(truncated, /<dt>Truncated result<\/dt><dd>(true|false)<\/dd>/);
        const complete = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0 }, [makeEpisode({ observations: [makeObservation({ truncated: false })] })]);
        assert.match(complete, /<dt>Truncated result<\/dt><dd>No<\/dd>/);
        assert.doesNotMatch(complete, /<dt>Truncated result<\/dt><dd>(true|false)<\/dd>/);
    });

    it('labels each source excerpt with its path, line range, and recorded side', () => {
        // Each excerpt heading names the recorded file and line range and says whether it was recorded before or after the change instead of printing the stored side enum.
        const episode = makeEpisode({ observations: [makeObservation({ evidence: [beforeEvidence(), afterEvidence()] })] });
        const report = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0 }, [episode]);
        assert.match(report, /<h4 class="evidence-source">src\/parser\.ts:10–12 · Recorded before the change<\/h4><pre><code>before excerpt<\/code><\/pre>/);
        assert.match(report, /<h4 class="evidence-source">src\/parser\.ts:20–22 · Recorded after the change<\/h4><pre><code>after excerpt<\/code><\/pre>/);
        assert.doesNotMatch(report, /<h4>src\/parser\.ts:10–12 · before<\/h4>/);
    });

    it('keeps the recorded question and finding a support was bound to', () => {
        // A support that names a question or claim still renders that recorded context next to the observation.
        const episode = makeEpisode({
            questions: ['Where is the parser entry point?', 'Which callers depend on it?'],
            claims: [{ claim: 'The parser is reached from the CLI.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        });
        const report = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0, questionIndex: 1, claimIndex: 0 }, [episode]);
        assert.match(report, /<h4>Recorded investigation question<\/h4><p>Which callers depend on it\?<\/p>/);
        assert.match(report, /<h4>Associated historical finding<\/h4><p>The parser is reached from the CLI\.<\/p>/);
        const withoutBinding = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0 }, [episode]);
        assert.doesNotMatch(withoutBinding, /Recorded investigation question/);
        assert.doesNotMatch(withoutBinding, /Associated historical finding/);
    });

    it('reports a failed tool call and its recorded error', () => {
        // A stored failure keeps its recorded error text and is never presented as a completed call.
        const failed = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0 },
            [makeEpisode({ observations: [makeObservation({ ok: false, error: 'tool failed' })] })]);
        assert.match(failed, /<dd>Failed tool call<\/dd>/);
        assert.match(failed, /<p class="error">tool failed<\/p>/);
        const completed = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0 }, [makeEpisode({})]);
        assert.match(completed, /<dd>Completed tool call<\/dd>/);
        assert.doesNotMatch(completed, /class="error"/);
    });

    it('states when a historical observation returned no source code', () => {
        // An observation saved without evidence is rendered as an explicit statement, not as an empty excerpt block.
        const report = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0 }, [makeEpisode({ observations: [makeObservation({ evidence: [] })] })]);

        assert.match(report, /<p>This historical observation returned no source code\.<\/p>/);
        assert.doesNotMatch(report, /<pre><code>/);
    });

    it('lists only the claims that used the cited evidence', () => {
        // The claims list is derived from the cited evidence, so unrelated claims are never attributed to this source.
        const episode = makeEpisode({
            observations: [makeObservation({ evidence: [beforeEvidence(), afterEvidence()] })],
            claims: [
                { claim: 'A claim citing the first evidence.', evidenceRefs: ['E1'], disposition: 'must_express' },
                { claim: 'A claim citing the second evidence.', evidenceRefs: ['E2'], disposition: 'optional' },
            ],
        });
        const cited = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0, evidenceId: 'E1' }, [episode]);
        assert.match(cited, /<li>A claim citing the first evidence\. · Must express<\/li>/);
        assert.doesNotMatch(cited, /A claim citing the second evidence\./);
        const uncited = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0, evidenceId: 'E2' },
            [makeEpisode({ observations: [makeObservation({ evidence: [beforeEvidence(), afterEvidence()] })] })]);
        assert.match(uncited, /<p>No recorded claim used this source\.<\/p>/);
    });

    it('labels every recorded conclusion verdict in the claim list', () => {
        // Each stored disposition is rendered as reader-facing copy rather than the raw enum, so the support list uses the same verdict vocabulary as the overview page.
        const episode = makeEpisode({
            claims: [
                { claim: 'The parser is reached from the CLI.', evidenceRefs: ['E1'], disposition: 'must_express' },
                { claim: 'The parser tolerates extra whitespace.', evidenceRefs: ['E1'], disposition: 'optional' },
                { claim: 'The parser rejects an empty file.', evidenceRefs: ['E1'], disposition: 'omit' },
            ],
        });

        const report = renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0 }, [episode]);

        assert.match(report, /<li>The parser is reached from the CLI\. · Must express<\/li>/);
        assert.match(report, /<li>The parser tolerates extra whitespace\. · Optional<\/li>/);
        assert.match(report, /<li>The parser rejects an empty file\. · Omitted<\/li>/);
        assert.doesNotMatch(report, /must_express/);
        assert.doesNotMatch(report, /· omit</);
        assert.doesNotMatch(report, /· optional</);
    });

    it('throws instead of rendering a support that points at missing history', () => {
        // A support that cannot be resolved is a broken report and must fail loudly rather than silently render partial provenance.
        const episode = makeEpisode({});
        assert.throws(
            () => renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 7 }, [episode]),
            /missing historical observation/,
        );
        assert.throws(
            () => renderSupport({ episodeId: '99999999-9999-4999-8999-999999999999', observationIndex: 0 }, [episode]),
            /missing historical observation/,
        );
        assert.throws(
            () => renderSupport({ episodeId: FIRST_EPISODE_ID, observationIndex: 0, evidenceId: 'E9' }, [episode]),
            /missing source evidence/,
        );
    });

    it('counts historical records and independent snapshots for a support group', () => {
        // The support summary reports the number of records and of independent snapshots they were recorded against.
        const supports: MemorySupport[] = [
            { episodeId: FIRST_EPISODE_ID, observationIndex: 0 },
            { episodeId: SECOND_EPISODE_ID, observationIndex: 0 },
            { episodeId: FIRST_EPISODE_ID, observationIndex: 1 },
        ];
        const report = renderSupports(supports, [
            makeEpisode({ id: FIRST_EPISODE_ID, snapshotId: digest('a'), observations: [makeObservation({}), makeObservation({})] }),
            makeEpisode({ id: SECOND_EPISODE_ID, snapshotId: digest('b') }),
        ]);

        assert.match(report, /<summary>3 historical records · 2 independent snapshots<\/summary>/);
        assert.equal((report.match(/<details class="evidence-record">/g) ?? []).length, 3);
        assert.throws(() => renderSupports([{ episodeId: '99999999-9999-4999-8999-999999999999', observationIndex: 0 }], []),
            /Memory support episode is unavailable/);
    });

    it('renders one long-term memory with its route, lessons, and per-item provenance', () => {
        // A stored experience is rendered as a card that keeps the applicable situation, the investigation route, the lessons, and the provenance of each item separate.
        const episodes = [makeEpisode({ id: FIRST_EPISODE_ID, snapshotId: digest('a') }), makeEpisode({ id: SECOND_EPISODE_ID, snapshotId: digest('b') })];
        const report = renderEntry(makeEntry({}), episodes);

        assert.match(report, /<article class="memory-card">/);
        assert.match(report, /<h3>Applicable situation<\/h3><p class="situation">Inspect the parser before changing its consumer\.<\/p>/);
        assert.match(report, /<h3>Investigation route<\/h3><ol>/);
        assert.match(report, /<code>src\/parser\.ts → parse\(\)<\/code>/);
        assert.match(report, /<p class="section-copy">Historical tool: readFileContent<\/p>/);
        assert.match(report, /<h3>Historical lessons<\/h3>/);
        assert.match(report, /<h4>Historical observation<\/h4><p>Recorded parser behaviour\.<\/p>/);
        assert.match(report, /<h4>Implication for investigation<\/h4><p>Start at the parser entry point\.<\/p>/);
        assert.match(report, /<h4>Limits of reuse<\/h4><p>Check current source before relying on it\.<\/p>/);
        assert.match(report, /<summary>2 historical records · 2 independent snapshots<\/summary>/);
        assert.throws(() => renderEntry(makeEntry({}), []), /Memory support episode is unavailable/);
    });

    it('renders a retired experience with its reason and optional replacement', () => {
        // A retirement keeps its reason and only names a replacement experience when one was recorded.
        const episodes = [makeEpisode({ id: FIRST_EPISODE_ID, snapshotId: digest('a') }), makeEpisode({ id: SECOND_EPISODE_ID, snapshotId: digest('b') })];
        const replaced = renderEntry(makeEntry({ retirement: { reason: 'Superseded by the new parser.', snapshotCount: 2, replacementEntryId: ENTRY_ID, supports: makeSupports() } }), episodes);
        assert.match(replaced, /<section class="experience-item retirement"><h3>Retired historical experience<\/h3>/);
        assert.match(replaced, /<p>Superseded by the new parser\.<\/p>/);
        assert.match(replaced, /<p class="section-copy">Replacement experience: <code>10000000-0000-4000-8000-000000000001<\/code><\/p>/);

        const unreplaced = renderEntry(makeEntry({ retirement: { reason: 'Superseded by the new parser.', snapshotCount: 2, replacementEntryId: null, supports: makeSupports() } }), episodes);
        assert.match(unreplaced, /Retired historical experience/);
        assert.doesNotMatch(unreplaced, /Replacement experience/);
    });

    it('wraps report content in a script-free document shell', () => {
        // The shared shell declares the editor language, denies every resource except inline styles, and appends the page stylesheet after the core rules.
        const report = renderReportDocument('Test report', '<p class="situation">body</p>', '.page-specific { color: red; }');

        assert.match(report, /^<!DOCTYPE html><html lang="[^"]+"><head><meta charset="UTF-8">/);
        assert.match(report, new RegExp(`<html lang="${vscode.env.language}">`));
        assert.match(report, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">/);
        assert.match(report, /<title>Test report<\/title>/);
        assert.match(report, /\.memory-card \{/);
        assert.match(report, /\.page-specific \{ color: red; \}\s*<\/style><\/head><body><p class="situation">body<\/p><\/body><\/html>$/);
        assert.doesNotMatch(report, /<script/);
    });

    it('formats record timestamps with the editor locale', () => {
        // Timestamps use the editor language and the medium date/short time style, so every report in a locale renders the same value.
        const expected = new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(1_700_000_000_000));

        assert.equal(createMemoryDateFormatter()(1_700_000_000_000), expected);
    });
});

/** Deterministic digest so record and snapshot ids stay addressable in assertions. */
function digest(seed: string): string {
    return seed.repeat(64 / seed.length);
}

interface ObservationOptions {
    tool?: string;
    summary?: string;
    ok?: boolean;
    error?: string;
    truncated?: boolean;
    evidence?: Array<Record<string, unknown>>;
}

interface EpisodeOptions {
    id?: string;
    createdAt?: number;
    status?: InvestigationEpisode['status'];
    snapshotId?: string;
    questions?: string[];
    claims?: Array<{ claim: string; evidenceRefs: string[]; disposition: 'must_express' | 'optional' | 'omit' }>;
    observations?: Array<Record<string, unknown>>;
}

function beforeEvidence(): Record<string, unknown> {
    return makeEvidence('E1', 'before', 10, 12, 'before excerpt', 'src/parser.ts');
}

function afterEvidence(): Record<string, unknown> {
    return makeEvidence('E2', 'after', 20, 22, 'after excerpt', 'src/parser.ts');
}

function makeEvidence(id: string, side: 'before' | 'after', startLine: number, endLine: number, excerpt: string, path: string): Record<string, unknown> {
    return {
        id,
        source: {
            snapshotId: digest('a'), path, side, blobOid: digest('b').slice(0, 40), startLine, endLine, excerpt,
            contentHash: digest('c'), truncated: false, sourceType: 'text',
        },
    };
}

/** One recorded observation; defaults describe a successful call that returned source code. */
function makeObservation(options: ObservationOptions): Record<string, unknown> {
    return {
        step: 0,
        tool: options.tool ?? 'readFileContent',
        arguments: { filePath: 'src/parser.ts' },
        ok: options.ok ?? true,
        summary: options.summary ?? 'recorded evidence',
        ...(options.error === undefined ? {} : { error: options.error }),
        evidence: options.evidence ?? [beforeEvidence()],
        durationMs: 1,
        truncated: options.truncated ?? false,
    };
}

/** One stored investigation record shaped like the persisted episode schema. */
function makeEpisode(options: EpisodeOptions): InvestigationEpisode {
    return {
        version: 3,
        id: options.id ?? FIRST_EPISODE_ID,
        createdAt: options.createdAt ?? 1,
        snapshot: {
            id: options.snapshotId ?? digest('a'), repositoryId: digest('r'), worktreeId: digest('w'), head: null,
            beforeTree: digest('b').slice(0, 40), afterTree: digest('c').slice(0, 40), indexFingerprint: digest('d'), autoStaged: false,
        },
        changedPaths: ['src/parser.ts'],
        questions: options.questions ?? ['Where is the parser entry point?'],
        observations: options.observations ?? [makeObservation({})],
        claims: options.claims ?? [{ claim: 'The parser is reached from the CLI.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        status: options.status ?? 'complete',
        model: 'memory-test-model',
        promptVersion: 'memory-experience-1',
        toolsetVersion: 'snapshot-memory-experience-1',
    } as unknown as InvestigationEpisode;
}

/** Two supports over two independent snapshots, the minimum a stored experience item records. */
function makeSupports(): MemorySupport[] {
    return [
        { episodeId: FIRST_EPISODE_ID, observationIndex: 0, evidenceId: 'E1', questionIndex: 0, claimIndex: 0 },
        { episodeId: SECOND_EPISODE_ID, observationIndex: 0 },
    ];
}

/** One stored long-term memory shaped like the persisted handbook entry schema. */
function makeEntry(options: { retirement?: HandbookEntry['retirement'] }): HandbookEntry {
    return {
        id: ENTRY_ID,
        situation: 'Inspect the parser before changing its consumer.',
        retirement: options.retirement ?? null,
        steps: [{ path: 'src/parser.ts', symbol: 'parse()', purpose: 'Read the parser entry point first.', operation: 'readFileContent', supports: makeSupports(), snapshotCount: 2 }],
        lessons: [{
            observation: 'Recorded parser behaviour.', implication: 'Start at the parser entry point.', limitation: 'Check current source before relying on it.',
            supports: makeSupports(), snapshotCount: 2,
        }],
        targetPaths: ['src/parser.ts'],
        triggers: ['src/parser.ts'],
    } as unknown as HandbookEntry;
}
