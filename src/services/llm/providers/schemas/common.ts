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

export const repoAnalysisResponseSchema = z.object({
  summary: z.string().min(1).describe("Brief but comprehensive summary of the repository purpose and architecture"),
  projectType: z.string().min(1).default('Unknown Project').describe("Main project type (e.g., Web App, Library, CLI Tool, etc.)"),
  technologies: z.array(z.string().min(1)).default([]).describe("Array of main technologies used"),
  insights: z.array(z.string().min(1)).default([]).describe("Key architectural insights about the project")
} as const);
