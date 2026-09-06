import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { AgentProfile, AgentRuntime, EvidenceLedger } from '../../agent';
import { createChangeAnalysisProfile } from '../../services/analysis/change/investigation/changeAnalysisProfile';
import { DiffData } from '../../services/git/gitTypes';
import { RepositorySnapshotReader } from '../../services/git/repositorySnapshot';
import { LLMExecution } from '../../services/llm/llmTypes';
import { AIRunRequest, AIRunResponse, AISession, CustomProvider } from '../../services/llm/providers';
import { resolveChainTokenBudget } from '../../services/llm/inputTokenBudget';

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
        thinkingLevel: 'low',
        tokenBudget,
        thinkingFor: () => ({ reasoning: true, level: 'low' }),
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

describe('AgentRuntime contracts', () => {
    it('keeps cache identity, tools, thinking, and schema stable across turns', async () => {
        const requests: AIRunRequest[] = [];
        const sessionIds: Array<string | undefined> = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'call-1', name: 'inspect', arguments: { reason: 'verify' } }],
                stopReason: 'tool_call',
                usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 },
            }),
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
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, '/tmp/repository');

        assert.equal(result.output, 'done');
        assert.deepEqual(sessionIds, ['agent:runtime-test:7:3:test-model']);
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[0].tools, requests[1].tools);
        assert.deepEqual(requests[0].thinking, requests[1].thinking);
        assert.deepEqual(requests[0].responseFormat, requests[1].responseFormat);
        assert.equal(requests[1].messages?.length, 0);
        assert.equal(requests[1].toolResults?.[0].output, 'verified');
        assert.equal(result.metrics.apiCalls, 2);
        assert.deepEqual(result.metrics.usage.map(usage => usage.cachedInputTokens), [80, 15]);
    });

    it('allocates globally unique D ids in diff order', () => {
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
                changeTargets: [],
                dependencyContext: {
                    callers: [], callees: [], stateDependencies: [], relatedConfigs: [], relatedTypes: [],
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
                capabilityContext: { technicalCapability: null, productCapability: null },
                intentAnalysis: { primaryIntent: null, supportedBy: [], confidence: 'low' },
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
            extraction: {
                changedFiles: [{ path: 'a.ts', changeType: 'modified' as const }],
                changedSymbols: [],
                introducedSymbols: [], removedSymbols: [], changedCalls: [], changedConfigs: [],
                changedTypes: [], changedDependencies: [],
            },
            plan: { targets: [], notes: null },
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
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.deepEqual(executedArguments.map(args => args.maxLines), [400]);
        assert.equal(requests.length, 3);
        assert.equal(requests[1].toolResults?.[0].isError, true);
        assert.match(requests[1].toolResults?.[0].output ?? '', /maxLines.*400/);
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
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.deepEqual(executedPaths, ['src/inside.ts']);
        assert.equal(requests[1].toolResults?.[0].isError, true);
        assert.match(requests[1].toolResults?.[0].output ?? '', /outside/);
        assert.equal(requests[2].toolResults?.[0].output, 'inside root');
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'tool_rejected').length, 1);
    });

    it('creates one deterministic epoch and preserves ledger ids across continuation', async () => {
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
        assert.equal(requests[1].messages?.[0].content.includes('checkpoint:D1'), true);
    });

    it('retries an invalid compound terminal without changing the request contract', async () => {
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
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'schemaRetry') {
                    events.push(`retry:${event.attempt}`);
                }
            },
        }).run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'repaired');
        assert.deepEqual(events, ['retry:1']);
        assert.deepEqual(requests[0].responseFormat, requests[1].responseFormat);
        assert.equal(requests[1].toolChoice, 'none');
    });

    it('repairs an invalid mixed terminal through a no-tools strict Custom request', async () => {
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
        const execution: LLMExecution = {
            model: 'local-model',
            temperature: 0.2,
            maxOutputTokens: tokenBudget.maxOutputTokens,
            maxRetries: 1,
            thinkingLevel: 'low',
            tokenBudget,
            thinkingFor: () => ({ reasoning: true, level: 'low' }),
            createSession: messages => provider.createSession({
                model: 'local-model',
                systemInstruction: messages.find(message => message.role === 'system')?.content,
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
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'repaired');
        assert.equal(requests.length, 3);
        assert.equal(requests[0].response_format, undefined);
        assert.equal(requests[1].response_format, undefined);
        assert.equal(requests[0].tool_choice, 'auto');
        assert.equal(requests[1].tool_choice, 'auto');
        assert.equal(requests[0].parallel_tool_calls, false);
        assert.equal(requests[1].parallel_tool_calls, false);
        assert.ok(Array.isArray(requests[0].tools));
        assert.ok(Array.isArray(requests[1].tools));
        assert.equal(requests[2].tool_choice, 'none');
        assert.equal(requests[2].tools, undefined);
        assert.equal(requests[2].parallel_tool_calls, undefined);
        const format = requests[2].response_format as {
            type: string;
            json_schema: { name: string; strict: boolean };
        };
        assert.equal(format.type, 'json_schema');
        assert.equal(format.json_schema.name, 'customMixedRepairFinal');
        assert.equal(format.json_schema.strict, true);
    });

    it('rejects a premature terminal and keeps tools available for profile-required evidence', async () => {
        const requests: AIRunRequest[] = [];
        const events: string[] = [];
        const execution = createExecution([
            response({ structured: { value: 'premature' }, text: '{"value":"premature"}' }),
            response({
                toolCalls: [{ id: 'collect', name: 'inspect', arguments: { reason: 'collect evidence' } }],
                stopReason: 'tool_call',
            }),
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
                maxSteps: 1,
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
            validateTerminal: (_raw, state) => state.ledger.snapshot().some(item => item.source === 'repository')
                ? null
                : 'Repository evidence is required.',
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime({
            onEvent: event => {
                if (event.type === 'terminalRetry') {
                    events.push(`retry:${event.attempt}`);
                }
            },
        }).run(execution, profile, '/tmp/repository');

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
        assert.deepEqual(events, ['retry:1']);
        assert.equal(requests.length, 3);
        assert.equal(requests[1].toolChoice, 'auto');
        assert.match(requests[1].messages?.[0].content ?? '', /Repository evidence is required/);
        assert.equal(result.state.ledger.snapshot().some(item => item.id === 'E1'), true);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'terminal_retry').length, 1);
    });

    it('stops terminal retries at the configured boundary', async () => {
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({ structured: { value: 'premature-1' } }),
            response({ structured: { value: 'premature-2' } }),
        ], requests, []);
        const profile: AgentProfile<null, { value: string }, string> = {
            id: 'terminal-retry-limit-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'terminalRetryLimitTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                // Keep unused step budget so failure uses profile retry limits,
                // not the budget-exhaustion path that skips tool-asking retries.
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [], opening: [] }),
            grantTools: () => [],
            buildToolDefinitions: () => [],
            validateTerminal: () => 'Evidence remains missing.',
            normalizeFinal: raw => raw.value,
            preservePartialResult: (_state, error) => String((error as Error).message),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.match(result.output, /remained invalid after 1 profile retry attempt/);
        assert.equal(requests.length, 2);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'terminal_retry').length, 1);
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'terminal_failure').length, 1);
    });

    it('soft-rejects over-budget tool calls then completes on forced terminal', async () => {
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'over-budget', name: 'inspect', arguments: { reason: 'too late' } }],
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
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'forced-done');
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'max_steps').length, 1);
        assert.equal(requests.length, 2);
        assert.equal(requests[1].toolChoice, 'none');
        assert.equal(requests[1].toolResults?.length, 1);
        assert.equal(requests[1].toolResults?.[0].isError, true);
        assert.match(requests[1].toolResults?.[0].output ?? '', /budget_exhausted/);
    });

    it('executes the first tool in a batch then soft-rejects the rest before forced terminal', async () => {
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
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(executeCount, 1);
        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'after-batch');
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'max_steps').length, 1);
        assert.equal(requests.length, 2);
        assert.equal(requests[1].toolChoice, 'none');
        assert.equal(requests[1].toolResults?.length, 2);
        assert.equal(requests[1].toolResults?.[0].output, 'executed-once');
        assert.notEqual(requests[1].toolResults?.[0].isError, true);
        assert.equal(requests[1].toolResults?.[1].isError, true);
        assert.match(requests[1].toolResults?.[1].output ?? '', /budget_exhausted/);
    });

    it('returns partial when forced finalize turn still requests tools', async () => {
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'over-budget', name: 'inspect', arguments: { reason: 'first' } }],
                stopReason: 'tool_call',
            }),
            response({
                toolCalls: [{ id: 'still-tools', name: 'inspect', arguments: { reason: 'second' } }],
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
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.equal(result.metrics.issues.filter(issue => issue.type === 'max_steps').length, 1);
        assert.equal(requests.length, 2);
    });

    it('returns partial on invalid forced terminal without tool-asking retry', async () => {
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'over-budget', name: 'inspect', arguments: { reason: 'too late' } }],
                stopReason: 'tool_call',
            }),
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
            validateTerminal: () => 'Evidence remains missing.',
            normalizeFinal: raw => raw.value,
            preservePartialResult: (_state, error) => String((error as Error).message),
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.equal(requests.length, 2);
        const allContent = requests.flatMap(request => request.messages ?? []).map(message => message.content).join('\n');
        assert.ok(!allContent.includes('terminal_rejected'));
        assert.ok(!allContent.includes('call the granted repository tools'));
        assert.ok(result.metrics.issues.some(issue => issue.type === 'terminal_failure'
            && (/budget exhaustion|Evidence remains missing/.test(issue.message))));
    });

    it('does not allow a read-only tool to allocate repository evidence', async () => {
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
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'complete');
        assert.equal(result.output, 'done');
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
});

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
