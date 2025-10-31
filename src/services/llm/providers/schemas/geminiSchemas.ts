import { Type } from "@google/genai";

/**
 * Gemini-specific schemas for structured output using responseSchema format
 * These schemas are based on the common Zod schemas but converted to Gemini's Type format
 */

/**
 * Convert Zod string to Gemini Type.STRING with description
 */
const createStringType = (description?: string) => ({
    type: Type.STRING,
    ...(description && { description })
});

/**
 * Convert Zod boolean to Gemini Type.BOOLEAN
 */
const createBooleanType = (description?: string) => ({
    type: Type.BOOLEAN,
    ...(description && { description })
});

/**
 * Convert Zod number to Gemini Type.NUMBER
 */
const createNumberType = (description?: string, minimum?: number) => ({
    type: Type.NUMBER,
    ...(description && { description }),
    ...(minimum !== undefined && { minimum })
});

/**
 * Convert Zod array to Gemini Type.ARRAY
 */
const createArrayType = (items: any, description?: string) => ({
    type: Type.ARRAY,
    items,
    ...(description && { description })
});

/**
 * Convert Zod enum to Gemini Type.STRING with enum values
 */
const createEnumType = (enumValues: string[], description?: string) => ({
    type: Type.STRING,
    enum: enumValues,
    ...(description && { description })
});

/**
 * Schema for commit message generation
 */
export const GeminiCommitMessageSchema = {
    type: Type.OBJECT,
    properties: {
        commitMessage: createStringType('The generated commit message following the specified template and conventions')
    },
    required: ['commitMessage'],
    propertyOrdering: ['commitMessage']
};

/**
 * Schema for file summary analysis
 */
export const GeminiFileSummarySchema = {
    type: Type.OBJECT,
    properties: {
        file: createStringType('The file path relative to repository root'),
        status: createEnumType(['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored'], 'The git status of the file'),
        summary: createStringType('A concise summary of changes in this file (max 200 chars)'),
        breaking: createBooleanType('Whether this file contains breaking changes')
    },
    required: ['file', 'status', 'summary', 'breaking'],
    propertyOrdering: ['file', 'status', 'summary', 'breaking']
};



/**
 * Schema for classify and draft response
 */
export const GeminiClassifyAndDraftSchema = {
    type: Type.OBJECT,
    properties: {
        type: createStringType('Type of the changes, including in the base of the allowed types, If the user provides a template, prioritize the user s template. '),
        scope: createStringType('Scope of the changes (optional)'),
        breaking: createBooleanType('Whether changes are breaking'),
        description: createStringType('A short description of the changes'),
        body: createStringType('A detailed body of the commit message (optional)'),
        footers: createArrayType({
            type: Type.OBJECT,
            properties: {
                token: createStringType('Footer token name'),
                value: createStringType('Value for this footer')
            },
            required: ['token', 'value']
        }, 'List of footers for the commit message'),
        commitMessage: createStringType('The full draft commit message following the specified template and conventions'),
        notes: createStringType('Any additional notes or explanations about the commit message')
    },
    required: ['type', 'breaking', 'description', 'footers', 'commitMessage', 'notes'],
    propertyOrdering: ['type', 'scope', 'breaking', 'description', 'body', 'footers', 'commitMessage', 'notes']
};

/**
 * Schema for validate and fix response
 */
export const GeminiValidateAndFixSchema = {
    type: Type.OBJECT,
    properties: {
        status: createEnumType(['valid', 'fixed'], 'Indicates if the original commit message was valid or has been fixed'),
        commitMessage: createStringType('The validated or fixed commit message following the specified template and conventions'),
        violations: createArrayType(createStringType(), 'List of violations found in the original commit message'),
        notes: createStringType('Any additional notes or explanations about the validation or fixes applied')
    },
    required: ['status', 'commitMessage', 'violations'],
    propertyOrdering: ['status', 'commitMessage', 'violations', 'notes']
};

/**
 * Schema for repository analysis response
 */
export const GeminiRepoAnalysisSchema = {
    type: Type.OBJECT,
    properties: {
        summary: createStringType("Brief but comprehensive summary of the repository purpose and architecture"),
        projectType: createStringType("The primary type of the project, e.g., 'web application', 'library', 'CLI tool'"),
        technologies: createArrayType(createStringType(), "Array of main technologies used"),
        insights: createArrayType(createStringType(), "Key insights about the repository.")
    }
};

/**
 * Schema for repository analysis action during exploration
 */
export const GeminiRepoAnalysisActionSchema = {
    type: Type.OBJECT,
    properties: {
        action: createEnumType(['tool', 'final'], "Action type: 'tool' to call a tool, 'final' to provide final analysis"),
        toolName: createEnumType(['listDirectory', 'searchFiles', 'readFileContent', 'compressContext'], "Tool to call when action is 'tool'"),
        args: {
            type: Type.OBJECT,
            properties: {
                // listDirectory
                dirPath: createStringType("Absolute directory path inside repository (for listDirectory)"),
                depth: createNumberType("Directory depth (for listDirectory)", 0),
                excludePatterns: createArrayType(createStringType(), "Glob-like patterns to exclude (for listDirectory/searchFiles)"),
                // searchFiles
                query: createStringType("Search query (for searchFiles)"),
                searchType: createEnumType(['name','content'], "Search type (for searchFiles)"),
                useRegex: createBooleanType("Use regular expression (for searchFiles)"),
                searchPath: createStringType("Path to search within (for searchFiles)"),
                maxResults: createNumberType("Maximum results (for searchFiles)", 1),
                caseSensitive: createBooleanType("Case sensitive (for searchFiles)"),
                maxMatchesPerFile: createNumberType("Max matches per file (for searchFiles)", 1),
                contextLines: createNumberType("Context lines for content search (for searchFiles)", 0),
                // readFileContent
                filePath: createStringType("Absolute file path inside repository (for readFileContent)"),
                startLine: createNumberType("Start line (for readFileContent)", 1),
                maxLines: createNumberType("Max lines (for readFileContent)", 1),
                encoding: createStringType("Text encoding (for readFileContent)"),
                // compressContext
                content: createStringType("Content to compress (for compressContext)"),
                targetTokens: createNumberType("Target tokens after compression (for compressContext)", 1),
                preserveStructure: createBooleanType("Preserve structure (for compressContext)"),
                language: createStringType("Language hint (for compressContext)")
            },
            description: "Arguments for the tool call - provide only relevant properties for the selected tool"
        },
        reason: createStringType("Brief explanation of what you will do next (required)"),
        final: {
            type: Type.OBJECT,
            properties: {
                summary: createStringType("Brief but comprehensive summary of the repository purpose and architecture"),
                projectType: createStringType("Main project type (e.g., Web App, Library, CLI Tool, etc.)"),
                technologies: createArrayType(createStringType(), "Array of main technologies used"),
                insights: createArrayType(createStringType(), "Key architectural insights about the project")
            },
            description: "Final analysis result when action is 'final'"
        }
    },
    required: ['action','reason']
};
