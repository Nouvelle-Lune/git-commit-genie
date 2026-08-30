import { AIChatTemplateValue, AIThinkingConfig } from './types';

/** Applies the OpenAI Responses API reasoning object. */
export function applyOpenAIResponsesThinking(
    body: Record<string, unknown>,
    thinking: AIThinkingConfig | undefined,
): void {
    if (!thinking || !thinking.reasoning) {
        return;
    }
    if (thinking.level === 'off' && thinking.nativeValue === undefined && thinking.mappedValue === null) {
        return;
    }
    const effort = thinking.nativeValue ?? thinking.mappedValue ?? (thinking.level === 'off' ? 'none' : thinking.level);
    body.reasoning = { effort };
}

/** Applies Anthropic extended thinking within the caller's hard max_tokens ceiling. */
export function applyAnthropicThinking(
    body: Record<string, unknown>,
    thinking: AIThinkingConfig | undefined,
): void {
    if (!thinking || !thinking.reasoning) {
        return;
    }
    if (thinking.level === 'off' && thinking.nativeValue === undefined && thinking.mappedValue === null) {
        return;
    }
    const nativeValue = thinking.nativeValue ?? thinking.mappedValue ?? thinking.level;
    if (thinking.level === 'off' || nativeValue === 'disabled') {
        body.thinking = { type: 'disabled' };
        return;
    }
    if (thinking.budget === undefined) {
        throw new Error('Anthropic thinking requires a configured token budget.');
    }

    const maxTokens = Number(body.max_tokens ?? 8192);
    if (thinking.budget >= maxTokens) {
        throw new Error(
            `Anthropic thinking budget (${thinking.budget}) must be smaller than the derived output budget (${maxTokens}). ` +
            'Raise gitCommitGenie.chain.contextWindowTokens or lower the thinking level.',
        );
    }
    body.thinking = { type: 'enabled', budget_tokens: thinking.budget };
    // Anthropic extended thinking does not accept sampling controls such as temperature.
    delete body.temperature;
}

/** Applies the Gemini Interactions API thinking level or legacy numeric budget. */
export function applyGoogleThinking(
    body: Record<string, unknown>,
    thinking: AIThinkingConfig | undefined,
    model?: string,
): void {
    if (!thinking || !thinking.reasoning) {
        return;
    }
    if (thinking.level === 'off' && thinking.nativeValue === undefined
        && (thinking.mappedValue === null || thinking.mappedValue === undefined)) {
        applyPiGoogleDisabledThinking(body, model);
        return;
    }
    const nativeValue = thinking.nativeValue ?? thinking.mappedValue ?? thinking.level;

    const generationConfig = body.generation_config as Record<string, unknown>;
    if (thinking.level !== 'off' && thinking.budget !== undefined) {
        generationConfig.thinking_budget = thinking.budget;
        return;
    }
    const numericValue = Number(nativeValue);
    if (nativeValue.trim() !== '' && Number.isInteger(numericValue)) {
        generationConfig.thinking_budget = numericValue;
    } else {
        generationConfig.thinking_level = nativeValue;
    }
}

/** Applies Pi-style thinking formats used by OpenAI Chat Completions-compatible endpoints. */
export function applyOpenAICompatibleThinking(
    body: Record<string, unknown>,
    thinking: AIThinkingConfig | undefined,
): void {
    if (!thinking || !thinking.reasoning) {
        return;
    }

    const enabled = thinking.level !== 'off';
    const format = thinking.format ?? 'openai';
    switch (format) {
        case 'off':
            break;
        case 'zai':
            body.thinking = enabled
                ? { type: 'enabled', clear_thinking: false }
                : { type: 'disabled' };
            if (enabled && allowsReasoningEffort(thinking)) {
                applyReasoningEffort(body, thinking);
            }
            break;
        case 'qwen':
            body.enable_thinking = enabled;
            if (enabled && allowsReasoningEffort(thinking)) {
                applyReasoningEffort(body, thinking);
            }
            break;
        case 'qwen-chat-template':
            body.chat_template_kwargs = {
                enable_thinking: enabled,
                preserve_thinking: true,
            };
            break;
        case 'chat-template': {
            const values = resolveChatTemplateValues(thinking.chatTemplateKwargs, thinking);
            if (values !== undefined) {
                body.chat_template_kwargs = values;
            }
            break;
        }
        case 'baseten': {
            const values = resolveChatTemplateValues(thinking.chatTemplateArgs, thinking);
            if (values !== undefined) {
                body.chat_template_args = values;
            }
            if (allowsReasoningEffort(thinking)) {
                applyReasoningEffort(body, thinking);
            }
            break;
        }
        case 'deepseek':
            if (enabled || canSendOff(thinking)) {
                body.thinking = enabled ? { type: 'enabled' } : { type: 'disabled' };
            }
            if (enabled && allowsReasoningEffort(thinking)) {
                applyReasoningEffort(body, thinking);
            }
            break;
        case 'openrouter':
            if (enabled) {
                const effort = getThinkingEffort(thinking);
                if (effort !== undefined) {
                    body.reasoning = { effort };
                }
            } else if (canSendOff(thinking)) {
                body.reasoning = { effort: getThinkingEffort(thinking) ?? 'none' };
            }
            break;
        case 'ant-ling':
            if (enabled) {
                const effort = getThinkingEffort(thinking);
                if (effort !== undefined) {
                    body.reasoning = { effort };
                }
            }
            break;
        case 'together':
            body.reasoning = { enabled };
            if (enabled && allowsReasoningEffort(thinking)) {
                applyReasoningEffort(body, thinking);
            }
            break;
        case 'string-thinking':
            if (enabled) {
                const effort = getThinkingEffort(thinking);
                if (effort !== undefined) {
                    body.thinking = effort;
                }
            } else if (canSendOff(thinking)) {
                const effort = getThinkingEffort(thinking);
                if (effort !== undefined) {
                    body.thinking = effort;
                }
            }
            break;
        case 'openai':
            if (enabled || canSendOff(thinking)) {
                applyReasoningEffort(body, thinking);
            }
            break;
        default:
            throw new Error(`Unsupported OpenAI-compatible thinking format '${String(format)}'.`);
    }

    // The budget field is independent of thinkingFormat, just as in Pi. It is
    // emitted as a top-level extra body field by the OpenAI SDK.
    if (thinking.thinkingTokenBudgetField !== undefined && thinking.budget !== undefined) {
        body[thinking.thinkingTokenBudgetField] = thinking.budget;
    }
}

function applyReasoningEffort(body: Record<string, unknown>, thinking: AIThinkingConfig): void {
    const effort = getThinkingEffort(thinking);
    if (effort !== undefined) {
        body.reasoning_effort = effort;
    }
}

function allowsReasoningEffort(thinking: AIThinkingConfig): boolean {
    // An explicit custom model-level value is itself an instruction to send the
    // native effort string, unless the model explicitly disables that field.
    return thinking.supportsReasoningEffort === true
        || (thinking.nativeValue !== undefined && thinking.supportsReasoningEffort !== false);
}

function getThinkingEffort(thinking: AIThinkingConfig): string | undefined {
    if (thinking.nativeValue !== undefined) {
        return thinking.nativeValue;
    }
    if (thinking.mappedValue !== undefined && thinking.mappedValue !== null) {
        return thinking.mappedValue;
    }
    return thinking.level === 'off' ? undefined : thinking.level;
}

function canSendOff(thinking: AIThinkingConfig): boolean {
    return thinking.nativeValue !== undefined || thinking.mappedValue !== null;
}

type ResolvedChatTemplateValue = string | number | boolean | null;

function resolveChatTemplateValues(
    values: Record<string, AIChatTemplateValue> | undefined,
    thinking: AIThinkingConfig,
): Record<string, ResolvedChatTemplateValue> | undefined {
    if (values === undefined) {
        return undefined;
    }

    const resolved: Record<string, ResolvedChatTemplateValue> = {};
    for (const [key, value] of Object.entries(values)) {
        if (value === null || typeof value !== 'object') {
            resolved[key] = value;
            continue;
        }
        if (thinking.level === 'off' && value.omitWhenOff) {
            continue;
        }
        switch (value.$var) {
            case 'thinking.enabled':
                resolved[key] = thinking.level !== 'off';
                break;
            case 'thinking.effort': {
                const effort = getThinkingEffort(thinking);
                if (effort !== undefined) {
                    resolved[key] = effort;
                }
                break;
            }
            case 'thinking.budget':
                if (thinking.budget !== undefined) {
                    resolved[key] = thinking.budget;
                }
                break;
            default:
                throw new Error(`Unsupported chat template thinking variable '${String(value.$var)}'.`);
        }
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function applyPiGoogleDisabledThinking(body: Record<string, unknown>, model?: string): void {
    const generationConfig = body.generation_config as Record<string, unknown>;
    const modelId = model?.toLowerCase() ?? '';
    if (/gemini-3(?:\.\d+)?-pro/.test(modelId)) {
        generationConfig.thinking_level = 'LOW';
        return;
    }
    if (/gemini-3(?:\.\d+)?-flash/.test(modelId)) {
        generationConfig.thinking_level = 'MINIMAL';
        return;
    }
    generationConfig.thinking_budget = 0;
}
