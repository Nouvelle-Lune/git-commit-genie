import { z } from "zod";

/**
 * Shared Zod schemas used to constrain JSON output across providers.
 */

export const commitMessageSchema = z.object({
  commitMessage: z.string().min(1)
} as const);

const evidenceReferenceSchema = z.object({
  detail: z.string().min(1),
  evidenceHunkIds: z.array(z.string().min(1)).min(1),
} as const);

export const evidenceSummaryResponseSchema = z.object({
  changes: z.array(z.object({
    action: z.string().min(1),
    target: z.string().min(1),
    behavior: z.string().min(1),
    exactSymbols: z.array(z.string().min(1)),
    evidenceHunkIds: z.array(z.string().min(1)).min(1),
  } as const)),
  tests: z.array(evidenceReferenceSchema),
  breakingSignals: z.array(evidenceReferenceSchema),
  uncertainties: z.array(evidenceReferenceSchema),
} as const);

export const classifyAndDraftResponseSchema = z.object({
  type: z.string().trim().min(1).regex(/^[a-z]+$/),
  scope: z.string().trim().min(1).regex(/^[A-Za-z0-9_.-]+$/).nullable().default(null),
  breaking: z.boolean(),
  description: z.string().trim().min(1).regex(/^[^\r\n]+$/),
  body: z.string().trim().min(1).nullable().default(null),
  footers: z.array(z.object({
    token: z.string().trim().min(1).regex(/^(?:BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*)$/),
    value: z.string().trim().min(1)
  })).default([]),
  notes: z.string().nullable().default(null)
} as const).superRefine((draft, context) => {
  const hasBreakingFooter = draft.footers.some(footer => (
    footer.token === 'BREAKING CHANGE' || footer.token === 'BREAKING-CHANGE'
  ));
  if (!draft.breaking && hasBreakingFooter) {
    context.addIssue({
      code: 'custom',
      path: ['footers'],
      message: 'BREAKING CHANGE footer requires breaking=true.',
    });
  }
});

export const validateAndFixResponseSchema = z.object({
  status: z.enum(['valid', 'fixed']).default('valid'),
  commitMessage: z.string().min(1),
  violations: z.array(z.string().min(1)).default([]),
  notes: z.string().nullable().default(null)
} as const);

export const ragRerankResponseSchema = z.object({
  selected: z.array(z.object({
    id: z.string().min(1),
    reason: z.string().min(1),
  })),
  notes: z.string().nullable(),
} as const);

// ----- Change-Conditioned Chain -----

export const CHANGED_SYMBOL_TYPES = [
  'function', 'method', 'class', 'interface', 'type',
  'constant', 'variable', 'config_key', 'route', 'cli_flag', 'unknown'
] as const;

export const CHANGE_KINDS = [
  'added', 'removed', 'signature', 'function_body',
  'type_shape', 'value', 'renamed', 'moved', 'unknown'
] as const;

export const INVESTIGATION_TARGET_KINDS = [
  'symbol', 'config', 'type', 'dependency', 'interface', 'cli_or_api'
] as const;

export const changeExtractionResponseSchema = z.object({
  changedSymbols: z.array(z.object({
    name: z.string().min(1),
    file: z.string().min(1),
    symbolType: z.enum(CHANGED_SYMBOL_TYPES),
    changeKind: z.enum(CHANGE_KINDS),
    evidenceRefs: z.array(z.string().min(1)),
  } as const)),
  introducedSymbols: z.array(z.string().min(1)),
  removedSymbols: z.array(z.string().min(1)),
  changedCalls: z.array(z.string().min(1)),
  changedConfigs: z.array(z.string().min(1)),
  changedTypes: z.array(z.string().min(1)),
  changedDependencies: z.array(z.string().min(1)),
} as const);

export const investigationPlanResponseSchema = z.object({
  targets: z.array(z.object({
    target: z.string().min(1),
    kind: z.enum(INVESTIGATION_TARGET_KINDS),
    file: z.string().nullable(),
    questions: z.array(z.string().min(1)).min(1).max(6),
  } as const)).max(4),
  notes: z.string().nullable(),
} as const);

export const AGENT_CLAIM_CATEGORIES = [
  'observed_change',
  'repository_fact',
  'supported_inference',
  'uncertain_inference',
] as const;

export const AGENT_CLAIM_DISPOSITIONS = ['must_express', 'optional', 'omit'] as const;

/** One terminal replaces the former investigation, semantic, and selection requests. */
export const changeAnalysisAgentFinalResponseSchema = z.object({
  investigation: z.object({
    findings: z.array(z.object({
      target: z.string().min(1),
      question: z.string().min(1),
      answer: z.string().min(1),
      evidenceRefs: z.array(z.string().min(1)).max(8),
    } as const)).max(12),
    unresolvedQuestions: z.array(z.string().min(1)).max(12),
    stopReason: z.string().min(1),
  } as const),
  changeTargets: z.array(z.object({
    symbol: z.string().min(1),
    file: z.string().min(1),
    role: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).max(8),
  } as const)).max(12),
  dependencyContext: z.object({
    callers: z.array(z.string().min(1)).max(20),
    callees: z.array(z.string().min(1)).max(20),
    stateDependencies: z.array(z.string().min(1)).max(20),
    relatedConfigs: z.array(z.string().min(1)).max(20),
    relatedTypes: z.array(z.string().min(1)).max(20),
  } as const),
  claims: z.array(z.object({
    category: z.enum(AGENT_CLAIM_CATEGORIES),
    claim: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).max(8),
    disposition: z.enum(AGENT_CLAIM_DISPOSITIONS),
  } as const)).max(20),
  behaviorAnalysis: z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
    observableEffect: z.string().nullable(),
  } as const),
  capabilityContext: z.object({
    technicalCapability: z.string().nullable(),
    productCapability: z.string().nullable(),
  } as const),
  intentAnalysis: z.object({
    primaryIntent: z.string().nullable(),
    supportedBy: z.array(z.string().min(1)).max(8),
    confidence: z.enum(['low', 'medium', 'high']),
  } as const),
  changeClassification: z.object({
    existingBehaviorCorrected: z.boolean(),
    newCapabilityAdded: z.boolean(),
    externalBehaviorChanged: z.boolean(),
    structuralOnly: z.boolean(),
    recommendedType: z.string().nullable(),
    reason: z.string().nullable(),
  } as const),
  suggestedScope: z.string().nullable(),
  selectionNotes: z.string().nullable(),
  uncertainties: z.array(z.string().min(1)).max(12),
} as const);

export const repoAnalysisResponseSchema = z.object({
  summary: z.string().min(1).describe("Brief but comprehensive summary of the repository purpose and architecture"),
  projectType: z.string().min(1).default('Unknown Project').describe("Main project type (e.g., Web App, Library, CLI Tool, etc.)"),
  technologies: z.array(z.string().min(1)).default([]).describe("Array of main technologies used"),
  insights: z.array(z.string().min(1)).default([]).describe("Key architectural insights about the project")
} as const);
