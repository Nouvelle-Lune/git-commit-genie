import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import {
    structuredOutputInstructionBlock,
    structuredOutputPromptInjection,
    toolLoopTerminalPromptInjection,
} from '../../services/llm/structuredOutputPrompt';
import { classifyAndDraftResponseSchema } from '../../services/llm/providers/schemas/common';

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
