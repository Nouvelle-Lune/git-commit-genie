import { z } from 'zod';
import {
    AgentProfile,
    type AgentRunMetrics,
    AgentRunState,
    AgentToolDefinition,
    EvidenceLedger,
    ToolGrant,
} from '../../../../agent';
import { LLMExecution } from '../../../llm/llmTypes';
import { changeAnalysisAgentFinalResponseSchema } from '../../../llm/providers/schemas/common';
import { normalizeSemanticAnalysis } from '../semanticAnalysis';
import {
    AgentClaim,
    ChangeAnalysisStatus,
    ChangeExtraction,
    DraftEvidence,
    InformationSelection,
    InvestigationFinding,
    InvestigationPlan,
    RepositoryAnalysisContext,
    RepositoryEvidence,
    RepositoryEvidenceItem,
    SemanticChangeAnalysis,
    TracedAgentClaim,
} from '../types';
import { buildInvestigationToolResultMessage } from '../prompts';
import { logInvestigationToolCall } from '../../../llm/chatWebviewLogging';
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
    reason: string;
    summary: string;
    ok: boolean;
    evidenceCount: number;
}

export interface ChangeAnalysisAgentInput {
    extraction: ChangeExtraction;
    plan: InvestigationPlan;
    repositoryPath: string;
    excludePatterns: string[];
    evidence: DraftEvidence[];
    repositoryTerminology?: RepositoryAnalysisContext;
    userTemplate?: string;
    maxSteps: number;
    onStep?: (event: InvestigationStepEvent) => void;
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
    maxResults: nullable({ type: 'integer', minimum: 1 }),
};

const TOOL_PARAMETERS: Record<InvestigationToolName, Record<string, unknown>> = {
    getChangedSymbols: objectSchema(REASON_PROPERTY, ['reason']),
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
        maxResults: nullable({ type: 'integer', minimum: 1 }),
    }, ['reason', 'query', 'dirPath', 'searchType', 'useRegex', 'maxResults']),
    readFileContent: objectSchema({
        ...REASON_PROPERTY,
        filePath: { type: 'string', minLength: 1 },
        startLine: nullable({ type: 'integer', minimum: 1 }),
        maxLines: nullable({ type: 'integer', minimum: 1 }),
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
    const openQuestions = input.plan.targets.flatMap(target =>
        target.questions.map(question => `${target.target}: ${question}`)
    );
    const evidenceItems: RepositoryEvidenceItem[] = [];

    return {
        id: 'change-analysis',
        promptVersion: '2',
        toolsetVersion: '2',
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
                    `Diff evidence representation: ${JSON.stringify(input.evidence)}`,
                    `Repository evidence ledger: ${JSON.stringify(state.ledger.snapshot()
                        .filter(item => item.source === 'repository'))}`,
                    `Completed calls: ${JSON.stringify(state.observations.map(item => ({ tool: item.tool, arguments: item.arguments, ok: item.ok })))}`,
                    `Open questions: ${openQuestions.join(' | ') || 'none'}`,
                    'Use the unchanged tool contract. Finish with the compound terminal when evidence is sufficient.',
                    '</context_checkpoint>',
                ].join('\n'),
            }),
        },
        buildPrompt: profileInput => ({
            stable: [{
                role: 'system',
                content: [
                    '<agent_protocol>',
                    'You investigate one concrete code change and finish with one structured compound terminal.',
                    'Tools may only inspect the granted repository. Use the fixed D*/E* evidence ledger identifiers.',
                    'D identifiers cite changed diff hunks. E identifiers cite repository observations returned by tools.',
                    'Never invent evidence ids and never use path:line as an evidence id.',
                    'Separate observed change, repository fact, supported inference, and uncertainty.',
                    'Each claim selects must_express, optional, or omit. Uncertain claims must be omitted.',
                    'Do not emit a standalone investigation terminal before semantic analysis and selection are complete.',
                    '</agent_protocol>',
                ].join('\n'),
            }],
            opening: [{
                role: 'user',
                content: [
                    '<run_context>',
                    `Tool-step budget: ${profileInput.maxSteps}`,
                    `Change extraction: ${JSON.stringify(profileInput.extraction)}`,
                    `Investigation plan: ${JSON.stringify(profileInput.plan)}`,
                    `Diff evidence: ${JSON.stringify(profileInput.evidence)}`,
                    `Repository terminology: ${JSON.stringify(profileInput.repositoryTerminology ?? null)}`,
                    `User template constraints: ${JSON.stringify(profileInput.userTemplate ?? null)}`,
                    '</run_context>',
                    '<terminal_contract>',
                    'After investigation, return the fixed compound JSON terminal. Keep must_express to at most 3 claims and optional to at most 4.',
                    'If evidence cannot establish intent or impact, use null fields and uncertainties instead of guessing.',
                    '</terminal_contract>',
                ].join('\n'),
            }],
        }),
        grantTools: profileInput => CHANGE_ANALYSIS_TOOL_NAMES.map(name => ({
            name,
            allowedRoot: profileInput.repositoryPath,
            excludePatterns: [...profileInput.excludePatterns],
            maxResults: 50,
            maxLines: 400,
            maxDepth: 1,
            allocateEvidence: !['getChangedSymbols', 'listDirectory'].includes(name),
        })),
        buildToolDefinitions: (_profileInput, state) => CHANGE_ANALYSIS_TOOL_NAMES.map(name => (
            createExecutableDefinition(name, input, state, evidenceItems, openQuestions)
        )),
        normalizeFinal: (raw, state) => normalizeCompoundTerminal(raw, state, evidenceItems),
        preservePartialResult: (state, error) => unavailableOutput(
            state,
            evidenceItems,
            String((error as { message?: unknown })?.message ?? error),
        ),
    };
}

function createExecutableDefinition(
    name: InvestigationToolName,
    input: ChangeAnalysisAgentInput,
    state: AgentRunState,
    evidenceItems: RepositoryEvidenceItem[],
    openQuestions: string[],
): AgentToolDefinition<ChangeAnalysisAgentInput> {
    return {
        name,
        description: toolDescription(name),
        parameters: TOOL_PARAMETERS[name],
        execute: async (context, args) => {
            const toolName = name;
            const toolContext: InvestigationToolContext = {
                repositoryPath: context.grant.allowedRoot,
                excludePatterns: context.grant.excludePatterns,
                changedSymbols: input.extraction.changedSymbols.map(symbol => ({
                    name: symbol.name,
                    file: symbol.file,
                    symbolType: symbol.symbolType,
                    changeKind: symbol.changeKind,
                })),
                allocateEvidence: evidence => context.allocateEvidence(evidence),
            };
            if (toolName !== 'readFileContent') {
                logInvestigationToolCall(
                    input.repositoryPath,
                    toolName,
                    args,
                    String(args.reason ?? '').trim(),
                    state.steps,
                    input.maxSteps,
                );
            }
            const outcome = await runInvestigationTool(toolContext, toToolCall(toolName, args));
            for (const item of outcome.evidence) {
                evidenceItems.push(item);
            }
            input.onStep?.({
                step: state.steps,
                tool: toolName,
                reason: String(args.reason ?? '').trim(),
                summary: outcome.summary,
                ok: outcome.ok,
                evidenceCount: outcome.evidence.length,
            });
            return {
                ok: outcome.ok,
                output: buildInvestigationToolResultMessage({
                    tool: toolName,
                    summary: outcome.summary,
                    evidence: outcome.evidence,
                    remainingSteps: Math.max(0, input.maxSteps - state.steps),
                    openQuestions,
                }).content,
            };
        },
    };
}

function toolDescription(name: InvestigationToolName): string {
    const descriptions: Record<InvestigationToolName, string> = {
        getChangedSymbols: 'List symbols already grounded in the diff extraction.',
        findSymbolDefinition: 'Locate and read the most likely definition of a changed symbol.',
        findSymbolReferences: 'Find repository references to a changed symbol.',
        findCallers: 'Find call sites of a changed function or method.',
        findCallees: 'Inspect direct calls made by a changed function or method.',
        findImplementations: 'Find implementations or consumers of a changed interface or type.',
        findTypeDefinition: 'Locate and read a changed type definition.',
        searchCode: 'Search repository file names or contents for a focused query.',
        readFileContent: 'Read a bounded line range from one repository file.',
        listDirectory: 'List one repository directory at depth one.',
    };
    return descriptions[name];
}

function normalizeCompoundTerminal(
    raw: RawFinal,
    state: AgentRunState,
    evidenceItems: RepositoryEvidenceItem[],
): ChangeAnalysisAgentOutput {
    const issues: string[] = [];
    const claims = raw.claims.map(claim => normalizeClaim(claim, state, issues));
    const validClaims = claims.filter((claim): claim is AgentClaim => claim !== null);
    const tracedClaims = validClaims.map((claim, index) => ({ ...claim, id: `C${index + 1}` }));
    const changeTargets = raw.changeTargets.map(target => ({
        ...target,
        evidenceRefs: filterKnownRefs(
            `changeTargets['${target.symbol}'].evidenceRefs`,
            target.evidenceRefs,
            state,
            issues,
        ),
    }));
    const intentAnalysis = {
        ...raw.intentAnalysis,
        supportedBy: filterKnownRefs(
            'intentAnalysis.supportedBy',
            raw.intentAnalysis.supportedBy,
            state,
            issues,
        ),
    };
    const rawSemantic: SemanticChangeAnalysis = {
        changeTargets,
        dependencyContext: raw.dependencyContext,
        observedChanges: validClaims.filter(claim => claim.category === 'observed_change'),
        repositoryFacts: validClaims.filter(claim => claim.category === 'repository_fact'),
        behaviorAnalysis: raw.behaviorAnalysis,
        capabilityContext: raw.capabilityContext,
        supportedInferences: validClaims.filter(claim => claim.category === 'supported_inference'),
        uncertainInferences: validClaims.filter(claim => claim.category === 'uncertain_inference'),
        intentAnalysis,
        changeClassification: raw.changeClassification,
        uncertainties: [
            ...raw.uncertainties,
            ...validClaims
                .filter(claim => claim.category === 'uncertain_inference')
                .map(claim => claim.claim),
        ],
    };
    const repositoryEvidence = normalizeRepositoryEvidence(raw, state, evidenceItems, issues);
    const semanticAnalysis = normalizeSemanticAnalysis(rawSemantic, repositoryEvidence, state.ledger);
    const selectable = validClaims.filter(claim => (
        claim.category !== 'uncertain_inference' && claim.evidenceRefs.length > 0
    ));
    const selection: InformationSelection = {
        mustExpress: selectable
            .filter(claim => claim.disposition === 'must_express')
            .map(claim => claim.claim)
            .slice(0, 3),
        optional: selectable
            .filter(claim => claim.disposition === 'optional')
            .map(claim => claim.claim)
            .slice(0, 4),
        omit: Array.from(new Set([
            ...validClaims.filter(claim => claim.disposition === 'omit').map(claim => claim.claim),
            ...validClaims.filter(claim => claim.category === 'uncertain_inference').map(claim => claim.claim),
        ])).slice(0, 8),
        suggestedScope: cleanText(raw.suggestedScope),
        notes: cleanText(raw.selectionNotes),
    };
    return {
        repositoryEvidence,
        semanticAnalysis,
        informationSelection: selection,
        analysisStatus: issues.length ? 'degraded' : 'complete',
        issues,
        claims: tracedClaims,
    };
}

function normalizeClaim(
    claim: RawFinal['claims'][number],
    state: AgentRunState,
    issues: string[],
): AgentClaim | null {
    const claimText = claim.claim.trim();
    if (!claimText) {
        const message = 'Compound terminal contained an empty claim after trimming.';
        issues.push(message);
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
): RepositoryEvidence {
    const repositoryIssueStart = issues.length;
    const findings: InvestigationFinding[] = raw.investigation.findings.map(finding => {
        const refs = filterKnownRefs(
            `Investigation finding '${finding.question}'`,
            finding.evidenceRefs,
            state,
            issues,
        );
        return { ...finding, evidenceRefs: refs };
    });
    return {
        items: [...evidenceItems],
        findings,
        unresolvedQuestions: cleanStrings(raw.investigation.unresolvedQuestions),
        stopReason: raw.investigation.stopReason.trim(),
        steps: state.steps,
        degraded: issues.length > repositoryIssueStart,
    };
}

function filterKnownRefs(
    label: string,
    values: unknown,
    state: AgentRunState,
    issues: string[],
): string[] {
    const refs = cleanStrings(values);
    const valid = refs.filter(ref => state.ledger.has(ref));
    const invalid = refs.filter(ref => !state.ledger.has(ref));
    if (invalid.length) {
        const message = `${label} referenced unknown evidence: ${invalid.join(', ')}.`;
        issues.push(message);
        state.issues.push({ type: 'invalid_reference', message, step: state.steps });
    }
    return valid;
}

function unavailableOutput(
    state: AgentRunState,
    evidenceItems: RepositoryEvidenceItem[],
    reason: string,
): ChangeAnalysisAgentOutput {
    const repositoryEvidence: RepositoryEvidence = {
        items: [...evidenceItems],
        findings: [],
        unresolvedQuestions: [],
        stopReason: reason,
        steps: state.steps,
        degraded: true,
    };
    return {
        repositoryEvidence,
        semanticAnalysis: normalizeSemanticAnalysis({}, repositoryEvidence, state.ledger),
        informationSelection: {
            mustExpress: [],
            optional: [],
            omit: [],
            suggestedScope: null,
            notes: reason,
        },
        analysisStatus: 'unavailable',
        issues: [reason],
        claims: [],
    };
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
