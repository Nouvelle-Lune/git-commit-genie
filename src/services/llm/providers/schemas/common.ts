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
  type: z.string().min(1),
  scope: z.string().nullable().default(null),
  breaking: z.boolean(),
  description: z.string().min(1),
  body: z.string().nullable().default(null),
  footers: z.array(z.object({
    token: z.string().default(''),
    value: z.string().default('')
  })).default([]),
  commitMessage: z.string().min(1),
  notes: z.string().nullable().default(null)
} as const);

export const validateAndFixResponseSchema = z.object({
  status: z.enum(['valid', 'fixed']).default('valid'),
  commitMessage: z.string().min(1),
  violations: z.array(z.string().min(1)).default([]),
  notes: z.string().nullable().default(null)
} as const);

export const ragPreparationResponseSchema = z.object({
  changeSetSummary: z.object({
    text: z.string().min(1),
    dominantType: z.string().nullable().default(null),
    dominantScope: z.string().nullable().default(null),
    areas: z.array(z.string().min(1)).default([]),
    fileKinds: z.array(z.string().min(1)).default([]),
    changeActions: z.array(z.string().min(1)).default([]),
    entities: z.array(z.string().min(1)).default([]),
  }),
  retrievalFeatures: z.object({
    predictedType: z.string().nullable().default(null),
    predictedScope: z.string().nullable().default(null),
    areas: z.array(z.string().min(1)).default([]),
    fileKinds: z.array(z.string().min(1)).default([]),
    changeActions: z.array(z.string().min(1)).default([]),
    entities: z.array(z.string().min(1)).default([]),
    touchedPaths: z.array(z.string().min(1)).default([]),
    fileExtensions: z.array(z.string().min(1)).default([]),
    statusMix: z.array(z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored'])).default([]),
    fileCount: z.number().int().min(0),
    hasDocs: z.boolean(),
    hasTests: z.boolean(),
    hasConfig: z.boolean(),
    hasRenames: z.boolean(),
    isCrossLayer: z.boolean(),
    breakingLike: z.boolean(),
  })
} as const);

export const ragRerankResponseSchema = z.object({
  selected: z.array(z.object({
    id: z.string().min(1),
    reason: z.string().min(1),
  })).default([]),
  notes: z.string().nullable().default(null),
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

export const investigationFinalResponseSchema = z.object({
  findings: z.array(z.object({
    target: z.string().min(1),
    question: z.string().min(1),
    answer: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
  } as const)),
  unresolvedQuestions: z.array(z.string().min(1)),
  stopReason: z.string().min(1),
} as const);

const evidenceBackedClaimSchema = z.object({
  claim: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
} as const);

export const semanticAnalysisResponseSchema = z.object({
  changeTargets: z.array(z.object({
    symbol: z.string().min(1),
    file: z.string().min(1),
    role: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
  } as const)),
  dependencyContext: z.object({
    callers: z.array(z.string().min(1)),
    callees: z.array(z.string().min(1)),
    stateDependencies: z.array(z.string().min(1)),
    relatedConfigs: z.array(z.string().min(1)),
    relatedTypes: z.array(z.string().min(1)),
  } as const),
  observedChanges: z.array(evidenceBackedClaimSchema),
  repositoryFacts: z.array(evidenceBackedClaimSchema),
  behaviorAnalysis: z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
    observableEffect: z.string().nullable(),
  } as const),
  capabilityContext: z.object({
    technicalCapability: z.string().nullable(),
    productCapability: z.string().nullable(),
  } as const),
  supportedInferences: z.array(evidenceBackedClaimSchema),
  uncertainInferences: z.array(evidenceBackedClaimSchema),
  intentAnalysis: z.object({
    primaryIntent: z.string().nullable(),
    supportedBy: z.array(z.string().min(1)),
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
  uncertainties: z.array(z.string().min(1)),
} as const);

export const informationSelectionResponseSchema = z.object({
  mustExpress: z.array(z.string().min(1)).min(1).max(3),
  optional: z.array(z.string().min(1)).max(4),
  omit: z.array(z.string().min(1)).max(8),
  suggestedScope: z.string().nullable(),
  notes: z.string().nullable(),
} as const);

export const repoAnalysisResponseSchema = z.object({
  summary: z.string().min(1).describe("Brief but comprehensive summary of the repository purpose and architecture"),
  projectType: z.string().min(1).default('Unknown Project').describe("Main project type (e.g., Web App, Library, CLI Tool, etc.)"),
  technologies: z.array(z.string().min(1)).default([]).describe("Array of main technologies used"),
  insights: z.array(z.string().min(1)).default([]).describe("Key architectural insights about the project")
} as const);
