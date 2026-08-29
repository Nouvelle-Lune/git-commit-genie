import { z } from 'zod';
import { AIMessage, AIRunResponse } from './providers';

export type StructuredCompletionRun = (messages: AIMessage[]) => Promise<AIRunResponse>;

export interface StructuredCompletionCallbacks {
    onMissingStructured?: (attempt: number, totalAttempts: number, response: AIRunResponse) => void;
    onValidationFailed?: (
        attempt: number,
        totalAttempts: number,
        response: AIRunResponse,
        error: z.ZodError,
    ) => void;
}

export interface StructuredCompletionOptions<T> {
    run: StructuredCompletionRun;
    schema: z.ZodType<T>;
    initialMessages: AIMessage[];
    maxRetries: number;
    label?: string;
    callbacks?: StructuredCompletionCallbacks;
}

const MISSING_STRUCTURED_RETRY = 'The previous response contained no final JSON object. Return exactly one complete JSON object matching the requested schema. Do not include markdown or explanation.';

/**
 * Runs a provider session with Zod validation and schema-aware retries.
 * JSON extraction failures surface as missing structured output instead of SyntaxError.
 */
export async function runStructuredCompletion<T>(options: StructuredCompletionOptions<T>): Promise<{
    data: T;
    response: AIRunResponse;
}> {
    const { run, schema, initialMessages, maxRetries, label = 'structured response', callbacks } = options;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
        throw new Error(`maxRetries must be a non-negative integer; received ${maxRetries}.`);
    }

    const totalAttempts = maxRetries + 1;
    let delta = initialMessages;

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        const response = await run(delta);
        const structured = response.structured;
        if (structured === undefined) {
            callbacks?.onMissingStructured?.(attempt + 1, totalAttempts, response);
            if (attempt < totalAttempts - 1) {
                delta = [{ role: 'user', content: MISSING_STRUCTURED_RETRY }];
                continue;
            }
            throw new Error(`Provider returned no structured output for ${label} after ${totalAttempts} attempts`);
        }

        const parsed = schema.safeParse(structured);
        if (parsed.success) {
            return { data: parsed.data, response };
        }

        callbacks?.onValidationFailed?.(attempt + 1, totalAttempts, response, parsed.error);
        if (attempt < totalAttempts - 1) {
            delta = [{
                role: 'user',
                content: `The previous response failed schema validation: ${parsed.error}. Return one corrected JSON object matching the requested schema.`,
            }];
            continue;
        }

        throw new Error(`Structured result failed local validation for ${label} after ${totalAttempts} attempts: ${parsed.error}`);
    }

    throw new Error(`Structured request for ${label} exited retry loop unexpectedly.`);
}
