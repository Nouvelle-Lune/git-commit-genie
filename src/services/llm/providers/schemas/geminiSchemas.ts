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
 * Schema for template policy analysis
 */
export const GeminiTemplatePolicySchema = {
    type: Type.OBJECT,
    properties: {
        header: {
            type: Type.OBJECT,
            properties: {
                requireScope: createBooleanType('Whether scope is required in commit header'),
                scopeDerivation: createEnumType(['directory', 'repo', 'none'], 'How to derive the scope'),
                preferBangForBreaking: createBooleanType('Whether to use ! for breaking changes'),
                alsoRequireBreakingFooter: createBooleanType('Whether breaking footer is also required')
            },
            required: ['requireScope', 'scopeDerivation', 'preferBangForBreaking', 'alsoRequireBreakingFooter']
        },
        types: {
            type: Type.OBJECT,
            properties: {
                allowed: createArrayType(createStringType(), 'List of allowed commit types'),
                preferred: createStringType('Preferred commit type for this change (can be null)'),
                useStandardTypes: createBooleanType('Whether to use standard conventional commit types')
            },
            required: ['allowed', 'preferred', 'useStandardTypes']
        },
        body: {
            type: Type.OBJECT,
            properties: {
                alwaysInclude: createBooleanType('Whether body should always be included'),
                orderedSections: createArrayType(createStringType(), 'Ordered list of body sections'),
                bulletRules: createArrayType({
                    type: Type.OBJECT,
                    properties: {
                        section: createStringType('Section name for this bullet rule'),
                        maxBullets: createNumberType('Maximum bullets for this section', 1),
                        style: createEnumType(['dash', 'asterisk'], 'Bullet style preference')
                    },
                    required: ['section']
                }, 'Rules for bullet formatting in body sections'),
                bulletContentMode: createEnumType(['plain', 'file-prefixed', 'type-prefixed'], 'How to format bullet content')
            },
            required: ['alwaysInclude', 'orderedSections', 'bulletRules']
        },
        footers: {
            type: Type.OBJECT,
            properties: {
                required: createArrayType(createStringType(), 'List of required footer tokens'),
                defaults: createArrayType({
                    type: Type.OBJECT,
                    properties: {
                        token: createStringType('Footer token name'),
                        value: createStringType('Default value for this footer')
                    },
                    required: ['token', 'value']
                }, 'Default footer values')
            },
            required: ['required', 'defaults']
        },
        lexicon: {
            type: Type.OBJECT,
            properties: {
                prefer: createArrayType(createStringType(), 'Preferred words and phrases'),
                avoid: createArrayType(createStringType(), 'Words and phrases to avoid'),
                tone: createEnumType(['imperative', 'neutral', 'friendly'], 'Overall tone for commit messages')
            },
            required: ['prefer', 'avoid', 'tone']
        }
    },
    required: ['header', 'types', 'body', 'footers', 'lexicon'],
    propertyOrdering: ['header', 'types', 'body', 'footers', 'lexicon']
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