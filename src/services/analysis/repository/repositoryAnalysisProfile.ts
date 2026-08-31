import * as path from 'path';
import { z } from 'zod';
import {
    AgentProfile,
    type AgentRunMetrics,
    AgentRunState,
    AgentRuntime,
    AgentToolDefinition,
    ToolGrant,
} from '../../../agent';
import { LLMExecution } from '../../llm/llmTypes';
import { repoAnalysisResponseSchema } from '../../llm/providers/schemas/common';
import { listDirectory } from '../tools/directory';
import { readFileContent } from '../tools/file';
import { compactToolResultForConversation } from '../tools/formatting';
import { searchFiles } from '../tools/search';
import { ToolResult } from '../tools/types';
import { logger } from '../../logger';
import {
    logRepositoryAnalysisToolCall,
    logSchemaValidationToWebview,
    wrapSessionWithWebviewLogging,
} from '../../llm/chatWebviewLogging';
import { LLMAnalysisResponse, RepositoryAnalysis } from './repositoryAnalysisTypes';

type RawFinal = z.infer<typeof repoAnalysisResponseSchema>;

export interface RepositoryAnalysisAgentInput {
    repositoryPath: string;
    recentCommits: string[];
    excludePatterns: string[];
    previousAnalysis?: RepositoryAnalysis;
    maxSteps: number;
}

export interface RepositoryAnalysisAgentOutput {
    analysis: LLMAnalysisResponse | null;
    status: 'complete' | 'failed';
    issues: string[];
    runtimeMetrics?: AgentRunMetrics;
}

const TOOL_ORDER = ['listDirectory', 'searchFiles', 'readFileContent'] as const;
type RepositoryToolName = typeof TOOL_ORDER[number];

const TOOL_PARAMETERS: Record<RepositoryToolName, Record<string, unknown>> = {
    listDirectory: objectSchema({
        reason: { type: 'string', minLength: 1 },
        dirPath: { type: 'string' },
        depth: nullable({ type: 'integer', minimum: 0 }),
    }, ['reason', 'dirPath', 'depth']),
    searchFiles: objectSchema({
        reason: { type: 'string', minLength: 1 },
        query: { type: 'string', minLength: 1 },
        searchType: { enum: ['name', 'content'] },
        useRegex: nullable({ type: 'boolean' }),
        searchPath: nullable({ type: 'string' }),
        maxResults: nullable({ type: 'integer', minimum: 1 }),
        caseSensitive: nullable({ type: 'boolean' }),
        maxMatchesPerFile: nullable({ type: 'integer', minimum: 1 }),
        contextLines: nullable({ type: 'integer', minimum: 0 }),
    }, ['reason', 'query', 'searchType', 'useRegex', 'searchPath', 'maxResults', 'caseSensitive', 'maxMatchesPerFile', 'contextLines']),
    readFileContent: objectSchema({
        reason: { type: 'string', minLength: 1 },
        filePath: { type: 'string', minLength: 1 },
        startLine: nullable({ type: 'integer', minimum: 1 }),
        maxLines: nullable({ type: 'integer', minimum: 1 }),
        encoding: nullable({ type: 'string' }),
    }, ['reason', 'filePath', 'startLine', 'maxLines', 'encoding']),
};

function nullable(schema: Record<string, unknown>): Record<string, unknown> {
    return { anyOf: [schema, { type: 'null' }] };
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
    return { type: 'object', properties, required, additionalProperties: false };
}

export function createRepositoryAnalysisProfile(
    input: RepositoryAnalysisAgentInput,
): AgentProfile<RepositoryAnalysisAgentInput, RawFinal, RepositoryAnalysisAgentOutput> {
    const incremental = input.previousAnalysis !== undefined;
    return {
        id: 'repository-analysis',
        promptVersion: '2',
        toolsetVersion: '2',
        requestType: 'investigation',
        finalName: 'repositoryAnalysisFinal',
        finalSchema: repoAnalysisResponseSchema,
        contextPolicy: {
            maxSteps: input.maxSteps,
            maxEpochs: 1,
            maxObservationChars: 40_000,
            buildCheckpoint: state => ({
                role: 'user',
                content: [
                    '<context_checkpoint>',
                    `Mode: ${incremental ? 'incremental' : 'initial'}`,
                    `Completed tool calls: ${state.steps}`,
                    `Observations: ${JSON.stringify(compactCheckpointObservations(state))}`,
                    `Previous analysis: ${JSON.stringify(input.previousAnalysis ?? null)}`,
                    `Recent commits: ${JSON.stringify(input.recentCommits)}`,
                    'Continue with the unchanged tools and return the repository analysis terminal.',
                    '</context_checkpoint>',
                ].join('\n'),
            }),
        },
        buildPrompt: profileInput => ({
            stable: [{
                role: 'system',
                content: [
                    '<agent_protocol>',
                    'You are an autonomous repository analysis agent.',
                    'Use the fixed repository tools to establish purpose, architecture, technologies, and key insights.',
                    'For every tool call include a concise English reason.',
                    'Prefer targeted search and bounded reads over broad scans.',
                    'Return the fixed structured terminal when the analysis is sufficient.',
                    '</agent_protocol>',
                ].join('\n'),
            }],
            opening: [{
                role: 'user',
                content: [
                    '<run_context>',
                    `Mode: ${profileInput.previousAnalysis ? 'incremental' : 'initial'}`,
                    `Exclude patterns: ${JSON.stringify(profileInput.excludePatterns)}`,
                    `Previous analysis: ${JSON.stringify(profileInput.previousAnalysis ?? null)}`,
                    `Recent commits: ${JSON.stringify(profileInput.recentCommits)}`,
                    '</run_context>',
                    '<objective>',
                    profileInput.previousAnalysis
                        ? 'Verify whether recent commits materially changed repository functionality or architecture. Preserve unchanged fields and finalize early when no material change is established.'
                        : 'Explore high-signal files and produce the initial repository analysis.',
                    '</objective>',
                ].join('\n'),
            }],
        }),
        grantTools: profileInput => TOOL_ORDER.map(name => ({
            name,
            allowedRoot: profileInput.repositoryPath,
            excludePatterns: [...profileInput.excludePatterns],
            maxResults: name === 'searchFiles' ? 100 : undefined,
            maxLines: name === 'readFileContent' ? 1_000 : undefined,
            maxDepth: name === 'listDirectory' ? 4 : undefined,
            allocateEvidence: false,
        })),
        buildToolDefinitions: (_profileInput, state) => TOOL_ORDER.map(name => (
            createToolDefinition(name, input, state)
        )),
        normalizeFinal: (raw, state) => ({
            analysis: {
                summary: raw.summary.trim(),
                projectType: raw.projectType.trim(),
                technologies: uniqueStrings(raw.technologies),
                insights: uniqueStrings(raw.insights),
            },
            status: 'complete',
            issues: state.issues.map(issue => issue.message),
        }),
        preservePartialResult: (state, error) => ({
            analysis: null,
            status: 'failed',
            issues: [
                ...state.issues.map(issue => issue.message),
                String((error as { message?: unknown })?.message ?? error),
            ],
        }),
    };
}

function createToolDefinition(
    name: RepositoryToolName,
    input: RepositoryAnalysisAgentInput,
    state: AgentRunState,
): AgentToolDefinition<RepositoryAnalysisAgentInput> {
    return {
        name,
        description: {
            listDirectory: 'List repository entries under a bounded directory depth.',
            searchFiles: 'Search repository file names or contents.',
            readFileContent: 'Read a bounded range from one repository file.',
        }[name],
        parameters: TOOL_PARAMETERS[name],
        execute: async (context, args) => {
            const reason = String(args.reason ?? '').trim();
            logger.info(
                `[Genie][RepoAnalysis] Step ${state.steps}/${input.maxSteps}: ${name}. Reason: ${reason.slice(0, 500)}`,
            );
            if (name !== 'readFileContent') {
                logRepositoryAnalysisToolCall(
                    input.repositoryPath,
                    name,
                    args,
                    reason,
                    state.steps,
                    input.maxSteps,
                );
            }
            const result = await runRepositoryTool(context.grant, name, args);
            return {
                ok: result.success,
                output: compactToolResultForConversation(
                    input.repositoryPath,
                    name,
                    result,
                ).compactText,
            };
        },
    };
}

async function runRepositoryTool(
    grant: ToolGrant,
    name: RepositoryToolName,
    args: Record<string, unknown>,
): Promise<ToolResult<unknown>> {
    switch (name) {
        case 'listDirectory': {
            const directory = resolveInside(grant.allowedRoot, String(args.dirPath ?? '.'));
            return listDirectory(directory, {
                depth: typeof args.depth === 'number' ? args.depth : 1,
                excludePatterns: grant.excludePatterns,
            });
        }
        case 'searchFiles': {
            const query = String(args.query ?? '').trim();
            const searchPath = typeof args.searchPath === 'string'
                ? resolveInside(grant.allowedRoot, args.searchPath)
                : grant.allowedRoot;
            return searchFiles(grant.allowedRoot, query, {
                searchType: args.searchType === 'content' ? 'content' : 'name',
                useRegex: args.useRegex === true,
                searchPath,
                maxResults: typeof args.maxResults === 'number' ? args.maxResults : 50,
                caseSensitive: args.caseSensitive === true,
                excludePatterns: grant.excludePatterns,
                maxMatchesPerFile: typeof args.maxMatchesPerFile === 'number' ? args.maxMatchesPerFile : 5,
                contextLines: typeof args.contextLines === 'number' ? args.contextLines : 2,
            });
        }
        case 'readFileContent': {
            const filePath = resolveInside(grant.allowedRoot, String(args.filePath));
            return readFileContent(filePath, {
                startLine: typeof args.startLine === 'number' ? args.startLine : 1,
                maxLines: typeof args.maxLines === 'number' ? args.maxLines : 200,
                encoding: typeof args.encoding === 'string' ? args.encoding : 'utf-8',
            }, String(args.reason ?? 'Repository analysis'));
        }
    }
}

function resolveInside(repositoryPath: string, candidate: string): string {
    const root = path.resolve(repositoryPath);
    const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Repository tool path escapes root: ${candidate}`);
    }
    return absolute;
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function compactCheckpointObservations(state: AgentRunState): Array<Record<string, unknown>> {
    const maxCheckpointChars = 60_000;
    let remaining = maxCheckpointChars;
    return state.observations.map(observation => {
        const maxOutputChars = Math.min(1_200, Math.max(0, remaining));
        const output = observation.output.slice(0, maxOutputChars);
        remaining -= output.length;
        return {
            tool: observation.tool,
            arguments: observation.arguments,
            ok: observation.ok,
            output,
            truncated: output.length < observation.output.length,
        };
    });
}

export async function runRepositoryAnalysisProfile(
    input: RepositoryAnalysisAgentInput,
    execution: LLMExecution,
): Promise<RepositoryAnalysisAgentOutput> {
    const runtime = new AgentRuntime({
        wrapSession: session => wrapSessionWithWebviewLogging(
            session,
            input.repositoryPath,
            'investigation',
        ),
        onEvent: event => {
            if (event.type === 'schemaRetry') {
                logSchemaValidationToWebview(
                    input.repositoryPath,
                    { profile: 'repository-analysis', attempt: event.attempt, message: event.message },
                    'Repository analysis terminal schema retry',
                );
            }
        },
    });
    const result = await runtime.run(execution, createRepositoryAnalysisProfile(input), input);
    return { ...result.output, runtimeMetrics: result.metrics };
}
