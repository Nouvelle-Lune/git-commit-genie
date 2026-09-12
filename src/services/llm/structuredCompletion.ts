import { z } from 'zod';
import { AIMessage, AIRunResponse } from './providers';
import { buildStructuredFieldIssues, formatFieldIssuesForModel } from './structuredFieldIssues';

export type StructuredOutputFailureKind =
    | 'context_exhausted'
    | 'reasoning_exhausted'
    | 'visible_output_exhausted'
    | 'ambiguous_length'
    | 'content_filtered';

export class StructuredOutputTerminatedError extends Error {
    constructor(
        readonly kind: StructuredOutputFailureKind,
        readonly response: AIRunResponse,
        label: string,
    ) {
        super(terminationMessage(kind, label));
        this.name = 'StructuredOutputTerminatedError';
    }
}

/**
 * A response that arrived but failed local schema validation on the final
 * attempt of its own retry budget.
 *
 * `fieldIssueLines` is the same field-level repair list the retry prompt uses.
 * A caller that owns a longer-lived retry loop — the investigation planner
 * spans both schema and contract rejections under one budget — runs this with
 * `maxRetries: 0` and reuses the lines instead of parsing them back out of the
 * message. The message itself is unchanged so existing log text stays stable.
 */
export class StructuredFieldRejectionError extends Error {
    constructor(
        readonly fieldIssueLines: string[],
        message: string,
    ) {
        super(message);
        this.name = 'StructuredFieldRejectionError';
    }
}

/**
 * A response that arrived without any final JSON object, whose termination the
 * provider did not classify as unrecoverable.
 *
 * Typed separately from the transport and budget failures that share this code
 * path because it is the one non-schema failure that asking again can fix: the
 * documented repair is to restate the JSON requirement. A caller that owns its
 * own retry loop has to tell this apart from the failures that will not answer
 * differently the second time.
 */
export class MissingStructuredOutputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MissingStructuredOutputError';
    }
}

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
    /**
     * The retry budget this request belongs to, when a caller owns the loop.
     *
     * Terminal messages name that budget instead of the single request each
     * call performs. Without it, a planner that ran three requests and gave up
     * would report "after 1 attempts", which is the number a reader would use
     * to attribute the failure.
     */
    callerOwnedRetry?: { attempt: number; totalAttempts: number };
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
    // Only the wording of the terminal messages uses this; loop control stays
    // on `totalAttempts`, which this call really does run.
    const reportedTotalAttempts = options.callerOwnedRetry?.totalAttempts ?? totalAttempts;
    let delta = initialMessages;

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        const response = await run(delta);
        const structured = response.structured;
        if (structured === undefined) {
            callbacks?.onMissingStructured?.(attempt + 1, totalAttempts, response);
            const termination = classifyStructuredTermination(response);
            if (termination !== undefined) {
                throw new StructuredOutputTerminatedError(termination, response, label);
            }
            if (attempt < totalAttempts - 1) {
                delta = [{ role: 'user', content: MISSING_STRUCTURED_RETRY }];
                continue;
            }
            throw new MissingStructuredOutputError(
                `Provider returned no structured output for ${label} after ${reportedTotalAttempts} attempts`,
            );
        }

        const parsed = schema.safeParse(structured);
        if (parsed.success) {
            return { data: parsed.data, response };
        }

        callbacks?.onValidationFailed?.(attempt + 1, totalAttempts, response, parsed.error);
        // Field-level feedback exposes the rejected value and the exact local
        // contract. Replaying a serialized ZodError made small models infer the
        // repair and repeatedly return the same invalid enum or oversized array.
        const fieldIssueLines = formatFieldIssuesForModel(buildStructuredFieldIssues(parsed.error, structured));
        if (attempt < totalAttempts - 1) {
            delta = [{
                role: 'user',
                content: [
                    `The previous response failed schema validation for ${label}. Fix exactly these fields:`,
                    ...fieldIssueLines.map(line => `- ${line}`),
                    'Return one complete corrected JSON object matching the requested schema. Do not add markdown or explanation.',
                ].join('\n'),
            }];
            continue;
        }

        throw new StructuredFieldRejectionError(
            fieldIssueLines,
            `Structured result failed local validation for ${label} after ${reportedTotalAttempts} attempts:\n${fieldIssueLines.map(line => `- ${line}`).join('\n')}`,
        );
    }

    throw new Error(`Structured request for ${label} exited retry loop unexpectedly.`);
}

/**
 * Names the provider-side termination that makes a missing JSON object
 * unrecoverable. Shared with the Agent Runtime so a truncated terminal is not
 * reported as a schema problem the model could have avoided.
 */
export function classifyStructuredTermination(response: AIRunResponse): StructuredOutputFailureKind | undefined {
    if (response.stopReason === 'context_window') {
        return 'context_exhausted';
    }
    if (response.stopReason === 'content_filter') {
        return 'content_filtered';
    }
    if (response.stopReason === 'unknown_length') {
        return 'ambiguous_length';
    }
    if (response.stopReason !== 'max_output_tokens') {
        return undefined;
    }

    const reasoningTokens = response.usage?.reasoningTokens;
    const outputTokens = response.usage?.outputTokens;
    const visibleTokens = response.usage?.visibleOutputTokens;
    const reasoningDominated = typeof reasoningTokens === 'number'
        && typeof outputTokens === 'number'
        && reasoningTokens >= outputTokens * 0.8
        && (visibleTokens ?? 0) <= 128;
    if (reasoningDominated || (!response.text.trim() && Boolean(response.reasoning))) {
        return 'reasoning_exhausted';
    }
    return 'visible_output_exhausted';
}

function terminationMessage(kind: StructuredOutputFailureKind, label: string): string {
    switch (kind) {
        case 'context_exhausted':
            return `The ${label} request exhausted the model context window before producing complete JSON.`;
        case 'reasoning_exhausted':
            return `The ${label} request used its output budget on reasoning before producing final JSON. ` +
                'Reasoning tokens count toward the output limit for this provider. Raise gitCommitGenie.chain.contextWindowTokens or lower the thinking level.';
        case 'visible_output_exhausted':
            return `The ${label} response reached the derived output budget before its JSON was complete. ` +
                'Raise gitCommitGenie.chain.contextWindowTokens or reduce the requested result size.';
        case 'ambiguous_length':
            return `The ${label} response ended because of a provider length limit, but the Custom provider did not report whether input context, reasoning, or visible output was exhausted. ` +
                'The request was not retried to avoid duplicate cost. Check the endpoint context window, output limit, and thinking setting.';
        case 'content_filtered':
            return `The ${label} response was stopped by the provider content filter before complete JSON was produced.`;
    }
}
