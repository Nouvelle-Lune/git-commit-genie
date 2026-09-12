const STRUCTURED_OUTPUT_INSTRUCTIONS = [
    'Return exactly one JSON object matching the provider response schema.',
    'Use the exact camelCase keys.',
    'Do not add keys, wrap the object, use markdown, or replace primitive values with objects.',
].join('\n');

/** Prompt contract for structured output when the provider enforces the schema via responseFormat. */
export function structuredOutputInstructionBlock(): string {
    return [
        '<schema>',
        STRUCTURED_OUTPUT_INSTRUCTIONS,
        '</schema>',
    ].join('\n');
}

/**
 * Injects the JSON Schema into the prompt when structured output is unavailable.
 *
 * Minified on purpose: a request-scoped schema can carry one required property
 * per diff hunk, and pretty-printing it cost roughly 2.4x its size on every
 * request. The injection is a fallback contract for endpoints that enforce
 * `response_format` loosely, so it has to stay complete — it just does not have
 * to be indented.
 */
export function structuredOutputPromptInjection(schema: Record<string, unknown>): string {
    return [
        'Return exactly one JSON object matching this JSON Schema. Use the exact camelCase keys.',
        'Do not add keys, wrap the object, use markdown, or replace primitive values with objects.',
        JSON.stringify(schema),
    ].join('\n');
}

/** Describes the terminal JSON without constraining an earlier native tool call. */
export function toolLoopTerminalPromptInjection(schema: Record<string, unknown>): string {
    return [
        'When no further tool call is needed, return exactly one JSON object matching this JSON Schema.',
        'Use the exact camelCase keys. Do not add keys, wrap the object, use markdown, or replace primitive values with objects.',
        'When calling a tool, return only one tool call and no accompanying text.',
        JSON.stringify(schema, null, 2),
    ].join('\n');
}
