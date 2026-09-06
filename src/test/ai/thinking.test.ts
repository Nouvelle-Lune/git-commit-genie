import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    AIModelConfig,
    AIModelThinkingMetadata,
    applyAnthropicThinking,
    applyGoogleThinking,
    applyOpenAICompatibleThinking,
    applyOpenAIResponsesThinking,
    CustomProvider,
    getModelThinkingMetadata,
    getSupportedThinkingLevels,
    resolveThinkingConfig,
    ThinkingLevel,
} from '../../services/llm/providers';

function model(
    provider: AIModelConfig['provider'],
    modelId: string,
    metadata?: Partial<AIModelThinkingMetadata>,
): AIModelConfig {
    return {
        id: `${provider}-${modelId}`,
        label: modelId,
        provider,
        model: modelId,
        ...metadata,
    };
}

function settings(
    defaultThinkingLevel: string,
    modelThinkingLevels: Record<string, string> = {},
    thinkingBudgets: Record<string, number> = {},
) {
    return {
        defaultThinkingLevel,
        modelThinkingLevels,
        thinkingBudgets,
    };
}

function assertUnsupportedLevel(
    configured: AIModelConfig,
    level: string,
    supported: readonly string[],
): void {
    assert.throws(
        () => resolveThinkingConfig(configured, settings(level)),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(`Model '${configured.provider}/${configured.model}'`));
            assert.match(error.message, new RegExp(`thinking level '${level}'`));
            assert.match(error.message, new RegExp(`Supported levels: ${supported.join(', ')}`));
            return true;
        },
    );
}

describe('unified native thinking configuration', () => {
    it('keeps an unknown official model closed and fails hard on unsupported levels', () => {
        const configured = model('openai', 'unknown-model');
        const metadata = getModelThinkingMetadata(configured);
        assert.deepEqual(getSupportedThinkingLevels(metadata), ['off']);

        assertUnsupportedLevel(configured, 'high', ['off']);

        const thinking = resolveThinkingConfig(configured, settings('off'));
        const body: Record<string, unknown> = {};
        assert.equal(thinking.reasoning, false);
        assert.equal(thinking.level, 'off');
        applyOpenAIResponsesThinking(body, thinking);
        assert.deepEqual(body, {});
    });

    it('applies the global level to a custom model without model editing', () => {
        const configured = model('custom', 'Qwen3.5-9B');
        const metadata = getModelThinkingMetadata(configured);
        const thinking = resolveThinkingConfig(configured, settings('low'));
        const body: Record<string, unknown> = { temperature: 0.2 };

        assert.deepEqual(getSupportedThinkingLevels(metadata), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
        assert.equal(thinking.reasoning, true);
        assert.equal(thinking.level, 'low');
        applyOpenAICompatibleThinking(body, thinking);
        assert.deepEqual(body, { temperature: 0.2, reasoning_effort: 'low' });
    });

    it('keeps an explicitly unsupported custom model closed', () => {
        const configured = model('custom', 'plain-instruct', { thinkingFormat: 'off' });
        const thinking = resolveThinkingConfig(configured, settings('high'));
        const body: Record<string, unknown> = {};

        assert.equal(thinking.reasoning, false);
        assert.deepEqual(getSupportedThinkingLevels(getModelThinkingMetadata(configured)), ['off']);
        applyOpenAICompatibleThinking(body, thinking);
        assert.deepEqual(body, {});
    });

    it('maps a standard model-level off override through the custom format', () => {
        const configured = model('custom', 'local-model');
        const thinking = resolveThinkingConfig(configured, settings('low', {
            'custom/local-model': 'off',
        }));
        const body: Record<string, unknown> = { temperature: 0.2 };

        assert.equal(thinking.level, 'off');
        assert.equal(thinking.nativeValue, undefined);
        applyOpenAICompatibleThinking(body, thinking);
        assert.deepEqual(body, { temperature: 0.2, reasoning_effort: 'none' });
    });

    it('does not let a stale custom reasoning flag suppress the configured off value', () => {
        const configured = model('custom', 'legacy-local-model', { reasoning: false });
        const thinking = resolveThinkingConfig(configured, settings('off'));
        const body: Record<string, unknown> = {};

        assert.equal(thinking.reasoning, true);
        assert.equal(thinking.level, 'off');
        applyOpenAICompatibleThinking(body, thinking);
        assert.deepEqual(body, { reasoning_effort: 'none' });
    });

    it('passes arbitrary native values from custom model-level overrides', () => {
        const configured = model('custom', 'Qwen3.5-9B');
        const thinking = resolveThinkingConfig(configured, settings('off', {
            'custom/Qwen3.5-9B': 'VERY_HIGH',
        }));
        const body: Record<string, unknown> = { temperature: 0.2 };

        assert.equal(thinking.reasoning, true);
        assert.equal(thinking.level, 'medium');
        assert.equal(thinking.nativeValue, 'VERY_HIGH');
        applyOpenAICompatibleThinking(body, thinking);
        assert.deepEqual(body, { temperature: 0.2, reasoning_effort: 'VERY_HIGH' });
    });

    it('preserves custom native overrides without capability probing or rewrite', () => {
        const configured = model('custom', 'endpoint-model');
        const thinking = resolveThinkingConfig(configured, settings('low', {
            'custom/endpoint-model': 'ULTRA',
        }));

        assert.equal(thinking.nativeValue, 'ULTRA');
        assert.equal(thinking.level, 'medium');
        // resolve must not rewrite the native override even when the endpoint would reject it later
        assert.notEqual(thinking.nativeValue, 'low');
        assert.notEqual(thinking.level, 'off');
    });

    it('rejects arbitrary thinking values for official models', () => {
        assert.throws(
            () => resolveThinkingConfig(model('openai', 'gpt-5.4'), settings('low', {
                'openai/gpt-5.4': 'VERY_HIGH',
            })),
            /Invalid thinking level/,
        );
    });

    it('fails hard when an official model does not support the selected logical level', () => {
        assertUnsupportedLevel(model('openai', 'unknown-model'), 'high', ['off']);
        assertUnsupportedLevel(
            model('openai', 'o3'),
            'off',
            ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        );
        assertUnsupportedLevel(
            model('google', 'gemini-3.1-pro-preview'),
            'off',
            ['minimal', 'low', 'medium', 'high'],
        );
        assertUnsupportedLevel(
            model('google', 'gemini-3.1-pro-preview'),
            'xhigh',
            ['minimal', 'low', 'medium', 'high'],
        );
        assertUnsupportedLevel(
            model('google', 'gemini-3.1-pro-preview'),
            'max',
            ['minimal', 'low', 'medium', 'high'],
        );
        assertUnsupportedLevel(
            model('google', 'gemini-2.5-pro'),
            'off',
            ['low', 'medium', 'high'],
        );
    });

    it('resolves every logical level for OpenAI gpt-5.4 and serializes protocol mappings', () => {
        const configured = model('openai', 'gpt-5.4');
        const expected: Record<ThinkingLevel, string> = {
            off: 'none',
            minimal: 'minimal',
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: 'xhigh',
            max: 'xhigh',
        };
        for (const level of Object.keys(expected) as ThinkingLevel[]) {
            const thinking = resolveThinkingConfig(configured, settings(level));
            assert.equal(thinking.level, level);
            assert.equal(thinking.mappedValue, expected[level]);
            const body: Record<string, unknown> = {};
            applyOpenAIResponsesThinking(body, thinking);
            assert.deepEqual(body, { reasoning: { effort: expected[level] } });
        }
    });

    it('keeps a single-model override exact and never silently raises off', () => {
        const configured = model('openai', 'gpt-5.4');
        const overridden = resolveThinkingConfig(configured, settings('off', {
            'openai/gpt-5.4': 'high',
        }));
        assert.equal(overridden.level, 'high');
        assert.equal(overridden.mappedValue, 'high');

        const off = resolveThinkingConfig(configured, settings('off'));
        assert.equal(off.level, 'off');
        assert.equal(off.mappedValue, 'none');
        const body: Record<string, unknown> = {};
        applyOpenAIResponsesThinking(body, off);
        assert.deepEqual(body, { reasoning: { effort: 'none' } });
    });

    it('serializes Anthropic budgets and removes incompatible sampling controls', () => {
        const configured = model('anthropic', 'claude-opus-4-5');
        const thinking = resolveThinkingConfig(configured, settings('medium'));
        const body: Record<string, unknown> = { max_tokens: 12000, temperature: 0.2 };

        applyAnthropicThinking(body, thinking);
        assert.deepEqual(body, {
            max_tokens: 12000,
            thinking: { type: 'enabled', budget_tokens: 10240 },
        });
        assert.throws(
            () => applyAnthropicThinking({ max_tokens: 4096 }, thinking),
            /must be smaller than the derived output budget/,
        );
    });

    it('serializes explicit off values for supported native adapters', () => {
        const openAIThinking = resolveThinkingConfig(model('openai', 'gpt-5.4'), settings('off'));
        const openAIBody: Record<string, unknown> = {};
        applyOpenAIResponsesThinking(openAIBody, openAIThinking);
        assert.deepEqual(openAIBody, { reasoning: { effort: 'none' } });

        const anthropicThinking = resolveThinkingConfig(model('anthropic', 'claude-opus-4-5'), settings('off'));
        const anthropicBody: Record<string, unknown> = { max_tokens: 4096 };
        applyAnthropicThinking(anthropicBody, anthropicThinking);
        assert.deepEqual(anthropicBody, {
            max_tokens: 4096,
            thinking: { type: 'disabled' },
        });

        const googleThinking = resolveThinkingConfig(model('google', 'gemini-2.5-flash'), settings('off'));
        const googleBody: Record<string, unknown> = { generation_config: {} };
        applyGoogleThinking(googleBody, googleThinking);
        assert.deepEqual(googleBody, { generation_config: { thinking_budget: 0 } });
    });

    it('serializes Google budget and level models for supported levels only', () => {
        const legacyConfigured = model('google', 'gemini-2.5-pro');
        const legacyThinking = resolveThinkingConfig(legacyConfigured, settings('medium', {}, { medium: 12345 }));
        const legacyBody: Record<string, unknown> = { generation_config: {} };
        applyGoogleThinking(legacyBody, legacyThinking);
        assert.deepEqual(legacyBody, { generation_config: { thinking_budget: 12345 } });

        const levelConfigured = model('google', 'gemini-3.1-pro-preview');
        assert.deepEqual(
            getSupportedThinkingLevels(getModelThinkingMetadata(levelConfigured)),
            ['minimal', 'low', 'medium', 'high'],
        );
        const levelThinking = resolveThinkingConfig(levelConfigured, settings('high'));
        const levelBody: Record<string, unknown> = { generation_config: {} };
        applyGoogleThinking(levelBody, levelThinking, levelConfigured.model);
        assert.deepEqual(levelBody, { generation_config: { thinking_level: 'high' } });

        const openAIAlwaysOnConfigured = model('openai', 'o3');
        assert.deepEqual(
            getSupportedThinkingLevels(getModelThinkingMetadata(openAIAlwaysOnConfigured)),
            ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        );
        const openAIAlwaysOnThinking = resolveThinkingConfig(openAIAlwaysOnConfigured, settings('high'));
        const openAIAlwaysOnBody: Record<string, unknown> = {};
        applyOpenAIResponsesThinking(openAIAlwaysOnBody, openAIAlwaysOnThinking);
        assert.deepEqual(openAIAlwaysOnBody, { reasoning: { effort: 'high' } });
    });

    it('serializes OpenAI Responses and OpenAI-compatible Chat Completions reasoning', () => {
        const openAIConfigured = model('openai', 'gpt-5.4');
        const openAIThinking = resolveThinkingConfig(openAIConfigured, settings('high'));
        const openAIBody: Record<string, unknown> = {};
        applyOpenAIResponsesThinking(openAIBody, openAIThinking);
        assert.deepEqual(openAIBody, { reasoning: { effort: 'high' } });

        const customConfigured = model('custom', 'local-reasoning-model');
        const customThinking = resolveThinkingConfig(customConfigured, settings('high'));
        const customBody: Record<string, unknown> = { temperature: 0.2 };
        applyOpenAICompatibleThinking(customBody, customThinking);
        assert.deepEqual(customBody, {
            temperature: 0.2,
            reasoning_effort: 'high',
        });

        const customOffThinking = resolveThinkingConfig(customConfigured, settings('off'));
        const customOffBody: Record<string, unknown> = { temperature: 0.2 };
        applyOpenAICompatibleThinking(customOffBody, customOffThinking);
        assert.deepEqual(customOffBody, {
            temperature: 0.2,
            reasoning_effort: 'none',
        });
    });

    it('serializes Pi boolean and chat-template formats for local endpoints', () => {
        const qwen = model('custom', 'Qwen3.5-9B', { thinkingFormat: 'qwen' });
        const qwenBody: Record<string, unknown> = {};
        applyOpenAICompatibleThinking(qwenBody, resolveThinkingConfig(qwen, settings('low')));
        assert.deepEqual(qwenBody, { enable_thinking: true });

        const qwenOffBody: Record<string, unknown> = {};
        applyOpenAICompatibleThinking(qwenOffBody, resolveThinkingConfig(qwen, settings('off')));
        assert.deepEqual(qwenOffBody, { enable_thinking: false });

        const qwenOverrideBody: Record<string, unknown> = {};
        const qwenOverrideThinking = resolveThinkingConfig(qwen, settings('low', {
            'custom/Qwen3.5-9B': 'off',
        }));
        assert.equal(qwenOverrideThinking.nativeValue, undefined);
        applyOpenAICompatibleThinking(qwenOverrideBody, qwenOverrideThinking);
        assert.deepEqual(qwenOverrideBody, { enable_thinking: false });

        const qwenTemplate = model('custom', 'Qwen3.5-9B-template', {
            thinkingFormat: 'qwen-chat-template',
            thinkingTokenBudgetField: 'thinking_budget',
        });
        const qwenTemplateBody: Record<string, unknown> = {};
        applyOpenAICompatibleThinking(
            qwenTemplateBody,
            resolveThinkingConfig(qwenTemplate, settings('low', {}, { low: 4096 })),
        );
        assert.deepEqual(qwenTemplateBody, {
            chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
            thinking_budget: 4096,
        });
    });

    it('resolves generic template variables and local server budget fields', () => {
        const configured = model('custom', 'local-template', {
            thinkingFormat: 'chat-template',
            chatTemplateKwargs: {
                enable_thinking: { $var: 'thinking.enabled' },
                effort: { $var: 'thinking.effort' },
                budget: { $var: 'thinking.budget', omitWhenOff: true },
                static_value: 'template-v1',
            },
            thinkingTokenBudgetField: 'thinking_token_budget',
        });
        const body: Record<string, unknown> = {};
        applyOpenAICompatibleThinking(body, resolveThinkingConfig(configured, settings('medium')));
        assert.deepEqual(body, {
            chat_template_kwargs: {
                enable_thinking: true,
                effort: 'medium',
                budget: 10240,
                static_value: 'template-v1',
            },
            thinking_token_budget: 10240,
        });

        const offBody: Record<string, unknown> = {};
        applyOpenAICompatibleThinking(offBody, resolveThinkingConfig(configured, settings('off')));
        assert.deepEqual(offBody, {
            chat_template_kwargs: {
                enable_thinking: false,
                effort: 'none',
                static_value: 'template-v1',
            },
        });
    });

    it('serializes the remaining Pi-compatible custom formats', () => {
        const cases: Array<{
            format: NonNullable<AIModelThinkingMetadata['thinkingFormat']>;
            expected: Record<string, unknown>;
        }> = [
            { format: 'deepseek', expected: { thinking: { type: 'enabled' } } },
            { format: 'openrouter', expected: { reasoning: { effort: 'high' } } },
            { format: 'together', expected: { reasoning: { enabled: true } } },
            { format: 'string-thinking', expected: { thinking: 'high' } },
            { format: 'ant-ling', expected: { reasoning: { effort: 'high' } } },
        ];
        for (const { format, expected } of cases) {
            const body: Record<string, unknown> = {};
            applyOpenAICompatibleThinking(
                body,
                resolveThinkingConfig(model('custom', `local-${format}`, { thinkingFormat: format }), settings('high')),
            );
            assert.deepEqual(body, expected);
        }

        const basetenBody: Record<string, unknown> = {};
        applyOpenAICompatibleThinking(
            basetenBody,
            resolveThinkingConfig(model('custom', 'local-baseten', {
                thinkingFormat: 'baseten',
                chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
            }), settings('low')),
        );
        assert.deepEqual(basetenBody, { chat_template_args: { enable_thinking: true } });

        const deepseekOffBody: Record<string, unknown> = {};
        applyOpenAICompatibleThinking(
            deepseekOffBody,
            resolveThinkingConfig(model('custom', 'local-deepseek', { thinkingFormat: 'deepseek' }), settings('off')),
        );
        assert.deepEqual(deepseekOffBody, { thinking: { type: 'disabled' } });
    });

    it('keeps custom native overrides effective across format profiles', () => {
        const configured = model('custom', 'local-qwen', { thinkingFormat: 'qwen' });
        const thinking = resolveThinkingConfig(configured, settings('off', {
            'custom/local-qwen': 'VERY_HIGH',
        }));
        const body: Record<string, unknown> = {};
        applyOpenAICompatibleThinking(body, thinking);
        assert.deepEqual(body, { enable_thinking: true, reasoning_effort: 'VERY_HIGH' });
    });

    it('normalizes reasoning_content from a custom response', async () => {
        const fakeClient = {
            chat: {
                completions: {
                    create: async () => ({
                        choices: [{
                            message: {
                                content: '{"ok":true}',
                                reasoning_content: 'local reasoning',
                                tool_calls: [],
                            },
                        }],
                    }),
                },
            },
        } as any;
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://127.0.0.1:8000/v1' }, fakeClient);
        const response = await provider.createSession({
            model: 'local-model',
            thinking: {
                reasoning: true,
                level: 'low',
                requiresReasoningContentOnAssistantMessages: true,
            },
        }).run({});
        assert.equal(response.reasoning, 'local reasoning');
    });

    it('binds session thinking into the chat request and ignores request-level overrides', async () => {
        let requestBody: Record<string, unknown> | undefined;
        const fakeClient = {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        requestBody = body;
                        return { choices: [{ message: { content: 'ok' } }] };
                    },
                },
            },
        } as any;
        const configured = model('custom', 'Qwen3.5-9B', { thinkingFormat: 'qwen-chat-template' });
        const provider = new CustomProvider({ apiKey: 'test', baseUrl: 'http://127.0.0.1:8000/v1' }, fakeClient);
        const thinking = resolveThinkingConfig(configured, settings('off'));

        await provider.createSession({ model: configured.model, thinking }).run({
            messages: [{ role: 'user', content: 'hello' }],
        });

        assert.deepEqual(requestBody?.chat_template_kwargs, {
            enable_thinking: false,
            preserve_thinking: true,
        });
    });
});
