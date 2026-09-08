import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { AgentRunState, EvidenceLedger } from '../../agent';
import {
    ChangeAnalysisAgentInput,
    createChangeAnalysisProfile,
} from '../../services/analysis/change/investigation/changeAnalysisProfile';
import { RepositorySnapshotReader } from '../../services/git/repositorySnapshot';
import {
    AGENT_TERMINAL_LIMITS,
    changeAnalysisAgentFinalResponseSchema,
} from '../../services/llm/providers/schemas/common';
import { MEMORY_DEFAULTS, MemoryRequestError } from '../../services/memory/settings';

describe('ChangeAnalysisProfile terminal normalization', () => {
    it('exposes the runtime grant limits in every repository tool schema', () => {
        const input = makeInput();
        const profile = createChangeAnalysisProfile(input);
        const definitions = profile.buildToolDefinitions(input, makeState());
        const byName = new Map(definitions.map(definition => [definition.name, definition]));

        const readFileParameters = byName.get('readFileContent')?.parameters;
        const readFileProperties = readFileParameters?.properties as Record<string, any>;
        assert.equal(readFileProperties.maxLines.anyOf[0].maximum, 400);
        assert.match(byName.get('readFileContent')?.description ?? '', /400/);

        for (const definition of definitions) {
            const properties = definition.parameters.properties as Record<string, any> | undefined;
            if (properties?.maxResults) {
                assert.equal(properties.maxResults.anyOf[0].maximum, 50, definition.name);
                assert.match(definition.description, /50/);
            }
        }
    });

    it('returns summaries and evidence counts for both memory tool definitions', async () => {
        // Verify the memory tools expose structured navigation and current source counts through their public result envelopes.
        const navigation = [{
            id: 'M1',
            origin: 'handbook' as const,
            situation: 'When parser behavior changes, inspect the parser entry point.',
            targetPaths: ['src/parser.ts'],
            steps: [{ path: 'src/parser.ts', symbol: 'parse', purpose: 'Inspect the parser entry point.', operation: 'readFileContent' }],
            lessons: [],
            sourceCount: 1,
            observationCount: 1,
            snapshotCount: 2,
        }];
        const source = {
            snapshotId: 'snapshot-1',
            path: 'src/parser.ts',
            side: 'after' as const,
            blobOid: 'blob-1',
            startLine: 2,
            endLine: 3,
            excerpt: 'parse(input)',
            contentHash: 'hash-1',
            truncated: false,
            sourceType: 'text' as const,
        };
        const memory = {
            settings: MEMORY_DEFAULTS,
            budget: { used: 0, remaining: 16, limit: 16, searchesUsed: 1, searchesRemaining: 2, navigationTokens: 1500, resultTokens: 4096 },
            searchRepositoryMemory: async () => navigation,
            readMemorySources: async (memoryIds: string[]) => {
                assert.deepEqual(memoryIds, ['M1']);
                return [{ key: 'source-key', status: 'source_unchanged' as const, source }];
            },
            assertResultBudget: () => undefined,
        };
        const input = { ...makeInput(), memory: memory as any };
        const profile = createChangeAnalysisProfile(input);
        const definitions = profile.buildToolDefinitions(input, makeState());
        const search = definitions.find(definition => definition.name === 'searchRepositoryMemory');
        const read = definitions.find(definition => definition.name === 'readMemorySources');
        assert.ok(search);
        assert.ok(read);

        const context = {
            input,
            grant: { name: 'searchRepositoryMemory', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: false },
            ledger: new EvidenceLedger(),
            state: makeState(),
            allocateEvidence: (evidence: Record<string, unknown>) => ({ id: 'E1', ...evidence }),
        } as any;
        const searchOutcome = await search!.execute(context, { query: 'parse' });
        assert.equal(searchOutcome.ok, true);
        assert.equal(searchOutcome.evidenceCount, 0);
        assert.match(searchOutcome.summary ?? '', /1 historical navigation/);
        assert.deepEqual(JSON.parse(searchOutcome.output).navigation, navigation);

        const readOutcome = await read!.execute(context, { memoryIds: ['M1'] });
        assert.equal(readOutcome.ok, true);
        assert.equal(readOutcome.evidenceCount, 1);
        assert.match(readOutcome.summary ?? '', /1\/1 source/);
        assert.deepEqual(JSON.parse(readOutcome.output).statuses, ['source_unchanged']);
    });

    it('records a rejected memory request and returns an in-band structured tool error', async () => {
        const records: Array<Record<string, unknown>> = [];
        const memory = {
            settings: MEMORY_DEFAULTS,
            budget: { used: 0, remaining: 16, limit: 16, searchesUsed: 0, searchesRemaining: 3, navigationTokens: 1500, resultTokens: 4096 },
            reject: (code: MemoryRequestError['code'], message: string): never => {
                throw new MemoryRequestError(code, message, { used: 0, remaining: 16, limit: 16 });
            },
            readMemorySources: async (): Promise<never> => {
                throw new MemoryRequestError('unknown_memory_id', 'Unknown Memory navigation ID: M404.', { memoryId: 'M404' });
            },
        };
        const input = {
            ...makeInput(),
            memory: memory as any,
            recorder: { record: (observation: Record<string, unknown>) => records.push(observation) } as any,
        };
        const profile = createChangeAnalysisProfile(input);
        const read = profile.buildToolDefinitions(input, makeState()).find(definition => definition.name === 'readMemorySources');
        assert.ok(read);

        const outcome = await read!.execute({
            input,
            grant: { name: 'readMemorySources', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: true },
            ledger: new EvidenceLedger(),
            state: makeState(),
            allocateEvidence: () => { throw new Error('Memory evidence must be ledger-owned.'); },
        } as any, { memoryIds: ['M404'] });

        assert.equal(outcome.ok, false);
        assert.equal(outcome.preserveOutput, true);
        assert.equal(JSON.parse(outcome.output).error.code, 'unknown_memory_id');
        assert.equal(records.length, 1);
        assert.equal(records[0].ok, false);
        assert.equal(records[0].tool, 'readMemorySources');
    });

    it('rejects the legacy supports argument through the memory tool schema', async () => {
        const records: Array<Record<string, unknown>> = [];
        const memory = {
            settings: MEMORY_DEFAULTS,
            budget: { used: 0, remaining: 16, limit: 16, searchesUsed: 0, searchesRemaining: 3, navigationTokens: 1500, resultTokens: 4096 },
            reject: (code: MemoryRequestError['code'], message: string): never => {
                throw new MemoryRequestError(code, message, { used: 0, remaining: 16, limit: 16 });
            },
            readMemorySources: async (): Promise<never> => { throw new Error('legacy supports must not reach the retriever'); },
        };
        const input = {
            ...makeInput(),
            memory: memory as any,
            recorder: { record: (observation: Record<string, unknown>) => records.push(observation) } as any,
        };
        const profile = createChangeAnalysisProfile(input);
        const read = profile.buildToolDefinitions(input, makeState()).find(definition => definition.name === 'readMemorySources');
        assert.ok(read);

        const outcome = await read!.execute({
            input,
            grant: { name: 'readMemorySources', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: true },
            ledger: new EvidenceLedger(),
            state: makeState(),
            allocateEvidence: () => { throw new Error('Memory evidence must be ledger-owned.'); },
        } as any, { supports: [{ episodeId: 'uuid', evidenceId: 'E1' }] });

        assert.equal(outcome.ok, false);
        assert.equal(JSON.parse(outcome.output).error.code, 'invalid_arguments');
        assert.equal(records.length, 1);
        assert.equal(records[0].ok, false);
    });

    it('reuses the same E id when a repeatable memory source is read again', async () => {
        const source = {
            snapshotId: 'snapshot-1',
            path: 'src/parser.ts',
            side: 'after' as const,
            blobOid: 'blob-1',
            startLine: 2,
            endLine: 3,
            excerpt: 'parse(input)',
            contentHash: 'hash-1',
            truncated: false,
            sourceType: 'text' as const,
        };
        const records: Array<Record<string, any>> = [];
        let calls = 0;
        const memory = {
            settings: MEMORY_DEFAULTS,
            budget: { used: 1, remaining: 15, limit: 16, searchesUsed: 0, searchesRemaining: 3, navigationTokens: 1500, resultTokens: 4096 },
            readMemorySources: async () => { calls += 1; return [{ key: 'same-source', status: 'source_unchanged' as const, source }]; },
            assertResultBudget: () => undefined,
        };
        const input = {
            ...makeInput(),
            memory: memory as any,
            recorder: { record: (observation: Record<string, unknown>) => records.push(observation) } as any,
        };
        const profile = createChangeAnalysisProfile(input);
        const read = profile.buildToolDefinitions(input, makeState()).find(definition => definition.name === 'readMemorySources');
        assert.ok(read);
        const context = {
            input,
            grant: { name: 'readMemorySources', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: true },
            ledger: new EvidenceLedger(),
            state: makeState(),
            allocateEvidence: () => { throw new Error('Memory evidence must be ledger-owned.'); },
        } as any;

        const first = await read!.execute(context, { memoryIds: ['M1'] });
        const second = await read!.execute(context, { memoryIds: ['M1'] });
        assert.equal(calls, 2);
        assert.equal(first.evidenceCount, 1);
        assert.equal(second.evidenceCount, 1);
        assert.equal(JSON.parse(first.output).evidence[0].id, 'E1');
        assert.equal(JSON.parse(second.output).evidence[0].id, 'E1');
        assert.equal(records.length, 2);
        assert.equal(records[0].evidence[0].id, 'E1');
        assert.deepEqual(records[1].evidence, []);
    });

    it('returns an explicit result-budget error without publishing any E ledger evidence', async () => {
        const source = {
            snapshotId: 'snapshot-1',
            path: 'src/parser.ts',
            side: 'after' as const,
            blobOid: 'blob-1',
            startLine: 2,
            endLine: 3,
            excerpt: 'parse(input)',
            contentHash: 'hash-1',
            truncated: false,
            sourceType: 'text' as const,
        };
        const records: Array<Record<string, any>> = [];
        let serializedResult = '';
        const memory = {
            settings: MEMORY_DEFAULTS,
            budget: { used: 1, remaining: 15, limit: 16, searchesUsed: 0, searchesRemaining: 3, navigationTokens: 1500, resultTokens: 1 },
            readMemorySources: async () => [{ key: 'oversized-source', status: 'source_unchanged' as const, source }],
            assertResultBudget: (output: string): never => {
                serializedResult = output;
                throw new MemoryRequestError('result_budget_exceeded', 'Memory result exceeds its token budget; request fewer memoryIds.', {
                    requested: 20,
                    limit: 1,
                });
            },
        };
        const input = {
            ...makeInput(),
            memory: memory as any,
            recorder: { record: (observation: Record<string, unknown>) => records.push(observation) } as any,
        };
        const profile = createChangeAnalysisProfile(input);
        const read = profile.buildToolDefinitions(input, makeState()).find(definition => definition.name === 'readMemorySources');
        assert.ok(read);
        const ledger = new EvidenceLedger();

        const outcome = await read!.execute({
            input,
            grant: { name: 'readMemorySources', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: true },
            ledger,
            state: makeState(),
            allocateEvidence: () => { throw new Error('Memory evidence must not be allocated before the result budget passes.'); },
        } as any, { memoryIds: ['M1'] });

        assert.equal(serializedResult.length > 0, true);
        assert.equal(outcome.ok, false);
        assert.equal(outcome.preserveOutput, true);
        const output = JSON.parse(outcome.output) as { error: Record<string, unknown>; budget: Record<string, unknown> };
        assert.deepEqual(output.error, {
            code: 'result_budget_exceeded',
            message: 'Memory result exceeds its token budget; request fewer memoryIds.',
            requested: 20,
            limit: 1,
        });
        assert.deepEqual(ledger.snapshot().filter(entry => entry.source === 'repository'), []);
        assert.equal(records.length, 1);
        assert.equal(records[0].ok, false);
        assert.deepEqual(records[0].evidence, []);
    });

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

        assert.match(profile.validateFinalizationPrecondition?.(state) ?? '', /no E\* repository evidence/);

        state.ledger.recordRepositoryEvidence({
            id: 'E1',
            kind: 'callers',
            target: 'parse',
            ref: 'src/client.ts:4',
            excerpt: 'parse(input)',
        });
        assert.equal(profile.validateFinalizationPrecondition?.(state), null);
    });

    it('allows finalization without repository evidence when the plan is empty', () => {
        const profile = createChangeAnalysisProfile(makeInput());

        assert.equal(profile.validateFinalizationPrecondition?.(makeState()), null);
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

    it('requires findings to cite repository evidence while preserving valid E* references', () => {
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
                    evidenceRefs: ['E1'],
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

        const mixedTerminal = changeAnalysisAgentFinalResponseSchema.safeParse({
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
        assert.equal(mixedTerminal.success, false);

        const output = profile.normalizeFinal(terminal.data, state);

        assert.deepEqual(output.repositoryEvidence.findings[0].evidenceRefs, ['E1']);
        assert.equal(output.analysisStatus, 'complete');
    });

    it('trims informationSelection lists using AGENT_TERMINAL_LIMITS', () => {
        const profile = createChangeAnalysisProfile(makeInput());
        const limits = AGENT_TERMINAL_LIMITS;
        const claims = [
            ...Array.from({ length: limits.maxMustExpressClaims + 1 }, (_, index) => ({
                category: 'observed_change' as const,
                claim: `must ${index + 1}`,
                evidenceRefs: ['D1'],
                disposition: 'must_express' as const,
            })),
            ...Array.from({ length: limits.maxOptionalClaims + 1 }, (_, index) => ({
                category: 'observed_change' as const,
                claim: `optional ${index + 1}`,
                evidenceRefs: ['D1'],
                disposition: 'optional' as const,
            })),
            ...Array.from({ length: limits.maxOmittedClaims + 1 }, (_, index) => ({
                category: 'observed_change' as const,
                claim: `omit ${index + 1}`,
                evidenceRefs: ['D1'],
                disposition: 'omit' as const,
            })),
        ];
        const raw = changeAnalysisAgentFinalResponseSchema.parse({
            ...minimalRaw(),
            claims,
        });

        const output = profile.normalizeFinal(raw, makeState());

        assert.equal(output.informationSelection.mustExpress.length, limits.maxMustExpressClaims);
        assert.equal(output.informationSelection.optional.length, limits.maxOptionalClaims);
        assert.equal(output.informationSelection.omit.length, limits.maxOmittedClaims);
        assert.deepEqual(
            output.informationSelection.mustExpress,
            Array.from({ length: limits.maxMustExpressClaims }, (_, index) => `must ${index + 1}`),
        );
        assert.deepEqual(
            output.informationSelection.optional,
            Array.from({ length: limits.maxOptionalClaims }, (_, index) => `optional ${index + 1}`),
        );
        assert.deepEqual(
            output.informationSelection.omit,
            Array.from({ length: limits.maxOmittedClaims }, (_, index) => `omit ${index + 1}`),
        );
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
