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

// Compression tool response schema
export const compressionResponseSchema = z.object({
  compressed_content: z.string().min(1)
} as const);

const toolActionSchema = z.object({
  action: z.literal('tool').describe("Call a tool to continue exploring"),
  toolName: z.enum(['listDirectory', 'searchFiles', 'readFileContent', 'compressContext']).describe("Tool to call"),
  args: z.record(z.string(), z.any()).describe("Arguments for the tool call (object with tool-specific fields; may be empty)"),
  reason: z.string().min(1).describe("Brief explanation of what you will do next")
} as const);

const finalActionSchema = z.object({
  action: z.literal('final').describe("Provide final structured analysis"),
  final: z.object({
    summary: z.string().min(1).describe("Brief but comprehensive summary of the repository purpose and architecture"),
    projectType: z.string().min(1).describe("Main project type (e.g., Web App, Library, CLI Tool, etc.)"),
    technologies: z.array(z.string().min(1)).describe("Array of main technologies used"),
    insights: z.array(z.string().min(1)).describe("Key architectural insights about the project")
  }).describe("Final analysis result")
} as const);

export const repoAnalysisActionSchema = z.discriminatedUnion('action', [toolActionSchema, finalActionSchema]);

// This is used only for OpenAI Responses API text.format to satisfy its restricted JSON Schema subset.
export const openAIRepoAnalysisActionSchema = z.object({
  action: z.enum(['tool', 'final']),
  toolName: z.enum(['listDirectory', 'searchFiles', 'readFileContent', 'compressContext']).nullable(),
  args: z.object({
    // listDirectory
    dirPath: z.string().nullable(),
    depth: z.number().int().min(0).nullable(),
    excludePatterns: z.array(z.string()).nullable(),
    // searchFiles
    query: z.string().nullable(),
    searchType: z.enum(['name', 'content']).nullable(),
    useRegex: z.boolean().nullable(),
    searchPath: z.string().nullable(),
    maxResults: z.number().int().min(1).nullable(),
    caseSensitive: z.boolean().nullable(),
    maxMatchesPerFile: z.number().int().min(1).nullable(),
    contextLines: z.number().int().min(0).nullable(),
    // readFileContent
    filePath: z.string().nullable(),
    startLine: z.number().int().min(1).nullable(),
    maxLines: z.number().int().min(1).nullable(),
    encoding: z.string().nullable(),
    // compressContext
    content: z.string().nullable(),
    targetTokens: z.number().int().min(1).nullable(),
    preserveStructure: z.boolean().nullable(),
    language: z.string().nullable(),
  }).strict(),
  reason: z.string().nullable(),
  final: z.object({
    summary: z.string().min(1),
    projectType: z.string().min(1),
    technologies: z.array(z.string().min(1)),
    insights: z.array(z.string().min(1)),
  }).strict().nullable(),
}).strict();
