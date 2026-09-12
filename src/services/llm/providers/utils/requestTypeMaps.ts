import type { z } from 'zod';
import type { RequestType } from '../../llmTypes';
import {
    evidenceSummaryResponseSchema,
    classifyAndDraftResponseSchema,
    validateAndFixResponseSchema,
    commitMessageSchema,
    factAwareCommitMessageSchema,
    ragRerankResponseSchema,
} from '../schemas/common';

const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
    commitMessage: 'build-commit-msg',
    summary: 'summarize',
    draft: 'draft',
    fix: 'validate-fix',
    ragRerank: 'rag-rerank',
    investigationPlan: 'investigation-plan',
    investigation: 'investigation',
    enforceLanguage: 'lang-fix',
};

const VALIDATION_SCHEMAS: Partial<Record<RequestType, z.ZodTypeAny>> = {
    commitMessage: commitMessageSchema,
    summary: evidenceSummaryResponseSchema,
    draft: classifyAndDraftResponseSchema,
    fix: validateAndFixResponseSchema,
    ragRerank: ragRerankResponseSchema,
    enforceLanguage: factAwareCommitMessageSchema,
};

/**
 * Request types whose schema is built per request and passed through
 * `LLMRunOptions.validationSchema`. Listing them here is what turns a missing
 * schema into a configuration error instead of a silently unconstrained JSON
 * request: these stages have no meaningful behaviour without their contract.
 */
const REQUEST_SCOPED_SCHEMAS = new Set<RequestType>(['investigationPlan']);

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

/** True when the request type is only valid with a caller-supplied schema. */
export function requiresRequestScopedSchema(reqType?: string): boolean {
    return Boolean(reqType) && REQUEST_SCOPED_SCHEMAS.has(reqType as RequestType);
}
