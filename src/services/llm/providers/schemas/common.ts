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
  if (draft.scope && /^\[?[CDE]\d+(?:\/P\d+)?\]?$/i.test(draft.scope)) {
    context.addIssue({
      code: 'custom',
      path: ['scope'],
      message: 'Scope cannot be an internal claim or evidence identifier.',
    });
  }
  const breakingFooterCount = draft.footers.filter(footer => (
    footer.token === 'BREAKING CHANGE' || footer.token === 'BREAKING-CHANGE'
  )).length;
  const hasBreakingFooter = breakingFooterCount > 0;
  if (!draft.breaking && hasBreakingFooter) {
    context.addIssue({
      code: 'custom',
      path: ['footers'],
      message: 'BREAKING CHANGE footer requires breaking=true.',
    });
  }
  if (breakingFooterCount > 1) {
    context.addIssue({
      code: 'custom',
      path: ['footers'],
      message: 'Only one BREAKING CHANGE footer is allowed.',
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
  'file', 'symbol', 'config', 'type', 'dependency', 'interface', 'cli_or_api'
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

/**
 * Single source of truth for the compound terminal's size limits.
 *
 * The exported JSON Schema, the prompt contract, and local Zod validation all
 * read these numbers, so a model can never be shown a limit that differs from
 * the one it is validated against. Observed failures ("nine refs in
 * intentAnalysis.supportedBy", "six refs in a finding") came from limits that
 * existed only in Zod and were therefore invisible to the model.
 */
export const AGENT_TERMINAL_LIMITS = {
  /** Applies to every evidence reference array in the terminal. */
  maxEvidenceRefs: 8,
  /** A finding without repository evidence is not a finding. */
  minFindingEvidenceRefs: 1,
  maxFindings: 12,
  maxUnresolvedQuestions: 12,
  maxChangeTargets: 12,
  maxDependencyEntries: 20,
  maxClaims: 20,
  maxUncertainties: 12,
  maxMustExpressClaims: 3,
  maxOptionalClaims: 4,
  /**
   * Per-disposition counts cannot be expressed in a JSON Schema, so all three
   * are enforced when the terminal is normalized. The must_express and optional
   * caps are also stated in the prompt because they shape what the model should
   * promote; this one is not, since telling a model to cap `omit` would push it
   * to drop claims outright rather than record them as omitted.
   */
  maxOmittedClaims: 8,
} as const;

const agentEvidenceReferenceSchema = z.string().regex(
  /^[DE]\d+$/,
  'Evidence references must be ledger-owned D* diff ids or E* repository ids.'
);

const repositoryEvidenceIdSchema = z.string().regex(
  /^E\d+$/,
  'Investigation findings must cite E* repository evidence ids returned by repository tools.'
);

/**
 * Expressed as a plain item pattern plus array bounds so the whole rule
 * survives `z.toJSONSchema`. The previous `superRefine` version was silently
 * dropped from the exported schema, which is why models kept answering
 * findings with D* diff ids only.
 */
const findingEvidenceReferenceSchema = z.array(repositoryEvidenceIdSchema)
  .min(AGENT_TERMINAL_LIMITS.minFindingEvidenceRefs)
  .max(AGENT_TERMINAL_LIMITS.maxEvidenceRefs)
  .describe(
    `${AGENT_TERMINAL_LIMITS.minFindingEvidenceRefs} to ${AGENT_TERMINAL_LIMITS.maxEvidenceRefs} repository evidence ids such as ["E1","E3"]. `
    + 'Only E* ids are allowed here; a D* diff id, a file path, or a range like "E1-E4" is invalid. '
    + 'If a question was answered from the diff alone, drop the finding and put the question in unresolvedQuestions.'
  );

const agentClaimSchema = z.object({
  category: z.enum(AGENT_CLAIM_CATEGORIES).describe(
    'observed_change: stated by the diff alone, cites only D* ids. '
    + 'repository_fact: learned from a repository tool result, requires at least one E* id. '
    + 'supported_inference: a conclusion combining D* and/or E* evidence, requires at least one id. '
    + 'uncertain_inference: unproven, must use an empty evidenceRefs array and disposition "omit".'
  ),
  claim: z.string().min(1),
  evidenceRefs: z.array(agentEvidenceReferenceSchema)
    .max(AGENT_TERMINAL_LIMITS.maxEvidenceRefs)
    .describe(
      `At most ${AGENT_TERMINAL_LIMITS.maxEvidenceRefs} ledger ids that directly support this claim, such as ["D2","E1"]. `
      + 'Pick the ids a reader would check first instead of listing everything collected.'
    ),
  disposition: z.enum(AGENT_CLAIM_DISPOSITIONS).describe(
    `must_express: at most ${AGENT_TERMINAL_LIMITS.maxMustExpressClaims} claims that the commit message must state. `
    + `optional: at most ${AGENT_TERMINAL_LIMITS.maxOptionalClaims} claims worth stating if space allows. `
    + 'omit: everything else, and mandatory for uncertain_inference.'
  ),
} as const).superRefine((claim, context) => {
  if (claim.category === 'observed_change' && !claim.evidenceRefs.some(ref => ref.startsWith('D'))) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceRefs'],
      message: 'observed_change requires at least one D* diff evidence reference.',
    });
  }
  if (claim.category === 'repository_fact' && !claim.evidenceRefs.some(ref => ref.startsWith('E'))) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceRefs'],
      message: 'repository_fact requires at least one E* repository evidence reference.',
    });
  }
  if (claim.category === 'supported_inference' && claim.evidenceRefs.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceRefs'],
      message: 'supported_inference requires at least one D* or E* evidence reference.',
    });
  }
  if (claim.category === 'uncertain_inference' && claim.disposition !== 'omit') {
    context.addIssue({
      code: 'custom',
      path: ['disposition'],
      message: 'uncertain_inference must use the omit disposition.',
    });
  }
});

/** One terminal replaces the former investigation, semantic, and selection requests. */
export const changeAnalysisAgentFinalResponseSchema = z.object({
  investigation: z.object({
    findings: z.array(z.object({
      target: z.string().min(1).describe('An investigation plan target, copied exactly.'),
      question: z.string().min(1),
      answer: z.string().min(1).describe('What the repository evidence actually showed, not a restatement of the question.'),
      evidenceRefs: findingEvidenceReferenceSchema,
    } as const)).max(AGENT_TERMINAL_LIMITS.maxFindings)
      .describe('Only questions answered with repository evidence. An empty array is valid.'),
    unresolvedQuestions: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxUnresolvedQuestions)
      .describe('Planned questions the repository evidence could not answer. Leave them here instead of guessing.'),
    stopReason: z.string().min(1).describe('Why the investigation ended, in one sentence.'),
  } as const),
  changeTargets: z.array(z.object({
    symbol: z.string().min(1),
    file: z.string().min(1),
    role: z.string().min(1),
    evidenceRefs: z.array(agentEvidenceReferenceSchema)
      .max(AGENT_TERMINAL_LIMITS.maxEvidenceRefs)
      .describe(`At most ${AGENT_TERMINAL_LIMITS.maxEvidenceRefs} D* or E* ids showing this symbol's role.`),
  } as const)).max(AGENT_TERMINAL_LIMITS.maxChangeTargets),
  dependencyContext: z.object({
    callers: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxDependencyEntries),
    callees: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxDependencyEntries),
    stateDependencies: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxDependencyEntries),
    relatedConfigs: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxDependencyEntries),
    relatedTypes: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxDependencyEntries),
  } as const).describe('Names observed in evidence. Use empty arrays when nothing was observed.'),
  claims: z.array(agentClaimSchema).max(AGENT_TERMINAL_LIMITS.maxClaims),
  behaviorAnalysis: z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
    observableEffect: z.string().nullable(),
  } as const).describe('Use null for any part the evidence does not establish.'),
  capabilityContext: z.object({
    technicalCapability: z.string().nullable(),
    productCapability: z.string().nullable(),
  } as const).describe('Use null rather than naming a capability the evidence does not connect to this change.'),
  intentAnalysis: z.object({
    primaryIntent: z.string().nullable().describe('One intent, or null when the evidence supports several equally.'),
    supportedBy: z.array(agentEvidenceReferenceSchema)
      .max(AGENT_TERMINAL_LIMITS.maxEvidenceRefs)
      .describe(
        `At most ${AGENT_TERMINAL_LIMITS.maxEvidenceRefs} D* or E* ids that establish the primary intent. `
        + 'Cite the decisive evidence only, and use an empty array when primaryIntent is null.'
      ),
    confidence: z.enum(['low', 'medium', 'high']),
  } as const),
  changeClassification: z.object({
    existingBehaviorCorrected: z.boolean(),
    newCapabilityAdded: z.boolean(),
    externalBehaviorChanged: z.boolean(),
    structuralOnly: z.boolean(),
    recommendedType: z.string().nullable().describe('A Conventional Commit type such as fix, feat, or refactor, or null.'),
    reason: z.string().nullable(),
  } as const),
  suggestedScope: z.string().nullable().describe('A short scope token derived from the investigated code path, or null. Never an evidence id.'),
  selectionNotes: z.string().nullable(),
  uncertainties: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxUncertainties),
} as const);
