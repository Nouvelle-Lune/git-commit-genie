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

const createNullableStringType = (description?: string) => ({
    ...createStringType(description),
    nullable: true
});

/**
 * Convert Zod boolean to Gemini Type.BOOLEAN
 */
const createBooleanType = (description?: string) => ({
    type: Type.BOOLEAN,
    ...(description && { description })
});

const createNullableBooleanType = (description?: string) => ({
    ...createBooleanType(description),
    nullable: true
});

/**
 * Convert Zod number to Gemini Type.NUMBER
 */
const createNumberType = (description?: string, minimum?: number) => ({
    type: Type.NUMBER,
    ...(description && { description }),
    ...(minimum !== undefined && { minimum })
});

const createNullableNumberType = (description?: string, minimum?: number) => ({
    ...createNumberType(description, minimum),
    nullable: true
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

const GeminiEvidenceReferenceSchema = {
    type: Type.OBJECT,
    properties: {
        detail: createStringType('Evidence-grounded observation'),
        evidenceHunkIds: createArrayType(createStringType(), 'Hunk ids supporting this observation')
    },
    required: ['detail', 'evidenceHunkIds'],
    propertyOrdering: ['detail', 'evidenceHunkIds']
};

/**
 * Schema for hunk-referenced evidence extracted from one file diff chunk.
 */
export const GeminiEvidenceSummarySchema = {
    type: Type.OBJECT,
    properties: {
        changes: createArrayType({
            type: Type.OBJECT,
            properties: {
                action: createStringType('Concise change action'),
                target: createStringType('Changed technical target'),
                behavior: createStringType('Observable behavior change'),
                exactSymbols: createArrayType(createStringType(), 'Exact identifiers, settings, flags, or API names'),
                evidenceHunkIds: createArrayType(createStringType(), 'Hunk ids supporting this change')
            },
            required: ['action', 'target', 'behavior', 'exactSymbols', 'evidenceHunkIds']
        }, 'Evidence-grounded changes'),
        tests: createArrayType(GeminiEvidenceReferenceSchema, 'Test-related evidence'),
        breakingSignals: createArrayType(GeminiEvidenceReferenceSchema, 'Potential breaking-change evidence'),
        uncertainties: createArrayType(GeminiEvidenceReferenceSchema, 'Hunk-referenced details that cannot be concluded')
    },
    required: ['changes', 'tests', 'breakingSignals', 'uncertainties'],
    propertyOrdering: ['changes', 'tests', 'breakingSignals', 'uncertainties']
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

export const GeminiRagPreparationSchema = {
    type: Type.OBJECT,
    properties: {
        changeSetSummary: {
            type: Type.OBJECT,
            properties: {
                text: createStringType('Compact retrieval summary for the whole change set'),
                dominantType: createStringType('Likely dominant Conventional Commit type, or null if unclear'),
                dominantScope: createStringType('Likely dominant scope, or null if unclear'),
                areas: createArrayType(createStringType(), 'Broad functional areas'),
                fileKinds: createArrayType(createStringType(), 'Stable file kind buckets'),
                changeActions: createArrayType(createStringType(), 'Concise change verbs'),
                entities: createArrayType(createStringType(), 'Concrete technical nouns')
            },
            required: ['text', 'areas', 'fileKinds', 'changeActions', 'entities']
        },
        retrievalFeatures: {
            type: Type.OBJECT,
            properties: {
                predictedType: createStringType('Likely Conventional Commit type, or null if unclear'),
                predictedScope: createStringType('Likely scope, or null if unclear'),
                areas: createArrayType(createStringType(), 'Broad functional areas'),
                fileKinds: createArrayType(createStringType(), 'Stable file kind buckets'),
                changeActions: createArrayType(createStringType(), 'Concise change verbs'),
                entities: createArrayType(createStringType(), 'Concrete technical nouns'),
                touchedPaths: createArrayType(createStringType(), 'Changed file paths'),
                fileExtensions: createArrayType(createStringType(), 'Observed file extensions'),
                statusMix: createArrayType(createEnumType(['added', 'modified', 'deleted', 'renamed', 'untracked', 'ignored']), 'Observed status values'),
                fileCount: createNumberType('Number of changed files', 0),
                hasDocs: createBooleanType('Whether docs files are present'),
                hasTests: createBooleanType('Whether test files are present'),
                hasConfig: createBooleanType('Whether config files are present'),
                hasRenames: createBooleanType('Whether renamed files are present'),
                isCrossLayer: createBooleanType('Whether changes span multiple functional areas'),
                breakingLike: createBooleanType('Whether inputs suggest a breaking change')
            },
            required: ['areas', 'fileKinds', 'changeActions', 'entities', 'touchedPaths', 'fileExtensions', 'statusMix', 'fileCount', 'hasDocs', 'hasTests', 'hasConfig', 'hasRenames', 'isCrossLayer', 'breakingLike']
        }
    },
    required: ['changeSetSummary', 'retrievalFeatures'],
    propertyOrdering: ['changeSetSummary', 'retrievalFeatures']
};

export const GeminiRagRerankSchema = {
    type: Type.OBJECT,
    properties: {
        selected: createArrayType({
            type: Type.OBJECT,
            properties: {
                id: createStringType('Candidate short id (e.g., c1, c7) from the prompt'),
                reason: createStringType('Why this commit is a good style reference for the current change'),
            },
            required: ['id', 'reason']
        }, 'Selected historical commit messages'),
        notes: createStringType('Optional notes about the reranking result')
    },
    required: ['selected'],
    propertyOrdering: ['selected', 'notes']
};

// ----- Change-Conditioned Chain -----

const GeminiStringArray = (description?: string) => createArrayType(createStringType(), description);

export const GeminiChangeExtractionSchema = {
    type: Type.OBJECT,
    properties: {
        changedSymbols: createArrayType({
            type: Type.OBJECT,
            properties: {
                name: createStringType('Exact symbol identifier as written in the diff'),
                file: createStringType('Path of the file containing the symbol'),
                symbolType: createEnumType(
                    ['function', 'method', 'class', 'interface', 'type', 'constant', 'variable', 'config_key', 'route', 'cli_flag', 'unknown'],
                    'Kind of symbol'
                ),
                changeKind: createEnumType(
                    ['added', 'removed', 'signature', 'function_body', 'type_shape', 'value', 'renamed', 'moved', 'unknown'],
                    'What about the symbol changed'
                ),
                evidenceRefs: GeminiStringArray('Hunk ids or path:line anchors proving the symbol changed')
            },
            required: ['name', 'file', 'symbolType', 'changeKind', 'evidenceRefs']
        }, 'Symbols whose definition or body changed'),
        introducedSymbols: GeminiStringArray('Newly introduced identifiers'),
        removedSymbols: GeminiStringArray('Removed identifiers'),
        changedCalls: GeminiStringArray('Call expressions added or removed'),
        changedConfigs: GeminiStringArray('Configuration keys added, removed, or re-valued'),
        changedTypes: GeminiStringArray('Types or interfaces whose shape changed'),
        changedDependencies: GeminiStringArray('Dependency names added, removed, or version-bumped')
    },
    required: ['changedSymbols', 'introducedSymbols', 'removedSymbols', 'changedCalls', 'changedConfigs', 'changedTypes', 'changedDependencies'],
    propertyOrdering: ['changedSymbols', 'introducedSymbols', 'removedSymbols', 'changedCalls', 'changedConfigs', 'changedTypes', 'changedDependencies']
};

export const GeminiInvestigationPlanSchema = {
    type: Type.OBJECT,
    properties: {
        targets: createArrayType({
            type: Type.OBJECT,
            properties: {
                target: createStringType('Symbol, config key, type, or dependency to investigate'),
                kind: createEnumType(['symbol', 'config', 'type', 'dependency', 'interface', 'cli_or_api'], 'Target category'),
                file: createNullableStringType('File containing the target, or null when unknown'),
                questions: GeminiStringArray('Questions the repository must answer for this target')
            },
            required: ['target', 'kind', 'file', 'questions']
        }, 'Investigation targets'),
        notes: createNullableStringType('Optional reasoning about target selection')
    },
    required: ['targets', 'notes'],
    propertyOrdering: ['targets', 'notes']
};

export const GeminiInvestigationActionSchema = {
    type: Type.OBJECT,
    properties: {
        action: createEnumType(['tool', 'final'], "'tool' to keep investigating, 'final' to stop"),
        tool: {
            ...createEnumType(
            ['getChangedSymbols', 'findSymbolDefinition', 'findSymbolReferences', 'findCallers', 'findCallees', 'findImplementations', 'findTypeDefinition', 'searchCode', 'readFileContent', 'listDirectory'],
            'Tool to call when action is tool'
            ),
            nullable: true
        },
        reason: createNullableStringType('What you will learn from this call'),
        symbol: createNullableStringType('Symbol argument for symbol-oriented tools'),
        filePath: createNullableStringType('File path for readFileContent, or a scope hint for symbol tools'),
        dirPath: createNullableStringType('Directory path for listDirectory'),
        query: createNullableStringType('Query for searchCode'),
        searchType: {
            ...createEnumType(['name', 'content'], 'Search mode for searchCode'),
            nullable: true
        },
        useRegex: createNullableBooleanType('Treat the searchCode query as a regular expression'),
        startLine: createNullableNumberType('Start line for readFileContent', 1),
        maxLines: createNullableNumberType('Line window for readFileContent', 1),
        maxResults: createNullableNumberType('Result cap for search-oriented tools', 1),
        final: {
            type: Type.OBJECT,
            properties: {
                findings: createArrayType({
                    type: Type.OBJECT,
                    properties: {
                        target: createStringType('Investigated target'),
                        question: createStringType('Question that was answered'),
                        answer: createStringType('Answer grounded in retrieved evidence'),
                        evidenceRefs: GeminiStringArray('Evidence ids or path:line citations')
                    },
                    required: ['target', 'question', 'answer', 'evidenceRefs']
                }, 'Answered investigation questions'),
                unresolvedQuestions: GeminiStringArray('Questions the repository could not answer'),
                stopReason: createStringType('Why the investigation stopped')
            },
            required: ['findings', 'unresolvedQuestions', 'stopReason'],
            description: 'Final investigation result when action is final',
            nullable: true
        }
    },
    required: ['action', 'tool', 'reason', 'symbol', 'filePath', 'dirPath', 'query', 'searchType', 'useRegex', 'startLine', 'maxLines', 'maxResults', 'final'],
    propertyOrdering: ['action', 'tool', 'reason', 'symbol', 'filePath', 'dirPath', 'query', 'searchType', 'useRegex', 'startLine', 'maxLines', 'maxResults', 'final']
};

const GeminiEvidenceBackedClaim = {
    type: Type.OBJECT,
    properties: {
        claim: createStringType('A single factual statement'),
        evidenceRefs: GeminiStringArray('Diff hunk ids or repository path:line citations supporting the claim')
    },
    required: ['claim', 'evidenceRefs']
};

export const GeminiSemanticAnalysisSchema = {
    type: Type.OBJECT,
    properties: {
        changeTargets: createArrayType({
            type: Type.OBJECT,
            properties: {
                symbol: createStringType('Changed symbol'),
                file: createStringType('File containing the symbol'),
                role: createStringType('Role the symbol plays in the repository'),
                evidenceRefs: GeminiStringArray('Citations proving the role')
            },
            required: ['symbol', 'file', 'role', 'evidenceRefs']
        }, 'Changed symbols and their repository roles'),
        dependencyContext: {
            type: Type.OBJECT,
            properties: {
                callers: GeminiStringArray('Callers of the changed symbols'),
                callees: GeminiStringArray('Downstream calls made by the changed symbols'),
                stateDependencies: GeminiStringArray('Shared state read or mutated'),
                relatedConfigs: GeminiStringArray('Configuration affecting the changed behavior'),
                relatedTypes: GeminiStringArray('Types or interfaces constraining the change')
            },
            required: ['callers', 'callees', 'stateDependencies', 'relatedConfigs', 'relatedTypes']
        },
        observedChanges: createArrayType(GeminiEvidenceBackedClaim, 'Facts read directly from the diff'),
        repositoryFacts: createArrayType(GeminiEvidenceBackedClaim, 'Facts read from repository evidence'),
        behaviorAnalysis: {
            type: Type.OBJECT,
            properties: {
                before: createNullableStringType('Behavior before the change, or null when evidence is insufficient'),
                after: createNullableStringType('Behavior after the change, or null when evidence is insufficient'),
                observableEffect: createNullableStringType('Externally observable effect, or null')
            },
            required: ['before', 'after', 'observableEffect']
        },
        capabilityContext: {
            type: Type.OBJECT,
            properties: {
                technicalCapability: createNullableStringType('Affected technical capability, or null'),
                productCapability: createNullableStringType('Affected product capability, or null when unproven')
            },
            required: ['technicalCapability', 'productCapability']
        },
        supportedInferences: createArrayType(GeminiEvidenceBackedClaim, 'Inferences fully supported by evidence'),
        uncertainInferences: createArrayType(GeminiEvidenceBackedClaim, 'Plausible but unproven inferences'),
        intentAnalysis: {
            type: Type.OBJECT,
            properties: {
                primaryIntent: createNullableStringType('Primary intent of the change, or null when ambiguous'),
                supportedBy: GeminiStringArray('Citations supporting the intent'),
                confidence: createEnumType(['low', 'medium', 'high'], 'Confidence in the primary intent')
            },
            required: ['primaryIntent', 'supportedBy', 'confidence']
        },
        changeClassification: {
            type: Type.OBJECT,
            properties: {
                existingBehaviorCorrected: createBooleanType('An existing incorrect behavior was corrected'),
                newCapabilityAdded: createBooleanType('A new externally meaningful capability was added'),
                externalBehaviorChanged: createBooleanType('Externally observable behavior changed'),
                structuralOnly: createBooleanType('Only internal structure changed'),
                recommendedType: createNullableStringType('Recommended Conventional Commit type, or null'),
                reason: createNullableStringType('Why this type follows from the evidence')
            },
            required: ['existingBehaviorCorrected', 'newCapabilityAdded', 'externalBehaviorChanged', 'structuralOnly', 'recommendedType', 'reason']
        },
        uncertainties: GeminiStringArray('Anything the evidence could not settle')
    },
    required: ['changeTargets', 'dependencyContext', 'observedChanges', 'repositoryFacts', 'behaviorAnalysis', 'capabilityContext', 'supportedInferences', 'uncertainInferences', 'intentAnalysis', 'changeClassification', 'uncertainties'],
    propertyOrdering: ['changeTargets', 'dependencyContext', 'observedChanges', 'repositoryFacts', 'behaviorAnalysis', 'capabilityContext', 'supportedInferences', 'uncertainInferences', 'intentAnalysis', 'changeClassification', 'uncertainties']
};

export const GeminiInformationSelectionSchema = {
    type: Type.OBJECT,
    properties: {
        mustExpress: GeminiStringArray('Statements the commit message must convey'),
        optional: GeminiStringArray('Statements that help but are not required'),
        omit: GeminiStringArray('Statements that must stay out of the commit message'),
        suggestedScope: createNullableStringType('Scope grounded in the investigated code paths, or null'),
        notes: createNullableStringType('Optional notes about the selection')
    },
    required: ['mustExpress', 'optional', 'omit', 'suggestedScope', 'notes'],
    propertyOrdering: ['mustExpress', 'optional', 'omit', 'suggestedScope', 'notes']
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
