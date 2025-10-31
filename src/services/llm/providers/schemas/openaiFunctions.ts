// OpenAI Responses API function definitions for repo analysis tools
// These are strict JSON Schemas (no oneOf/anyOf) per OpenAI's structured tools requirements.

export const OpenAIFunction_ListDirectory = {
  type: 'function',
  name: 'listDirectory',
  description: 'List directory entries up to a depth; dirPath must be inside repository.',
  parameters: {
    type: 'object',
    properties: {
      dirPath: { type: 'string', description: 'Absolute path to directory inside the repository' },
      depth: { type: 'number', minimum: 0, description: 'Maximum depth to traverse (0 means only dir itself)' },
      excludePatterns: { type: 'array', items: { type: 'string' }, description: 'Glob-like patterns to exclude' },
      reason: { type: 'string', description: 'Brief reason for choosing this tool' }
    },
    required: ['dirPath'],
    additionalProperties: false
  }
} as const;

export const OpenAIFunction_SearchFiles = {
  type: 'function',
  name: 'searchFiles',
  description: 'Search files by name or content; paths must be inside repository.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      searchType: { type: 'string', enum: ['name', 'content'] },
      useRegex: { type: 'boolean' },
      searchPath: { type: 'string' },
      maxResults: { type: 'number', minimum: 1 },
      caseSensitive: { type: 'boolean' },
      excludePatterns: { type: 'array', items: { type: 'string' } },
      maxMatchesPerFile: { type: 'number', minimum: 1 },
      contextLines: { type: 'number', minimum: 0 },
      reason: { type: 'string', description: 'Brief reason for choosing this tool' }
    },
    required: ['query','searchType'],
    additionalProperties: false
  }
} as const;

export const OpenAIFunction_ReadFileContent = {
  type: 'function',
  name: 'readFileContent',
  description: 'Read a file segment; filePath must be inside repository.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      startLine: { type: 'number', minimum: 1 },
      maxLines: { type: 'number', minimum: 1 },
      encoding: { type: 'string' },
      reason: { type: 'string', description: 'Brief reason for choosing this tool' }
    },
    required: ['filePath'],
    additionalProperties: false
  }
} as const;

export const OpenAIFunction_CompressContext = {
  type: 'function',
  name: 'compressContext',
  description: 'Use LLM summarization to compress long context before continuing exploration.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      targetTokens: { type: 'number', minimum: 1 },
      preserveStructure: { type: 'boolean' },
      language: { type: 'string' },
      reason: { type: 'string', description: 'Brief reason for choosing this tool' }
    },
    required: ['content'],
    additionalProperties: false
  }
} as const;

export const OpenAIFunction_Finalize = {
  type: 'function',
  name: 'finalize',
  description: 'Return the final structured repository analysis and end the exploration.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', minLength: 1 },
      projectType: { type: 'string', minLength: 1 },
      technologies: { type: 'array', items: { type: 'string', minLength: 1 } },
      insights: { type: 'array', items: { type: 'string', minLength: 1 } }
    },
    required: ['summary','projectType','technologies','insights'],
    additionalProperties: false
  }
} as const;

export const OpenAIRepoAnalysisFunctions = [
  OpenAIFunction_ListDirectory,
  OpenAIFunction_SearchFiles,
  OpenAIFunction_ReadFileContent,
  OpenAIFunction_CompressContext,
  OpenAIFunction_Finalize,
] as const;
