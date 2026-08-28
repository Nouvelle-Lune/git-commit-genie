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
  required: [
    'action', 'tool', 'reason', 'symbol', 'filePath', 'dirPath', 'query',
    'searchType', 'useRegex', 'startLine', 'maxLines', 'maxResults', 'final'
  ]
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

const EvidenceReferenceJSONSchema = {
  type: 'object',
  properties: {
    detail: { type: 'string', minLength: 1 },
    evidenceHunkIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }
  },
  required: ['detail', 'evidenceHunkIds']
} as const;

export const EvidenceSummaryJSONSchema = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', minLength: 1 },
          target: { type: 'string', minLength: 1 },
          behavior: { type: 'string', minLength: 1 },
          exactSymbols: { type: 'array', items: { type: 'string', minLength: 1 } },
          evidenceHunkIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }
        },
        required: ['action', 'target', 'behavior', 'exactSymbols', 'evidenceHunkIds']
      }
    },
    tests: { type: 'array', items: EvidenceReferenceJSONSchema },
    breakingSignals: { type: 'array', items: EvidenceReferenceJSONSchema },
    uncertainties: { type: 'array', items: EvidenceReferenceJSONSchema }
  },
  required: ['changes', 'tests', 'breakingSignals', 'uncertainties']
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
          id: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 }
        },
        required: ['id', 'reason']
      }
    },
    notes: { type: ['string', 'null'] }
  },
  required: ['selected']
} as const;

// ----- Change-Conditioned Chain -----

const CHANGED_SYMBOL_TYPE_ENUM = [
  'function', 'method', 'class', 'interface', 'type',
  'constant', 'variable', 'config_key', 'route', 'cli_flag', 'unknown'
] as const;

const CHANGE_KIND_ENUM = [
  'added', 'removed', 'signature', 'function_body',
  'type_shape', 'value', 'renamed', 'moved', 'unknown'
] as const;

const INVESTIGATION_TOOL_ENUM = [
  'getChangedSymbols', 'findSymbolDefinition', 'findSymbolReferences',
  'findCallers', 'findCallees', 'findImplementations', 'findTypeDefinition',
  'searchCode', 'readFileContent', 'listDirectory'
] as const;

const StringArrayJSONSchema = { type: 'array', items: { type: 'string' } } as const;

export const ChangeExtractionJSONSchema = {
  type: 'object',
  properties: {
    changedSymbols: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          file: { type: 'string', minLength: 1 },
          symbolType: { type: 'string', enum: CHANGED_SYMBOL_TYPE_ENUM },
          changeKind: { type: 'string', enum: CHANGE_KIND_ENUM },
          evidenceRefs: StringArrayJSONSchema
        },
        required: ['name', 'file', 'symbolType', 'changeKind', 'evidenceRefs']
      }
    },
    introducedSymbols: StringArrayJSONSchema,
    removedSymbols: StringArrayJSONSchema,
    changedCalls: StringArrayJSONSchema,
    changedConfigs: StringArrayJSONSchema,
    changedTypes: StringArrayJSONSchema,
    changedDependencies: StringArrayJSONSchema
  },
  required: [
    'changedSymbols', 'introducedSymbols', 'removedSymbols',
    'changedCalls', 'changedConfigs', 'changedTypes', 'changedDependencies'
  ]
} as const;

export const InvestigationPlanJSONSchema = {
  type: 'object',
  properties: {
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: ['symbol', 'config', 'type', 'dependency', 'interface', 'cli_or_api'] },
          file: { type: ['string', 'null'] },
          questions: StringArrayJSONSchema
        },
        required: ['target', 'kind', 'file', 'questions']
      }
    },
    notes: { type: ['string', 'null'] }
  },
  required: ['targets', 'notes']
} as const;

export const InvestigationActionJSONSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tool', 'final'] },
    tool: { type: ['string', 'null'], enum: [...INVESTIGATION_TOOL_ENUM, null] },
    reason: { type: ['string', 'null'] },
    symbol: { type: ['string', 'null'] },
    filePath: { type: ['string', 'null'] },
    dirPath: { type: ['string', 'null'] },
    query: { type: ['string', 'null'] },
    searchType: { type: ['string', 'null'], enum: ['name', 'content', null] },
    useRegex: { type: ['boolean', 'null'] },
    startLine: { type: ['number', 'null'] },
    maxLines: { type: ['number', 'null'] },
    maxResults: { type: ['number', 'null'] },
    final: {
      type: ['object', 'null'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              target: { type: 'string', minLength: 1 },
              question: { type: 'string', minLength: 1 },
              answer: { type: 'string', minLength: 1 },
              evidenceRefs: StringArrayJSONSchema
            },
            required: ['target', 'question', 'answer', 'evidenceRefs']
          }
        },
        unresolvedQuestions: StringArrayJSONSchema,
        stopReason: { type: 'string', minLength: 1 }
      },
      required: ['findings', 'unresolvedQuestions', 'stopReason']
    }
  },
  required: [
    'action', 'tool', 'reason', 'symbol', 'filePath', 'dirPath', 'query',
    'searchType', 'useRegex', 'startLine', 'maxLines', 'maxResults', 'final'
  ]
} as const;

const EvidenceBackedClaimJSONSchema = {
  type: 'object',
  properties: {
    claim: { type: 'string', minLength: 1 },
    evidenceRefs: StringArrayJSONSchema
  },
  required: ['claim', 'evidenceRefs']
} as const;

export const SemanticAnalysisJSONSchema = {
  type: 'object',
  properties: {
    changeTargets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string', minLength: 1 },
          file: { type: 'string', minLength: 1 },
          role: { type: 'string', minLength: 1 },
          evidenceRefs: StringArrayJSONSchema
        },
        required: ['symbol', 'file', 'role', 'evidenceRefs']
      }
    },
    dependencyContext: {
      type: 'object',
      properties: {
        callers: StringArrayJSONSchema,
        callees: StringArrayJSONSchema,
        stateDependencies: StringArrayJSONSchema,
        relatedConfigs: StringArrayJSONSchema,
        relatedTypes: StringArrayJSONSchema
      },
      required: ['callers', 'callees', 'stateDependencies', 'relatedConfigs', 'relatedTypes']
    },
    observedChanges: { type: 'array', items: EvidenceBackedClaimJSONSchema },
    repositoryFacts: { type: 'array', items: EvidenceBackedClaimJSONSchema },
    behaviorAnalysis: {
      type: 'object',
      properties: {
        before: { type: ['string', 'null'] },
        after: { type: ['string', 'null'] },
        observableEffect: { type: ['string', 'null'] }
      },
      required: ['before', 'after', 'observableEffect']
    },
    capabilityContext: {
      type: 'object',
      properties: {
        technicalCapability: { type: ['string', 'null'] },
        productCapability: { type: ['string', 'null'] }
      },
      required: ['technicalCapability', 'productCapability']
    },
    supportedInferences: { type: 'array', items: EvidenceBackedClaimJSONSchema },
    uncertainInferences: { type: 'array', items: EvidenceBackedClaimJSONSchema },
    intentAnalysis: {
      type: 'object',
      properties: {
        primaryIntent: { type: ['string', 'null'] },
        supportedBy: StringArrayJSONSchema,
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
      },
      required: ['primaryIntent', 'supportedBy', 'confidence']
    },
    changeClassification: {
      type: 'object',
      properties: {
        existingBehaviorCorrected: { type: 'boolean' },
        newCapabilityAdded: { type: 'boolean' },
        externalBehaviorChanged: { type: 'boolean' },
        structuralOnly: { type: 'boolean' },
        recommendedType: { type: ['string', 'null'] },
        reason: { type: ['string', 'null'] }
      },
      required: [
        'existingBehaviorCorrected', 'newCapabilityAdded',
        'externalBehaviorChanged', 'structuralOnly', 'recommendedType', 'reason'
      ]
    },
    uncertainties: StringArrayJSONSchema
  },
  required: [
    'changeTargets', 'dependencyContext', 'observedChanges', 'repositoryFacts',
    'behaviorAnalysis', 'capabilityContext', 'supportedInferences',
    'uncertainInferences', 'intentAnalysis', 'changeClassification', 'uncertainties'
  ]
} as const;

export const InformationSelectionJSONSchema = {
  type: 'object',
  properties: {
    mustExpress: StringArrayJSONSchema,
    optional: StringArrayJSONSchema,
    omit: StringArrayJSONSchema,
    suggestedScope: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] }
  },
  required: ['mustExpress', 'optional', 'omit', 'suggestedScope', 'notes']
} as const;

export const AnthropicChangeExtractionTool = {
  name: 'change_extraction',
  description: 'Return the changed symbols, calls, configs, types, and dependencies observed in the diff.',
  input_schema: ChangeExtractionJSONSchema
} as const;

export const AnthropicInvestigationPlanTool = {
  name: 'investigation_plan',
  description: 'Return the repository investigation targets and the questions each target must answer.',
  input_schema: InvestigationPlanJSONSchema
} as const;

export const AnthropicInvestigationActionTool = {
  name: 'investigation_action',
  description: 'Return the next repository investigation tool call, or finalize with grounded findings.',
  input_schema: InvestigationActionJSONSchema
} as const;

export const AnthropicSemanticAnalysisTool = {
  name: 'semantic_analysis',
  description: 'Return evidence-backed semantic analysis of the current change.',
  input_schema: SemanticAnalysisJSONSchema
} as const;

export const AnthropicInformationSelectionTool = {
  name: 'information_selection',
  description: 'Return which semantic information belongs in the commit message.',
  input_schema: InformationSelectionJSONSchema
} as const;

export const AnthropicEvidenceSummaryTool = {
  name: 'evidence_summary',
  description: 'Return structured, hunk-referenced evidence for one file diff chunk.',
  input_schema: EvidenceSummaryJSONSchema
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
