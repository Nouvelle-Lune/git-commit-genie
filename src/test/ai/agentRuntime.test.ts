import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { AgentProfile, AgentRuntime, EvidenceLedger, FINISH_INVESTIGATION_TOOL } from '../../agent';
import { createChangeAnalysisProfile } from '../../services/analysis/change/investigation/changeAnalysisProfile';
import { DiffData } from '../../services/git/gitTypes';
import {
    hashContent,
    RepositorySnapshotReader,
    SnapshotEntry,
    SnapshotIdentity,
    SourceObservation,
} from '../../services/git/repositorySnapshot';
import { LLMExecution } from '../../services/llm/llmTypes';
import { AIRunRequest, AIRunResponse, AISession, CustomProvider } from '../../services/llm/providers';
import { resolveChainTokenBudget } from '../../services/llm/inputTokenBudget';
import { EpisodeRecorder } from '../../services/memory/recorder';
import { MemoryRetriever } from '../../services/memory/retriever';
import { MEMORY_DEFAULTS } from '../../services/memory/settings';
import { InvestigationEpisode } from '../../services/memory/types';

function createExecution(
    responses: AIRunResponse[],
    requests: AIRunRequest[],
    sessionIds: Array<string | undefined>,
): LLMExecution {
    const tokenBudget = resolveChainTokenBudget({
        provider: 'custom',
        model: 'test-model',
        contextWindowTokens: 128_000,
    });
    return {
        model: 'test-model',
        temperature: 0.2,
        maxOutputTokens: tokenBudget.maxOutputTokens,
        maxRetries: 1,
        thinking: { reasoning: true, level: 'low' },
        tokenBudget,
        createSession: (_messages, id) => {
            sessionIds.push(id);
            const transcript: Array<{ role: 'system' | 'developer' | 'user' | 'assistant'; content: string }> = [];
            const session: AISession = {
                provider: 'custom',
                model: 'test-model',
                run: async request => {
                    requests.push(request);
                    transcript.push(...(request.messages ?? []));
                    const response = responses.shift();
                    if (!response) {
                        throw new Error('No fake response remains.');
                    }
                    return response;
                },
                snapshot: () => ({
                    provider: 'custom',
                    model: 'test-model',
                    continuation: { serverManaged: false },
                    transcript: [...transcript],
                }),
            };
            return session;
        },
        run: async () => { throw new Error('not used'); },
        accountCall: async () => ({ status: 'pricing-not-configured' as const }),
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
    };
}

function response(overrides: Partial<AIRunResponse>): AIRunResponse {
    return {
        text: '',
        toolCalls: [],
        stopReason: 'completed',
        continuation: { serverManaged: false },
        raw: {},
        ...overrides,
    };
}

type SimpleProfile<Input> = AgentProfile<Input, { value: string }, string>;

function profileRequestHooks<Input>(
    hooks: Partial<Pick<SimpleProfile<Input>, 'validateFinalizationPrecondition' | 'buildFinalizationRequest' | 'buildCorrectionRequest'>> = {},
): Pick<SimpleProfile<Input>, 'buildFinalizationRequest' | 'buildCorrectionRequest'>
    & Partial<Pick<SimpleProfile<Input>, 'validateFinalizationPrecondition'>> {
    return {
        buildFinalizationRequest: (_input, _state, reason) => [{
            role: 'user',
            content: reason ? `Finalize: ${reason}` : 'Return the terminal JSON object now.',
        }],
        buildCorrectionRequest: (_input, _state, failure) => [{
            role: 'user',
            content: failure.message,
        }],
        ...hooks,
    };
}

function finishInvestigationResponse(reason = 'enough evidence'): AIRunResponse {
    return response({
        toolCalls: [{
            id: 'finish-1',
            name: FINISH_INVESTIGATION_TOOL,
            arguments: { reason },
        }],
        stopReason: 'tool_call',
    });
}

function inspectToolResponse(callId: string, reason: string): AIRunResponse {
    return response({
        toolCalls: [{
            id: callId,
            name: 'inspect',
            arguments: { reason, filePath: 'src/target.ts' },
        }],
        stopReason: 'tool_call',
    });
}

function buildInspectProfile(
    maxSteps: number,
    execute: () => { output: string },
): AgentProfile<null, { value: string }, string> {
    return {
        id: 'duplicate-tool-call-test',
        promptVersion: '1',
        toolsetVersion: '1',
        requestType: 'investigation',
        finalName: 'duplicateToolCallTestFinal',
        finalSchema: z.object({ value: z.string() }),
        contextPolicy: {
            maxSteps,
            maxEpochs: 0,
            maxObservationChars: 100,
            buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
        },
        buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
        grantTools: () => [{
            name: 'inspect',
            allowedRoot: '/tmp/repository',
            excludePatterns: [],
            allocateEvidence: false,
        }],
        buildToolDefinitions: () => [{
            name: 'inspect',
            description: 'Inspect.',
            parameters: { type: 'object' },
            execute: async () => execute(),
        }],
        ...profileRequestHooks(),
        normalizeFinal: raw => raw.value,
        preservePartialResult: () => 'partial',
    };
}

describe('AgentRuntime contracts', () => {
    it('keeps cache identity, tools, thinking, and schema stable across turns', async () => {
        // Verify keeps cache identity, tools, thinking, and schema stable across turns.
        const requests: AIRunRequest[] = [];
        const sessionIds: Array<string | undefined> = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'call-1', name: 'inspect', arguments: { reason: 'verify' } }],
                stopReason: 'tool_call',
                usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 },
            }),
            finishInvestigationResponse('verified'),
            response({
                structured: { value: 'done' },
                text: '{"value":"done"}',
                usage: { inputTokens: 20, cachedInputTokens: 15, outputTokens: 5 },
            }),
        ], requests, sessionIds);
        const profile: AgentProfile<string, { value: string }, string> = {
            id: 'runtime-test',
            promptVersion: '7',
            toolsetVersion: '3',
            requestType: 'investigation',
            finalName: 'runtimeTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 2,
                maxEpochs: 0,
                maxObservationChars: 1_000,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: repositoryPath => ({
                stable: [{ role: 'system', content: 'stable protocol' }],
                opening: [{ role: 'user', content: repositoryPath }],
            }),
            grantTools: repositoryPath => [{
                name: 'inspect',
                allowedRoot: repositoryPath,
                excludePatterns: [],
                allocateEvidence: false,
            }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: {
                    type: 'object',
                    properties: { reason: { type: 'string' } },
                    required: ['reason'],
                    additionalProperties: false,
                },
                execute: async () => ({ output: 'verified' }),
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, '/tmp/repository');

        assert.equal(result.output, 'done');
        assert.deepEqual(sessionIds, ['agent:runtime-test:7:3:test-model']);
        assert.equal(requests.length, 3);
        assert.equal(requests[0].responseFormat, undefined);
        assert.equal(requests[1].responseFormat, undefined);
        assert.ok(requests[2].responseFormat);
        assert.deepEqual(requests[0].tools, requests[2].tools);
        assert.equal('thinking' in requests[0], false);
        assert.equal('thinking' in requests[2], false);
        assert.equal(requests[1].toolChoice, 'auto');
        assert.equal(requests[2].toolChoice, 'none');
        assert.equal(requests[1].toolResults?.[0].output, 'verified');
        assert.equal(result.metrics.apiCalls, 3);
        assert.deepEqual(result.metrics.usage.map(usage => usage.cachedInputTokens).filter(value => value !== undefined), [80, 15]);
    });

    it('allocates globally unique D ids in diff order', () => {
        // Verify allocates globally unique D ids in diff order.
        const diffs: DiffData[] = [
            makeDiff('a.ts', ['@@ -1 +1 @@', '@@ -10 +10 @@']),
            makeDiff('b.ts', ['@@ -3 +3 @@']),
        ];

        const ledger = EvidenceLedger.fromDiffs(diffs);

        assert.deepEqual(ledger.getDiffIds('a.ts'), ['D1', 'D2']);
        assert.deepEqual(ledger.getDiffIds('b.ts'), ['D3']);
        assert.equal(ledger.resolveDiffAnchor('a.ts', 10), 'D2');
    });

    it('removes unknown claim references and keeps generation available', async () => {
        // Verify removes unknown claim references and keeps generation available.
        const diffs = [makeDiff('a.ts', ['@@ -1 +1 @@'])];
        const ledger = EvidenceLedger.fromDiffs(diffs);
        const requests: AIRunRequest[] = [];
        const execution = createExecution([response({
            structured: {
                investigation: {
                    findings: [],
                    unresolvedQuestions: [],
                    stopReason: 'enough evidence',
                },
                claims: [
                    {
                        category: 'observed_change',
                        claim: 'updates value',
                        evidenceRefs: ['D1'],
                        disposition: 'must_express',
                    },
                    {
                        category: 'repository_fact',
                        claim: 'used by clients',
                        evidenceRefs: ['E999'],
                        disposition: 'must_express',
                    },
                ],
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
            },
        })], requests, []);
        const input = {
            rawDiff: [{
                kind: 'raw' as const,
                fileName: 'a.ts',
                status: 'modified' as const,
                evidenceIds: ['D1'],
                rawDiff: '@@ -1 +1 @@\n-old\n+new',
            }],
            plan: {
                targets: [],
                coverage: [{ diffEvidenceRef: 'D1', decision: 'diff_sufficient' as const, targetIds: [] }],
                notes: null,
            },
            snapshot: {} as RepositorySnapshotReader,
            repositoryPath: '/tmp/repository',
            excludePatterns: [],
            evidence: [],
            maxSteps: 0,
        };

        const result = await new AgentRuntime().run(
            execution,
            createChangeAnalysisProfile(input),
            input,
            ledger,
        );

        assert.equal(result.status, 'complete');
        assert.equal(result.output.analysisStatus, 'degraded');
        assert.deepEqual(result.output.informationSelection.mustExpress, ['updates value']);
        assert.ok(result.output.informationSelection.omit.includes('used by clients'));
        assert.equal(result.output.semanticAnalysis.repositoryFacts.length, 0);
    });

    it('soft-rejects readFileContent maxLines above its grant and lets the model correct it', async () => {
        // Verify soft-rejects readFileContent maxLines above its grant and lets the model correct it.
        const requests: AIRunRequest[] = [];
        const executedArguments: Array<Record<string, unknown>> = [];
        const execution = createExecution([
            response({
                toolCalls: [{
                    id: 'too-many-lines',
                    name: 'readFileContent',
                    arguments: { reason: 'read the implementation', filePath: 'src/example.ts', maxLines: 401 },
                }],
                stopReason: 'tool_call',
            }),
            response({
                toolCalls: [{
                    id: 'bounded-lines',
                    name: 'readFileContent',
                    arguments: { reason: 'retry with the grant limit', filePath: 'src/example.ts', maxLines: 400 },
                }],
                stopReason: 'tool_call',
            }),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'max-lines-permission-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'permissionTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 2,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{
                name: 'readFileContent',
                allowedRoot: '/tmp/repository',
                excludePatterns: [],
                maxLines: 400,
                allocateEvidence: false,
            }],
            buildToolDefinitions: () => [{
                name: 'readFileContent',
                description: 'Read a bounded file range.',
                parameters: { type: 'object' },
                execute: async (_context, args) => {
                    executedArguments.push(args);
                    return {
                        output: `read ${String(args.maxLines)} lines`,
                        summary: 'Read the requested bounded range.',
                        evidenceCount: 1,
                    };
                },
            }],
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
            ...profileRequestHooks(),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.deepEqual(executedArguments.map(args => args.maxLines), [400]);
        assert.equal(requests.length, 3);
        assert.equal(requests[1].toolResults?.[0].isError, true);
        assert.match(requests[1].toolResults?.[0].output ?? '', /maxLines.*400/);
        assert.equal(requests[2].toolChoice, 'none');
        assert.equal(requests[2].toolResults?.[0].output, 'read 400 lines');
        assert.equal(result.state.steps, 2);
        assert.equal(result.state.observations.length, 2);
        assert.equal(result.state.observations[0].ok, false);
        assert.match(result.state.observations[0].output, /maxLines.*400/);
        assert.equal(result.state.observations[1].ok, true);
        assert.equal(result.state.observations[1].summary, 'Read the requested bounded range.');
        assert.equal(result.state.observations[1].evidenceCount, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'tool_rejected').length, 1);
    });

    it('soft-rejects a path escape and lets the model retry inside the granted root', async () => {
        // Verify soft-rejects a path escape and lets the model retry inside the granted root.
        const requests: AIRunRequest[] = [];
        const executedPaths: unknown[] = [];
        const execution = createExecution([
            response({
                toolCalls: [{
                    id: 'escape',
                    name: 'inspect',
                    arguments: { reason: 'inspect outside', filePath: '../outside.ts' },
                }],
                stopReason: 'tool_call',
            }),
            response({
                toolCalls: [{
                    id: 'inside',
                    name: 'inspect',
                    arguments: { reason: 'inspect inside', filePath: 'src/inside.ts' },
                }],
                stopReason: 'tool_call',
            }),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'path-permission-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'pathPermissionTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 2,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{
                name: 'inspect',
                allowedRoot: '/tmp/repository',
                excludePatterns: [],
                allocateEvidence: false,
            }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect a bounded path.',
                parameters: { type: 'object' },
                execute: async (_context, args) => {
                    executedPaths.push(args.filePath);
                    return { output: 'inside root' };
                },
            }],
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
            ...profileRequestHooks(),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.deepEqual(executedPaths, ['src/inside.ts']);
        assert.equal(requests[1].toolResults?.[0].isError, true);
        assert.match(requests[1].toolResults?.[0].output ?? '', /outside/);
        assert.equal(requests[2].toolChoice, 'none');
        assert.equal(requests[2].toolResults?.[0].output, 'inside root');
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'tool_rejected').length, 1);
    });

    it('creates one deterministic epoch and preserves ledger ids across continuation', async () => {
        // Verify creates one deterministic epoch and preserves ledger ids across continuation.
        const requests: AIRunRequest[] = [];
        const sessionIds: Array<string | undefined> = [];
        const events: string[] = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'large', name: 'inspect', arguments: { reason: 'collect' } }],
                stopReason: 'tool_call',
            }),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, sessionIds);
        execution.tokenBudget.compressionTriggerTokens = 20;
        const ledger = EvidenceLedger.fromDiffs([makeDiff('a.ts', ['@@ -1 +1 @@'])]);
        const profile: AgentProfile<string, { value: string }, string> = {
            id: 'epoch-test',
            promptVersion: '2',
            toolsetVersion: '4',
            requestType: 'investigation',
            finalName: 'epochTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 1,
                maxObservationChars: 1_000,
                buildCheckpoint: state => ({
                    role: 'user',
                    content: `checkpoint:${state.ledger.snapshot().map(entry => entry.id).join(',')}`,
                }),
            },
            buildPrompt: () => ({
                stable: [{ role: 'system', content: 'protocol' }],
                opening: [{ role: 'user', content: 'small' }],
            }),
            grantTools: () => [{
                name: 'inspect',
                allowedRoot: '/tmp/repository',
                excludePatterns: [],
                allocateEvidence: false,
            }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: { type: 'object' },
                execute: async () => ({ output: 'x'.repeat(10_000) }),
            }],
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
            ...profileRequestHooks(),
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'contextCompacted') {
                    events.push(`epoch:${event.epoch}`);
                }
            },
        }).run(execution, profile, '/tmp/repository', ledger);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.deepEqual(events, ['epoch:1']);
        assert.deepEqual(sessionIds, ['agent:epoch-test:2:4:test-model', 'agent:epoch-test:2:4:test-model']);
        assert.deepEqual(ledger.snapshot().map(entry => entry.id), ['D1']);
        assert.equal(requests[1].toolChoice, 'none');
        assert.equal(requests[1].messages?.[0].content.includes('checkpoint:D1'), true);
        for (const request of requests) {
            assert.equal('thinking' in request, false);
        }
    });

    it('retries an invalid compound terminal without changing the request contract', async () => {
        // Verify retries an invalid compound terminal without changing the request contract.
        const requests: AIRunRequest[] = [];
        const events: string[] = [];
        const execution = createExecution([
            response({ structured: { value: 42 }, text: '{"value":42}' }),
            response({ structured: { value: 'repaired' }, text: '{"value":"repaired"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'retry-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'retryTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 0,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
            ...profileRequestHooks(),
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'retry') {
                    events.push(`retry:${event.attempt}:${event.category}`);
                }
            },
        }).run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'repaired');
        assert.deepEqual(events, ['retry:1:schemaMismatch']);
        assert.ok(requests[0].responseFormat);
        assert.ok(requests[1].responseFormat);
        assert.equal(requests[0].toolChoice, 'none');
        assert.equal(requests[1].toolChoice, 'none');
        assert.equal('thinking' in requests[0], false);
        assert.equal('thinking' in requests[1], false);
    });

    it('repairs an invalid mixed terminal through a no-tools strict Custom request', async () => {
        // Verify repairs an invalid mixed terminal through a no-tools strict Custom request.
        const requests: Array<Record<string, unknown>> = [];
        let callCount = 0;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requests.push(body);
                        callCount += 1;
                        if (callCount === 1) {
                            return {
                                choices: [{
                                    finish_reason: 'tool_calls',
                                    message: {
                                        role: 'assistant',
                                        content: null,
                                        tool_calls: [{
                                            id: 'call_inspect',
                                            type: 'function',
                                            function: { name: 'inspect', arguments: '{"reason":"collect evidence"}' },
                                        }],
                                    },
                                }],
                            };
                        }
                        if (callCount === 2) {
                            return {
                                choices: [{
                                    finish_reason: 'stop',
                                    message: { role: 'assistant', content: '{"value":42}' },
                                }],
                            };
                        }
                        return {
                            choices: [{
                                finish_reason: 'stop',
                                message: { role: 'assistant', content: '{"value":"repaired"}' },
                            }],
                        };
                    },
                },
            },
        } as any);
        const tokenBudget = resolveChainTokenBudget({
            provider: 'custom',
            model: 'local-model',
            contextWindowTokens: 128_000,
        });
        const thinking = { reasoning: true, level: 'high' as const };
        const execution: LLMExecution = {
            model: 'local-model',
            temperature: 0.2,
            maxOutputTokens: tokenBudget.maxOutputTokens,
            maxRetries: 1,
            thinking,
            tokenBudget,
            createSession: messages => provider.createSession({
                model: 'local-model',
                systemInstruction: messages.find(message => message.role === 'system')?.content,
                thinking,
            }),
            run: async () => { throw new Error('not used'); },
            accountCall: async () => ({ status: 'pricing-not-configured' as const }),
            getRecordedQuotes: () => [],
            notifyUsageCostIfEnabled: () => undefined,
        };
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'custom-mixed-repair-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'customMixedRepairFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 1_000,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({
                stable: [{ role: 'system', content: 'Investigate the repository.' }],
                opening: [{ role: 'user', content: 'collect evidence' }],
            }),
            grantTools: () => [{
                name: 'inspect',
                allowedRoot: '/tmp/repository',
                excludePatterns: [],
                allocateEvidence: false,
            }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect the repository.',
                parameters: {
                    type: 'object',
                    properties: { reason: { type: 'string' } },
                    required: ['reason'],
                    additionalProperties: false,
                },
                execute: async () => ({ output: 'verified repository evidence' }),
            }],
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
            ...profileRequestHooks(),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'repaired');
        assert.equal(requests.length, 3);
        assert.equal(requests[0].response_format, undefined);
        assert.equal(requests[0].tool_choice, 'auto');
        assert.equal(requests[0].parallel_tool_calls, false);
        assert.ok(Array.isArray(requests[0].tools));
        assert.equal(requests[1].tool_choice, 'none');
        assert.equal(requests[1].tools, undefined);
        assert.equal(requests[1].parallel_tool_calls, undefined);
        assert.ok(requests[1].response_format);
        assert.equal(requests[2].tool_choice, 'none');
        const format = requests[1].response_format as {
            type: string;
            json_schema: { name: string; strict: boolean };
        };
        assert.equal(format.type, 'json_schema');
        assert.equal(format.json_schema.name, 'customMixedRepairFinal');
        assert.equal(format.json_schema.strict, true);
        const systemContent = String((requests[1].messages as Array<{ content: string }>)[0].content);
        assert.match(systemContent, /"type":\s*"object"/);
        for (const body of requests) {
            assert.equal(body.reasoning_effort, 'high');
            assert.equal('thinking' in body, false);
        }
    });

    it('rejects a premature terminal and keeps tools available for profile-required evidence', async () => {
        // Verify rejects a premature terminal and keeps tools available for profile-required evidence.
        const requests: AIRunRequest[] = [];
        const events: string[] = [];
        const execution = createExecution([
            finishInvestigationResponse('not enough yet'),
            response({
                toolCalls: [{ id: 'collect', name: 'inspect', arguments: { reason: 'collect evidence' } }],
                stopReason: 'tool_call',
            }),
            finishInvestigationResponse('evidence collected'),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const profile: AgentProfile<string, { value: string }, string> = {
            id: 'terminal-boundary-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'terminalBoundaryTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 2,
                maxEpochs: 0,
                maxObservationChars: 1_000,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: repositoryPath => ({
                stable: [{ role: 'system', content: 'collect repository evidence' }],
                opening: [{ role: 'user', content: repositoryPath }],
            }),
            grantTools: repositoryPath => [{
                name: 'inspect',
                allowedRoot: repositoryPath,
                excludePatterns: [],
                allocateEvidence: true,
            }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect and collect evidence.',
                parameters: { type: 'object' },
                execute: async context => {
                    context.allocateEvidence({
                        kind: 'search',
                        target: 'value',
                        ref: 'src/value.ts:1',
                        excerpt: 'export const value = 1;',
                    });
                    return { output: 'evidence collected' };
                },
            }],
            ...profileRequestHooks({
                validateFinalizationPrecondition: state => state.ledger.snapshot().some(item => item.source === 'repository')
                    ? null
                    : 'Repository evidence is required.',
            }),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'retry') {
                    events.push(`retry:${event.attempt}:${event.category}`);
                }
            },
        }).run(execution, profile, '/tmp/repository');

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.deepEqual(events, ['retry:1:evidencePrecondition']);
        assert.equal(requests.length, 4);
        assert.equal(requests[0].toolChoice, 'auto');
        assert.equal(requests[1].toolResults?.[0].isError, true);
        assert.match(requests[1].toolResults?.[0].output ?? '', /Repository evidence is required/);
        assert.equal(requests[3].toolChoice, 'none');
        assert.equal(result.state.ledger.snapshot().some(item => item.id === 'E1'), true);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'evidence_precondition').length, 1);
        assert.equal(result.metrics.toolSteps, 1);
    });

    it('stops terminal retries at the configured boundary', async () => {
        // Verify stops terminal retries at the configured boundary.
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            finishInvestigationResponse('missing evidence'),
            finishInvestigationResponse('still missing'),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'terminal-retry-limit-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'terminalRetryLimitTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [], opening: [] }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            ...profileRequestHooks({
                validateFinalizationPrecondition: () => 'Evidence remains missing.',
            }),
            normalizeFinal: raw => raw.value,
            preservePartialResult: (_state, error) => String((error as Error).message),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.match(result.output, /Evidence remains missing/);
        assert.equal(requests.length, 2);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'evidence_precondition').length, 2);
        assert.equal(result.metrics.toolSteps, 0);
    });

    it('degrades to finalization after evidence precondition repair turns are exhausted', async () => {
        // A degrade-policy profile must close tools after bounded finish retries and complete from the available evidence.
        const requests: AIRunRequest[] = [];
        const events: string[] = [];
        const execution = createExecution([
            finishInvestigationResponse('missing evidence'),
            finishInvestigationResponse('still missing'),
            response({ structured: { value: 'diff-only' }, text: '{"value":"diff-only"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'terminal-degrade-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'terminalDegradeTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [], opening: [] }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            finalizationPreconditionPolicy: 'degrade',
            ...profileRequestHooks({
                validateFinalizationPrecondition: () => 'Repository evidence is required.',
            }),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'retry' || event.type === 'stageChanged') {
                    events.push(event.type === 'retry'
                        ? `retry:${event.category}:${event.attempt}`
                        : `stage:${event.trigger}`);
                }
            },
        }).run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'diff-only');
        assert.deepEqual(events, ['retry:evidencePrecondition:1', 'stage:preconditionUnmet']);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'evidence_precondition_degraded').length, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'evidence_precondition').length, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'terminal_failure').length, 0);
        assert.equal(result.metrics.toolSteps, 0);
        assert.equal(requests.length, 3);
        assert.match(requests[1].toolResults?.[0].output ?? '', /still open/);
        assert.match(requests[2].toolResults?.[0].output ?? '', /diff-only/);
        assert.match(requests[2].toolResults?.[0].output ?? '', /never present a diff-only fact as a repository fact/i);
    });

    it('records a distinct degradation when the normal lookup budget ends without E* evidence', async () => {
        // A normal budget boundary must finalize without a terminal retry and classify missing evidence as an explicit degradation.
        const requests: AIRunRequest[] = [];
        const events: string[] = [];
        const execution = createExecution([
            inspectToolResponse('budgeted-lookup', 'check the changed symbol'),
            response({ structured: { value: 'budget-done' }, text: '{"value":"budget-done"}' }),
        ], requests, []);
        const profile = {
            ...buildInspectProfile(1, () => ({ output: 'navigation-only result' })),
            finalizationPreconditionPolicy: 'degrade' as const,
            validateFinalizationPrecondition: () => 'Repository evidence is required.',
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'retry' || event.type === 'stageChanged') {
                    events.push(event.type === 'retry'
                        ? `retry:${event.category}`
                        : `stage:${event.trigger}`);
                }
            },
        }).run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'budget-done');
        assert.deepEqual(events, ['stage:budgetExhausted']);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'evidence_precondition_degraded').length, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'evidence_precondition').length, 0);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'terminal_failure').length, 0);
        assert.equal(result.state.steps, 1);
        assert.equal(result.metrics.toolSteps, 1);
        assert.equal(requests.length, 2);
        assert.equal(requests[1].toolChoice, 'none');
    });

    it('soft-rejects over-budget tool calls then completes on forced terminal', async () => {
        // Verify soft-rejects over-budget tool calls then completes on forced terminal.
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                toolCalls: [
                    { id: 'allowed', name: 'inspect', arguments: { reason: 'one' } },
                    { id: 'over-budget', name: 'inspect', arguments: { reason: 'too late' } },
                ],
                stopReason: 'tool_call',
            }),
            response({ structured: { value: 'forced-done' }, text: '{"value":"forced-done"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'max-step-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'maxStepTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{ name: 'inspect', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: false }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: { type: 'object' },
                execute: async () => ({ output: 'executed-once' }),
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'forced-done');
        assert.equal(result.state.steps, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'budget_exhausted').length, 0);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].toolChoice, 'auto');
        assert.equal(requests[1].toolChoice, 'none');
        assert.ok(requests[1].responseFormat);
        assert.equal(requests[1].toolResults?.length, 2);
        assert.equal(requests[1].toolResults?.[1].isError, true);
        assert.match(requests[1].toolResults?.[1].output ?? '', /<investigation_closed>/);
        assert.match(requests[1].toolResults?.[1].output ?? '', /not executed/);
    });

    it('executes the first tool in a batch then soft-rejects the rest before forced terminal', async () => {
        // Verify executes the first tool in a batch then soft-rejects the rest before forced terminal.
        const requests: AIRunRequest[] = [];
        let executeCount = 0;
        const execution = createExecution([
            response({
                toolCalls: [
                    { id: 'first', name: 'inspect', arguments: { reason: 'one' } },
                    { id: 'second', name: 'inspect', arguments: { reason: 'two' } },
                ],
                stopReason: 'tool_call',
            }),
            response({ structured: { value: 'after-batch' }, text: '{"value":"after-batch"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'mid-batch-budget-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'midBatchBudgetTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{ name: 'inspect', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: false }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: { type: 'object' },
                execute: async () => {
                    executeCount += 1;
                    return { output: 'executed-once' };
                },
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(executeCount, 1);
        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'after-batch');
        assert.equal(result.state.steps, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'budget_exhausted').length, 0);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].toolChoice, 'auto');
        assert.equal(requests[1].toolChoice, 'none');
        assert.equal(requests[1].toolResults?.length, 2);
        assert.equal(requests[1].toolResults?.[0].output, 'executed-once');
        assert.notEqual(requests[1].toolResults?.[0].isError, true);
        assert.equal(requests[1].toolResults?.[1].isError, true);
        assert.match(requests[1].toolResults?.[1].output ?? '', /<investigation_closed>/);
        assert.match(requests[1].toolResults?.[1].output ?? '', /not executed/);
    });

    it('returns partial when forced finalize turn still requests tools', async () => {
        // Verify returns partial when forced finalize turn still requests tools.
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'still-tools', name: 'inspect', arguments: { reason: 'second' } }],
                stopReason: 'tool_call',
            }),
            response({
                toolCalls: [{ id: 'still-tools-2', name: 'inspect', arguments: { reason: 'third' } }],
                stopReason: 'tool_call',
            }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'forced-finalize-tools-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'forcedFinalizeToolsTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 0,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{ name: 'inspect', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: false }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: { type: 'object' },
                execute: async () => { throw new Error('execute must not run'); },
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'protocol_violation').length, 2);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].toolChoice, 'none');
        assert.equal(requests[1].toolChoice, 'none');
    });

    it('returns partial on invalid forced terminal without tool-asking retry', async () => {
        // Verify returns partial on invalid forced terminal without tool-asking retry.
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({ structured: { value: 'invalid-terminal' }, text: '{"value":"invalid-terminal"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'forced-finalize-invalid-terminal-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'forcedFinalizeInvalidTerminalTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 0,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{ name: 'inspect', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: false }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: { type: 'object' },
                execute: async () => { throw new Error('execute must not run'); },
            }],
            ...profileRequestHooks({
                validateFinalizationPrecondition: () => 'Evidence remains missing.',
            }),
            normalizeFinal: raw => raw.value,
            preservePartialResult: (_state, error) => String((error as Error).message),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.equal(requests.length, 0);
        assert.match(result.output, /Evidence remains missing/);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'evidence_precondition').length, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'terminal_failure').length, 0);
    });

    it('does not allow a read-only tool to allocate repository evidence', async () => {
        // Verify does not allow a read-only tool to allocate repository evidence.
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'read-only', name: 'inspect', arguments: { reason: 'attempt allocation' } }],
                stopReason: 'tool_call',
            }),
        ], [], []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'allocator-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'allocatorTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{ name: 'inspect', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: false }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: { type: 'object' },
                execute: async context => {
                    context.allocateEvidence({
                        kind: 'search',
                        target: 'x',
                        ref: 'src/x.ts:1',
                        excerpt: 'x',
                    });
                    return { output: 'must not execute' };
                },
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: (_state, error) => String((error as Error).message),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.match(result.output, /not allowed to allocate evidence/);
        assert.equal(result.state.ledger.snapshot().length, 0);
        assert.equal(result.metrics.issues.some(issue => issue.type === 'tool_rejected'), false);
        assert.equal(result.metrics.issues.some(issue => issue.type === 'terminal_failure'), true);
    });

    it('keeps raw and model-visible observation output separate when runtime truncates it', async () => {
        // Verify keeps raw and model-visible observation output separate when runtime truncates it.
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'inspect', name: 'inspect', arguments: { reason: 'collect details' } }],
                stopReason: 'tool_call',
            }),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const rawOutput = 'A complete repository observation that is longer than the visible budget.';
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'observation-output-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'observationOutputTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 20,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{ name: 'inspect', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: false }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: { type: 'object' },
                execute: async () => ({
                    output: rawOutput,
                    summary: 'Collected a complete observation.',
                    evidenceCount: 2,
                }),
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.equal(requests[1].toolChoice, 'none');
        assert.equal(result.state.observations.length, 1);
        const observation = result.state.observations[0];
        assert.equal(observation.rawOutput, rawOutput);
        assert.equal(observation.outputTruncated, true);
        assert.notEqual(observation.output, rawOutput);
        assert.match(observation.output, /tool output truncated by runtime policy/);
        assert.equal(observation.summary, 'Collected a complete observation.');
        assert.equal(observation.evidenceCount, 2);
        assert.equal(requests[1].toolResults?.[0].output, observation.output);
    });

    it('ends investigation early through finishInvestigation without consuming repository budget', async () => {
        // Verify ends investigation early through finishInvestigation without consuming repository budget.
        const requests: AIRunRequest[] = [];
        const events: Array<Record<string, unknown>> = [];
        const execution = createExecution([
            finishInvestigationResponse('planned questions answered'),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'early-finish-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'earlyFinishTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 3,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{ name: 'inspect', allowedRoot: '/tmp/repository', excludePatterns: [], allocateEvidence: false }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect.',
                parameters: { type: 'object' },
                execute: async () => { throw new Error('execute must not run'); },
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'stageChanged') {
                    events.push({
                        stage: event.stage,
                        trigger: event.trigger,
                        toolSteps: event.toolSteps,
                        evidenceCount: event.evidenceCount,
                        reason: event.reason,
                    });
                }
            },
        }).run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.equal(result.metrics.toolSteps, 0);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].toolChoice, 'auto');
        assert.equal(requests[0].responseFormat, undefined);
        assert.equal(requests[1].toolChoice, 'none');
        assert.ok(requests[1].responseFormat);
        assert.deepEqual(events, [{
            stage: 'finalization',
            trigger: 'finishTool',
            toolSteps: 0,
            evidenceCount: 0,
            reason: 'planned questions answered',
        }]);
    });

    it('skips investigation entirely when maxSteps is zero', async () => {
        // Verify skips investigation entirely when maxSteps is zero.
        const requests: AIRunRequest[] = [];
        const events: string[] = [];
        const execution = createExecution([
            response({ structured: { value: 'zero-budget' }, text: '{"value":"zero-budget"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'zero-budget-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'zeroBudgetTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 0,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'stageChanged') {
                    events.push(`${event.stage}:${event.trigger}`);
                }
            },
        }).run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'zero-budget');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].toolChoice, 'none');
        assert.deepEqual(events, ['finalization:noBudget']);
        assert.equal(result.metrics.toolSteps, 0);
    });

    it('rejects duplicate finishInvestigation calls in the same batch', async () => {
        // Verify rejects duplicate finishInvestigation calls in the same batch.
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                toolCalls: [
                    { id: 'finish-1', name: FINISH_INVESTIGATION_TOOL, arguments: { reason: 'done' } },
                    { id: 'finish-2', name: FINISH_INVESTIGATION_TOOL, arguments: { reason: 'again' } },
                ],
                stopReason: 'tool_call',
            }),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'duplicate-finish-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'duplicateFinishTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [], opening: [] }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'tool_rejected').length, 1);
        assert.equal(requests[1].toolResults?.[1].isError, true);
        assert.match(requests[1].toolResults?.[1].output ?? '', /already ended/);
    });

    it('retries protocol violations when investigation returns prose instead of tools', async () => {
        // Verify retries protocol violations when investigation returns prose instead of tools.
        const requests: AIRunRequest[] = [];
        const events: string[] = [];
        const execution = createExecution([
            response({ text: 'Here is my analysis.', stopReason: 'completed' }),
            finishInvestigationResponse('corrected'),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'protocol-violation-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'protocolViolationTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [], opening: [] }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'retry') {
                    events.push(`${event.stage}:${event.category}:${event.attempt}`);
                }
            },
        }).run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.deepEqual(events, ['investigation:protocolViolation:1']);
        assert.match(requests[1].messages?.[0].content ?? '', /without calling a tool/);
    });

    it('throws reserved finishInvestigation when a profile grants it explicitly', async () => {
        // Verify throws reserved finishInvestigation when a profile grants it explicitly.
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'reserved-tool-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'reservedToolTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [], opening: [] }),
            grantTools: () => [{
                name: FINISH_INVESTIGATION_TOOL,
                allowedRoot: '/tmp/repository',
                excludePatterns: [],
                allocateEvidence: false,
            }],
            buildToolDefinitions: () => [{
                name: FINISH_INVESTIGATION_TOOL,
                description: 'Reserved duplicate.',
                parameters: { type: 'object' },
                execute: async () => ({ output: 'must not run' }),
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };
        const execution = createExecution([], [], []);

        await assert.rejects(
            () => new AgentRuntime().run(execution, profile, null),
            /reserved control tool 'finishInvestigation'/,
        );
    });

    it('propagates cancellation without degrading to partial', async () => {
        // Verify propagates cancellation without degrading to partial.
        const controller = new AbortController();
        const requests: AIRunRequest[] = [];
        const tokenBudget = resolveChainTokenBudget({
            provider: 'custom',
            model: 'test-model',
            contextWindowTokens: 128_000,
        });
        const execution: LLMExecution = {
            model: 'test-model',
            temperature: 0.2,
            maxOutputTokens: tokenBudget.maxOutputTokens,
            maxRetries: 1,
            thinking: { reasoning: false, level: 'off' },
            tokenBudget,
            signal: controller.signal,
            createSession: messages => {
                const session: AISession = {
                    provider: 'custom',
                    model: 'test-model',
                    run: async () => {
                        controller.abort();
                        const error = new Error('The operation was aborted');
                        error.name = 'AbortError';
                        throw error;
                    },
                    snapshot: () => ({
                        provider: 'custom',
                        model: 'test-model',
                        continuation: { serverManaged: false },
                        transcript: [...messages],
                    }),
                };
                return session;
            },
            run: async () => { throw new Error('not used'); },
            accountCall: async () => ({ status: 'pricing-not-configured' as const }),
            getRecordedQuotes: () => [],
            notifyUsageCostIfEnabled: () => undefined,
        };
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'cancel-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'cancelTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 0,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [], opening: [] }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial-never-used',
        };

        await assert.rejects(
            () => new AgentRuntime().run(execution, profile, null),
            (error: unknown) => (error as Error).name === 'AbortError',
        );
    });

    it('counts rejected duplicate tool calls toward the step budget and still finalizes', async function () {
        // Verify counts rejected duplicate tool calls toward the step budget and still finalizes.
        this.timeout(5_000);
        const requests: AIRunRequest[] = [];
        let executeCount = 0;
        const maxSteps = 3;
        const execution = createExecution([
            inspectToolResponse('call-1', 'first attempt'),
            inspectToolResponse('call-2', 'second attempt'),
            inspectToolResponse('call-3', 'third attempt'),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const profile = buildInspectProfile(maxSteps, () => {
            executeCount += 1;
            return { output: 'inspected once' };
        });

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.equal(result.metrics.toolSteps, maxSteps);
        assert.equal(executeCount, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'duplicate_tool_call').length, 2);
        assert.equal(requests.length, 4);
        assert.equal(requests[0].toolChoice, 'auto');
        assert.equal(requests[0].responseFormat, undefined);
        assert.equal(requests[3].toolChoice, 'none');
        assert.ok(requests[3].responseFormat);
    });

    it('treats duplicate tool calls as identical when only reason differs', async () => {
        // Verify treats duplicate tool calls as identical when only reason differs.
        const requests: AIRunRequest[] = [];
        let executeCount = 0;
        const execution = createExecution([
            inspectToolResponse('call-1', 'first reason'),
            inspectToolResponse('call-2', 'second reason'),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        const profile = buildInspectProfile(2, () => {
            executeCount += 1;
            return { output: 'inspected once' };
        });

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(executeCount, 1);
        assert.equal(result.metrics.toolSteps, 2);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'duplicate_tool_call').length, 1);
        const duplicateResult = requests[2].toolResults?.find(result => result.isError === true);
        assert.ok(duplicateResult);
        assert.match(duplicateResult?.output ?? '', /Duplicate tool call/);
        assert.equal(requests[2].toolChoice, 'none');
    });

    it('keeps ten repository evidence items and continues after an in-band memory rejection', async () => {
        // Verify a memory source rejection remains an in-band tool observation while repository evidence is preserved.
        const requests: AIRunRequest[] = [];
        const snapshot = makeIncidentSnapshot();
        const memory = new MemoryRetriever({
            epoch: 'epoch', generation: 1, episodes: [], handbook: [], representedSupports: [], consolidated: [], organizedSeeds: [],
        }, snapshot, []);
        const recorder = new EpisodeRecorder(snapshot.identity, 'test-model');
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'repo-1', name: 'searchCode', arguments: {
                    reason: 'collect repository evidence', query: 'parse', dirPath: null,
                    searchType: 'content', useRegex: false, maxResults: 8, side: null,
                } }],
                stopReason: 'tool_call',
            }),
            response({
                toolCalls: [{ id: 'repo-2', name: 'searchCode', arguments: {
                    reason: 'collect the remaining repository evidence', query: 'secondary', dirPath: null,
                    searchType: 'content', useRegex: false, maxResults: 10, side: null,
                } }],
                stopReason: 'tool_call',
            }),
            response({
                toolCalls: [{ id: 'memory-1', name: 'readMemorySources', arguments: { memoryIds: ['M404'] } }],
                stopReason: 'tool_call',
            }),
            finishInvestigationResponse('the repository evidence is sufficient'),
            response({ structured: incidentTerminal(), text: JSON.stringify(incidentTerminal()) }),
        ], requests, []);
        const input = {
            snapshot,
            recorder,
            memory,
            rawDiff: [{
                kind: 'raw' as const,
                fileName: 'src/parser.ts',
                status: 'modified' as const,
                evidenceIds: ['D1'],
                rawDiff: '@@ -1 +1 @@\n-old\n+new',
            }],
            plan: {
                targets: [{
                    id: 'T1',
                    target: 'parse',
                    kind: 'symbol' as const,
                    file: 'src/parser.ts',
                    diffEvidenceRefs: ['D1'],
                    questions: ['Where is parse used?'],
                }],
                coverage: [{ diffEvidenceRef: 'D1', decision: 'investigate' as const, targetIds: ['T1'] }],
                notes: null,
            },
            repositoryPath: '/tmp/repository',
            excludePatterns: [],
            evidence: [],
            maxSteps: 4,
        };
        const events: Array<{ type: string; observation?: { tool: string; ok: boolean; output: string } }> = [];
        const result = await new AgentRuntime({ onEvent: event => {
            if (event.type === 'toolComplete') {
                events.push({ type: event.type, observation: event.observation });
            }
        } }).run(execution, createChangeAnalysisProfile(input), input, new EvidenceLedger());

        assert.equal(result.status, 'complete');
        assert.equal(result.output.analysisStatus, 'complete');
        assert.equal(result.metrics.toolSteps, 3);
        assert.deepEqual(result.state.observations.map(item => ({ tool: item.tool, ok: item.ok })), [
            { tool: 'searchCode', ok: true },
            { tool: 'searchCode', ok: true },
            { tool: 'readMemorySources', ok: false },
        ]);
        assert.deepEqual(result.state.ledger.snapshot()
            .filter(item => item.source === 'repository')
            .map(item => item.id), Array.from({ length: 10 }, (_, index) => `E${index + 1}`));
        const memoryEvent = events.find(event => event.observation?.tool === 'readMemorySources');
        assert.equal(memoryEvent?.observation?.ok, false);
        assert.equal(requests[3].toolResults?.[0].isError, true);
        const rejectedOutput = requests[3].toolResults?.[0].output ?? '';
        assert.deepEqual(JSON.parse(rejectedOutput).error, {
            code: 'unknown_memory_id',
            message: 'Unknown Memory navigation ID: M404.',
            memoryId: 'M404',
            used: 0,
            remaining: 16,
            limit: 16,
            searchesUsed: 0,
            searchesRemaining: 3,
            navigationTokens: 1500,
            resultTokens: 4096,
        });
        assert.equal(result.state.observations[2].output, rejectedOutput);
        assert.equal(result.state.observations[2].outputTruncated, false);
        assert.equal(requests[3].toolChoice, 'auto');
        assert.equal(requests[4].toolChoice, 'none');

        const episode = recorder.seal({
            changedPaths: ['src/parser.ts'], changedSymbols: ['parse'], questions: ['Where is parse used?'],
            claims: [], status: 'complete',
        });
        assert.deepEqual(episode.observations.map(observation => ({ tool: observation.tool, ok: observation.ok })), [
            { tool: 'searchCode', ok: true },
            { tool: 'searchCode', ok: true },
            { tool: 'readMemorySources', ok: false },
        ]);
        assert.deepEqual(episode.observations.slice(0, 2).flatMap(observation => observation.evidence.map(item => item.id)),
            Array.from({ length: 10 }, (_, index) => `E${index + 1}`));
        assert.deepEqual(episode.observations[2].evidence, []);
    });

    it('preserves published M ids in a checkpoint and restarts navigation at M1 per run', async () => {
        // Verify asynchronous live memory search publishes M navigation before checkpoint compression and restarts IDs per run.
        const requests: AIRunRequest[] = [];
        const snapshot = makeIncidentSnapshot();
        const view = {
            epoch: 'epoch',
            generation: 1,
            episodes: [makeCheckpointEpisode(snapshot)],
            handbook: [],
            representedSupports: [],
            consolidated: [],
            organizedSeeds: [],
        };
        const access = { load: async () => view, epoch: async () => view.epoch };
        const memory = new MemoryRetriever(view, snapshot, [], () => [], MEMORY_DEFAULTS, access);
        let published: Awaited<ReturnType<typeof memory.searchRepositoryMemory>> = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'memory-search', name: 'searchMemory', arguments: {} }],
                stopReason: 'tool_call',
            }),
            response({ structured: { value: 'done' }, text: '{"value":"done"}' }),
        ], requests, []);
        execution.tokenBudget.compressionTriggerTokens = 21;
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'memory-checkpoint-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'memoryCheckpointTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 1,
                maxObservationChars: 1_000,
                buildCheckpoint: () => ({ role: 'user', content: `checkpoint:${published.map(item => item.id).join(',')}` }),
            },
            buildPrompt: () => ({
                stable: [{ role: 'system', content: 'protocol' }],
                opening: [{ role: 'user', content: 'search memory' }],
            }),
            grantTools: () => [{
                name: 'searchMemory',
                allowedRoot: '/tmp/repository',
                excludePatterns: [],
                allocateEvidence: false,
            }],
            buildToolDefinitions: () => [{
                name: 'searchMemory',
                description: 'Search historical navigation.',
                parameters: { type: 'object' },
                execute: async () => {
                    published = await memory.searchRepositoryMemory({ paths: ['src/parser.ts'], symbols: [], keywords: ['parse'] });
                    return { output: JSON.stringify(published), preserveOutput: true };
                },
            }],
            ...profileRequestHooks(),
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.deepEqual(published.map(item => item.id), ['M1']);
        assert.equal(requests.length, 2);
        assert.equal(requests[1].messages?.[0].content, 'checkpoint:M1');
        assert.equal(requests[1].toolChoice, 'none');

        const nextRun = new MemoryRetriever(view, snapshot, []);
        assert.deepEqual(
            nextRun.retrieveNavigation({ paths: ['src/parser.ts'], symbols: [], keywords: ['parse'] }).map(item => item.id),
            ['M1'],
        );
    });
});

function incidentTerminal() {
    return {
        investigation: {
            findings: [],
            unresolvedQuestions: [],
            stopReason: 'The repository evidence was collected.',
        },
        claims: [{
            category: 'observed_change',
            claim: 'the parser diff changes one branch',
            evidenceRefs: ['D1'],
            disposition: 'must_express',
        }],
        behaviorAnalysis: { before: null, after: null, observableEffect: null },
        changeClassification: {
            existingBehaviorCorrected: false,
            newCapabilityAdded: false,
            externalBehaviorChanged: false,
            structuralOnly: true,
            recommendedType: null,
            reason: null,
        },
        suggestedScope: null,
        selectionNotes: null,
        uncertainties: [],
    };
}

function makeIncidentSnapshot(): RepositorySnapshotReader {
    const identity: SnapshotIdentity = {
        id: '1'.repeat(64), repositoryId: '2'.repeat(64), worktreeId: '3'.repeat(64), head: '4'.repeat(40),
        beforeTree: '5'.repeat(40), afterTree: '6'.repeat(40), indexFingerprint: '7'.repeat(64), autoStaged: false,
    };
    const contents = new Map<string, string>();
        const entries: SnapshotEntry[] = [];
    for (let index = 0; index < 10; index += 1) {
        const filePath = `src/memory-fixture-${index}.ts`;
        const content = index < 2 ? 'parse call secondary' : 'parse call';
        const oid = index.toString(16).padStart(40, '0');
        contents.set(filePath, content);
        entries.push({ path: filePath, mode: '100644', oid });
    }
    const snapshot = {
        root: '/tmp/repository',
        identity,
        metrics: { gitObjectCalls: 0, blobBytes: 0, sourceReads: 0, searchCalls: 0, filesSearched: 0 },
        entries: () => entries.map(entry => ({ ...entry })),
        entry: (filePath: string) => entries.find(entry => entry.path === filePath),
        readBatch: async (batch: SnapshotEntry[]) => new Map(batch.map(entry => [entry.oid, contents.get(entry.path) ?? ''])),
        observe: async (filePath: string, startLine: number, _maxLines: number, _excludes: string[] = [], side: 'before' | 'after' = 'after', maxChars = 2000): Promise<SourceObservation> => {
            const excerpt = (contents.get(filePath) ?? '').split('\n').slice(startLine - 1, startLine).join('\n').slice(0, maxChars);
            const entry = entries.find(candidate => candidate.path === filePath);
            return {
                snapshotId: identity.id,
                path: filePath,
                side,
                blobOid: entry?.oid ?? '8'.repeat(40),
                startLine,
                endLine: startLine,
                excerpt,
                contentHash: hashContent(excerpt),
                truncated: false,
                sourceType: 'text',
            };
        },
    };
    return snapshot as unknown as RepositorySnapshotReader;
}

function makeCheckpointEpisode(snapshot: RepositorySnapshotReader): InvestigationEpisode {
    const source = {
        snapshotId: snapshot.identity.id,
        path: 'src/memory-fixture-0.ts',
        side: 'after' as const,
        blobOid: '0'.repeat(40),
        startLine: 1,
        endLine: 1,
        excerpt: 'parse call secondary',
        contentHash: hashContent('parse call secondary'),
        truncated: false,
        sourceType: 'text' as const,
    };
    return {
        version: 2,
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: 1,
        snapshot: snapshot.identity,
        changedPaths: ['src/parser.ts'],
        changedSymbols: ['parse'],
        questions: ['Where is parse used?'],
        observations: [{
            step: 0,
            tool: 'readFileContent',
            arguments: { filePath: source.path, startLine: 1, maxLines: 1 },
            ok: true,
            summary: 'read source',
            evidence: [{ id: 'E1', source }],
            durationMs: 1,
            truncated: false,
        }],
        claims: [{ claim: 'The parser source was inspected.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        status: 'complete',
        model: 'checkpoint-test',
        promptVersion: 'memory-experience-1',
        toolsetVersion: 'snapshot-memory-experience-1',
    };
}

function makeDiff(fileName: string, headers: string[]): DiffData {
    return {
        fileName,
        status: 'modified',
        diffHunks: headers.map((header, index) => ({
            header,
            content: `-${index}\n+${index + 1}`,
            additions: [`${index + 1}`],
            deletions: [`${index}`],
        })),
        rawDiff: headers.map((header, index) => `${header}\n-${index}\n+${index + 1}`).join('\n'),
    };
}
