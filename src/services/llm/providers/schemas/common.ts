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
  preservedFactIds: z.array(z.string().regex(/^C[0-9]+$/)).default([]),
  notes: z.string().nullable().default(null)
} as const).strict();

export const factAwareCommitMessageSchema = z.object({
  commitMessage: z.string().min(1),
  preservedFactIds: z.array(z.string().regex(/^C[0-9]+$/)).default([]),
} as const).strict();

export const ragRerankResponseSchema = z.object({
  selected: z.array(z.object({
    id: z.string().min(1),
    reason: z.string().min(1),
  })),
  notes: z.string().nullable(),
} as const);

// ----- Change-Conditioned Chain -----

export const INVESTIGATION_TARGET_KINDS = [
  'file', 'symbol', 'call', 'config', 'type', 'dependency', 'interface', 'cli_or_api', 'hunk', 'relation'
] as const;

/**
 * The retrieval verb a target declares, one literal per repository tool that
 * publishes evidence.
 *
 * `listDirectory` is deliberately absent: it is granted as navigation only and
 * never publishes an E* item, so a target served by listing a directory is a
 * hunk the diff already covers — a `diff_sufficient` decision, not an
 * investigation target. Declaring the verb is what stops the investigation from
 * defaulting to re-reading the changed file: the agent's first move per target
 * is the declared lookup, and `findCallers`-style tools return the location
 * instead of requiring the planner to predict a path.
 */
export const INVESTIGATION_LOOKUPS = [
  'definition', 'references', 'callers', 'callees', 'implementations', 'type', 'search', 'read'
] as const;

/** Derived from the array so the type and the constrained-decoding enum cannot drift apart. */
export type InvestigationLookup = typeof INVESTIGATION_LOOKUPS[number];

export const INVESTIGATION_PLAN_LIMITS = {
  /**
   * Ceiling on plan granularity, independent of the tool budget: past this many
   * targets the plan stops being a route and becomes a tour.
   */
  maxTargets: 12,
  /** Targets one hunk may be investigated through before the plan is too coarse. */
  maxTargetIdsPerCoverageEntry: 12,
} as const;

/** Well-formed diff evidence id. `[0-9]` rather than `\d` keeps the exported JSON Schema GBNF-convertible. */
const DIFF_EVIDENCE_ID_PATTERN = /^D[0-9]+$/;

/**
 * Builds the planner response schema for one request from that request's D* ids.
 *
 * The coverage contract is why this schema is built per request instead of
 * being registered statically. Every D* id of the current diff becomes a
 * required property of `coverage` with `additionalProperties: false`, so
 * constrained decoding — not the model's bookkeeping — guarantees that no hunk
 * is dropped, none is invented, and none is listed twice. That removes the
 * whole class of "the plan disagrees with its own coverage list" rejections and
 * frees the model to spend its capacity on the decision that actually needs
 * judgement: investigate or diff_sufficient, and through which targets.
 *
 * The tool budget is enforced the same way. A plan spends one repository call
 * per target, and JSON Schema cannot express "the questions of every target sum
 * to at most N", so the only decoder-enforceable form of that rule bounds the
 * target count instead: the array's `maxItems` is the smaller of the
 * granularity ceiling and the call budget. A plan that promises more lookups
 * than the agent can pay for is then unsamplable rather than a contract
 * violation discovered after a complete generation, when the only repair left
 * is asking the model to redo arithmetic it just got wrong.
 *
 * The input is rejected rather than repaired: a schema built from ambiguous ids
 * would hand the model a contract that cannot be satisfied.
 */
export function createInvestigationPlanResponseSchema(
  diffEvidenceIds: readonly string[],
  maxToolCalls: number,
): z.ZodTypeAny {
  if (!diffEvidenceIds.length) {
    throw new Error('An investigation plan schema needs at least one diff evidence id.');
  }
  const maxPlanTargets = Math.min(INVESTIGATION_PLAN_LIMITS.maxTargets, maxToolCalls);
  const seen = new Set<string>();
  for (const id of diffEvidenceIds) {
    if (!DIFF_EVIDENCE_ID_PATTERN.test(id)) {
      throw new Error(`Diff evidence id '${id}' is not a well-formed D* id.`);
    }
    if (seen.has(id)) {
      throw new Error(`Diff evidence id '${id}' is supplied more than once.`);
    }
    seen.add(id);
  }

  const coverageShape: Record<string, z.ZodTypeAny> = {};
  for (const id of diffEvidenceIds) {
    coverageShape[id] = z.object({
      decision: z.enum(['investigate', 'diff_sufficient']),
      // Bounded by the plan's own target cap as well: a coverage entry cannot
      // name more targets than the plan is allowed to declare, so a small model
      // cannot spend a repair attempt listing an id the schema never let it
      // declare in the first place.
      targetIds: z.array(z.string().min(1))
        .max(Math.min(INVESTIGATION_PLAN_LIMITS.maxTargetIdsPerCoverageEntry, maxPlanTargets)),
    } as const).strict();
  }

  return z.object({
    targets: z.array(z.object({
      id: z.string().min(1),
      target: z.string().min(1),
      kind: z.enum(INVESTIGATION_TARGET_KINDS),
      lookup: z.enum(INVESTIGATION_LOOKUPS),
      file: z.string().nullable(),
      // One question per target: the declared lookup is a single verb, and a
      // target carrying several questions would spend one call on work the plan
      // described as several.
      question: z.string().min(1),
    } as const).strict()).max(maxPlanTargets),
    coverage: z.object(coverageShape).strict(),
    notes: z.string().nullable(),
  } as const).strict();
}

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
  maxClaims: 20,
  maxUncertainties: 12,
  maxMustExpressClaims: 12,
  maxOptionalClaims: 12,
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
  /^[DE][0-9]+$/,
  'Evidence references must be ledger-owned D* diff ids or E* repository ids.'
);

const repositoryEvidenceIdSchema = z.string().regex(
  /^E[0-9]+$/,
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
    'observed_change: stated by the diff alone, cites only D* ids and no E* ids. '
    + 'repository_fact: learned from a repository tool result, cites E* ids only and no D* ids. '
    + 'supported_inference: a conclusion supported by one or more D* and/or E* evidence ids, requiring at least one id. '
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

/** One compact terminal contains evidence findings and the generator-facing facts. */
export const changeAnalysisAgentFinalResponseSchema = z.object({
  investigation: z.object({
    findings: z.array(z.object({
      target: z.string().min(1).describe('An investigation plan target, copied exactly.'),
      question: z.string().min(1).describe('A planned question answered by a repository tool, not by the diff alone.'),
      answer: z.string().min(1).describe('What the repository evidence actually showed, not a restatement of the question or a diff-only fact.'),
      evidenceRefs: findingEvidenceReferenceSchema,
    } as const)).max(AGENT_TERMINAL_LIMITS.maxFindings)
      .describe('Only questions answered with repository evidence. Each finding requires 1 to 8 real E* ids; diff-only questions belong in unresolvedQuestions.'),
    unresolvedQuestions: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxUnresolvedQuestions)
      .describe('Planned questions the repository evidence could not answer. Leave them here instead of guessing.'),
    stopReason: z.string().min(1).describe('Why the investigation ended, in one sentence.'),
  } as const),
  claims: z.array(agentClaimSchema).min(1).max(AGENT_TERMINAL_LIMITS.maxClaims)
    .describe('Route evidenceRefs by category: observed_change=D* only, repository_fact=E* only, supported_inference=D*/E*, uncertain_inference=[] with disposition omit.'),
  behaviorAnalysis: z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
    observableEffect: z.string().nullable(),
  } as const).describe('Use null for any part the evidence does not establish.'),
  changeClassification: z.object({
    existingBehaviorCorrected: z.boolean(),
    newCapabilityAdded: z.boolean(),
    externalBehaviorChanged: z.boolean(),
    structuralOnly: z.boolean(),
    recommendedType: z.string().nullable().describe('A Conventional Commit type such as fix, feat, or refactor, or null.'),
    reason: z.string().nullable(),
  } as const),
  suggestedScope: z.string().nullable().describe('A short scope token derived from the investigated code path, or null. Never an evidence id.'),
  selectionNotes: z.string().nullable().default(null),
  uncertainties: z.array(z.string().min(1)).max(AGENT_TERMINAL_LIMITS.maxUncertainties),
} as const).strict();
