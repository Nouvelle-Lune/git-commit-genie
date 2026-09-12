import { strict as assert } from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { AgentRunState, EvidenceLedger } from '../../agent';
import {
    ChangeAnalysisAgentInput,
    createChangeAnalysisProfile,
} from '../../services/analysis/change/investigation/changeAnalysisProfile';
import {
    InvestigationLookup,
    InvestigationPlan,
    RepositoryEvidenceItem,
} from '../../services/analysis/change/types';
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
        const memoryIdSchema = (read!.parameters.properties as Record<string, any>).memoryIds;
        assert.equal(memoryIdSchema.items.pattern, '^M[0-9]+$');
        assert.doesNotMatch(JSON.stringify(read!.parameters), /\\\\d/);

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
            claims: [{
                category: 'supported_inference',
                claim: 'improves product reliability',
                evidenceRefs: ['E404'],
                disposition: 'must_express',
            }],
            behaviorAnalysis: { before: null, after: null, observableEffect: null },
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
        // A non-empty investigation plan must expose its missing E* precondition until repository evidence is recorded.
        const input = makeInput();
        input.plan = {
            targets: [{
                id: 'T1',
                target: 'parse',
                kind: 'symbol',
                lookup: 'callers',
                file: 'src/parser.ts',
                question: 'Who calls parse?',
            }],
            coverage: { D1: { decision: 'investigate', targetIds: ['T1'] } },
            notes: null,
        };
        const profile = createChangeAnalysisProfile(input);
        const state = makeState();

        assert.equal(profile.finalizationPreconditionPolicy, 'degrade');
        assert.match(profile.validateFinalizationPrecondition?.(state) ?? '', /no E\* repository evidence/);
    });

    it('refuses finalization when evidence arrived without any tool resolving the declared lookup', () => {
        // The ledger records evidence, not its producer, so E* written outside the tool definitions (memory
        // expansion, or a caller recording evidence directly) satisfies the first precondition but not the second:
        // the plan declared a lookup and no locating tool ever ran.
        const input = makeInput();
        input.plan = investigatePlan('callers');
        const profile = createChangeAnalysisProfile(input);
        const state = makeState();

        state.ledger.recordRepositoryEvidence({
            id: 'E1',
            kind: 'callers',
            target: 'parse',
            ref: 'src/client.ts:4',
            excerpt: 'parse(input)',
        });

        assert.match(
            profile.validateFinalizationPrecondition?.(state) ?? '',
            /^No locating lookup has published E\* evidence yet\./,
        );
        assert.match(profile.validateFinalizationPrecondition?.(state) ?? '', /Call at least one of findSymbolDefinition/);
    });

    it('keeps finalization blocked while only a read published evidence and unblocks it after a locating lookup', async () => {
        // readFileContent publishes evidence but resolves no relation the diff does not already show, so on its own
        // it cannot satisfy a plan whose targets declare a locating lookup; the same run stops being blocked once a
        // content search publishes.
        await withTempRepo(async root => {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(path.join(root, 'src', 'parser.ts'), 'export function parse(input) {\n  return input;\n}\n');
            await fs.writeFile(path.join(root, 'src', 'client.ts'), 'import { parse } from "./parser";\nparse("x");\n');
            await commitAll(root, 'files');

            const snapshot = await RepositorySnapshotReader.capture(root, 'git');
            // The snapshot resolves the repository to its real path, and the tools contain every argument inside
            // it, so the grant has to carry that same root rather than the symlinked temporary directory.
            const input = { ...makeInput(), snapshot, repositoryPath: snapshot.root, plan: investigatePlan('callers') };
            const state = makeState();
            const profile = createChangeAnalysisProfile(input);
            const definitions = profile.buildToolDefinitions(input, state);
            const context = toolContext(snapshot.root, state);

            const read = definitions.find(definition => definition.name === 'readFileContent');
            assert.ok(read);
            const readOutcome = await read.execute(context, { filePath: 'src/parser.ts', startLine: 1, maxLines: 3 });
            assert.equal(readOutcome.ok, true, readOutcome.output);
            assert.ok((readOutcome.evidenceCount ?? 0) > 0, 'The read must publish evidence for this precondition to be the only one left.');
            assert.match(
                profile.validateFinalizationPrecondition?.(state) ?? '',
                /^No locating lookup has published E\* evidence yet\./,
            );

            const search = definitions.find(definition => definition.name === 'searchCode');
            assert.ok(search);
            const searchOutcome = await search.execute(context, { query: 'parse', searchType: 'content', maxResults: 5 });
            assert.equal(searchOutcome.ok, true);
            assert.ok((searchOutcome.evidenceCount ?? 0) > 0, 'The content search must publish evidence.');
            assert.equal(profile.validateFinalizationPrecondition?.(state), null);
            assert.equal(state.steps, 0, 'The precondition reads the ledger and the tool set, never the step counter.');
        });
    });

    it('renders each planned question with the tool its lookup resolves to in the checkpoint, the tool result, and the finalization request', async () => {
        // The plan JSON appears only in the opening prompt, so the planned-question checklist is the channel the
        // declared verb survives compaction through: every surface that repeats a question must name the tool.
        await withTempRepo(async root => {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(path.join(root, 'src', 'parser.ts'), 'export function parse(input) {\n  return input;\n}\n');
            await commitAll(root, 'files');

            // One question per target, so a multi-entry checklist needs two targets rather than two questions.
            const checklist = 'parse (findCallers): Who calls parse? | parse (readFileContent): What does parse return?';
            const snapshot = await RepositorySnapshotReader.capture(root, 'git');
            const input = {
                ...makeInput(),
                snapshot,
                repositoryPath: snapshot.root,
                plan: {
                    targets: [{
                        id: 'T1',
                        target: 'parse',
                        kind: 'symbol' as const,
                        lookup: 'callers' as const,
                        file: 'src/parser.ts',
                        question: 'Who calls parse?',
                    }, {
                        id: 'T2',
                        target: 'parse',
                        kind: 'symbol' as const,
                        lookup: 'read' as const,
                        file: 'src/parser.ts',
                        question: 'What does parse return?',
                    }],
                    coverage: { D1: { decision: 'investigate' as const, targetIds: ['T1', 'T2'] } },
                    notes: null,
                },
            };
            const profile = createChangeAnalysisProfile(input);
            const state = makeState();

            const checkpoint = profile.contextPolicy.buildCheckpoint(state).content;
            assert.ok(checkpoint.includes(`Planned-question checklist (not automatically marked complete): ${checklist}`), checkpoint);

            const read = profile.buildToolDefinitions(input, state).find(definition => definition.name === 'readFileContent');
            assert.ok(read);
            const outcome = await read.execute(toolContext(snapshot.root, state), { filePath: 'src/parser.ts', startLine: 1, maxLines: 3 });
            assert.ok(outcome.output.includes(`Planned-question checklist: ${checklist}`), outcome.output);

            const finalization = profile.buildFinalizationRequest(input, state, null)[0].content;
            assert.ok(finalization.includes(`Planned questions: ${checklist}`), finalization);
        });
    });

    it('embeds the repository map in the opening prompt and the checkpoint only when one is supplied', () => {
        // The map is an optional caller input; when present it orients the agent in the run context and survives
        // compaction, and when absent no empty <repository_map> block is rendered.
        const repositoryMap = '12 files, 2 directories (.ts 10, .md 2)\nsrc  10 files   [1 changed]';
        const withMap = createChangeAnalysisProfile({ ...makeInput(), repositoryMap });
        const withoutMap = createChangeAnalysisProfile(makeInput());
        const state = makeState();

        const opening = withMap.buildPrompt({ ...makeInput(), repositoryMap }).opening.map(message => message.content).join('\n');
        assert.match(opening, /<repository_map>\n12 files, 2 directories \(\.ts 10, \.md 2\)\nsrc  10 files {3}\[1 changed\]\nThis map locates structure outside the diff\. It is an inventory, not evidence: nothing in it has been read, and it never answers a question by itself\.\n<\/repository_map>/);
        assert.ok(
            opening.indexOf('<repository_map>') < opening.indexOf('Raw diff evidence:'),
            'The map must precede the diff so a repository-wide lookup stays choosable.',
        );
        assert.ok(withMap.contextPolicy.buildCheckpoint(state).content.includes(`Repository map: ${repositoryMap}`));
        assert.doesNotMatch(withoutMap.buildPrompt(makeInput()).opening.map(message => message.content).join('\n'), /<repository_map>/);
        assert.doesNotMatch(withoutMap.contextPolicy.buildCheckpoint(state).content, /Repository map:/);
    });

    it('embeds the keyed coverage plan in the investigation prompt without the removed target field', () => {
        // The investigation prompt hands the plan to the tool-using agent verbatim, so it must show coverage as a
        // D*-keyed object and must not carry the retired diffEvidenceRefs copy of the hunk relation.
        const input = makeInput();
        input.plan = investigatePlan('callers');
        const profile = createChangeAnalysisProfile(input);
        const opening = profile.buildPrompt(input).opening.map(message => message.content).join('\n');
        const planLine = opening.split('\n').find(line => line.startsWith('Investigation plan: '));

        assert.ok(planLine, 'The investigation prompt must embed the plan.');
        const embedded = JSON.parse(planLine.slice('Investigation plan: '.length)) as {
            targets: Array<Record<string, unknown>>;
            coverage: Record<string, unknown>;
        };
        assert.deepEqual(embedded.coverage, { D1: { decision: 'investigate', targetIds: ['T1'] } });
        assert.deepEqual(
            Object.keys(embedded.targets[0]),
            ['id', 'target', 'kind', 'lookup', 'file', 'question'],
        );
        assert.equal(embedded.targets[0].lookup, 'callers');
        assert.doesNotMatch(opening, /diffEvidenceRefs/);
    });

    it('allows finalization without repository evidence when the plan is empty', () => {
        // Verify the diff-sufficient plan can enter structured finalization without repository evidence.
        const profile = createChangeAnalysisProfile(makeInput());

        assert.equal(profile.validateFinalizationPrecondition?.(makeState()), null);
    });

    it('normalizes an evidence-precondition degradation as complete_diff_only without repository facts', () => {
        // A non-empty plan that exhausted evidence repair must preserve diff claims and expose a diff-only status to the draft stage.
        const input = makeInput();
        input.plan = investigatePlan('callers');
        const profile = createChangeAnalysisProfile(input);
        const state = makeState();
        state.issues.push({
            type: 'evidence_precondition_degraded',
            message: 'The plan has no E* evidence.',
            step: 0,
        });

        const output = profile.normalizeFinal(minimalRaw(), state);

        assert.equal(output.analysisStatus, 'complete_diff_only');
        assert.equal(output.semanticAnalysis.repositoryFacts.length, 0);
        assert.deepEqual(output.repositoryEvidence.items, []);
        assert.ok(output.issues.some(issue => issue.includes('downstream generation continues from diff evidence only')));
        const finalization = profile.buildFinalizationRequest(input, state, null)[0].content;
        assert.match(finalization, /Produce an explicit diff-only analysis/i);
        assert.match(finalization, /never present a diff-only fact as a repository fact/i);
    });

    it('propagates an exhausted terminal failure instead of manufacturing degraded facts', () => {
        // Verify finalization exhaustion remains an explicit chain failure and never becomes a file-name fallback claim.
        const profile = createChangeAnalysisProfile(makeInput());
        const error = new Error('terminal schema retries exhausted');

        assert.throws(() => profile.preservePartialResult?.(makeState(), error), error);
    });

    it('marks invalid claim references as degraded instead of silently dropping the claim', () => {
        // Verify an invalid final claim reference is visible as a degraded analysis result.
        const profile = createChangeAnalysisProfile(makeInput());
        const raw = changeAnalysisAgentFinalResponseSchema.parse({
            ...minimalRaw(),
            claims: [{
                category: 'supported_inference',
                claim: 'makes parsing deterministic',
                evidenceRefs: ['D404'],
                disposition: 'must_express',
            }],
        });

        const output = profile.normalizeFinal(raw, makeState());

        assert.equal(output.analysisStatus, 'degraded');
        assert.deepEqual(output.semanticAnalysis.supportedInferences, []);
        assert.ok(output.informationSelection.omit.includes('makes parsing deterministic'));
        assert.ok(output.issues.some(issue => issue.includes('D404')));
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

/** A non-empty plan whose single target investigates D1 through one declared lookup verb. */
function investigatePlan(lookup: InvestigationLookup): InvestigationPlan {
    return {
        targets: [{
            id: 'T1',
            target: 'parse',
            kind: 'symbol',
            lookup,
            file: 'src/parser.ts',
            question: 'Who calls parse?',
        }],
        coverage: { D1: { decision: 'investigate', targetIds: ['T1'] } },
        notes: null,
    };
}

/**
 * The tool context the runtime hands a definition: the grant owns the repository
 * root, and allocation goes through the ledger so a published item is both
 * allocated and recorded.
 */
function toolContext(root: string, state: AgentRunState): any {
    return {
        input: undefined,
        grant: { name: 'test', allowedRoot: root, excludePatterns: [], allocateEvidence: true },
        ledger: state.ledger,
        state,
        allocateEvidence: (evidence: Omit<RepositoryEvidenceItem, 'id'>) => state.ledger.allocateRepositoryEvidence(evidence),
    };
}

async function withTempRepo<T>(action: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-change-analysis-test-'));
    try {
        await runGit(root, ['init', '--quiet']);
        await runGit(root, ['config', 'user.name', 'Change Analysis Test']);
        await runGit(root, ['config', 'user.email', 'change-analysis-test@example.invalid']);
        return await action(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function commitAll(root: string, message: string): Promise<void> {
    await runGit(root, ['add', '-A']);
    await runGit(root, ['commit', '--quiet', '-m', message]);
}

function runGit(root: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        child.on('error', reject);
        child.on('close', code => code === 0
            ? resolve(Buffer.concat(stdout))
            : reject(new Error(`git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`)));
        child.stdin.end();
    });
}

function makeInput(): ChangeAnalysisAgentInput {
    return {
        rawDiff: [{
            kind: 'raw',
            fileName: 'src/parser.ts',
            status: 'modified',
            evidenceIds: ['D1'],
            rawDiff: '@@ -1 +1 @@\n-old\n+new',
        }],
        plan: {
            targets: [],
            coverage: { D1: { decision: 'diff_sufficient', targetIds: [] } },
            notes: null,
        },
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
        claims: [{
            category: 'observed_change' as const,
            claim: 'the parser diff changes one branch',
            evidenceRefs: ['D1'],
            disposition: 'must_express' as const,
        }],
        behaviorAnalysis: { before: null, after: null, observableEffect: null },
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
