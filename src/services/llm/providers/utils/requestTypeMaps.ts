import type { z } from 'zod';
import type { RequestType } from '../../llmTypes';
import {
    evidenceSummaryResponseSchema,
    classifyAndDraftResponseSchema,
    validateAndFixResponseSchema,
    commitMessageSchema,
    ragPreparationResponseSchema,
    ragRerankResponseSchema,
    changeExtractionResponseSchema,
    investigationPlanResponseSchema,
    semanticAnalysisResponseSchema,
    informationSelectionResponseSchema,
} from '../schemas/common';

const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
    commitMessage: 'build-commit-msg',
    summary: 'summarize',
    draft: 'draft',
    fix: 'validate-fix',
    ragPreparation: 'rag-prep',
    ragRerank: 'rag-rerank',
    changeExtraction: 'change-extract',
    investigationPlan: 'investigation-plan',
    semanticAnalysis: 'semantic-analysis',
    informationSelection: 'info-selection',
    strictFix: 'strict-fix',
    enforceLanguage: 'lang-fix',
};

const VALIDATION_SCHEMAS: Record<RequestType, z.ZodTypeAny> = {
    commitMessage: commitMessageSchema,
    summary: evidenceSummaryResponseSchema,
    draft: classifyAndDraftResponseSchema,
    fix: validateAndFixResponseSchema,
    ragPreparation: ragPreparationResponseSchema,
    ragRerank: ragRerankResponseSchema,
    changeExtraction: changeExtractionResponseSchema,
    investigationPlan: investigationPlanResponseSchema,
    semanticAnalysis: semanticAnalysisResponseSchema,
    informationSelection: informationSelectionResponseSchema,
    strictFix: commitMessageSchema,
    enforceLanguage: commitMessageSchema,
};

/**
 * Map a chain request type to a short, human-readable label used in logs and
 * cost summaries. The same mapping is used by every provider so it lives here
 * instead of being copy-pasted into each implementation.
 */
export function getRequestTypeLabel(reqType?: string): string {
    return reqType && reqType in REQUEST_TYPE_LABELS
        ? REQUEST_TYPE_LABELS[reqType as RequestType]
        : 'thinking';
}

/**
 * Returns the shared Zod validation schema for a given chain request type, or
 * undefined when the request type does not require structured validation.
 *
 * The map is identical across all providers — provider-specific schemas
 * (Anthropic tools, Gemini response schemas) are kept inside each provider.
 */
export function getValidationSchemaFor(reqType?: string): z.ZodTypeAny | undefined {
    if (!reqType) {
        return undefined;
    }
    return reqType in VALIDATION_SCHEMAS
        ? VALIDATION_SCHEMAS[reqType as RequestType]
        : undefined;
}
