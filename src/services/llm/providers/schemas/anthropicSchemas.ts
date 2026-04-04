/**
 * JSON Schemas to use with Anthropic tools' input_schema for structured output.
 * These mirror the Zod definitions in common.ts exactly.
 */

export const CommitMessageJSONSchema = {
  type: 'object',
  properties: {
    commitMessage: { type: 'string', minLength: 1 }
  },
  required: ['commitMessage']
} as const;

export const RepoAnalysisJSONSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 1 },
    projectType: { type: 'string', minLength: 1 },
    technologies: {
      type: 'array',
      items: { type: 'string', minLength: 1 }
    },
    insights: {
      type: 'array',
      items: { type: 'string', minLength: 1 }
    }
  },
  required: ['summary', 'projectType', 'technologies', 'insights']
} as const;

export const RepoAnalysisActionJSONSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tool', 'final'] },
    toolName: { type: 'string', enum: ['listDirectory', 'searchFiles', 'readFileContent', 'compressContext'] },
    args: { type: 'object' },
    reason: { type: 'string' },
    final: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1 },
        projectType: { type: 'string', minLength: 1 },
        technologies: {
          type: 'array',
          items: { type: 'string', minLength: 1 }
        },
        insights: {
          type: 'array',
          items: { type: 'string', minLength: 1 }
        }
      },
      required: ['summary', 'projectType', 'technologies', 'insights']
    }
  },
  required: ['action']
} as const;

export const CompressionJSONSchema = {
  type: 'object',
  properties: {
    compressed_content: { type: 'string', minLength: 1 }
  },
  required: ['compressed_content']
} as const;

/**
 * Convenience tool descriptors for Anthropic Messages API
 */
export const AnthropicCommitMessageTool = {
  name: 'commit_message',
  description: 'Return a JSON object containing a conventional commit message.',
  input_schema: CommitMessageJSONSchema
} as const;

export const AnthropicRepoAnalysisTool = {
  name: 'repo_analysis',
  description: 'Return a structured repository analysis as a JSON object.',
  input_schema: RepoAnalysisJSONSchema
} as const;

export const AnthropicRepoAnalysisActionTool = {
  name: 'repo_analysis_action',
  description: 'Return an action decision during repository analysis exploration.',
  input_schema: RepoAnalysisActionJSONSchema
} as const;

export const AnthropicCompressionTool = {
  name: 'compression',
  description: 'Return compressed content as JSON: { compressed_content: string }.',
  input_schema: CompressionJSONSchema
} as const;

// ----- Additional tools used in chain mode -----

export const FileSummaryJSONSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored'] },
    summary: { type: 'string', minLength: 1, maxLength: 200 },
    breaking: { type: 'boolean' }
  },
  required: ['file', 'status', 'summary', 'breaking']
} as const;

export const ClassifyAndDraftJSONSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
    scope: { type: ['string', 'null'] },
    breaking: { type: 'boolean' },
    description: { type: ['string', 'null'], minLength: 1 },
    body: { type: ['string', 'null'] },
    footers: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: {
          token: { type: ['string', 'null'] },
          value: { type: ['string', 'null'] }
        },
        required: ['token', 'value']
      }
    },
    commitMessage: { type: 'string', minLength: 1 },
    notes: { type: ['string', 'null'] }
  },
  required: ['type', 'scope', 'breaking', 'description', 'body', 'footers', 'commitMessage', 'notes']
} as const;

export const ValidateAndFixJSONSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['valid', 'fixed'] },
    commitMessage: { type: 'string', minLength: 1 },
    violations: { type: 'array', items: { type: ['string', 'null'] } },
    notes: { type: ['string', 'null'] }
  },
  required: ['status', 'commitMessage', 'violations', 'notes']
} as const;

export const RagPreparationJSONSchema = {
  type: 'object',
  properties: {
    changeSetSummary: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
        dominantType: { type: ['string', 'null'] },
        dominantScope: { type: ['string', 'null'] },
        areas: { type: 'array', items: { type: 'string' } },
        fileKinds: { type: 'array', items: { type: 'string' } },
        changeActions: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } }
      },
      required: ['text', 'dominantType', 'dominantScope', 'areas', 'fileKinds', 'changeActions', 'entities']
    },
    retrievalFeatures: {
      type: 'object',
      properties: {
        predictedType: { type: ['string', 'null'] },
        predictedScope: { type: ['string', 'null'] },
        areas: { type: 'array', items: { type: 'string' } },
        fileKinds: { type: 'array', items: { type: 'string' } },
        changeActions: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } },
        touchedPaths: { type: 'array', items: { type: 'string' } },
        fileExtensions: { type: 'array', items: { type: 'string' } },
        statusMix: { type: 'array', items: { type: 'string', enum: ['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored'] } },
        fileCount: { type: 'number', minimum: 0 },
        hasDocs: { type: 'boolean' },
        hasTests: { type: 'boolean' },
        hasConfig: { type: 'boolean' },
        hasRenames: { type: 'boolean' },
        isCrossLayer: { type: 'boolean' },
        breakingLike: { type: 'boolean' }
      },
      required: ['predictedType', 'predictedScope', 'areas', 'fileKinds', 'changeActions', 'entities', 'touchedPaths', 'fileExtensions', 'statusMix', 'fileCount', 'hasDocs', 'hasTests', 'hasConfig', 'hasRenames', 'isCrossLayer', 'breakingLike']
    }
  },
  required: ['changeSetSummary', 'retrievalFeatures']
} as const;

export const RagRerankJSONSchema = {
  type: 'object',
  properties: {
    selected: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          commitHash: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 }
        },
        required: ['commitHash', 'reason']
      }
    },
    notes: { type: ['string', 'null'] }
  },
  required: ['selected']
} as const;

export const AnthropicFileSummaryTool = {
  name: 'file_summary',
  description: 'Return a structured summary for a single file diff.',
  input_schema: FileSummaryJSONSchema
} as const;

export const AnthropicClassifyAndDraftTool = {
  name: 'classify_and_draft',
  description: 'Classify changes and draft a commit proposal as JSON.',
  input_schema: ClassifyAndDraftJSONSchema
} as const;

export const AnthropicValidateAndFixTool = {
  name: 'validate_and_fix',
  description: 'Validate and optionally fix a commit message; return JSON.',
  input_schema: ValidateAndFixJSONSchema
} as const;

export const AnthropicRagPreparationTool = {
  name: 'rag_preparation',
  description: 'Return structured changeSetSummary and retrievalFeatures for future RAG retrieval.',
  input_schema: RagPreparationJSONSchema
} as const;

export const AnthropicRagRerankTool = {
  name: 'rag_rerank',
  description: 'Rerank retrieved historical commit messages and return the best style-reference candidates.',
  input_schema: RagRerankJSONSchema
} as const;
