import type { z } from 'zod';
import {
    fileSummarySchema,
    classifyAndDraftResponseSchema,
    validateAndFixResponseSchema,
    commitMessageSchema,
    ragPreparationResponseSchema,
    ragRerankResponseSchema,
    repoAnalysisResponseSchema,
    repoAnalysisActionSchema,
} from '../schemas/common';

/**
 * Map a chain request type to a short, human-readable label used in logs and
 * cost summaries. The same mapping is used by every provider so it lives here
 * instead of being copy-pasted into each implementation.
 */
export function getRequestTypeLabel(reqType?: string): string {
    switch (reqType) {
        case 'summary': return 'summarize';
        case 'draft': return 'draft';
        case 'fix': return 'validate-fix';
        case 'ragPreparation': return 'rag-prep';
        case 'ragRerank': return 'rag-rerank';
        case 'strictFix': return 'strict-fix';
        case 'enforceLanguage': return 'lang-fix';
        case 'commitMessage': return 'build-commit-msg';
        case 'repoAnalysis': return 'repo-analysis';
        case 'repoAnalysisAction': return 'repo-analysis-action';
        default: return 'thinking';
    }
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
    const map: Record<string, z.ZodTypeAny> = {
        summary: fileSummarySchema,
        draft: classifyAndDraftResponseSchema,
        fix: validateAndFixResponseSchema,
        ragPreparation: ragPreparationResponseSchema,
        ragRerank: ragRerankResponseSchema,
        commitMessage: commitMessageSchema,
        strictFix: commitMessageSchema,
        enforceLanguage: commitMessageSchema,
        repoAnalysis: repoAnalysisResponseSchema,
        repoAnalysisAction: repoAnalysisActionSchema,
    };
    return map[reqType];
}
