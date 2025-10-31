import { Type } from '@google/genai';

// Gemini function declarations for repository analysis tools

export const GeminiFunction_ListDirectory = {
  name: 'listDirectory',
  description: 'List directory entries up to a depth; dirPath must be inside repository.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      dirPath: { type: Type.STRING, description: 'Absolute path to directory inside the repository' },
      depth: { type: Type.NUMBER, description: 'Maximum depth to traverse (0 means only dir itself)', minimum: 0 },
      excludePatterns: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Glob-like patterns to exclude' },
      reason: { type: Type.STRING, description: 'Brief reason for choosing this tool' },
    },
    required: ['dirPath'],
  },
} as const;

export const GeminiFunction_SearchFiles = {
  name: 'searchFiles',
  description: 'Search files by name or content; paths must be inside repository.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: 'Search query string' },
      searchType: { type: Type.STRING, enum: ['name', 'content'], description: 'Search by file name or file content' },
      useRegex: { type: Type.BOOLEAN, description: 'Interpret query as a regular expression' },
      searchPath: { type: Type.STRING, description: 'Directory path to limit the search (inside repo)' },
      maxResults: { type: Type.NUMBER, description: 'Maximum number of files to return', minimum: 1 },
      caseSensitive: { type: Type.BOOLEAN, description: 'Case sensitive search' },
      excludePatterns: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Glob-like patterns to exclude' },
      maxMatchesPerFile: { type: Type.NUMBER, description: 'Maximum matches per file for content search', minimum: 1 },
      contextLines: { type: Type.NUMBER, description: 'Number of context lines around a content match', minimum: 0 },
      reason: { type: Type.STRING, description: 'Brief reason for choosing this tool' },
    },
    required: ['query', 'searchType'],
  },
} as const;

export const GeminiFunction_ReadFileContent = {
  name: 'readFileContent',
  description: 'Read a file segment; filePath must be inside repository.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filePath: { type: Type.STRING, description: 'Absolute file path inside repository' },
      startLine: { type: Type.NUMBER, description: '1-based start line', minimum: 1 },
      maxLines: { type: Type.NUMBER, description: 'Maximum number of lines to read', minimum: 1 },
      encoding: { type: Type.STRING, description: 'Text encoding (default utf-8)' },
      reason: { type: Type.STRING, description: 'Brief reason for choosing this tool' },
    },
    required: ['filePath'],
  },
} as const;

export const GeminiFunction_CompressContext = {
  name: 'compressContext',
  description: 'Use LLM summarization to compress long context before continuing exploration.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      content: { type: Type.STRING, description: 'Content to compress' },
      targetTokens: { type: Type.NUMBER, description: 'Target token budget after compression', minimum: 1 },
      preserveStructure: { type: Type.BOOLEAN, description: 'Preserve headings/sections where possible' },
      language: { type: Type.STRING, description: 'Language hint for the compression output' },
      reason: { type: Type.STRING, description: 'Brief reason for choosing this tool' },
    },
    required: ['content'],
  },
} as const;

export const GeminiFunction_Finalize = {
  name: 'finalize',
  description: 'Return the final structured repository analysis and end the exploration.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING, description: 'Brief but comprehensive summary of the repository purpose and architecture' },
      projectType: { type: Type.STRING, description: "Main project type (e.g., Web App, Library, CLI Tool, etc.)" },
      technologies: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Array of main technologies used' },
      insights: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Key architectural insights about the project' },
    },
    required: ['summary', 'projectType', 'technologies', 'insights'],
  },
} as const;

export const GeminiRepoAnalysisFunctionDeclarations = [
  GeminiFunction_ListDirectory,
  GeminiFunction_SearchFiles,
  GeminiFunction_ReadFileContent,
  GeminiFunction_CompressContext,
  GeminiFunction_Finalize,
] as const;

