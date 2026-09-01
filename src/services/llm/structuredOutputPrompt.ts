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

/** Injects the JSON Schema into the prompt when structured output is unavailable. */
export function structuredOutputPromptInjection(schema: Record<string, unknown>): string {
    return [
        'Return exactly one JSON object matching this JSON Schema. Use the exact camelCase keys.',
        'Do not add keys, wrap the object, use markdown, or replace primitive values with objects.',
        JSON.stringify(schema, null, 2),
    ].join('\n');
}
