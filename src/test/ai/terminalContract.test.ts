import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { createChangeAnalysisProfile } from '../../services/analysis/change/investigation/changeAnalysisProfile';
import { buildCorrectionLines, terminalContractExample } from '../../services/analysis/change/investigation/terminalContract';
import { changeAnalysisAgentFinalResponseSchema } from '../../services/llm/providers/schemas/common';
import { RepositorySnapshotReader } from '../../services/git/repositorySnapshot';

describe('terminal contract regression', () => {
    it('keeps the documented example valid against the terminal schema', () => {
        // The documented terminal example must remain a complete valid response after contract changes.
        const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(JSON.parse(terminalContractExample()));
        assert.equal(parsed.success, true);
    });

    it('uses the two-phase short-memory-ID profile version and cache identity', () => {
        // The finalization profile must retain its two-phase prompt and cache identity contract.
        const input = {
            extraction: {
                changedFiles: [{ path: 'src/parser.ts', changeType: 'modified' as const }],
                changedSymbols: [],
                introducedSymbols: [],
                removedSymbols: [],
                changedCalls: [],
                changedConfigs: [],
                changedTypes: [],
                changedDependencies: [],
            },
            plan: { targets: [], notes: null },
            snapshot: {} as RepositorySnapshotReader,
            repositoryPath: '/tmp/repository',
            excludePatterns: [],
            evidence: [],
            maxSteps: 2,
        };
        const profile = createChangeAnalysisProfile(input);

        assert.equal(profile.promptVersion, '6');
        assert.equal(profile.toolsetVersion, 'snapshot-memory-handles-3');
        assert.match(
            `agent:${profile.id}:${profile.promptVersion}:${profile.toolsetVersion}:gpt-5`,
            /^agent:change-analysis:6:snapshot-memory-handles-3:/,
        );
    });

    it('keeps investigation prompts free of terminal JSON contract text', () => {
        // Investigation messages must stay tool-focused while the closed-tools finalization message carries the terminal contract.
        const input = {
            extraction: {
                changedFiles: [{ path: 'src/parser.ts', changeType: 'modified' as const }],
                changedSymbols: [],
                introducedSymbols: [],
                removedSymbols: [],
                changedCalls: [],
                changedConfigs: [],
                changedTypes: [],
                changedDependencies: [],
            },
            plan: { targets: [], notes: null },
            snapshot: {} as RepositorySnapshotReader,
            repositoryPath: '/tmp/repository',
            excludePatterns: [],
            evidence: [],
            maxSteps: 2,
        };
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
                expected: '^E\\d+$',
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
