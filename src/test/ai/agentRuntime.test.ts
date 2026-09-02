import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { AgentProfile, AgentRuntime, EvidenceLedger } from '../../agent';
import { createChangeAnalysisProfile } from '../../services/analysis/change/investigation/changeAnalysisProfile';
import { DiffData } from '../../services/git/gitTypes';
import { LLMExecution } from '../../services/llm/llmTypes';
import { AIRunRequest, AIRunResponse, AISession } from '../../services/llm/providers';
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

    it('rejects paths and numeric arguments outside a tool grant', async () => {
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                toolCalls: [{
                    id: 'escape',
                    name: 'inspect',
                    arguments: { filePath: '../outside.ts', maxResults: 51, maxLines: 401, depth: 2 },
                }],
                stopReason: 'tool_call',
            }),
        ], requests, []);
        const profile: AgentProfile<string, { value: string }, string> = {
            id: 'permission-test',
            promptVersion: '1',
            toolsetVersion: '1',
            requestType: 'investigation',
            finalName: 'permissionTestFinal',
            finalSchema: z.object({ value: z.string() }),
            contextPolicy: {
                maxSteps: 1,
                maxEpochs: 0,
                maxObservationChars: 100,
                buildCheckpoint: () => ({ role: 'user', content: 'checkpoint' }),
            },
            buildPrompt: () => ({ stable: [{ role: 'system', content: 'protocol' }], opening: [] }),
            grantTools: () => [{
                name: 'inspect',
                allowedRoot: '/tmp/repository',
                excludePatterns: [],
                maxResults: 50,
                maxLines: 400,
                maxDepth: 1,
                allocateEvidence: false,
            }],
            buildToolDefinitions: () => [{
                name: 'inspect',
                description: 'Inspect a bounded path.',
                parameters: { type: 'object' },
                execute: async () => ({ output: 'must not execute' }),
            }],
            normalizeFinal: raw => raw.value,
            preservePartialResult: (_state, error) => String((error as Error).message),
        };

        const result = await new AgentRuntime().run(execution, profile, '/tmp/repository');

        assert.equal(result.status, 'partial');
        assert.match(result.output, /outside/);
        assert.equal(requests.length, 1);
        assert.equal(result.state.observations.length, 0);
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
                maxSteps: 0,
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

    it('records max-step exhaustion once when a tool call arrives after the budget', async () => {
        const execution = createExecution([
            response({
                toolCalls: [{ id: 'over-budget', name: 'inspect', arguments: { reason: 'too late' } }],
                stopReason: 'tool_call',
            }),
        ], [], []);
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
                execute: async () => ({ output: 'must not execute' }),
            }],
            normalizeFinal: raw => raw.value,
            preservePartialResult: () => 'partial',
        };

        const result = await new AgentRuntime().run(execution, profile, null);

        assert.equal(result.status, 'partial');
        assert.equal(result.state.issues.filter(issue => issue.type === 'max_steps').length, 1);
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
