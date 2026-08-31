import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { AgentRunState, AgentRuntime, EvidenceLedger } from '../../agent';
import {
    createRepositoryAnalysisProfile,
    RepositoryAnalysisAgentInput,
} from '../../services/analysis/repository/repositoryAnalysisProfile';
import { LLMExecution } from '../../services/llm/llmTypes';
import { AIRunResponse, AIRunRequest, AISession } from '../../services/llm/providers';
import { resolveChainTokenBudget } from '../../services/llm/inputTokenBudget';
import { RepositoryAnalysis } from '../../services/analysis/repository/repositoryAnalysisTypes';

describe('RepositoryAnalysisProfile', () => {
    it('keeps initial and incremental prompts isolated while preserving the fixed tool contract', () => {
        const previous = makePreviousAnalysis();
        const initial = createRepositoryAnalysisProfile(makeInput());
        const incremental = createRepositoryAnalysisProfile(makeInput({ previousAnalysis: previous }));

        const initialPrompt = initial.buildPrompt(makeInput());
        const incrementalPrompt = incremental.buildPrompt(makeInput({ previousAnalysis: previous }));
        const initialState: AgentRunState = {
            ledger: new EvidenceLedger(),
            observations: [],
            issues: [],
            usages: [],
            apiCalls: 0,
            steps: 0,
            epoch: 0,
            stopReason: '',
        };

        assert.notEqual(initialPrompt.opening[0].content, incrementalPrompt.opening[0].content);
        assert.match(incrementalPrompt.opening[0].content, /incremental/);
        assert.deepEqual(
            initial.grantTools(makeInput()).map(tool => tool.name),
            ['listDirectory', 'searchFiles', 'readFileContent'],
        );
        assert.deepEqual(
            initial.buildToolDefinitions(makeInput(), initialState).map(tool => tool.name),
            ['listDirectory', 'searchFiles', 'readFileContent'],
        );
        assert.equal(initial.finalName, incremental.finalName);
        assert.equal(initial.requestType, incremental.requestType);
    });

    it('returns a failed partial result without fabricating an initial analysis', async () => {
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({ structured: { summary: '' }, text: '{"summary":""}' }),
        ], requests);

        const result = await new AgentRuntime().run(
            execution,
            createRepositoryAnalysisProfile(makeInput()),
            makeInput(),
        );

        assert.equal(result.status, 'partial');
        assert.equal(result.output.status, 'failed');
        assert.equal(result.output.analysis, null);
        assert.ok(result.output.issues.length > 0);
        assert.equal(requests.length, 1);
    });

    it('normalizes a complete terminal into the persistent analysis shape', async () => {
        const requests: AIRunRequest[] = [];
        const execution = createExecution([
            response({
                structured: {
                    summary: '  Repository summary. ',
                    projectType: ' Library ',
                    technologies: [' TypeScript ', 'TypeScript'],
                    insights: [' layered pipeline ', 'layered pipeline'],
                },
            }),
        ], requests);

        const result = await new AgentRuntime().run(
            execution,
            createRepositoryAnalysisProfile(makeInput()),
            makeInput(),
        );

        assert.equal(result.status, 'complete');
        assert.deepEqual(result.output.analysis, {
            summary: 'Repository summary.',
            projectType: 'Library',
            technologies: ['TypeScript'],
            insights: ['layered pipeline'],
        });
        assert.deepEqual(result.output.issues, []);
        assert.equal(requests[0].toolChoice, 'auto');
    });

    it('returns the same non-persistent failure shape for incremental analysis', async () => {
        const execution = createExecution([
            response({ structured: { summary: '' }, text: '{"summary":""}' }),
        ], []);
        const input = makeInput({ previousAnalysis: makePreviousAnalysis() });

        const result = await new AgentRuntime().run(
            execution,
            createRepositoryAnalysisProfile(input),
            input,
        );

        assert.equal(result.output.status, 'failed');
        assert.equal(result.output.analysis, null);
    });
});

function makeInput(overrides: Partial<RepositoryAnalysisAgentInput> = {}): RepositoryAnalysisAgentInput {
    return {
        repositoryPath: '/tmp/repository',
        recentCommits: ['feat: add runtime'],
        excludePatterns: ['node_modules'],
        maxSteps: 2,
        ...overrides,
    };
}

function makePreviousAnalysis(): RepositoryAnalysis {
    return {
        repositoryPath: '/tmp/repository',
        timestamp: '2026-08-30T00:00:00.000Z',
        summary: 'Previous repository summary.',
        projectType: 'Library',
        technologies: ['TypeScript'],
        insights: ['Uses a layered pipeline.'],
    };
}

function createExecution(
    responses: AIRunResponse[],
    requests: AIRunRequest[],
): LLMExecution {
    const tokenBudget = resolveChainTokenBudget({
        provider: 'custom',
        model: 'repository-test',
        contextWindowTokens: 128_000,
    });
    return {
        model: 'repository-test',
        temperature: 0,
        maxOutputTokens: tokenBudget.maxOutputTokens,
        maxRetries: 0,
        thinkingLevel: 'off',
        tokenBudget,
        thinkingFor: () => ({ reasoning: false, level: 'off' }),
        createSession: () => {
            const transcript: Array<{ role: 'system' | 'developer' | 'user' | 'assistant'; content: string }> = [];
            const session: AISession = {
                provider: 'custom',
                model: 'repository-test',
                run: async request => {
                    requests.push(request);
                    transcript.push(...(request.messages ?? []));
                    const next = responses.shift();
                    if (!next) {
                        throw new Error('No fake response remains.');
                    }
                    return next;
                },
                snapshot: () => ({
                    provider: 'custom',
                    model: 'repository-test',
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
