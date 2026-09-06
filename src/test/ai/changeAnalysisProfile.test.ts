import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { AgentRunState, EvidenceLedger } from '../../agent';
import {
    ChangeAnalysisAgentInput,
    createChangeAnalysisProfile,
} from '../../services/analysis/change/investigation/changeAnalysisProfile';
import { RepositorySnapshotReader } from '../../services/git/repositorySnapshot';
import { changeAnalysisAgentFinalResponseSchema } from '../../services/llm/providers/schemas/common';

describe('ChangeAnalysisProfile terminal normalization', () => {
    it('omits claims whose references are all invalid and leaves mustExpress empty', () => {
        const input = makeInput();
        const profile = createChangeAnalysisProfile(input);
        const raw = changeAnalysisAgentFinalResponseSchema.parse({
            investigation: {
                findings: [],
                unresolvedQuestions: [],
                stopReason: 'No repository evidence was needed.',
            },
            changeTargets: [],
            dependencyContext: {
                callers: [],
                callees: [],
                stateDependencies: [],
                relatedConfigs: [],
                relatedTypes: [],
            },
            claims: [{
                category: 'supported_inference',
                claim: 'improves product reliability',
                evidenceRefs: ['E404'],
                disposition: 'must_express',
            }],
            behaviorAnalysis: { before: null, after: null, observableEffect: null },
            capabilityContext: { technicalCapability: null, productCapability: 'reliability' },
            intentAnalysis: { primaryIntent: 'improve reliability', supportedBy: ['E404'], confidence: 'high' },
            changeClassification: {
                existingBehaviorCorrected: false,
                newCapabilityAdded: false,
                externalBehaviorChanged: false,
                structuralOnly: true,
                recommendedType: 'refactor',
                reason: null,
            },
            suggestedScope: null,
            selectionNotes: null,
            uncertainties: [],
        });
        const state = makeState();

        const output = profile.normalizeFinal(raw, state);

        assert.equal(output.analysisStatus, 'degraded');
        assert.deepEqual(output.informationSelection.mustExpress, []);
        assert.deepEqual(output.informationSelection.optional, []);
        assert.ok(output.informationSelection.omit.includes('improves product reliability'));
        assert.equal(output.semanticAnalysis.supportedInferences.length, 0);
        assert.equal(output.semanticAnalysis.capabilityContext.productCapability, null);
        assert.ok(output.issues.some(issue => issue.includes('E404')));
    });

    it('preserves valid claims without degrading the analysis when extra references are unknown', () => {
        const profile = createChangeAnalysisProfile(makeInput());
        const raw = changeAnalysisAgentFinalResponseSchema.parse({
            ...minimalRaw(),
            claims: [
                {
                    category: 'observed_change',
                    claim: 'changes the parser branch',
                    evidenceRefs: ['D1', 'D999'],
                    disposition: 'must_express',
                },
                {
                    category: 'repository_fact',
                    claim: 'has external callers',
                    evidenceRefs: ['E1'],
                    disposition: 'optional',
                },
            ],
        });
        const state = makeState();
        state.ledger.recordRepositoryEvidence({
            id: 'E1',
            kind: 'references',
            target: 'parse',
            ref: 'src/parser.ts:2',
            excerpt: 'parse(input)',
        });

        const output = profile.normalizeFinal(raw, state);

        assert.equal(output.analysisStatus, 'complete');
        assert.deepEqual(output.informationSelection.mustExpress, ['changes the parser branch']);
        assert.deepEqual(output.semanticAnalysis.repositoryFacts.map(claim => claim.evidenceRefs), [['E1']]);
        assert.ok(output.issues.some(issue => issue.includes('D999')));
        assert.deepEqual(output.claims.map(claim => claim.id), ['C1', 'C2']);
    });

    it('preserves compatible evidence without degrading when a claim also contains a wrong-kind reference', () => {
        const profile = createChangeAnalysisProfile(makeInput());
        const raw = changeAnalysisAgentFinalResponseSchema.parse({
            ...minimalRaw(),
            claims: [{
                category: 'repository_fact',
                claim: 'the parser has external callers',
                evidenceRefs: ['D1', 'E1'],
                disposition: 'optional',
            }],
        });
        const state = makeState();
        state.ledger.recordRepositoryEvidence({
            id: 'E1',
            kind: 'references',
            target: 'parse',
            ref: 'src/client.ts:4',
            excerpt: 'parse(input)',
        });

        const output = profile.normalizeFinal(raw, state);

        assert.equal(output.analysisStatus, 'complete');
        assert.deepEqual(output.semanticAnalysis.repositoryFacts[0].evidenceRefs, ['E1']);
        assert.deepEqual(output.informationSelection.optional, ['the parser has external callers']);
        assert.ok(output.issues.some(issue => issue.includes("incompatible with 'repository_fact': D1")));
    });

    it('rejects claim categories that have no compatible evidence kind', () => {
        const terminal = {
            ...minimalRaw(),
            claims: [{
                category: 'repository_fact',
                claim: 'the localization string changed',
                evidenceRefs: ['D1'],
                disposition: 'must_express',
            }],
        };

        const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(terminal);

        assert.equal(parsed.success, false);
        if (!parsed.success) {
            assert.match(parsed.error.message, /repository_fact requires at least one E\*/);
        }
    });

    it('requires evidence for supported inferences and omits uncertain inferences', () => {
        const unsupported = changeAnalysisAgentFinalResponseSchema.safeParse({
            ...minimalRaw(),
            claims: [{
                category: 'supported_inference',
                claim: 'the change improves reliability',
                evidenceRefs: [],
                disposition: 'must_express',
            }],
        });
        assert.equal(unsupported.success, false);
        if (!unsupported.success) {
            assert.match(unsupported.error.message, /supported_inference requires at least one/);
        }

        const nonOmittedUncertainty = changeAnalysisAgentFinalResponseSchema.safeParse({
            ...minimalRaw(),
            claims: [{
                category: 'uncertain_inference',
                claim: 'the change may improve reliability',
                evidenceRefs: ['D1'],
                disposition: 'optional',
            }],
        });
        assert.equal(nonOmittedUncertainty.success, false);
        if (!nonOmittedUncertainty.success) {
            assert.match(nonOmittedUncertainty.error.message, /uncertain_inference must use the omit disposition/);
        }
    });

    it('requires repository evidence before accepting a terminal for a non-empty plan', () => {
        const input = makeInput();
        input.plan = {
            targets: [{
                target: 'parse',
                kind: 'symbol',
                file: 'src/parser.ts',
                questions: ['Who calls parse?'],
            }],
            notes: null,
        };
        const profile = createChangeAnalysisProfile(input);
        const state = makeState();

        assert.match(profile.validateTerminal?.(minimalRaw(), state) ?? '', /no E\* repository evidence/);

        state.ledger.recordRepositoryEvidence({
            id: 'E1',
            kind: 'callers',
            target: 'parse',
            ref: 'src/client.ts:4',
            excerpt: 'parse(input)',
        });
        assert.equal(profile.validateTerminal?.(minimalRaw(), state), null);
    });

    it('allows a terminal without repository evidence when the plan is empty', () => {
        const profile = createChangeAnalysisProfile(makeInput());

        assert.equal(profile.validateTerminal?.(minimalRaw(), makeState()), null);
    });

    it('marks invalid references in targets and intent as degraded instead of silently dropping them', () => {
        const profile = createChangeAnalysisProfile(makeInput());
        const raw = changeAnalysisAgentFinalResponseSchema.parse({
            ...minimalRaw(),
            changeTargets: [{
                symbol: 'parse',
                file: 'src/parser.ts',
                role: 'changed function',
                evidenceRefs: ['D404'],
            }],
            intentAnalysis: {
                primaryIntent: 'make parsing deterministic',
                supportedBy: ['E404'],
                confidence: 'high',
            },
        });

        const output = profile.normalizeFinal(raw, makeState());

        assert.equal(output.analysisStatus, 'degraded');
        assert.equal(output.semanticAnalysis.changeTargets[0].evidenceRefs.length, 0);
        assert.deepEqual(output.semanticAnalysis.intentAnalysis.supportedBy, []);
        assert.ok(output.issues.some(issue => issue.includes('changeTargets')));
        assert.ok(output.issues.some(issue => issue.includes('supportedBy')));
    });

    it('requires findings to cite repository evidence while preserving valid mixed references', () => {
        const input = makeInput();
        const profile = createChangeAnalysisProfile(input);
        const state = makeState();
        state.ledger.recordRepositoryEvidence({
            id: 'E1',
            kind: 'search',
            target: 'parse',
            ref: 'src/client.ts:4',
            excerpt: 'parse(input)',
        });

        const terminal = changeAnalysisAgentFinalResponseSchema.safeParse({
            ...minimalRaw(),
            investigation: {
                findings: [{
                    target: 'parse',
                    question: 'Who calls parse?',
                    answer: 'The client calls parse.',
                    evidenceRefs: ['E1', 'D1'],
                }],
                unresolvedQuestions: [],
                stopReason: 'Enough evidence.',
            },
        });
        assert.equal(terminal.success, true);
        if (!terminal.success) {
            return;
        }

        const diffOnlyTerminal = changeAnalysisAgentFinalResponseSchema.safeParse({
            ...minimalRaw(),
            investigation: {
                findings: [{
                    target: 'parse',
                    question: 'Who calls parse?',
                    answer: 'The client calls parse.',
                    evidenceRefs: ['D1'],
                }],
                unresolvedQuestions: [],
                stopReason: 'Enough evidence.',
            },
        });
        assert.equal(diffOnlyTerminal.success, false);

        const output = profile.normalizeFinal(terminal.data, state);

        assert.deepEqual(output.repositoryEvidence.findings[0].evidenceRefs, ['E1']);
        assert.equal(output.analysisStatus, 'complete');
        assert.ok(output.issues.some(issue => issue.includes("Investigation finding 'Who calls parse?' used evidence incompatible")));
    });
});

function makeInput(): ChangeAnalysisAgentInput {
    return {
        extraction: {
            changedFiles: [{ path: 'src/parser.ts', changeType: 'modified' }],
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
}

function makeState(): AgentRunState {
    const diff = {
        fileName: 'src/parser.ts',
        status: 'modified' as const,
        rawDiff: '@@ -1 +1 @@\n-old\n+new',
        diffHunks: [{
            header: '@@ -1 +1 @@',
            content: '-old\n+new',
            additions: ['new'],
            deletions: ['old'],
        }],
    };
    return {
        ledger: EvidenceLedger.fromDiffs([diff]),
        observations: [],
        issues: [],
        usages: [],
        apiCalls: 0,
        steps: 0,
        epoch: 0,
        stopReason: '',
    };
}

function minimalRaw() {
    return {
        investigation: {
            findings: [],
            unresolvedQuestions: [],
            stopReason: 'Enough evidence.',
        },
        changeTargets: [],
        dependencyContext: {
            callers: [],
            callees: [],
            stateDependencies: [],
            relatedConfigs: [],
            relatedTypes: [],
        },
        claims: [],
        behaviorAnalysis: { before: null, after: null, observableEffect: null },
        capabilityContext: { technicalCapability: null, productCapability: null },
        intentAnalysis: { primaryIntent: null, supportedBy: [], confidence: 'low' as const },
        changeClassification: {
            existingBehaviorCorrected: false,
            newCapabilityAdded: false,
            externalBehaviorChanged: false,
            structuralOnly: true,
            recommendedType: 'refactor',
            reason: null,
        },
        suggestedScope: null,
        selectionNotes: null,
        uncertainties: [],
    };
}
