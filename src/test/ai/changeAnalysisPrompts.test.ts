import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    buildInvestigationPlanMessages,
    buildInvestigationToolResultMessage,
} from '../../services/analysis/change/prompts';
import { DraftEvidence } from '../../services/analysis/change/types';
import {
    createInvestigationPlanResponseSchema,
    INVESTIGATION_LOOKUPS,
    INVESTIGATION_TARGET_KINDS,
    INVESTIGATION_PLAN_LIMITS,
} from '../../services/llm/providers/schemas/common';

const evidence: DraftEvidence[] = [{
    kind: 'raw',
    fileName: 'parser.ts',
    status: 'modified',
    evidenceIds: ['D1'],
    rawDiff: '@@ -1 +1 @@\n-return old\n+return new',
}];

describe('raw-diff change analysis prompts', () => {
    it('describes the schema-owned coverage key set instead of a model-maintained D* list', () => {
        // Verify the planner prompt states that coverage is a keyed object whose key set the schema already fixed,
        // so a model never has to reproduce, merge, or reconcile the D* list itself.
        const messages = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /complete raw diff/i);
        assert.match(content, /The response schema already declares one coverage key per D\* id of this diff/);
        assert.match(content, /coverage is a JSON object keyed by diff evidence id, not an array/);
        assert.match(content, /Never delete, rename, or add a coverage key/);
        assert.match(content, /Each value has exactly decision and targetIds/);
        assert.match(content, /Every target you declare must be named by at least one investigate entry/);
        assert.match(content, /4 repository tool call/);
        assert.match(content, /information gain/i);
        assert.match(content, /Coverage preserves the diff; it is not a must-express\/optional\/omit decision/);
        assert.doesNotMatch(content, /change extraction/i);
        // The retired double-bookkeeping guidance must not survive anywhere in the prompt.
        assert.doesNotMatch(content, /diffEvidenceRefs/);
        assert.doesNotMatch(content, /[0-9]+ D\* ids per target/);
        assert.doesNotMatch(content, /merge/i);
        assert.doesNotMatch(content, /duplicate/i);
    });

    it('does not describe the removed semantic extraction payload or embed a full schema', () => {
        // Verify the new prompt exposes only the provider schema contract instead of resurrecting extraction fields.
        const messages = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /provider response schema/);
        assert.doesNotMatch(content, /changedSymbols/);
        assert.doesNotMatch(content, /introducedSymbols/);
        assert.doesNotMatch(content, /"properties":\s*\{/);
    });

    it('lists every legal target kind and maps configuration to config', () => {
        // The planner prompt must expose the exact provider enum so a model cannot invent language-specific target kinds.
        const content = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        for (const kind of INVESTIGATION_TARGET_KINDS) {
            assert.match(content, new RegExp(`\\b${kind}\\b`));
        }
        assert.match(content, /Return exactly the top-level keys targets, coverage, and notes/);
        assert.match(content, /Each target has exactly id, target, kind, lookup, file, and question\./);
        assert.match(content, /Each value has exactly decision and targetIds/);
        assert.match(content, /Use "config" for configuration keys/);
        assert.match(content, /"interface" for contracts/);
        assert.match(content, /"cli_or_api" for commands, routes, flags, or parameters/);
    });

    it('publishes the per-entry coverage cap the decoder enforces at that budget', () => {
        // A coverage entry can never name more targets than the plan is allowed to declare, so the prompt has to
        // publish min(maxTargetIdsPerCoverageEntry, min(maxTargets, maxToolCalls)) rather than the entry ceiling:
        // a model shown 12 at a 4-call budget would name ids the decoder refuses, and the rejection would look like
        // a schema fault instead of the budget it really is.
        const targetIdsPerCoverageEntry = (maxToolCalls: number): number => Math.min(
            INVESTIGATION_PLAN_LIMITS.maxTargetIdsPerCoverageEntry,
            Math.min(INVESTIGATION_PLAN_LIMITS.maxTargets, maxToolCalls),
        );

        for (const maxToolCalls of [4, 12]) {
            const content = buildInvestigationPlanMessages({ evidence, maxToolCalls })
                .map(message => message.content)
                .join('\n');

            assert.ok(content.includes(
                `A target carries exactly one question, and a plan declares at most ${Math.min(INVESTIGATION_PLAN_LIMITS.maxTargets, maxToolCalls)} target(s): `
                + `one coverage entry may name at most ${targetIdsPerCoverageEntry(maxToolCalls)} targets.`,
            ), content);
        }
        // The two budgets differ, so the assertion above cannot be satisfied by a prompt that always printed the
        // ceiling: at 4 calls the budget is the binding number and at the ceiling it is the entry limit.
        assert.equal(targetIdsPerCoverageEntry(4), 4);
        assert.equal(targetIdsPerCoverageEntry(INVESTIGATION_PLAN_LIMITS.maxTargets), INVESTIGATION_PLAN_LIMITS.maxTargetIdsPerCoverageEntry);
    });

    it('keeps one investigate entry in the excerpt while every other shown value is diff_sufficient', () => {
        // The example must show both decision values and always keep one investigate entry, because a plan with no
        // target grants the agent no repository tools at all; the remaining shown values teach the quiet default.
        const content = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');
        const example = plannerExample(content);

        assert.deepEqual(example.coverage, {
            D1: { decision: 'investigate', targetIds: ['T1'] },
        });
        assert.equal(example.targets.length, 1);
        assert.deepEqual(example.targets[0].lookup, 'definition');
        assert.match(content, /Most hunks of a diff are diff_sufficient/);
        assert.match(content, /a plan with no target grants the agent no repository tools at all/);
    });

    it('takes the first, middle, and last D* of an 80-hunk request as a deliberately partial excerpt', () => {
        // The excerpt carries three real ids so the middle-hunk shape is visible, while staying an excerpt: showing
        // all 80 keys would present 79 diff_sufficient values and push the model to a zero-target plan.
        const ids = Array.from({ length: 80 }, (_, index) => `D${index + 1}`);
        const wideEvidence: DraftEvidence[] = [{
            kind: 'raw',
            fileName: 'src/custom.ts',
            status: 'modified',
            evidenceIds: ids,
            rawDiff: '@@ -1 +1 @@\n-old\n+new',
        }];
        const content = buildInvestigationPlanMessages({ evidence: wideEvidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');
        const coverage = plannerExampleCoverage(content);

        assert.deepEqual(Object.keys(coverage), ['D1', 'D41', 'D80']);
        assert.deepEqual(coverage.D1, { decision: 'investigate', targetIds: ['T1'] });
        assert.deepEqual(coverage.D41, { decision: 'diff_sufficient', targetIds: [] });
        assert.deepEqual(coverage.D80, { decision: 'diff_sufficient', targetIds: [] });
        assert.match(content, /uses ids from the current input only to demonstrate the output shape/i);
        assert.match(content, /coverage is incomplete on purpose/i);
        assert.match(content, /must contain one entry for every D\* id the schema supplies, not only the ones shown here/);
        assert.match(content, /Do not copy its decisions, target, or question/i);
    });

    it('keeps two distinct excerpt keys when the middle id collapses onto the last one', () => {
        // With two ids the middle and last positions are the same hunk, so de-duplication must leave exactly the two
        // real keys instead of repeating the second one under the same name.
        const twoIdEvidence: DraftEvidence[] = [{
            kind: 'raw',
            fileName: 'src/custom.ts',
            status: 'modified',
            evidenceIds: ['D1', 'D2'],
            rawDiff: '@@ -1 +1 @@\n-old\n+new',
        }];
        const content = buildInvestigationPlanMessages({ evidence: twoIdEvidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        assert.deepEqual(Object.keys(plannerExampleCoverage(content)), ['D1', 'D2']);
    });

    it('shrinks the example to a single key when the request supplies one D* id', () => {
        // A one-hunk request has no second id to show, so the example must not invent or repeat a foreign key.
        const customEvidence: DraftEvidence[] = [{
            kind: 'raw',
            fileName: 'src/custom.ts',
            status: 'modified',
            evidenceIds: ['D7'],
            rawDiff: '@@ -7 +7 @@\n-old\n+new',
        }];
        const content = buildInvestigationPlanMessages({ evidence: customEvidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        assert.deepEqual(Object.keys(plannerExampleCoverage(content)), ['D7']);
        assert.match(content, /"D7": \{/);
        assert.doesNotMatch(content, /"D2": \{/);
    });

    it('lists every lookup literal and prefers a relation verb over reading a changed file', () => {
        // lookup is a closed vocabulary the model must copy literally, and the verbs are ranked: a relation verb is
        // the default, while "read" is reserved for a hunk whose surroundings the diff does not show.
        const content = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        for (const lookup of INVESTIGATION_LOOKUPS) {
            assert.match(content, new RegExp(`\\b${lookup}\\b`), `The prompt must name the '${lookup}' lookup literal.`);
        }
        assert.match(content, /Every target\.lookup must be exactly one of these literal values/);
        assert.match(content, /"read" returns a region of a changed file/);
        assert.match(content, /Prefer a relation verb when the unknown is a relation/);
        assert.match(content, /A target is one coherent unknown plus a concrete repository entry point/);
        // read is a legal verb again, so the retired "a target never declares read" rule must not survive in the
        // prompt: the only guard left against a read-only investigation is the finalization precondition.
        assert.match(content, /- every lookup is one of the exact literals above;/);
        assert.doesNotMatch(content, /never declares "read"/);
        assert.doesNotMatch(content, /mutually exclusive/);
    });

    it('states the target budget as the smaller of the granularity ceiling and the tool calls', () => {
        // The size limit is no longer a sum the planner validates; it is the schema's target-array bound. The prompt
        // therefore has to publish that same number — min(maxTargets, maxToolCalls) — everywhere it mentions the
        // budget, or a model shown a larger cap would fill a plan the decoder then truncates.
        for (const maxToolCalls of [4, 12, 30]) {
            const targetBudget = Math.min(INVESTIGATION_PLAN_LIMITS.maxTargets, maxToolCalls);
            const content = buildInvestigationPlanMessages({ evidence, maxToolCalls })
                .map(message => message.content)
                .join('\n');
            const critical = content.slice(content.indexOf('<critical>'), content.indexOf('</critical>'));

            // The budget also leads the critical block, which is the first block the model reads.
            assert.ok(
                critical.includes(`Your plan must fit the shared budget: at most ${targetBudget} target(s), one repository lookup each.`),
                critical,
            );
            assert.ok(content.includes(
                `The investigation agent has ${maxToolCalls} repository tool call(s), shared by every target in your plan and by nothing else.`,
            ));
            assert.ok(content.includes(
                `Each target spends one of those calls on the lookup it declares, so a plan declaring more than ${targetBudget} target(s) would promise lookups the agent cannot pay for.`,
            ));
            assert.ok(content.includes(
                `That cap is the whole budget: ${maxToolCalls} repository call(s) are all the agent has, and each target spends one on the lookup it declares.`,
            ));
            assert.ok(content.includes(
                `When the material unknowns cannot all fit in ${targetBudget} target(s), keep the hunks whose answer most changes the commit message`,
            ));
            assert.ok(content.includes(`- the plan declares at most ${targetBudget} target(s), one question each;`));
            // Every budget sentence counts targets now: a surviving "question(s) in total" line would restore the
            // sum rule the schema cannot express and the planner no longer checks.
            assert.doesNotMatch(content, /question\(s\) in total/);
            assert.doesNotMatch(content, /Question budget/);
            assert.doesNotMatch(content, /To cut:/);
        }
    });

    it('names the target deletion a budget cut forces, not only the relabelling', () => {
        // Relabelling a hunk diff_sufficient can orphan its target, which is a second violation and a second attempt,
        // so the cut sentence has to carry the deletion in the same breath as the decision.
        const content = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        assert.match(
            content,
            /mark the rest diff_sufficient, declare no target those entries no longer name, and state in notes which unknowns the budget left unfunded\./,
        );
        assert.match(content, /Every target you declare must be named by at least one investigate entry\./);
        assert.match(content, /- every target you declared is named by at least one investigate entry;/);
    });

    it('accepts the example target shape once every required coverage key is supplied', () => {
        // The example fixes the field shape a model copies, and the request-scoped schema judges that shape, not the
        // excerpt's key set: the plan below supplies every D* key the request declares while reusing the example's
        // own target verbatim. A stale field name or a missing lookup would poison every answer that copies it.
        const ids = ['D1', 'D2', 'D3', 'D4'];

        for (const maxToolCalls of [4, 12]) {
            const content = buildInvestigationPlanMessages({ evidence: evidenceWithIds(ids), maxToolCalls })
                .map(message => message.content)
                .join('\n');
            const example = plannerExample(content);
            const plan = {
                targets: example.targets,
                coverage: completeCoverage(ids, example.coverage),
                notes: example.notes,
            };

            const parsed = createInvestigationPlanResponseSchema(ids, maxToolCalls).safeParse(plan);

            assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
            assert.equal(example.targets.length, 1, 'The example must keep exactly one declared target.');
        }
    });

    it('keeps the excerpt a strict subset of the request ids, which the same schema rejects as a whole plan', () => {
        // The excerpt shows the first, middle, and last hunk on purpose, so for a four-hunk request it must omit the
        // middle key and the object must not decode as that request's plan. The schema is built from the request's
        // ids, never from the keys the excerpt happens to show: a schema derived from the excerpt would accept it by
        // construction and could not notice a dropped hunk.
        const ids = ['D1', 'D2', 'D3', 'D4'];
        const content = buildInvestigationPlanMessages({ evidence: evidenceWithIds(ids), maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');
        const example = plannerExample(content);
        const excerptKeys = Object.keys(example.coverage);

        assert.ok(excerptKeys.length > 0, 'The excerpt must demonstrate at least one coverage entry.');
        for (const key of excerptKeys) {
            assert.ok(ids.includes(key), `The excerpt named '${key}', which this request never supplied.`);
        }
        assert.ok(excerptKeys.length < ids.length, `The excerpt must stay partial, but it showed every supplied id.`);
        assert.deepEqual(
            ids.filter(id => !excerptKeys.includes(id)),
            ['D2'],
            'The excerpt must omit the middle hunk of this request.',
        );

        const parsed = createInvestigationPlanResponseSchema(ids, 4).safeParse({
            targets: example.targets,
            coverage: example.coverage,
            notes: example.notes,
        });

        assert.equal(parsed.success, false, 'The incomplete excerpt must not decode as this request\'s plan.');
        if (!parsed.success) {
            assert.deepEqual(
                parsed.error.issues.map(issue => [issue.path.join('.'), issue.code]),
                [['coverage.D2', 'invalid_type']],
                JSON.stringify(parsed.error.issues),
            );
        }
    });

    it('declares on both sides of a partial example JSON that the excerpt is not a valid plan', () => {
        // A response assembled by copying the excerpt has to be told the object is incomplete before and after the
        // JSON, because the line after it is where copying happens: a model that reads only the block's tail would
        // otherwise return the shown keys as its whole coverage and drop every hunk the excerpt omits. That claim is
        // only true while the excerpt really is a strict subset, so every size here supplies at least four ids: the
        // excerpt samples three keys, and below four the same sentence would deny an omission the model can see is
        // absent.
        for (const size of [4, 12]) {
            const ids = Array.from({ length: size }, (_, index) => `D${index + 1}`);
            const content = buildInvestigationPlanMessages({ evidence: evidenceWithIds(ids), maxToolCalls: 4 })
                .map(message => message.content)
                .join('\n');
            const { before, after } = plannerExampleProse(content);

            assert.ok(before.includes('coverage is incomplete on purpose'), before);
            assert.ok(before.includes('one entry for every D* id the schema supplies'), before);
            assert.ok(after.includes('not a valid plan for this request'), after);
            assert.ok(after.includes('one entry for every D* id the schema supplies'), after);
            // The complete-coverage wording belongs to the other branch: an excerpt that is partial for this request
            // must never tell the model the object above "happens to satisfy" it.
            assert.ok(!before.includes('happens to show every supplied D* id'), before);
            assert.ok(!after.includes('happens to satisfy this request'), after);
        }
    });

    it('states on both sides of a complete example JSON that its decisions are illustrative, not that it is invalid', () => {
        // When the request supplies at most three ids, the first/middle/last sample covers every one of them, so the
        // excerpt is a legal plan for this request. Calling it incomplete there would send the model looking for an
        // omission that does not exist, while the excerpt still has to be marked illustrative so its decisions are
        // never copied as an answer.
        for (const size of [1, 2, 3]) {
            const ids = Array.from({ length: size }, (_, index) => `D${index + 1}`);
            const content = buildInvestigationPlanMessages({ evidence: evidenceWithIds(ids), maxToolCalls: 4 })
                .map(message => message.content)
                .join('\n');
            const { before, after } = plannerExampleProse(content);

            // The premise of this branch: the excerpt really does show every supplied id, so the warning below would
            // be false rather than merely imprecise.
            assert.deepEqual(Object.keys(plannerExampleCoverage(content)).sort(), [...ids].sort());

            assert.ok(!before.includes('incomplete on purpose'), before);
            assert.ok(!before.includes('not a valid plan'), before);
            assert.ok(!after.includes('incomplete on purpose'), after);
            assert.ok(!after.includes('not a valid plan'), after);
            assert.ok(before.includes('happens to show every supplied D* id'), before);
            assert.ok(before.includes('must still carry one entry for each of them'), before);
            assert.ok(after.includes('happens to satisfy this request'), after);
            assert.ok(after.includes('one entry for every D* id the schema supplies'), after);
        }
    });

    it('renders exactly one coverage warning pair per request size, switching at the fourth id', () => {
        // The two warning pairs describe mutually exclusive requests: the excerpt is either the whole key set or a
        // strict subset of it. Whichever it is, the model must be told, so this walks the boundary — three ids are
        // fully sampled, four is the first size the three-key sample cannot cover — and requires each size to carry
        // the pair that is true for it and not the other, rather than only sampling one size from each branch.
        for (const size of [1, 2, 3, 4, 5, 8]) {
            const ids = Array.from({ length: size }, (_, index) => `D${index + 1}`);
            const content = buildInvestigationPlanMessages({ evidence: evidenceWithIds(ids), maxToolCalls: 4 })
                .map(message => message.content)
                .join('\n');
            const { before, after } = plannerExampleProse(content);
            const partial = size >= 4;

            assert.equal(
                before.includes('incomplete on purpose'),
                partial,
                `A ${size}-id request must ${partial ? '' : 'not '}be described as an incomplete excerpt.`,
            );
            assert.equal(
                after.includes('not a valid plan for this request'),
                partial,
                `A ${size}-id request must ${partial ? '' : 'not '}be called an invalid plan.`,
            );
            assert.equal(
                before.includes('happens to show every supplied D* id'),
                !partial,
                `A ${size}-id request must ${partial ? 'not ' : ''}be told the excerpt shows every supplied id.`,
            );
            assert.equal(
                after.includes('happens to satisfy this request'),
                !partial,
                `A ${size}-id request must ${partial ? 'not ' : ''}be told the excerpt satisfies it.`,
            );
        }
    });

    it('omits the repository map block entirely when the caller passes no map', () => {
        // The map is an optional input: without one the prompt must not render an empty block or a dangling tag,
        // because the model would read a missing inventory as an empty repository.
        const content = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        assert.doesNotMatch(content, /<repository_map>/);
        assert.doesNotMatch(content, /It is an inventory, not evidence/);
    });

    it('places the repository map before the raw diff evidence it is meant to orient', () => {
        // The map is described as an inventory rather than evidence and must precede the diff, so the model sees
        // where the change lives before deciding whether a repository-wide lookup is worth a call.
        const content = buildInvestigationPlanMessages({
            evidence,
            maxToolCalls: 4,
            repositoryMap: '12 files, 2 directories (.ts 10, .md 2)\nsrc  10 files   [1 changed]',
        })
            .map(message => message.content)
            .join('\n');

        assert.match(content, /<repository_map>\n12 files, 2 directories \(\.ts 10, \.md 2\)\nsrc  10 files {3}\[1 changed\]\nThis map locates structure outside the diff\. It is an inventory, not evidence: nothing in it has been read, and it never answers a question by itself\.\n<\/repository_map>/);
        assert.ok(
            content.indexOf('<repository_map>') < content.indexOf('<raw_diff_evidence>'),
            'The repository map must be rendered before the raw diff evidence.',
        );
    });

    it('guides executable repository questions without turning coverage into fact selection', () => {
        // The planner must ask for concrete evidence routes and keep must-express decisions outside coverage planning.
        const content = buildInvestigationPlanMessages({ evidence, maxToolCalls: 4 })
            .map(message => message.content)
            .join('\n');

        assert.match(content, /fewest questions that distinguish the correct commit-message claim/i);
        assert.match(content, /must name the concrete symbol, path, key, endpoint, or relation to inspect/);
        assert.match(content, /every question is answerable by the declared lookup of the target it belongs to/);
        assert.match(content, /symbol\/call/);
        assert.match(content, /config\/cli_or_api/);
        assert.match(content, /type\/interface/);
        assert.match(content, /file\/hunk\/relation/);
        assert.match(content, /a test file does not prove the test passed/i);
        assert.match(content, /Coverage preserves the diff/);
    });

    it('shows cumulative evidence and a deliberately static planned-question checklist', () => {
        // Tool results must report ledger progress while making clear that planned questions are not auto-marked as complete.
        const message = buildInvestigationToolResultMessage({
            tool: 'readFileContent',
            summary: 'Read the changed parser definition.',
            evidence: [{
                id: 'E1',
                kind: 'definition',
                target: 'parse',
                ref: 'src/parser.ts:1-4',
                excerpt: 'function parse(input) { return input; }',
            }],
            repositoryEvidenceCount: 2,
            remainingSteps: 1,
            plannedQuestions: ['parse: Who calls parse?', 'parse: Which config controls it?'],
        });

        assert.match(message.content, /Repository evidence collected so far: 2 E\* item\(s\)/);
        assert.match(message.content, /Planned-question checklist: parse: Who calls parse\? \| parse: Which config controls it\?/);
        assert.match(message.content, /checklist is not automatically updated/i);
        assert.doesNotMatch(message.content, /Open questions:/);
        assert.match(message.content, /Call finishInvestigation now/i);
        assert.match(message.content, /leave any unanswered question unresolved/i);
    });

    it('requires a real evidence-producing lookup before finishing a non-empty investigation', () => {
        // A zero-E* result must steer the agent away from finishInvestigation and away from navigation-only tools.
        const message = buildInvestigationToolResultMessage({
            tool: 'listDirectory',
            summary: 'Listed one directory.',
            evidence: [],
            repositoryEvidenceCount: 0,
            remainingSteps: 2,
            plannedQuestions: ['parse: Who calls parse?'],
        });

        assert.match(message.content, /Do not call finishInvestigation yet/i);
        assert.match(message.content, /evidence-producing read or content search/i);
        assert.match(message.content, /listDirectory, searchRepositoryMemory, and searchCode with searchType "name" do not themselves publish E\* evidence/i);
    });

    it('spends the last repository call on evidence when no E* exists and then lets runtime finalize', () => {
        // With one call left and no repository evidence, the tool result must require one evidence lookup before runtime closes the phase.
        const message = buildInvestigationToolResultMessage({
            tool: 'searchCode',
            summary: 'The search returned no matching source.',
            evidence: [],
            repositoryEvidenceCount: 0,
            remainingSteps: 1,
            plannedQuestions: ['parse: Who calls parse?'],
        });

        assert.match(message.content, /Only one repository call remains and no E\* evidence exists/i);
        assert.match(message.content, /Use that final call on the highest-priority evidence-producing read or search/i);
        assert.match(message.content, /runtime will then close investigation and continue/i);
        assert.doesNotMatch(message.content, /Call finishInvestigation now/i);
    });
});

/** The body of the prompt's <minimal_example> block: the excerpt JSON plus the prose around it. */
function plannerExampleBlock(prompt: string): string {
    const block = prompt.match(/<minimal_example>\n([\s\S]*?)\n<\/minimal_example>/);
    assert.ok(block, 'The planner prompt must contain a <minimal_example> block.');
    return block[1];
}

/**
 * Splits the <minimal_example> block into the prose before and after its
 * embedded excerpt JSON — the two places a model copying the excerpt reads the
 * statement about what that excerpt is, so both have to be checked separately.
 */
function plannerExampleProse(prompt: string): { before: string; after: string } {
    const block = plannerExampleBlock(prompt);
    const jsonStart = block.indexOf('{');
    const jsonEnd = block.lastIndexOf('}') + 1;

    assert.ok(
        jsonStart > 0 && jsonEnd > jsonStart && jsonEnd < block.length,
        'The excerpt JSON must be embedded in prose on both sides.',
    );
    return { before: block.slice(0, jsonStart), after: block.slice(jsonEnd) };
}

/**
 * Parses the prompt's <minimal_example> JSON so a test can assert the excerpt
 * shape instead of grepping whole lines.
 */
function plannerExample(prompt: string): {
    targets: Array<{ lookup?: string }>;
    coverage: Record<string, unknown>;
    notes: string | null;
} {
    const block = plannerExampleBlock(prompt);
    const json = block.slice(block.indexOf('{'), block.lastIndexOf('}') + 1);
    const example = JSON.parse(json) as {
        targets?: Array<{ lookup?: string }>;
        coverage?: Record<string, unknown>;
        notes?: string | null;
    };
    assert.ok(example.coverage, 'The planner example must demonstrate the coverage object.');
    assert.ok(example.targets, 'The planner example must demonstrate the targets array.');
    return { targets: example.targets, coverage: example.coverage, notes: example.notes ?? null };
}

/** The coverage object of the prompt's example, for tests that only inspect the excerpt keys. */
function plannerExampleCoverage(prompt: string): Record<string, unknown> {
    return plannerExample(prompt).coverage;
}

/** Raw-diff evidence carrying the given D* ids, for requests wider than the single-hunk shared fixture. */
function evidenceWithIds(ids: readonly string[]): DraftEvidence[] {
    return [{
        kind: 'raw',
        fileName: 'src/custom.ts',
        status: 'modified',
        evidenceIds: [...ids],
        rawDiff: '@@ -1 +1 @@\n-old\n+new',
    }];
}

/**
 * Builds the coverage object the request-scoped schema requires: the excerpt's
 * own values are copied verbatim and every key it omits takes the quiet default.
 */
function completeCoverage(ids: readonly string[], excerpt: Record<string, unknown>): Record<string, unknown> {
    const coverage: Record<string, unknown> = {};
    for (const id of ids) {
        coverage[id] = excerpt[id] ?? { decision: 'diff_sufficient', targetIds: [] };
    }
    return coverage;
}
