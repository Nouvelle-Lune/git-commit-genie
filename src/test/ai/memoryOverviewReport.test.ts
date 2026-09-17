import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import type { MemoryView } from '../../services/memory/store';
import { entrySupports, HandbookEntry, InvestigationEpisode, MemorySupport } from '../../services/memory/types';
import { formatMemoryOverviewReport, MemoryOverviewContext } from '../../ui/memoryOverviewReport';

const PARSE_EPISODE_ID = '11111111-1111-4111-8111-111111111111';
const NEWEST_EPISODE_ID = '22222222-2222-4222-8222-222222222222';
const DEGRADED_EPISODE_ID = '33333333-3333-4333-8333-333333333333';
const ENTRY_ID = '10000000-0000-4000-8000-000000000001';
const SNAPSHOT_A = 'a'.repeat(64);
const SNAPSHOT_B = 'b'.repeat(64);

const CONTEXT: MemoryOverviewContext = {
    repositoryLabel: 'memory-command-repository',
    repositoryRoot: '/tmp/memory-overview-repository',
    repositoryId: 'r'.repeat(64),
    storageDirectory: `/tmp/memory-storage/repository-memory/${'r'.repeat(64)}`,
};

describe('Memory overview report', () => {
    it('renders the repository hero, saved-history framing, and overview metrics', () => {
        // The page opens with the repository label and states that the content is stored history, then counts long-term memories, records, repository versions, and which records are still waiting.
        const episodes = [makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 1_000, snapshotId: SNAPSHOT_A }), makeEpisode({ id: NEWEST_EPISODE_ID, createdAt: 3_000, snapshotId: SNAPSHOT_B, status: 'complete_diff_only' }), makeEpisode({ id: DEGRADED_EPISODE_ID, createdAt: 2_000, snapshotId: SNAPSHOT_A, status: 'degraded', changedPaths: ['src/c.ts', 'src/d.ts', 'src/e.ts'] })];
        const handbook = [makeEntry({ supports: [{ episodeId: NEWEST_EPISODE_ID, observationIndex: 0, evidenceId: 'E1' }, { episodeId: NEWEST_EPISODE_ID, observationIndex: 0 }] })];

        const report = formatMemoryOverviewReport(makeView({ episodes, handbook }), CONTEXT);

        assert.match(report, /<html lang="/);
        assert.match(report, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">/);
        assert.match(report, /<title>Repository Memory: memory-command-repository<\/title>/);
        assert.match(report, /<header class="hero"><h1>memory-command-repository<\/h1>/);
        assert.match(report, /These are records saved by earlier investigations, not the current repository\. Check current source before relying on any conclusion\./);
        assert.match(report, /<h2>What is saved<\/h2>/);
        assert.match(report, /<strong>1<\/strong><span>Long-term memory<\/span><p>All are still in use<\/p>/);
        assert.match(report, /<strong>3<\/strong><span>Investigation records<\/span><p>From 2 repository versions<\/p>/);
        assert.match(report, new RegExp(`<p class="count-note">2 records have no long-term memory yet\\. Newest record saved ${escapeRegExp(formatRecordedAt(3_000))}\\.<\/p>`));
        assert.match(report, /<h2>Long-term memory<\/h2>/);
        assert.match(report, /These long-term memories may be recalled when related files or topics appear\./);
        assert.match(report, /Inspect the parser before changing its consumer\./);
        assert.match(report, /<h2>Investigation records<\/h2>/);
        assert.match(report, /All 3 records, newest first\. Each one is what an investigation saved at that moment; its excerpts come from the repository as it was then\./);
        assert.deepEqual(recordOrder(report), [NEWEST_EPISODE_ID, DEGRADED_EPISODE_ID, PARSE_EPISODE_ID]);
    });

    it('counts retired long-term memories and reports the stored generation details', () => {
        // Retired experiences are counted in the metric card, and the technical section reports every stored identifier, counter, and storage location.
        const episodes = [makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 1_000, snapshotId: SNAPSHOT_A })];
        const handbook = [makeEntry({}), makeEntry({ id: '10000000-0000-4000-8000-000000000002', retirement: { reason: 'Superseded by the new parser.', snapshotCount: 2, replacementEntryId: null, supports: [{ episodeId: PARSE_EPISODE_ID, observationIndex: 0 }, { episodeId: PARSE_EPISODE_ID, observationIndex: 0, evidenceId: 'E1' }] } })];

        const report = formatMemoryOverviewReport(makeView({
            episodes, handbook, consolidated: ['f1', 'f2', 'f3'], organizedSeeds: [PARSE_EPISODE_ID, NEWEST_EPISODE_ID], epoch: 'epoch-7', generation: 12,
        }), CONTEXT);

        assert.match(report, /<strong>2<\/strong><span>Long-term memory<\/span><p>1 retired<\/p>/);
        assert.match(report, /<summary>Technical information<\/summary><dl>/);
        assert.match(report, new RegExp(`<dt>Repository ID<\\/dt><dd><code>${'r'.repeat(64)}<\\/code><\\/dd>`));
        assert.match(report, /<dt>Repository path<\/dt><dd><code>\/tmp\/memory-overview-repository<\/code><\/dd>/);
        assert.match(report, new RegExp(`<dt>Memory storage<\\/dt><dd><code>${escapeRegExp(CONTEXT.storageDirectory)}<\\/code><\\/dd>`));
        assert.match(report, /<dt>Deletion epoch<\/dt><dd><code>epoch-7<\/code><\/dd>/);
        assert.match(report, /<dt>Published generation<\/dt><dd>12<\/dd>/);
        assert.match(report, /<dt>Organized batches<\/dt><dd>3<\/dd>/);
        assert.match(report, /<dt>Organized investigations<\/dt><dd>2<\/dd>/);
        assert.match(report, /<dt>Records cited by long-term memory<\/dt><dd>1<\/dd>/);
        assert.match(report, /This page is read-only\. Records and long-term memories change only through Memory operations in the editor\./);
    });

    it('lists records newest first and breaks equal timestamps by record id', () => {
        // The record list is ordered by saved time descending, and records saved at the same moment are ordered by ascending id so the page is stable.
        const episodes = [
            makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 900, snapshotId: SNAPSHOT_A }),
            makeEpisode({ id: NEWEST_EPISODE_ID, createdAt: 1_200, snapshotId: SNAPSHOT_B }),
            makeEpisode({ id: DEGRADED_EPISODE_ID, createdAt: 900, snapshotId: SNAPSHOT_A }),
        ];

        const report = formatMemoryOverviewReport(makeView({ episodes }), CONTEXT);

        assert.deepEqual(recordOrder(report), [NEWEST_EPISODE_ID, PARSE_EPISODE_ID, DEGRADED_EPISODE_ID]);
    });

    it('maps every stored investigation status to a plain-language label and tone', () => {
        // Each stored status renders the reader-facing label and the tone class used by both the record and its status tag.
        const statuses: Array<[InvestigationEpisode['status'], string, string]> = [
            ['complete', 'Complete', 'complete'],
            ['complete_diff_only', 'Diff only', 'complete'],
            ['degraded', 'Partially degraded', 'partial'],
            ['unavailable', 'Unavailable', 'inactive'],
            ['cancelled', 'Cancelled', 'inactive'],
            ['error', 'Failed', 'failed'],
        ];
        const episodes = statuses.map(([status], index) => makeEpisode({ id: episodeId(index), createdAt: index, status, snapshotId: SNAPSHOT_A }));

        const report = formatMemoryOverviewReport(makeView({ episodes }), CONTEXT);

        statuses.forEach(([, label, tone], index) => {
            const block = recordBlock(report, episodeId(index));
            assert.match(block, new RegExp(`^<details class="record status-${tone}">`), `${label} record tone`);
            assert.match(block, new RegExp(`<span class="tag status-${tone}">${label}<\\/span>`), `${label} status tag`);
        });
    });

    it('keeps the raw stored status in the record details', () => {
        // The expanded record keeps the stored status enum so the plain-language label never replaces the recorded fact.
        const report = formatMemoryOverviewReport(makeView({ episodes: [makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 1, status: 'complete_diff_only' })] }), CONTEXT);
        const block = recordBlock(report, PARSE_EPISODE_ID);

        assert.match(block, /<span class="tag status-complete">Diff only<\/span>/);
        assert.match(block, /<dt>Investigation status<\/dt><dd><code>complete_diff_only<\/code><\/dd>/);
    });

    it('labels each record by why it is not long-term memory yet', () => {
        // Category tags follow the documented priority: an already cited record stays cited even when it is organized or ineligible, an organized record without a conclusion is named as such, an ineligible record is diagnostic only, and the rest are waiting.
        const cited = makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 4_000, status: 'error' });
        const organized = makeEpisode({ id: NEWEST_EPISODE_ID, createdAt: 3_000, status: 'cancelled' });
        const diagnostic = makeEpisode({ id: DEGRADED_EPISODE_ID, createdAt: 2_000, status: 'complete', observations: [makeObservation({ tool: 'searchRepositoryMemory' })] });
        const waiting = makeEpisode({ id: episodeId(9), createdAt: 1_000 });

        const report = formatMemoryOverviewReport(makeView({
            episodes: [cited, organized, diagnostic, waiting],
            representedSupports: [{ episodeId: PARSE_EPISODE_ID, observationIndex: 0 }],
            organizedSeeds: [PARSE_EPISODE_ID, NEWEST_EPISODE_ID],
        }), CONTEXT);

        assert.match(recordBlock(report, PARSE_EPISODE_ID), /<span class="tag tag-muted" title="A long-term memory cites a record from this investigation\.">Used by long-term memory<\/span>/);
        assert.match(recordBlock(report, NEWEST_EPISODE_ID), /title="Memory organized this investigation but kept no conclusion from it\.">Organized with no conclusion<\/span>/);
        assert.match(recordBlock(report, DEGRADED_EPISODE_ID), /title="The investigation did not finish with usable observations, so it cannot become long-term memory\.">Diagnostic only<\/span>/);
        assert.match(recordBlock(report, episodeId(9)), /title="This investigation has not been organized yet\.">Waiting to be organized<\/span>/);
    });

    it('shows the first recorded paths and summarizes the hidden ones', () => {
        // The record summary shows at most two changed paths, states how many further files were recorded, and says explicitly when no path was recorded.
        const many = makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 3, changedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] });
        const none = makeEpisode({ id: NEWEST_EPISODE_ID, createdAt: 2, changedPaths: [] });
        const single = makeEpisode({ id: DEGRADED_EPISODE_ID, createdAt: 1, changedPaths: ['src/only.ts'] });

        const report = formatMemoryOverviewReport(makeView({ episodes: [many, none, single] }), CONTEXT);

        assert.match(recordBlock(report, PARSE_EPISODE_ID), /<span class="record-paths">src\/a\.ts, src\/b\.ts and 2 more files<\/span>/);
        assert.match(recordBlock(report, PARSE_EPISODE_ID), /<dt>Changed paths<\/dt><dd><code>src\/a\.ts<\/code> <code>src\/b\.ts<\/code> <code>src\/c\.ts<\/code> <code>src\/d\.ts<\/code><\/dd>/);
        assert.match(recordBlock(report, NEWEST_EPISODE_ID), /<span class="record-paths">No change paths were recorded\.<\/span>/);
        assert.match(recordBlock(report, NEWEST_EPISODE_ID), /<dt>Changed paths<\/dt><dd>None<\/dd>/);
        assert.match(recordBlock(report, DEGRADED_EPISODE_ID), /<span class="record-paths">src\/only\.ts<\/span>/);
    });

    it('opens a record into its questions, conclusions, and recorded observations', () => {
        // The expanded record keeps the investigation questions, the disposition of each conclusion, and one expandable provenance block per recorded observation.
        const episode = makeEpisode({
            id: PARSE_EPISODE_ID, createdAt: 1, snapshotId: SNAPSHOT_A, model: 'memory-record-model',
            questions: ['Where is the parser entry point?', 'Which callers depend on it?'],
            claims: [
                { claim: 'The parser is reached from the CLI.', evidenceRefs: ['E1'], disposition: 'must_express' },
                { claim: 'The parser tolerates extra whitespace.', evidenceRefs: ['E1'], disposition: 'optional' },
                { claim: 'The parser rejects an empty file.', evidenceRefs: ['E1'], disposition: 'omit' },
            ],
            observations: [makeObservation({}), makeObservation({ tool: 'searchCode', summary: 'second observation' })],
        });

        const report = formatMemoryOverviewReport(makeView({ episodes: [episode] }), CONTEXT);
        const block = recordBlock(report, PARSE_EPISODE_ID);

        assert.match(block, new RegExp(`<span class="record-time">${escapeRegExp(formatRecordedAt(1))}<\\/span>`));
        assert.match(block, /<dt>Record ID<\/dt><dd><code>11111111-1111-4111-8111-111111111111<\/code><\/dd>/);
        assert.match(block, new RegExp(`<dt>Repository snapshot<\\/dt><dd><code>${SNAPSHOT_A}<\\/code><\\/dd>`));
        assert.match(block, /<dt>Recorded by model<\/dt><dd>memory-record-model<\/dd>/);
        assert.match(block, /<dt>Record protocol<\/dt><dd><code>memory-experience-1<\/code> · <code>snapshot-memory-experience-1<\/code><\/dd>/);
        assert.match(block, /<h4>Investigation questions<\/h4><ol><li>Where is the parser entry point\?<\/li><li>Which callers depend on it\?<\/li><\/ol>/);
        assert.match(block, /<li>The parser is reached from the CLI\. <span class="tag tag-muted">Must express<\/span><\/li>/);
        assert.match(block, /<li>The parser tolerates extra whitespace\. <span class="tag tag-muted">Optional<\/span><\/li>/);
        assert.match(block, /<li>The parser rejects an empty file\. <span class="tag tag-muted">Omitted<\/span><\/li>/);
        assert.doesNotMatch(block, /must_express|· omit</);
        assert.match(block, /<h4>Recorded observations<\/h4><details class="evidence-record">/);
        assert.equal((block.match(/<details class="evidence-record">/g) ?? []).length, 2);
        assert.match(block, /readFileContent · Recorded step 0 · complete<\/summary>/);
        assert.match(block, /searchCode · Recorded step 0 · complete<\/summary>/);
        assert.match(block, /<h4 class="evidence-source">src\/parser\.ts:10–12 · Recorded before the change<\/h4>/);
    });

    it('states when an investigation saved no observation', () => {
        // A record stored without observations says so instead of rendering an empty observations section.
        const report = formatMemoryOverviewReport(makeView({ episodes: [makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 1, observations: [] })] }), CONTEXT);
        const block = recordBlock(report, PARSE_EPISODE_ID);

        assert.match(block, /<h4>Recorded observations<\/h4><p class="section-copy">No observation was recorded for this investigation\.<\/p>/);
        assert.doesNotMatch(block, /<details class="evidence-record">/);
    });

    it('shows a single empty state for a repository with no stored memory', () => {
        // A repository that stored nothing gets one explanation instead of two empty sections and no metrics that would all read zero.
        const report = formatMemoryOverviewReport(makeView({ episodes: [], handbook: [] }), CONTEXT);

        assert.match(report, /<div class="empty-state"><p>No memory is saved for this repository yet\.<\/p>/);
        assert.match(report, /While Repository Memory is enabled, every commit-message investigation saves a record\./);
        assert.doesNotMatch(report, /class="metrics"/);
        assert.doesNotMatch(report, /<h2>What is saved<\/h2>/);
        assert.doesNotMatch(report, /<h2>Long-term memory<\/h2>/);
        assert.doesNotMatch(report, /<h2>Investigation records<\/h2>/);
        assert.doesNotMatch(report, /Newest record saved/);
        assert.match(report, /<summary>Technical information<\/summary>/);
    });

    it('states that no long-term memory exists while records are stored', () => {
        // Records without any long-term memory keep the record list and explain the long-term memory empty state.
        const report = formatMemoryOverviewReport(makeView({ episodes: [makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 1 })], handbook: [] }), CONTEXT);

        assert.match(report, /<div class="empty-state"><p>No long-term memory has been created for this repository yet\.<\/p>/);
        assert.match(report, /Memory organizes saved records after several related investigations, while the editor is idle\./);
        assert.match(report, /<div class="record-list">/);
        assert.match(report, /<p class="count-note">1 records have no long-term memory yet\./);
    });

    it('escapes stored values and never emits markup from memory content', () => {
        // Repository labels, paths, questions, conclusions, excerpts, and identifiers are escaped, so stored content can never inject markup into the read-only page.
        const episode = makeEpisode({
            id: PARSE_EPISODE_ID, createdAt: 1, changedPaths: ['src/<script>alert("path")</script>.ts', "src/it's.ts"],
            questions: ['<script>alert("question")</script>'],
            claims: [{ claim: '<script>alert("claim")</script>', evidenceRefs: ['E1'], disposition: 'must_express' }],
            observations: [makeObservation({ summary: '<script>alert("summary")</script>', evidence: [beforeEvidence('<script>alert("excerpt")</script>')] })],
        });
        const report = formatMemoryOverviewReport(makeView({ episodes: [episode] }), { ...CONTEXT, repositoryLabel: '<script>alert("label")</script>' });

        assert.match(report, /<h1>&lt;script&gt;alert\(&quot;label&quot;\)&lt;\/script&gt;<\/h1>/);
        assert.match(report, /<title>Repository Memory: &lt;script&gt;alert\(&quot;label&quot;\)&lt;\/script&gt;<\/title>/);
        assert.match(report, /&lt;script&gt;alert\(&quot;path&quot;\)&lt;\/script&gt;\.ts/);
        assert.match(report, /src\/it&#39;s\.ts/);
        assert.match(report, /<li>&lt;script&gt;alert\(&quot;question&quot;\)&lt;\/script&gt;<\/li>/);
        assert.match(report, /&lt;script&gt;alert\(&quot;claim&quot;\)&lt;\/script&gt; <span class="tag tag-muted">Must express<\/span>/);
        assert.match(report, /&lt;script&gt;alert\(&quot;summary&quot;\)&lt;\/script&gt;/);
        assert.match(report, /&lt;script&gt;alert\(&quot;excerpt&quot;\)&lt;\/script&gt;/);
        assert.doesNotMatch(report, /<script/);
        assert.doesNotMatch(report, /<\/script>/);
        assert.doesNotMatch(report, /alert\("label"\)/);
    });

    it('throws instead of rendering a long-term memory that cites missing history', () => {
        // A long-term memory citing an episode the store no longer holds must fail the report instead of silently dropping its provenance.
        const handbook = [makeEntry({ supports: [{ episodeId: '99999999-9999-4999-8999-999999999999', observationIndex: 0 }, { episodeId: PARSE_EPISODE_ID, observationIndex: 0 }] })];

        assert.throws(
            () => formatMemoryOverviewReport(makeView({ episodes: [makeEpisode({ id: PARSE_EPISODE_ID, createdAt: 1 })], handbook }), CONTEXT),
            /Memory support episode is unavailable/,
        );
    });
});

function episodeId(index: number): string {
    return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function formatRecordedAt(createdAt: number): string {
    return new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(createdAt));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function recordOrder(report: string): string[] {
    return [...report.matchAll(/<dt>Record ID<\/dt><dd><code>([^<]+)<\/code><\/dd>/g)].map(match => match[1]);
}

/** Slice one rendered record so per-record assertions cannot read a neighbouring record. */
function recordBlock(report: string, episodeIdValue: string): string {
    const markerIndex = report.indexOf(`<dt>Record ID</dt><dd><code>${episodeIdValue}</code></dd>`);
    assert.ok(markerIndex >= 0, `Record '${episodeIdValue}' is missing from the report.`);
    const start = report.lastIndexOf('<details class="record ', markerIndex);
    const next = report.indexOf('<details class="record ', markerIndex);
    return report.slice(start, next >= 0 ? next : undefined);
}

interface ObservationOptions {
    tool?: string;
    summary?: string;
    evidence?: Array<Record<string, unknown>>;
}

interface EpisodeOptions {
    id: string;
    createdAt: number;
    status?: InvestigationEpisode['status'];
    snapshotId?: string;
    changedPaths?: string[];
    questions?: string[];
    claims?: Array<{ claim: string; evidenceRefs: string[]; disposition: 'must_express' | 'optional' | 'omit' }>;
    observations?: Array<Record<string, unknown>>;
    model?: string;
}

function beforeEvidence(excerpt = 'recorded excerpt'): Record<string, unknown> {
    return {
        id: 'E1',
        source: {
            snapshotId: SNAPSHOT_A, path: 'src/parser.ts', side: 'before', blobOid: 'c'.repeat(40), startLine: 10, endLine: 12,
            excerpt, contentHash: 'd'.repeat(64), truncated: false, sourceType: 'text',
        },
    };
}

/** One recorded observation; defaults describe a successful call that returned source code. */
function makeObservation(options: ObservationOptions = {}): Record<string, unknown> {
    return {
        step: 0,
        tool: options.tool ?? 'readFileContent',
        arguments: { filePath: 'src/parser.ts' },
        ok: true,
        summary: options.summary ?? 'recorded evidence',
        evidence: options.evidence ?? [beforeEvidence()],
        durationMs: 1,
        truncated: false,
    };
}

/** One stored investigation record shaped like the persisted episode schema. */
function makeEpisode(options: EpisodeOptions): InvestigationEpisode {
    return {
        version: 3,
        id: options.id,
        createdAt: options.createdAt,
        snapshot: {
            id: options.snapshotId ?? SNAPSHOT_A, repositoryId: 'e'.repeat(64), worktreeId: 'f'.repeat(64), head: null,
            beforeTree: 'c'.repeat(40), afterTree: 'd'.repeat(40), indexFingerprint: '1'.repeat(64), autoStaged: false,
        },
        changedPaths: options.changedPaths ?? ['src/parser.ts'],
        questions: options.questions ?? ['Where is the parser entry point?'],
        observations: options.observations ?? [makeObservation()],
        claims: options.claims ?? [{ claim: 'The parser is reached from the CLI.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        status: options.status ?? 'complete',
        model: options.model ?? 'memory-test-model',
        promptVersion: 'memory-experience-1',
        toolsetVersion: 'snapshot-memory-experience-1',
    } as unknown as InvestigationEpisode;
}

/** One stored long-term memory shaped like the persisted handbook entry schema. */
function makeEntry(options: { id?: string; supports?: MemorySupport[]; retirement?: HandbookEntry['retirement'] }): HandbookEntry {
    const supports = options.supports ?? [{ episodeId: PARSE_EPISODE_ID, observationIndex: 0 }, { episodeId: PARSE_EPISODE_ID, observationIndex: 0, evidenceId: 'E1' }];
    return {
        id: options.id ?? ENTRY_ID,
        situation: 'Inspect the parser before changing its consumer.',
        retirement: options.retirement ?? null,
        steps: [{ path: 'src/parser.ts', symbol: 'parse()', purpose: 'Read the parser entry point first.', operation: 'readFileContent', supports, snapshotCount: 2 }],
        lessons: [{
            observation: 'Recorded parser behaviour.', implication: 'Start at the parser entry point.', limitation: 'Check current source before relying on it.',
            supports, snapshotCount: 2,
        }],
        targetPaths: ['src/parser.ts'],
        triggers: ['src/parser.ts'],
    } as unknown as HandbookEntry;
}

/** One stored view; cited records default to whatever the given long-term memories reference. */
function makeView(options: {
    episodes: InvestigationEpisode[];
    handbook?: HandbookEntry[];
    representedSupports?: MemorySupport[];
    consolidated?: string[];
    organizedSeeds?: string[];
    epoch?: string;
    generation?: number;
}): MemoryView {
    const handbook = options.handbook ?? [];
    return {
        epoch: options.epoch ?? 'epoch',
        generation: options.generation ?? 1,
        episodes: options.episodes,
        handbook,
        representedSupports: options.representedSupports ?? handbook.flatMap(entry => entrySupports(entry)),
        consolidated: options.consolidated ?? [],
        organizedSeeds: options.organizedSeeds ?? [],
    };
}
