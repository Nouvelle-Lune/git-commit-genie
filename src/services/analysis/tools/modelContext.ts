/**
 * Centralized model context limits and token estimation.
 *
 * Provides a single place to maintain model max context sizes and the shared
 * CJK-aware token estimator used by prompt budgeting.
 */

/**
 * Approximate max context tokens for supported model names.
 * The values are conservative estimates intended for budgeting and trimming.
 */
export const MODEL_MAX_CONTEXT_TOKENS: Record<string, number> = {
  // OpenAI
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-5.4': 1_050_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.4-nano': 400_000,
  'gpt-5': 400_000,
  'gpt-5.2': 400_000,
  'gpt-5.2-pro': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 400_000,

  // DeepSeek
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,

  // Anthropic
  'claude-fable-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,

  // Google Gemini
  'gemini-3.6-flash': 1_048_576,
  'gemini-3.5-flash': 1_048_576,
  'gemini-3.1-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-pro': 1_048_576,

  // Qwen
  'qwen3.7-max': 1_000_000,
  'qwen3.7-plus': 1_000_000,
  'qwen3.7-flash': 1_000_000,
  'qwen3.6-flash': 1_000_000,
  'qwen3.5-plus': 1_000_000,
  'qwen3.5-flash': 1_000_000,
  'qwen-plus': 1_000_000,
  'qwen-plus-latest': 1_000_000,
  'qwen-flash': 1_000_000,
  'qwen3-coder-flash': 1_000_000,

  // GLM
  'glm-5.2': 1_000_000,
  'glm-5.1': 200_000,
  'glm-5': 200_000,
  'glm-5-turbo': 200_000,
  'glm-4.7': 200_000,
  'glm-4.7-flashx': 200_000,
  'glm-4.7-flash': 200_000,
  'glm-4.5-air': 128_000,

  // Kimi
  'kimi-k3': 1_000_000,
  'kimi-k2.7-code': 256_000,
  'kimi-k2.6': 256_000,

  // OpenRouter mapped model ids
  'openai/gpt-5.6-sol': 1_050_000,
  'openai/gpt-5.6-terra': 1_050_000,
  'openai/gpt-5.6-luna': 1_050_000,
  'openai/gpt-5.5': 1_050_000,
  'openai/gpt-5.4': 1_050_000,
  'openai/gpt-5.4-mini': 400_000,
  'openai/gpt-5.4-nano': 400_000,
  'openai/gpt-5': 400_000,
  'openai/gpt-5.2': 400_000,
  'openai/gpt-5-mini': 400_000,
  'openai/gpt-5-nano': 400_000,
  'deepseek/deepseek-v4-flash': 1_000_000,
  'deepseek/deepseek-v4-pro': 1_000_000,
  'anthropic/claude-fable-5': 1_000_000,
  'anthropic/claude-opus-5': 1_000_000,
  'anthropic/claude-sonnet-5': 1_000_000,
  'anthropic/claude-opus-4.8': 1_000_000,
  'anthropic/claude-opus-4.7': 1_000_000,
  'anthropic/claude-sonnet-4.6': 1_000_000,
  'anthropic/claude-opus-4.6': 1_000_000,
  'anthropic/claude-haiku-4.5': 200_000,
  'anthropic/claude-sonnet-4.5': 200_000,
  'anthropic/claude-opus-4.5': 200_000,
  'google/gemini-3.6-flash': 1_048_576,
  'google/gemini-3.5-flash': 1_048_576,
  'google/gemini-3.1-pro-preview': 1_048_576,
  'google/gemini-2.5-flash': 1_048_576,
  'google/gemini-2.5-pro': 1_048_576,
  'google/gemini-3-flash-preview': 1_048_576,
  'qwen/qwen3.7-max': 1_000_000,
  'qwen/qwen3.7-plus': 1_000_000,
  'qwen/qwen3.7-flash': 1_000_000,
  'qwen/qwen3.6-flash': 1_000_000,
  'qwen/qwen3.5-plus-20260420': 1_000_000,
  'qwen/qwen3.5-flash-02-23': 1_000_000,
  'qwen/qwen-plus': 1_000_000,
  'z-ai/glm-5.2': 1_000_000,
  'z-ai/glm-5.1': 200_000,
  'z-ai/glm-5': 200_000,
  'z-ai/glm-5-turbo': 200_000,
  'z-ai/glm-4.7': 200_000,
  'z-ai/glm-4.7-flash': 200_000,
  'z-ai/glm-4.5-air': 128_000,
  'moonshotai/kimi-k3': 1_000_000,
  'moonshotai/kimi-k2.7-code': 256_000,
  'moonshotai/kimi-k2.6': 256_000,
};

/**
 * Estimate token count using a CJK-aware heuristic.
 *
 * CJK characters are roughly ~1.5 chars/token; ASCII/Latin text ~4 chars/token.
 * Handles CJK Unified Ideographs, Hiragana, Katakana, Hangul Syllables,
 * plus common CJK punctuation/symbols and fullwidth forms.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk / 1.5 + other / 4;
}
