import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import {
    structuredOutputInstructionBlock,
    structuredOutputPromptInjection,
    toolLoopTerminalPromptInjection,
} from '../../services/llm/structuredOutputPrompt';
import {
    classifyAndDraftResponseSchema,
    createInvestigationPlanResponseSchema,
} from '../../services/llm/providers/schemas/common';

/** The shipped repository tool budget; the plan schema needs it to size its target array. */
const MAX_TOOL_CALLS = 4;

describe('structured output prompt helpers', () => {
    it('builds a schema-free instruction block for provider-enforced response formats', () => {
        const block = structuredOutputInstructionBlock();

        assert.match(block, /<schema>/);
        assert.match(block, /provider response schema/);
        assert.match(block, /Use the exact camelCase keys/);
        assert.doesNotMatch(block, /"properties"/);
        assert.doesNotMatch(block, /"type":\s*"object"/);
    });

    it('injects the full JSON schema for prompt-only fallback paths', () => {
        const schema = z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>;
        const injection = structuredOutputPromptInjection(schema);

        assert.match(injection, /matching this JSON Schema/);
        assert.match(injection, /"type":\s*"object"/);
        assert.match(injection, /"description"/);
        assert.match(injection, /"footers"/);
        assert.doesNotMatch(injection, /provider response schema/);
    });

    it('injects the fallback schema as one compact JSON line with no pretty-print indentation', () => {
        // The fallback contract must stay complete and parseable while the pretty-printed form is gone: the
        // schema line has to parse back to the schema object, and no line of the injection may be indented.
        const schema = z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>;
        const injection = structuredOutputPromptInjection(schema);
        const schemaLine = injection.split('\n').at(-1)!;

        assert.deepEqual(JSON.parse(schemaLine), schema);
        assert.doesNotMatch(injection, /\n\s/);
    });

    it('keeps a request-scoped injection well below the pretty-printed size of the same schema', () => {
        // The planner schema grows by one required coverage key per hunk; compacting the injection is what
        // keeps the fallback contract affordable at 80 D* ids, where pretty-printing costs over twice as much.
        const diffEvidenceIds = Array.from({ length: 80 }, (_, index) => `D${index + 1}`);
        const schema = z.toJSONSchema(
            createInvestigationPlanResponseSchema(diffEvidenceIds, MAX_TOOL_CALLS),
        ) as Record<string, unknown>;
        const injection = structuredOutputPromptInjection(schema);
        const prettyBytes = JSON.stringify(schema, null, 2).length;

        assert.deepEqual(JSON.parse(injection.split('\n').at(-1)!), schema);
        assert.ok(
            injection.length < prettyBytes * 0.5,
            `Injection of ${injection.length} chars must stay below half the ${prettyBytes}-char pretty schema.`,
        );
    });

    it('describes the terminal JSON boundary and single-call tool-turn contract', () => {
        const schema = z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>;
        const injection = toolLoopTerminalPromptInjection(schema);

        assert.match(injection, /When no further tool call is needed, return exactly one JSON object/);
        assert.match(injection, /When calling a tool, return only one tool call and no accompanying text\./);
        assert.match(injection, /"type":\s*"object"/);
        assert.match(injection, /"description"/);
        assert.match(injection, /"footers"/);
        assert.doesNotMatch(injection, /provider response schema/);
    });
});
