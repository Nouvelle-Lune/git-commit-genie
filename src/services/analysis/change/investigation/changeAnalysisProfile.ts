import { z } from 'zod';
import { RepositorySnapshotReader } from '../../../git/repositorySnapshot';
import { EpisodeRecorder } from '../../../memory/recorder';
import { MemoryRetriever } from '../../../memory/retriever';
import { MemoryNavigation } from '../../../memory/types';
import { MemoryRequestError } from '../../../memory/settings';
import {
    AgentProfile,
    type AgentRunMetrics,
    AgentRunState,
    AgentToolDefinition,
    EvidenceLedger,
    FINISH_INVESTIGATION_TOOL,
    ToolGrant,
} from '../../../../agent';
import {
    buildCorrectionLines,
    buildInvestigationProtocolLines,
    buildTerminalContractLines,
} from './terminalContract';
import { LLMExecution } from '../../../llm/llmTypes';
import { AGENT_TERMINAL_LIMITS, changeAnalysisAgentFinalResponseSchema } from '../../../llm/providers/schemas/common';
import { normalizeSemanticAnalysis } from '../semanticAnalysis';
import {
    AgentClaim,
    ChangeAnalysisStatus,
    DraftEvidence,
    InformationSelection,
    InvestigationFinding,
    InvestigationPlan,
    RepositoryEvidence,
    RepositoryEvidenceItem,
    SemanticChangeAnalysis,
    TracedAgentClaim,
} from '../types';
import { buildInvestigationToolResultMessage } from '../prompts';
import {
    CHANGE_ANALYSIS_TOOL_NAMES,
    InvestigationToolCall,
    InvestigationToolContext,
    InvestigationToolName,
    runInvestigationTool,
} from './tools';

type RawFinal = z.infer<typeof changeAnalysisAgentFinalResponseSchema>;

export interface InvestigationStepEvent {
    step: number;
    tool: string;
    source: 'repository' | 'memory';
    reason: string;
    summary: string;
    ok: boolean;
    evidenceCount: number;
    sourceStatuses?: string[];
    arguments: Record<string, unknown>;
    rawOutput: string;
    modelVisibleOutput: string;
    outputTruncated: boolean;
}

export interface ChangeAnalysisAgentInput {
    snapshot?: RepositorySnapshotReader;
    recorder?: EpisodeRecorder;
    memory?: MemoryRetriever;
    navigation?: MemoryNavigation[];
    rawDiff: DraftEvidence[];
    plan: InvestigationPlan;
    repositoryPath: string;
    excludePatterns: string[];
    evidence: DraftEvidence[];
    userTemplate?: string;
    maxSteps: number;
}

export interface ChangeAnalysisAgentOutput {
    repositoryEvidence: RepositoryEvidence;
    semanticAnalysis: SemanticChangeAnalysis;
    informationSelection: InformationSelection;
    analysisStatus: ChangeAnalysisStatus;
    issues: string[];
    runtimeMetrics?: AgentRunMetrics;
    claims: TracedAgentClaim[];
}

const REASON_PROPERTY = { reason: { type: 'string', minLength: 1 } };
const SYMBOL_PROPERTIES = {
    ...REASON_PROPERTY,
    symbol: { type: 'string', minLength: 1 },
    filePath: nullable({ type: 'string' }),
    maxResults: nullable({ type: 'integer', minimum: 1, maximum: 50 }),
};

const TOOL_PARAMETERS: Record<InvestigationToolName, Record<string, unknown>> = {
    findSymbolDefinition: objectSchema(SYMBOL_PROPERTIES, ['reason', 'symbol', 'filePath', 'maxResults']),
    findSymbolReferences: objectSchema(SYMBOL_PROPERTIES, ['reason', 'symbol', 'filePath', 'maxResults']),
    findCallers: objectSchema(SYMBOL_PROPERTIES, ['reason', 'symbol', 'filePath', 'maxResults']),
    findCallees: objectSchema(SYMBOL_PROPERTIES, ['reason', 'symbol', 'filePath', 'maxResults']),
    findImplementations: objectSchema(SYMBOL_PROPERTIES, ['reason', 'symbol', 'filePath', 'maxResults']),
    findTypeDefinition: objectSchema(SYMBOL_PROPERTIES, ['reason', 'symbol', 'filePath', 'maxResults']),
    searchCode: objectSchema({
        ...REASON_PROPERTY,
        query: { type: 'string', minLength: 1 },
        dirPath: nullable({ type: 'string' }),
        searchType: nullable({ enum: ['name', 'content'] }),
        useRegex: nullable({ type: 'boolean' }),
        maxResults: nullable({ type: 'integer', minimum: 1, maximum: 50 }),
    }, ['reason', 'query', 'dirPath', 'searchType', 'useRegex', 'maxResults']),
    readFileContent: objectSchema({
        ...REASON_PROPERTY,
        filePath: { type: 'string', minLength: 1 },
        startLine: nullable({ type: 'integer', minimum: 1 }),
        maxLines: nullable({ type: 'integer', minimum: 1, maximum: 400 }),
    }, ['reason', 'filePath', 'startLine', 'maxLines']),
    listDirectory: objectSchema({
        ...REASON_PROPERTY,
        dirPath: nullable({ type: 'string' }),
    }, ['reason', 'dirPath']),
};

function nullable(schema: Record<string, unknown>): Record<string, unknown> {
    return { anyOf: [schema, { type: 'null' }] };
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
    return { type: 'object', properties, required, additionalProperties: false };
}

function cleanStrings(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return Array.from(new Set(values
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(value => value.trim())));
}

function cleanText(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toToolCall(name: InvestigationToolName, args: Record<string, unknown>): InvestigationToolCall {
    return {
        tool: name,
        side: args.side === 'before' ? 'before' : 'after',
        symbol: typeof args.symbol === 'string' ? args.symbol : null,
        filePath: typeof args.filePath === 'string' ? args.filePath : null,
        dirPath: typeof args.dirPath === 'string' ? args.dirPath : null,
        query: typeof args.query === 'string' ? args.query : null,
        searchType: args.searchType === 'name' || args.searchType === 'content' ? args.searchType : null,
        useRegex: typeof args.useRegex === 'boolean' ? args.useRegex : null,
        startLine: typeof args.startLine === 'number' ? args.startLine : null,
        maxLines: typeof args.maxLines === 'number' ? args.maxLines : null,
        maxResults: typeof args.maxResults === 'number' ? args.maxResults : null,
    };
}

export function createChangeAnalysisProfile(
    input: ChangeAnalysisAgentInput,
): AgentProfile<ChangeAnalysisAgentInput, RawFinal, ChangeAnalysisAgentOutput> {
    const plannedQuestions = input.plan.targets.flatMap(target =>
        target.questions.map(question => `${target.target}: ${question}`)
    );
    const evidenceItems: RepositoryEvidenceItem[] = [];

    return {
        id: 'change-analysis',
        // Cached prompt identities must not reuse the former UUID-based Memory contract.
        promptVersion: '9',
        toolsetVersion: 'snapshot-memory-experience-2',
        requestType: 'investigation',
        finalName: 'changeAnalysisCompoundTerminal',
        finalSchema: changeAnalysisAgentFinalResponseSchema,
        contextPolicy: {
            maxSteps: input.maxSteps,
            maxEpochs: 1,
            maxObservationChars: 12_000,
            buildCheckpoint: state => ({
                role: 'user',
                content: [
                    '<context_checkpoint>',
                    'Continue the same change analysis from this deterministic checkpoint.',
                    `Completed tool calls: ${state.steps}`,
                    `Published memory navigation (historical investigation experience): ${JSON.stringify(input.memory?.publishedNavigation ?? [])}`,
                    `Remaining memory budget: ${JSON.stringify(input.memory?.budget ?? null)}`,
                    `Raw diff evidence: ${JSON.stringify(input.rawDiff)}`,
                    `Repository evidence ledger: ${JSON.stringify(state.ledger.snapshot()
                        .filter(item => item.source === 'repository'))}`,
                    `Completed calls: ${JSON.stringify(state.observations.map(item => ({ tool: item.tool, arguments: item.arguments, ok: item.ok })))}`,
                    `Planned-question checklist (not automatically marked complete): ${plannedQuestions.join(' | ') || 'none'}`,
                    `Use the unchanged tool contract and the evidence already collected to decide which questions remain material. Call ${FINISH_INVESTIGATION_TOOL} once they are answered or unanswerable.`,
                    '</context_checkpoint>',
                ].join('\n'),
            }),
        },
        buildPrompt: profileInput => ({
            stable: [{
                role: 'system',
                content: [
                    '<agent_protocol>',
                    ...buildInvestigationProtocolLines(FINISH_INVESTIGATION_TOOL),
                    '</agent_protocol>',
                ].join('\n'),
            }],
            opening: [{
                role: 'user',
                content: [
                    '<run_context>',
                    `Repository tool budget: ${profileInput.maxSteps} call(s). ${FINISH_INVESTIGATION_TOOL} is free and does not count against it.`,
                    `Investigation plan: ${JSON.stringify(profileInput.plan)}`,
                    `Raw diff evidence: ${JSON.stringify(profileInput.rawDiff)}`,
                    `Untrusted memory navigation (historical investigation experience): ${JSON.stringify(profileInput.navigation ?? [])}`,
                    `User template constraints: ${JSON.stringify(profileInput.userTemplate ?? null)}`,
                    '</run_context>',
                    '<investigation_goal>',
                    'Resolve the highest-value planned uncertainties with the narrowest repository lookups that directly support an answer.',
                    'Start from exact changed paths and symbols. Expand to consumers, callers, implementations, configuration, or tests only when that relation changes the factual commit-message claim.',
                    'If the plan contains targets, at least one successful evidence-producing lookup must publish E* evidence before finishInvestigation can be accepted.',
                    'Treat unanswered or unanswerable questions as unresolved; never manufacture an answer to complete the checklist.',
                    'The structured change-analysis object is requested in a separate turn after the investigation is closed.',
                    'Do not assemble it now, and do not describe its fields in this phase.',
                    '</investigation_goal>',
                ].join('\n'),
            }],
        }),
        grantTools: profileInput => (!profileInput.snapshot || !profileInput.plan.targets.length)
            ? []
            : [...CHANGE_ANALYSIS_TOOL_NAMES, ...(profileInput.memory ? ['searchRepositoryMemory', 'readMemorySources'] : [])].map(name => ({
            name,
            allowedRoot: profileInput.repositoryPath,
            excludePatterns: [...profileInput.excludePatterns],
            maxResults: 50,
            maxLines: 400,
            maxDepth: 1,
            allocateEvidence: !['listDirectory', 'searchRepositoryMemory'].includes(name),
        })),
        buildToolDefinitions: (_profileInput, state) => [...CHANGE_ANALYSIS_TOOL_NAMES.map(name => (
            createExecutableDefinition(name, input, state, evidenceItems, plannedQuestions)
        )), ...createMemoryDefinitions(input, state, evidenceItems)],
        validateFinalizationPrecondition: state => {
            if (!input.plan.targets.length) {
                return null;
            }
            const hasRepositoryEvidence = state.ledger.snapshot().some(item => item.source === 'repository');
            return hasRepositoryEvidence
                ? null
                : 'The investigation plan contains targets, but no E* repository evidence has been collected yet.'
                + ' A non-empty plan must produce at least one real repository evidence item before the investigation can end.';
        },
        // Missing repository evidence is observable degradation, not a reason
        // to discard the D* facts and prevent the downstream draft stage.
        finalizationPreconditionPolicy: 'degrade',
        buildFinalizationRequest: (profileInput, state, reason) => {
            const hasRepositoryEvidence = state.ledger.snapshot().some(item => item.source === 'repository');
            return [{
                role: 'user',
                content: [
                    '<investigation_closed>',
                    `Repository lookups used: ${state.steps} of ${profileInput.maxSteps}.`,
                    reason
                        ? `Your stated reason for stopping: ${reason}`
                        : hasRepositoryEvidence
                            ? 'The repository lookup limit ended the investigation normally.'
                            : 'No repository evidence was collected before investigation closed. Produce an explicit diff-only analysis so the draft stage can continue; never present a diff-only fact as a repository fact.',
                    `Diff evidence ids: ${JSON.stringify(diffEvidenceIds(state))}`,
                    `Repository evidence ids: ${JSON.stringify(repositoryEvidenceIndex(state))}`,
                    `Planned questions: ${plannedQuestions.join(' | ') || 'none'}`,
                    'Only the ids listed above exist. Any other id is invalid and will be rejected.',
                    '</investigation_closed>',
                    '',
                    ...buildTerminalContractLines(),
                ].join('\n'),
            }];
        },
        buildCorrectionRequest: (_profileInput, _state, failure) => [{
            role: 'user',
            content: buildCorrectionLines(failure, FINISH_INVESTIGATION_TOOL).join('\n'),
        }],
        normalizeFinal: (raw, state) => normalizeCompoundTerminal(raw, state, evidenceItems),
        // Terminal schema failures remain fatal. Only the explicit no-E*
        // precondition uses the typed diff-only path above.
        preservePartialResult: (_state, error) => { throw error; },
    };
}

function diffEvidenceIds(state: AgentRunState): string[] {
    return state.ledger.snapshot()
        .filter(entry => entry.source === 'diff')
        .map(entry => entry.id);
}

/**
 * Restates the repository evidence the model may cite. The ids already appeared
 * in tool results, but the finalization turn is where they get cited, and an
 * explicit closed list is what makes an invented id obviously wrong.
 */
function repositoryEvidenceIndex(state: AgentRunState): Array<{ id: string; kind: string; ref: string }> {
    return state.ledger.snapshot().flatMap(entry => (
        entry.source === 'repository'
            ? [{ id: entry.id, kind: entry.kind, ref: entry.ref }]
            : []
    ));
}

function createExecutableDefinition(
    name: InvestigationToolName,
    input: ChangeAnalysisAgentInput,
    state: AgentRunState,
    evidenceItems: RepositoryEvidenceItem[],
    plannedQuestions: string[],
): AgentToolDefinition<ChangeAnalysisAgentInput> {
    return {
        name,
        description: toolDescription(name),
        parameters: {
            ...TOOL_PARAMETERS[name],
            properties: { ...(TOOL_PARAMETERS[name].properties as Record<string, unknown>), side: { anyOf: [{ enum: ['before', 'after'] }, { type: 'null' }], description: 'Captured HEAD (before) or staged index (after, default). Never the working tree.' } },
            required: [...TOOL_PARAMETERS[name].required as string[], 'side'],
        },
        execute: async (context, args) => {
            const toolName = name;
            if (!input.snapshot) {
                throw new Error('Repository snapshot is required for a repository tool call.');
            }
            const toolContext: InvestigationToolContext = {
                snapshot: input.snapshot,
                repositoryPath: context.grant.allowedRoot,
                excludePatterns: context.grant.excludePatterns,
                allocateEvidence: evidence => context.allocateEvidence(evidence),
            };
            const started = performance.now();
            const outcome = await runInvestigationTool(toolContext, toToolCall(toolName, args));
            input.recorder?.record({ step: state.steps, tool: toolName, arguments: args, ok: outcome.ok,
                summary: outcome.summary, ...(outcome.error ? { error: outcome.error } : {}), evidence: outcome.evidence.map(evidence => {
                    if (!evidence.provenance) { throw new Error('Snapshot tool returned evidence without provenance.'); }
                    return { id: evidence.id, source: evidence.provenance };
                }), durationMs: performance.now() - started, truncated: outcome.evidence.some(evidence => evidence.provenance?.truncated) });
            for (const item of outcome.evidence) {
                evidenceItems.push(item);
            }
            const output = buildInvestigationToolResultMessage({
                tool: toolName,
                summary: outcome.summary,
                evidence: outcome.evidence,
                repositoryEvidenceCount: state.ledger.snapshot().filter(item => item.source === 'repository').length,
                remainingSteps: Math.max(0, input.maxSteps - state.steps),
                plannedQuestions,
            }).content;
            return {
                ok: outcome.ok,
                output,
                summary: outcome.summary,
                evidenceCount: outcome.evidence.length,
            };
        },
    };
}

function createMemoryDefinitions(input: ChangeAnalysisAgentInput, state: AgentRunState, evidenceItems: RepositoryEvidenceItem[]): AgentToolDefinition<ChangeAnalysisAgentInput>[] {
    const memory = input.memory;
    if (!memory) { return []; }
    const cachedEvidence = new Map<string, RepositoryEvidenceItem>();
    const searchSchema = z.object({ query: z.string().trim().min(1) }).strict();
    const readSchema = z.object({ memoryIds: z.array(z.string().regex(/^M[0-9]+$/)).min(1) }).strict();
    const guarded = (name: string, execute: AgentToolDefinition<ChangeAnalysisAgentInput>['execute']): AgentToolDefinition<ChangeAnalysisAgentInput>['execute'] => async (context, args) => {
        const started = performance.now();
        try { return await execute(context, args); }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            input.recorder?.record({ step: state.steps, tool: name, arguments: args, ok: false, summary: message,
                evidence: [], durationMs: performance.now() - started, truncated: false });
            if (!(error instanceof MemoryRequestError)) { throw error; }
            return { ok: false, preserveOutput: true, summary: message, evidenceCount: 0,
                output: JSON.stringify({ error: { code: error.code, message, ...error.details }, budget: memory.budget }) };
        }
    };
    return [{
        name: 'searchRepositoryMemory', description: `Search repository-wide historical situations, investigation routes, lessons, and their current-snapshot availability or retirement state. Select relevant guidance using the current diff. Returns short M* IDs. At most ${memory.settings['search.maxCalls']} searches per run.`,
        parameters: objectSchema({ query: { type: 'string', minLength: 1 } }, ['query']),
        execute: guarded('searchRepositoryMemory', async (_context, args) => {
            const started = performance.now();
            const parsed = searchSchema.safeParse(args);
            if (!parsed.success) { return memory.reject('invalid_arguments', parsed.error.message); }
            const navigation = await memory.searchRepositoryMemory({
                paths: rawDiffPaths(input.rawDiff),
                symbols: [],
                keywords: [parsed.data.query],
            });
            input.recorder?.record({ step: state.steps, tool: 'searchRepositoryMemory', arguments: args, ok: true,
                summary: `Found ${navigation.length} historical navigation candidate(s).`, evidence: [],
                durationMs: performance.now() - started, truncated: false });
            return {
                ok: true,
                preserveOutput: true,
                output: JSON.stringify({ navigation, budget: memory.budget }),
                summary: `Found ${navigation.length} historical navigation candidate(s).`,
                evidenceCount: 0,
            };
        }),
    }, {
        name: 'readMemorySources', description: `Expand published navigation IDs, for example {"memoryIds":["M1"]}. Each ID expands all its sources. At most ${memory.settings['sources.maxChunks']} unique source attempts per run. Never pass D*, E*, step IDs or UUIDs. Returns current E* evidence.`,
        repeatable: true,
        parameters: z.toJSONSchema(readSchema) as Record<string, unknown>,
        execute: guarded('readMemorySources', async (context, args) => {
            const started = performance.now();
            const parsed = readSchema.safeParse(args);
            if (!parsed.success) { return memory.reject('invalid_arguments', parsed.error.message); }
            const before = memory.budget;
            const sources = await memory.readMemorySources(parsed.data.memoryIds, context.signal);
            const fresh = sources.filter(item => item.source && !cachedEvidence.has(item.key));
            const previews = context.ledger.previewRepositoryEvidence(fresh.map(item => ({ kind: 'search', target: item.source!.path,
                ref: `${item.source!.path}:${item.source!.startLine}-${item.source!.endLine}`, excerpt: item.source!.excerpt, provenance: item.source! })));
            const candidates = new Map([...cachedEvidence, ...fresh.map((item, index) => [item.key, previews[index]] as const)]);
            const evidence = sources.flatMap(item => item.source ? [candidates.get(item.key)!] : []);
            const output = JSON.stringify({ statuses: sources.map(item => item.status), evidence, budgetBefore: before, budget: memory.budget });
            memory.assertResultBudget(output);
            context.signal?.throwIfAborted();
            // No ledger mutation happens until the complete serialized result fits.
            for (let index = 0; index < fresh.length; index++) {
                const item = previews[index];
                context.ledger.recordRepositoryEvidence(item);
                cachedEvidence.set(fresh[index].key, item);
                evidenceItems.push(item);
            }
            input.recorder?.record({ step: state.steps, tool: 'readMemorySources', arguments: args, ok: true,
                summary: `Memory statuses: ${sources.map(item => item.status).join(', ')}.`, evidence: previews.map(item => ({ id: item.id, source: item.provenance! })),
                durationMs: performance.now() - started, truncated: evidence.some(item => item.provenance?.truncated) });
            return {
                ok: true,
                preserveOutput: true,
                output,
                summary: `Memory ${parsed.data.memoryIds.join(', ')}: ${evidence.length}/${sources.length} source(s) available; ${memory.budget.used}/${memory.budget.limit} source attempts used.`,
                evidenceCount: evidence.length,
                sourceStatuses: sources.map(item => item.status),
            };
        }),
    }];
}

function toolDescription(name: InvestigationToolName): string {
    const descriptions: Record<InvestigationToolName, string> = {
        findSymbolDefinition: 'Locate and read likely definitions of one exact symbol. Use first when a planned question depends on what the changed symbol does or declares; regex-based candidates still require judgment.',
        findSymbolReferences: 'Find repository references to one exact symbol. Use to identify consumers or integration points, not to prove an exhaustive call graph.',
        findCallers: 'Find likely call sites of one exact function or method. Use when caller context determines the changed behavior or scope.',
        findCallees: 'Inspect likely direct calls made by one exact function or method. Use when downstream effects are not visible in the changed body.',
        findImplementations: 'Find likely implementations or consumers of one exact interface or type. Use when a contract change may affect multiple implementations.',
        findTypeDefinition: 'Locate and read matching type definitions. Use when field, variant, or compatibility constraints matter to the change.',
        searchCode: 'Search file names or contents for one focused exact token or narrow regex. searchType "name" is navigation only and publishes no E*; use content search or read source context when evidence is required.',
        readFileContent: 'Read a bounded region from one known repository file. Use for surrounding control flow, declarations, tests, or config consumers near a known location.',
        listDirectory: 'List one repository directory at depth one for navigation only. This tool publishes no E* evidence; do not use it when an exact path or symbol is already known.',
    };
    return descriptions[name];
}

function rawDiffPaths(evidence: DraftEvidence[]): string[] {
    return Array.from(new Set(evidence.map(item => item.fileName)));
}

function normalizeCompoundTerminal(
    raw: RawFinal,
    state: AgentRunState,
    evidenceItems: RepositoryEvidenceItem[],
): ChangeAnalysisAgentOutput {
    const issues: string[] = [];
    const degradations: string[] = [];
    const claims = raw.claims.map(claim => normalizeClaim(claim, state, issues, degradations));
    const validClaims = claims.filter((claim): claim is AgentClaim => claim !== null);
    const tracedClaims = validClaims.map((claim, index) => ({ ...claim, id: `C${index + 1}` }));
    const rawSemantic: SemanticChangeAnalysis = {
        changeTargets: [],
        dependencyContext: {
            callers: [],
            callees: [],
            stateDependencies: [],
            relatedConfigs: [],
            relatedTypes: [],
        },
        observedChanges: validClaims.filter(claim => claim.category === 'observed_change'),
        repositoryFacts: validClaims.filter(claim => claim.category === 'repository_fact'),
        behaviorAnalysis: raw.behaviorAnalysis,
        capabilityContext: {
            technicalCapability: null,
            productCapability: null,
        },
        supportedInferences: validClaims.filter(claim => claim.category === 'supported_inference'),
        uncertainInferences: validClaims.filter(claim => claim.category === 'uncertain_inference'),
        intentAnalysis: {
            primaryIntent: null,
            supportedBy: [],
            confidence: 'low',
        },
        changeClassification: raw.changeClassification,
        uncertainties: [
            ...raw.uncertainties,
            ...validClaims
                .filter(claim => claim.category === 'uncertain_inference')
            .map(claim => claim.claim),
        ],
    };
    const repositoryEvidence = normalizeRepositoryEvidence(raw, state, evidenceItems, issues, degradations);
    const semanticAnalysis = normalizeSemanticAnalysis(rawSemantic, repositoryEvidence, state.ledger);
    const selectable = validClaims.filter(claim => (
        claim.category !== 'uncertain_inference' && claim.evidenceRefs.length > 0
    ));
    const selection: InformationSelection = {
        mustExpress: selectable
            .filter(claim => claim.disposition === 'must_express')
            .map(claim => claim.claim)
            .slice(0, AGENT_TERMINAL_LIMITS.maxMustExpressClaims),
        optional: selectable
            .filter(claim => claim.disposition === 'optional')
            .map(claim => claim.claim)
            .slice(0, AGENT_TERMINAL_LIMITS.maxOptionalClaims),
        omit: Array.from(new Set([
            ...validClaims.filter(claim => claim.disposition === 'omit').map(claim => claim.claim),
            ...validClaims.filter(claim => claim.category === 'uncertain_inference').map(claim => claim.claim),
        ])).slice(0, AGENT_TERMINAL_LIMITS.maxOmittedClaims),
        suggestedScope: cleanText(raw.suggestedScope),
        notes: cleanText(raw.selectionNotes),
    };
    const hasRepositoryEvidence = state.ledger.snapshot().some(item => item.source === 'repository');
    const endedWithoutRepositoryEvidence = !hasRepositoryEvidence
        && state.issues.some(issue => issue.type === 'evidence_precondition_degraded');
    return {
        repositoryEvidence,
        semanticAnalysis,
        informationSelection: selection,
        analysisStatus: degradations.length
            ? 'degraded'
            : hasRepositoryEvidence ? 'complete' : 'complete_diff_only',
        issues: endedWithoutRepositoryEvidence
            ? [...issues, 'Repository investigation ended without E* evidence; downstream generation continues from diff evidence only.']
            : issues,
        claims: tracedClaims,
    };
}

function normalizeClaim(
    claim: RawFinal['claims'][number],
    state: AgentRunState,
    issues: string[],
    degradations: string[],
): AgentClaim | null {
    const claimText = claim.claim.trim();
    if (!claimText) {
        const message = 'Compound terminal contained an empty claim after trimming.';
        issues.push(message);
        degradations.push(message);
        state.issues.push({ type: 'terminal_failure', message, step: state.steps });
        return null;
    }
    const originalRefs = cleanStrings(claim.evidenceRefs);
    let refs = originalRefs.filter(ref => state.ledger.has(ref));
    const invalid = originalRefs.filter(ref => !state.ledger.has(ref));
    if (invalid.length) {
        const message = `Claim '${claimText}' referenced unknown evidence: ${invalid.join(', ')}.`;
        issues.push(message);
        state.issues.push({ type: 'invalid_reference', message, step: state.steps });
    }
    const knownRefs = refs;
    if (claim.category === 'observed_change') {
        refs = knownRefs.filter(ref => ref.startsWith('D'));
    } else if (claim.category === 'repository_fact') {
        refs = knownRefs.filter(ref => ref.startsWith('E'));
    }
    const wrongKindRefs = knownRefs.filter(ref => !refs.includes(ref));
    if (wrongKindRefs.length) {
        const message = `Claim '${claimText}' used evidence incompatible with '${claim.category}': ${wrongKindRefs.join(', ')}.`;
        issues.push(message);
        state.issues.push({ type: 'invalid_reference', message, step: state.steps });
    }
    if (!refs.length) {
        if (claim.category !== 'uncertain_inference') {
            const message = `Claim '${claimText}' has no valid evidence after normalization and was downgraded to uncertainty.`;
            issues.push(message);
            degradations.push(message);
            state.issues.push({ type: 'invalid_reference', message, step: state.steps });
        }
        return {
            category: 'uncertain_inference',
            claim: claimText,
            evidenceRefs: [],
            disposition: 'omit',
        };
    }
    return { ...claim, claim: claimText, evidenceRefs: refs };
}

function normalizeRepositoryEvidence(
    raw: RawFinal,
    state: AgentRunState,
    evidenceItems: RepositoryEvidenceItem[],
    issues: string[],
    degradations: string[],
): RepositoryEvidence {
    const repositoryDegradationStart = degradations.length;
    const findings: InvestigationFinding[] = raw.investigation.findings.map(finding => {
        const refs = filterKnownRefs(
            `Investigation finding '${finding.question}'`,
            finding.evidenceRefs,
            state,
            issues,
            degradations,
            'repository',
        );
        return { ...finding, evidenceRefs: refs };
    });
    return {
        items: [...evidenceItems],
        findings,
        unresolvedQuestions: cleanStrings(raw.investigation.unresolvedQuestions),
        stopReason: raw.investigation.stopReason.trim(),
        steps: state.steps,
        degraded: degradations.length > repositoryDegradationStart,
    };
}

function filterKnownRefs(
    label: string,
    values: unknown,
    state: AgentRunState,
    issues: string[],
    degradations: string[],
    expectedSource?: 'diff' | 'repository',
): string[] {
    const refs = cleanStrings(values);
    const known = refs.filter(ref => state.ledger.has(ref));
    const valid = expectedSource
        ? known.filter(ref => state.ledger.get(ref)?.source === expectedSource)
        : known;
    const invalid = refs.filter(ref => !state.ledger.has(ref));
    const incompatible = expectedSource
        ? known.filter(ref => !valid.includes(ref))
        : [];
    if (invalid.length) {
        const message = `${label} referenced unknown evidence: ${invalid.join(', ')}.`;
        issues.push(message);
        state.issues.push({ type: 'invalid_reference', message, step: state.steps });
    }
    if (incompatible.length) {
        const message = `${label} used evidence incompatible with '${expectedSource}' source: ${incompatible.join(', ')}.`;
        issues.push(message);
        state.issues.push({ type: 'invalid_reference', message, step: state.steps });
    }
    if (refs.length > 0 && valid.length === 0) {
        const message = `${label} has no valid evidence after normalization.`;
        issues.push(message);
        degradations.push(message);
        state.issues.push({ type: 'invalid_reference', message, step: state.steps });
    }
    return valid;
}

export async function runChangeAnalysisProfile(params: {
    input: ChangeAnalysisAgentInput;
    execution: LLMExecution;
    ledger: EvidenceLedger;
    runtime: import('../../../../agent').AgentRuntime;
}): Promise<ChangeAnalysisAgentOutput> {
    const result = await params.runtime.run(
        params.execution,
        createChangeAnalysisProfile(params.input),
        params.input,
        params.ledger,
    );
    return { ...result.output, runtimeMetrics: result.metrics };
}
