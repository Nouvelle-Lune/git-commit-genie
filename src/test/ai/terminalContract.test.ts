import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { createChangeAnalysisProfile } from '../../services/analysis/change/investigation/changeAnalysisProfile';
import { terminalContractExample } from '../../services/analysis/change/investigation/terminalContract';
import { changeAnalysisAgentFinalResponseSchema } from '../../services/llm/providers/schemas/common';
import { RepositorySnapshotReader } from '../../services/git/repositorySnapshot';

describe('terminal contract regression', () => {
    it('keeps the documented example valid against the terminal schema', () => {
        const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(JSON.parse(terminalContractExample()));
        assert.equal(parsed.success, true);
    });

    it('uses the two-phase short-memory-ID profile version and cache identity', () => {
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

        assert.equal(profile.promptVersion, '5');
        assert.equal(profile.toolsetVersion, 'snapshot-memory-handles-3');
        assert.match(
            `agent:${profile.id}:${profile.promptVersion}:${profile.toolsetVersion}:gpt-5`,
            /^agent:change-analysis:5:snapshot-memory-handles-3:/,
        );
    });

    it('keeps investigation prompts free of terminal JSON contract text', () => {
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
    });
});
