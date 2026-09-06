import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import { CustomProvider } from '../../services/llm/providers/custom';
import { classifyAndDraftResponseSchema } from '../../services/llm/providers/schemas/common';

const responseFormat = {
    name: 'draft',
    schema: z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>,
};

const repositoryTool = {
    name: 'readFileContent',
    description: 'Read a repository file.',
    parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
        additionalProperties: false,
    },
};

const terminalJson = '{"type":"fix","scope":null,"breaking":false,"description":"fix parsing","body":null,"footers":[],"notes":null}';

describe('Custom provider response accounting', () => {
    it('passes the component-only draft schema to compatible chat endpoints', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return {
                            choices: [{
                                finish_reason: 'stop',
                                message: {
                                    role: 'assistant',
                                    content: '{"type":"fix","scope":null,"breaking":false,"description":"fix parsing","body":null,"footers":[],"notes":null}',
                                },
                            }],
                        };
                    },
                },
            },
        } as any);

        await provider.createSession({ model: 'local-model' }).run({
            messages: [{ role: 'user', content: 'return draft components' }],
            responseFormat,
        });

        const format = requestBody?.response_format as {
            json_schema: { schema: { properties?: Record<string, unknown> } };
        };
        assert.equal(format.json_schema.schema.properties?.commitMessage, undefined);
        assert.equal(requestBody?.parallel_tool_calls, undefined);
    });

    it('maps an explicit transport retry policy to the SDK request options', async () => {
        const options: Array<Record<string, unknown>> = [];
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (_body: Record<string, unknown>, requestOptions: Record<string, unknown> = {}) => {
                        options.push(requestOptions);
                        return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: terminalJson } }] };
                    },
                },
            },
        } as any);
        const session = provider.createSession({ model: 'local-model' });

        await session.run({ messages: [{ role: 'user', content: 'one paid attempt' }], transportRetries: 0 });
        await session.run({ messages: [{ role: 'user', content: 'ordinary call' }] });

        assert.equal(options[0].maxRetries, 0);
        assert.equal(options[1].maxRetries, undefined);
    });

    it('injects the JSON schema into the prompt when structured output is unsupported', async () => {
        const schema = z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>;
        let requestBody: Record<string, unknown> | undefined;
        let attempts = 0;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        attempts += 1;
                        requestBody = body;
                        if (attempts === 1) {
                            const error = new Error('response_format json_schema is not supported');
                            (error as { status?: number }).status = 400;
                            throw error;
                        }
                        return {
                            choices: [{
                                finish_reason: 'stop',
                                message: {
                                    role: 'assistant',
                                    content: '{"type":"fix","scope":null,"breaking":false,"description":"fix parsing","body":null,"footers":[],"notes":null}',
                                },
                            }],
                        };
                    },
                },
            },
        } as any);

        await provider.createSession({ model: 'local-model' }).run({
            messages: [{ role: 'user', content: 'return draft components' }],
            responseFormat: { name: 'draft', schema },
        });

        assert.equal(attempts, 2);
        assert.equal((requestBody?.response_format as { type?: string })?.type, 'json_object');
        const messages = requestBody?.messages as Array<{ role: string; content: string }>;
        assert.match(messages[0].content, /"type":\s*"object"/);
        assert.match(messages[0].content, /Use the exact camelCase keys/);
    });

    it('appends the JSON schema to an existing system instruction on fallback', async () => {
        const schema = z.toJSONSchema(classifyAndDraftResponseSchema) as Record<string, unknown>;
        let requestBody: Record<string, unknown> | undefined;
        let attempts = 0;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        attempts += 1;
                        requestBody = body;
                        if (attempts === 1) {
                            const error = new Error('response_format json_schema is not supported');
                            (error as { status?: number }).status = 400;
                            throw error;
                        }
                        return {
                            choices: [{
                                finish_reason: 'stop',
                                message: {
                                    role: 'assistant',
                                    content: '{"type":"fix","scope":null,"breaking":false,"description":"fix parsing","body":null,"footers":[],"notes":null}',
                                },
                            }],
                        };
                    },
                },
            },
        } as any);

        const session = provider.createSession({
            model: 'local-model',
            systemInstruction: 'You are a commit message generator.',
        });
        await session.run({
            messages: [{ role: 'user', content: 'return draft components' }],
            responseFormat: { name: 'draft', schema },
        });

        assert.equal(attempts, 2);
        const messages = requestBody?.messages as Array<{ role: string; content: string }>;
        assert.equal(messages.length, 2);
        assert.match(messages[0].content, /You are a commit message generator\./);
        assert.match(messages[0].content, /"type":\s*"object"/);
        assert.equal(messages[1].role, 'user');
    });

    it('keeps tool turns unconstrained while retaining tools and parses terminal JSON locally', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return {
                            choices: [{
                                finish_reason: 'stop',
                                message: {
                                    role: 'assistant',
                                    content: terminalJson,
                                },
                            }],
                        };
                    },
                },
            },
        } as any);

        const result = await provider.createSession({ model: 'local-model' }).run({
            messages: [{ role: 'user', content: 'inspect the changed file' }],
            responseFormat,
            tools: [repositoryTool],
            toolChoice: 'auto',
        });

        assert.equal(requestBody?.response_format, undefined);
        assert.deepEqual(requestBody?.tools, [{
            type: 'function',
            function: repositoryTool,
        }]);
        assert.equal(requestBody?.parallel_tool_calls, false);
        assert.deepEqual(result.structured, JSON.parse(terminalJson));
        assert.match(String((requestBody?.messages as Array<{ role: string; content: string }>)[0].content), /When no further tool call is needed/);
    });

    it('replays an assistant tool call before its matching tool result across two session runs', async () => {
        const requests: Array<Record<string, unknown>> = [];
        let callCount = 0;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requests.push(body);
                        callCount += 1;
                        return callCount === 1
                            ? {
                                choices: [{
                                    finish_reason: 'tool_calls',
                                    message: {
                                        role: 'assistant',
                                        content: null,
                                        tool_calls: [{
                                            id: 'call_read_1',
                                            type: 'function',
                                            function: { name: repositoryTool.name, arguments: '{"filePath":"src/ui/pipelineDisplay.ts"}' },
                                        }],
                                    },
                                }],
                            }
                            : {
                                choices: [{
                                    finish_reason: 'stop',
                                    message: { role: 'assistant', content: terminalJson },
                                }],
                            };
                    },
                },
            },
        } as any);
        const session = provider.createSession({
            model: 'local-model',
            systemInstruction: 'Investigate the repository.',
        });

        const first = await session.run({
            messages: [{ role: 'user', content: 'inspect the changed file' }],
            responseFormat,
            tools: [repositoryTool],
            toolChoice: 'auto',
        });
        const second = await session.run({
            responseFormat,
            tools: [repositoryTool],
            toolChoice: 'auto',
            toolResults: [{
                callId: 'call_read_1',
                name: repositoryTool.name,
                output: 'file contents',
            }],
        });

        assert.equal(first.stopReason, 'tool_call');
        assert.deepEqual(second.structured, JSON.parse(terminalJson));
        assert.equal(requests.length, 2);
        for (const request of requests) {
            assert.equal(request.response_format, undefined);
            assert.deepEqual(request.tools, [{ type: 'function', function: repositoryTool }]);
            assert.equal(request.parallel_tool_calls, false);
            const systemContent = String((request.messages as Array<{ role: string; content: string }>)[0].content);
            assert.equal((systemContent.match(/When no further tool call is needed/g) ?? []).length, 1);
        }

        const messages = requests[1].messages as Array<{
            role: string;
            content: string | null;
            tool_call_id?: string;
            tool_calls?: Array<{ id: string }>;
        }>;
        const assistantIndex = messages.findIndex(message => message.role === 'assistant');
        assert.ok(assistantIndex >= 0);
        assert.deepEqual(messages[assistantIndex].tool_calls, [{
            id: 'call_read_1',
            type: 'function',
            function: { name: repositoryTool.name, arguments: '{"filePath":"src/ui/pipelineDisplay.ts"}' },
        }]);
        assert.deepEqual(messages[assistantIndex + 1], {
            role: 'tool',
            content: 'file contents',
            tool_call_id: 'call_read_1',
        });
    });

    it('appends the mixed-mode terminal and single-tool instructions to an existing system prompt', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return {
                            choices: [{
                                finish_reason: 'tool_calls',
                                message: {
                                    role: 'assistant',
                                    content: null,
                                    tool_calls: [{
                                        id: 'call_1',
                                        type: 'function',
                                        function: { name: repositoryTool.name, arguments: '{"filePath":"src/index.ts"}' },
                                    }],
                                },
                            }],
                        };
                    },
                },
            },
        } as any);

        const result = await provider.createSession({
            model: 'local-model',
            systemInstruction: 'You are a repository investigator.',
        }).run({
            messages: [{ role: 'user', content: 'inspect the changed file' }],
            responseFormat,
            tools: [repositoryTool],
            toolChoice: 'required',
        });

        const messages = requestBody?.messages as Array<{ role: string; content: string }>;
        assert.equal(messages[0].role, 'system');
        assert.match(messages[0].content, /You are a repository investigator\./);
        assert.match(messages[0].content, /When no further tool call is needed, return exactly one JSON object/);
        assert.match(messages[0].content, /When calling a tool, return only one tool call and no accompanying text\./);
        assert.match(messages[0].content, /"properties"/);
        assert.equal(result.stopReason, 'tool_call');
        assert.deepEqual(result.toolCalls, [{
            id: 'call_1',
            name: repositoryTool.name,
            arguments: { filePath: 'src/index.ts' },
        }]);
    });

    it('uses strict structured output and omits tools when toolChoice is none', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return {
                            choices: [{
                                finish_reason: 'stop',
                                message: { role: 'assistant', content: terminalJson },
                            }],
                        };
                    },
                },
            },
        } as any);

        const result = await provider.createSession({ model: 'local-model' }).run({
            messages: [{ role: 'user', content: 'return draft components' }],
            responseFormat,
            tools: [repositoryTool],
            toolChoice: 'none',
        });

        const format = requestBody?.response_format as { type: string; json_schema: { strict: boolean } };
        assert.equal(format.type, 'json_schema');
        assert.equal(format.json_schema.strict, true);
        assert.equal(requestBody?.tools, undefined);
        assert.equal(requestBody?.parallel_tool_calls, undefined);
        assert.equal(requestBody?.tool_choice, 'none');
        assert.deepEqual(result.structured, JSON.parse(terminalJson));
        assert.doesNotMatch(String((requestBody?.messages as Array<{ role: string; content: string }>)[0].content), /When no further tool call is needed/);
    });

    it('normalizes reasoning token details and known length termination', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const client = {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return {
                            choices: [{
                                finish_reason: 'length',
                                message: {
                                    role: 'assistant',
                                    content: '{"value":',
                                    reasoning_content: 'thinking',
                                },
                            }],
                            usage: {
                                prompt_tokens: 30,
                                completion_tokens: 100,
                                total_tokens: 130,
                                completion_tokens_details: { reasoning_tokens: 70 },
                            },
                        };
                    },
                },
            },
        } as any;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, client);
        const session = provider.createSession({ model: 'local-model' });

        const result = await session.run({
            messages: [{ role: 'user', content: 'return JSON' }],
            maxOutputTokens: 256,
        });

        assert.equal(requestBody?.max_tokens, 256);
        assert.equal(result.stopReason, 'max_output_tokens');
        assert.equal(result.stopReasonRaw, 'length');
        assert.equal(result.reasoning, 'thinking');
        assert.equal(result.usage?.reasoningTokens, 70);
        assert.equal(result.usage?.visibleOutputTokens, 30);
    });

    it('does not guess the exhausted budget when Custom only reports length', async () => {
        const client = {
            chat: { completions: { create: async () => ({
                choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
            }) } },
        } as any;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, client);
        const result = await provider.createSession({ model: 'local-model' }).run({
            messages: [{ role: 'user', content: 'return JSON' }],
        });

        assert.equal(result.stopReason, 'unknown_length');
    });

    it('serializes session-bound thinking into Chat Completions reasoning_effort', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://localhost:8080/v1' }, {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        bodies.push(body);
                        return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] };
                    },
                },
            },
        } as any);

        await provider.createSession({
            model: 'local-model',
            thinking: { reasoning: true, level: 'high', mappedValue: 'high', format: 'openai', supportsReasoningEffort: true },
        }).run({ messages: [{ role: 'user', content: 'high' }] });

        await provider.createSession({
            model: 'local-model',
            thinking: { reasoning: true, level: 'max', mappedValue: 'xhigh', format: 'openai', supportsReasoningEffort: true },
        }).run({ messages: [{ role: 'user', content: 'max' }] });

        await provider.createSession({
            model: 'local-model',
            thinking: { reasoning: true, level: 'off', mappedValue: 'none', format: 'openai', supportsReasoningEffort: true },
        }).run({ messages: [{ role: 'user', content: 'off' }] });

        assert.equal(bodies[0].reasoning_effort, 'high');
        assert.equal(bodies[1].reasoning_effort, 'xhigh');
        assert.equal(bodies[2].reasoning_effort, 'none');
    });
});
