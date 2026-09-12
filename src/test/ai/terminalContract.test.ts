import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { createChangeAnalysisProfile } from '../../services/analysis/change/investigation/changeAnalysisProfile';
import {
    buildCorrectionLines,
    buildInvestigationProtocolLines,
    terminalContractExample,
} from '../../services/analysis/change/investigation/terminalContract';
import { changeAnalysisAgentFinalResponseSchema } from '../../services/llm/providers/schemas/common';
import { RepositorySnapshotReader } from '../../services/git/repositorySnapshot';

describe('terminal contract regression', () => {
    it('keeps the documented example valid against the terminal schema', () => {
        // The documented terminal example must remain a complete valid response after contract changes.
        const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(JSON.parse(terminalContractExample()));
        assert.equal(parsed.success, true);
    });

    it('uses the two-phase short-memory-ID profile version and cache identity', () => {
        // The finalization profile must retain its two-phase prompt and cache identity contract; the version is
        // bumped whenever the investigation prompt contract changes, so a cached prompt is never reused across it.
        const input = makeInput();
        const profile = createChangeAnalysisProfile(input);

        assert.equal(profile.promptVersion, '11');
        assert.equal(profile.toolsetVersion, 'snapshot-memory-experience-2');
        assert.match(
            `agent:${profile.id}:${profile.promptVersion}:${profile.toolsetVersion}:gpt-5`,
            /^agent:change-analysis:11:snapshot-memory-experience-2:/,
        );
    });

    it('asks for a locating lookup in the evidence precondition correction and offers readFileContent only as a caveat', () => {
        // A read-only investigation cannot satisfy a plan that declared a locating lookup, so the correction lists
        // the locating tools as the repair and demotes readFileContent to the explanation of why a read is not one.
        const lines = buildCorrectionLines({
            stage: 'investigation',
            category: 'evidencePrecondition',
            message: 'No locating lookup has published E* evidence yet.',
            fieldIssues: [],
        }, 'finishInvestigation');
        const correction = lines.join('\n');
        const toolListLine = lines.find(line => line.startsWith('Use the highest-priority concrete path or symbol'));

        assert.ok(toolListLine, correction);
        assert.match(toolListLine, /findSymbolDefinition/);
        assert.match(toolListLine, /findSymbolReferences/);
        assert.match(toolListLine, /findCallers/);
        assert.match(toolListLine, /findCallees/);
        assert.match(toolListLine, /findImplementations/);
        assert.match(toolListLine, /findTypeDefinition/);
        assert.match(toolListLine, /searchCode\.$/);
        assert.doesNotMatch(toolListLine, /readFileContent/);
        assert.match(
            correction,
            /readFileContent publishes E\* evidence too, but it returns no relation the diff does not already show, so on its own it cannot satisfy a plan whose targets declare a locating lookup\./,
        );
        assert.match(correction, /listDirectory, searchRepositoryMemory, and searchCode with searchType "name" are navigation-only/);
    });

    it('teaches the investigation agent a bounded evidence-first exploration route', () => {
        // The investigation protocol must guide narrow repository exploration without claiming that search alone proves absence.
        const protocol = buildInvestigationProtocolLines('finishInvestigation').join('\n');

        assert.match(protocol, /plan targets in their listed priority order/i);
        assert.match(protocol, /exact changed symbol/i);
        assert.match(protocol, /callers, callees, implementations, configuration, or tests/i);
        assert.match(protocol, /after snapshot by default/i);
        assert.match(protocol, /before only when/i);
        assert.match(protocol, /empty search is not proof/i);
        assert.match(protocol, /Do not repeat the same tool call, tour unrelated directories/i);
        assert.match(protocol, /Successful evidence-producing reads and searches publish E\*/i);
        assert.match(protocol, /empty, failed, or navigation-only results publish none/i);
        assert.match(protocol, /searchCode with searchType "name" (?:is|are) navigation-only/i);
    });

    it('keeps investigation prompts free of terminal JSON contract text', () => {
        // Investigation messages must stay tool-focused while the closed-tools finalization message carries the terminal contract.
        const input = makeInput();
        const profile = createChangeAnalysisProfile(input);
        const investigation = [
            ...profile.buildPrompt(input).stable,
            ...profile.buildPrompt(input).opening,
        ].map(message => message.content).join('\n');
        const finalization = profile.buildFinalizationRequest(input, {
            ledger: { snapshot: () => [] } as any,
            observations: [],
            issues: [],
            usages: [],
            apiCalls: 0,
            steps: 0,
            epoch: 0,
            stopReason: '',
        }, 'done').map(message => message.content).join('\n');

        assert.match(investigation, /finishInvestigation/);
        assert.doesNotMatch(investigation, /<output_structure>/);
        assert.match(finalization, /<output_structure>/);
        assert.match(finalization, /<reference_counts>/);
        assert.match(finalization, /Diff evidence ids:/);
        assert.match(finalization, /Repository evidence ids:/);
        assert.match(finalization, /D\* and E\*.*cannot be used interchangeably/i);
        assert.match(finalization, /finding contains D\*.*(?:remove|move).*unresolvedQuestions/i);
        assert.match(finalization, /conclusion combines diff and repository evidence.*supported_inference/i);
        assert.match(finalization, /supported_inference claim evidenceRefs: one or more D\* and\/or E\* ids/i);
        assert.match(finalization, /self[-_ ]check/i);
    });

    it('gives findings schema retries concrete namespace repair actions', () => {
        // A D-only finding rejection must direct the model to use real E* evidence or route the question to unresolvedQuestions.
        const correction = buildCorrectionLines({
            stage: 'finalization',
            category: 'schemaMismatch',
            message: 'Terminal did not satisfy its schema.',
            fieldIssues: [{
                path: 'investigation.findings[0].evidenceRefs[0]',
                kind: 'invalidFormat',
                expected: '^E[0-9]+$',
                actual: '"D1"',
            }],
        }, 'finishInvestigation').join('\n');

        assert.match(correction, /(?:D\*|D-only)/i);
        assert.match(correction, /(?:move|remove).{0,100}(?:finding|findings)/i);
        assert.match(correction, /(?:real|valid|actual) E\*/i);
        assert.match(correction, /unresolvedQuestions/i);
        assert.match(correction, /do not relax.{0,100}finding E\* rule/i);
    });
});

function makeInput() {
    return {
        rawDiff: [{
            kind: 'raw' as const,
            fileName: 'src/parser.ts',
            status: 'modified' as const,
            evidenceIds: ['D1'],
            rawDiff: '@@ -1 +1 @@\n-old\n+new',
        }],
        plan: {
            targets: [],
            coverage: { D1: { decision: 'diff_sufficient' as const, targetIds: [] } },
            notes: null,
        },
        snapshot: {} as RepositorySnapshotReader,
        repositoryPath: '/tmp/repository',
        excludePatterns: [],
        evidence: [],
        maxSteps: 2,
    };
}
