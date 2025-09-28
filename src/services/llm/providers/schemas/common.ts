import { z } from "zod";

/**
 * Shared Zod schemas used to constrain JSON output across providers.
 */

export const commitMessageSchema = z.object({
  commitMessage: z.string().min(1)
} as const);

export const fileSummarySchema = z.object({
  file: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored']),
  summary: z.string().min(1),
  breaking: z.boolean()
} as const);

export const templatePolicySchema = z.object({
  header: z.object({
    requireScope: z.boolean(),
    scopeDerivation: z.enum(['directory', 'repo', 'none']).nullable(),
    preferBangForBreaking: z.boolean(),
    alsoRequireBreakingFooter: z.boolean()
  }),
  types: z.object({
    allowed: z.array(z.string().min(1)),
    preferred: z.string().min(1).nullable(),
    useStandardTypes: z.boolean()
  }),
  body: z.object({
    alwaysInclude: z.boolean(),
    orderedSections: z.array(z.string().min(1)),
    bulletRules: z.array(z.object({
      section: z.string().min(1),
      maxBullets: z.number().min(1).optional(),
      style: z.enum(['dash', 'asterisk']).optional()
    })),
    bulletContentMode: z.enum(['plain', 'file-prefixed', 'type-prefixed']).optional()
  }),
  footers: z.object({
    required: z.array(z.string().min(1)),
    defaults: z.array(z.object({
      token: z.string().min(1),
      value: z.string().min(1)
    })),
  }),
  lexicon: z.object({
    prefer: z.array(z.string().min(1)),
    avoid: z.array(z.string().min(1)),
    tone: z.enum(['imperative', 'neutral', 'friendly'])
  })
} as const);

export const classifyAndDraftResponseSchema = z.object({
  type: z.string().min(1),
  scope: z.string().min(1).nullable(),
  breaking: z.boolean(),
  description: z.string().min(1),
  body: z.string().min(1).nullable(),
  footers: z.array(z.object({
    token: z.string().min(1).nullable(),
    value: z.string().min(1).nullable()
  })).nullable(),
  commitMessage: z.string().min(1),
  notes: z.string().min(1).nullable()
} as const);

export const validateAndFixResponseSchema = z.object({
  status: z.enum(['valid', 'fixed']),
  commitMessage: z.string().min(1),
  violations: z.array(z.string().nullable()),
  notes: z.string().nullable()
} as const);

export const repoAnalysisResponseSchema = z.object({
  summary: z.string().min(1).describe("Brief but comprehensive summary of the repository purpose and architecture"),
  projectType: z.string().min(1).describe("Main project type (e.g., Web App, Library, CLI Tool, etc.)"),
  technologies: z.array(z.string().min(1)).describe("Array of main technologies used"),
  insights: z.array(z.string().min(1)).describe("Key architectural insights about the project")
} as const);

