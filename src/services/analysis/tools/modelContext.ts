/**
 * Centralized model context limits and helpers
 *
 * Provides a single place to maintain model max context sizes and a helper
 * to query limits by function name. This allows analysis and compression
 * logic to make budget decisions consistently.
 */

/**
 * Approximate max context tokens for supported model names.
 * The values are conservative estimates intended for budgeting and trimming.
 */
export const MODEL_MAX_CONTEXT_TOKENS: Record<string, number> = {
  // OpenAI
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
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-7-sonnet-20250219': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-1-20250805': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-sonnet-4-5-20250929': 200_000,
  'claude-opus-4-5-20251101': 200_000,



  // Google Gemini
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-preview-09-2025': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
  'gemini-3-pro-preview': 1_048_576,

  // Qwen
  'qwen3-max': 262_144,
  'qwen3-max-preview': 262_144,
  'qwen3.5-plus': 128_000,
  'qwen3.5-flash': 128_000,
  'qwen-plus': 1_000_000,
  'qwen-plus-latest': 1_000_000,
  'qwen3-coder-plus': 1_000_000,
  'qwen-flash': 1_000_000,
  'qwen3-coder-flash': 1_000_000,

  // GLM
  'glm-5': 128_000,
  'glm-5-turbo': 128_000,
  'glm-4.7': 200_000,
  'glm-4.7-flashx': 200_000,
  'glm-4.7-flash': 200_000,
  'glm-4.5': 128_000,
  'glm-4.5-air': 128_000,

  // Kimi
  'kimi-k2.5': 256_000,
  'kimi-k2': 256_000,
  'kimi-k2-thinking': 256_000,

  // OpenRouter mapped model ids
  'openai/gpt-5.4': 1_050_000,
  'openai/gpt-5.4-mini': 400_000,
  'openai/gpt-5.4-nano': 400_000,
  'openai/gpt-5': 400_000,
  'openai/gpt-5.2': 400_000,
  'openai/gpt-5-mini': 400_000,
  'openai/gpt-5-nano': 400_000,
  'deepseek/deepseek-v4-flash': 1_000_000,
  'deepseek/deepseek-v4-pro': 1_000_000,
  'anthropic/claude-3.5-haiku': 200_000,
  'anthropic/claude-3.5-sonnet': 200_000,
  'anthropic/claude-3.7-sonnet': 200_000,
  'anthropic/claude-sonnet-4': 200_000,
  'anthropic/claude-opus-4': 200_000,
  'anthropic/claude-opus-4.1': 200_000,
  'anthropic/claude-haiku-4.5': 200_000,
  'anthropic/claude-sonnet-4.5': 200_000,
  'anthropic/claude-opus-4.5': 200_000,
  'google/gemini-2.5-flash': 1_048_576,
  'google/gemini-2.5-pro': 1_048_576,
  'google/gemini-3-flash-preview': 1_048_576,
  'google/gemini-3-pro-preview': 1_048_576,
  'qwen/qwen3-max': 262_144,
  'qwen/qwen3-235b-a22b': 128_000,
  'qwen/qwen3.5-flash': 128_000,
  'qwen/qwen-plus': 1_000_000,
  'qwen/qwen3-coder-plus': 1_000_000,
  'qwen/qwen-turbo': 1_000_000,
  'qwen/qwen3-coder-30b-a3b-instruct': 1_000_000,
  'z-ai/glm-5': 128_000,
  'z-ai/glm-5-turbo': 128_000,
  'z-ai/glm-4.7': 200_000,
  'z-ai/glm-4.7-flashx': 200_000,
  'z-ai/glm-4.7-flash': 200_000,
  'z-ai/glm-4.5': 128_000,
  'z-ai/glm-4.5-air': 128_000,
  'moonshotai/kimi-k2.5': 256_000,
  'moonshotai/kimi-k2': 256_000,
  'moonshotai/kimi-k2-thinking': 256_000,
};

/**
 * Default token budgets by function when model is unknown.
 * These are conservative budgets for building prompts.
 */
export const FUNCTION_DEFAULT_BUDGET: Record<string, number> = {
  // Repo-level analysis usually benefits from larger context windows
  repoAnalysis: 120_000,
  // Commit message generation typically uses a smaller budget
  commitMessage: 32_000,
};

/**
 * Get max context tokens for a given function. If a model name is provided
 * and known, returns that model's max context. Otherwise falls back to the
 * function default budget, or a safe global default.
 *
 * @param functionName Logical function name, e.g. 'repoAnalysis', 'commitMessage'
 * @param modelName Optional model name to resolve specific context limits
 */
export function getMaxContextByFunction(functionName: string, modelName?: string): number {
  if (modelName) {
    const byModel = MODEL_MAX_CONTEXT_TOKENS[modelName];
    if (typeof byModel === 'number' && byModel > 0) {
      return byModel;
    }
  }

  const fallback = FUNCTION_DEFAULT_BUDGET[functionName];
  if (typeof fallback === 'number' && fallback > 0) {
    return fallback;
  }

  // Safe global default
  return 64_000;
}

/** Rough character budget estimate for a given token limit. */
export function estimateCharBudget(tokens: number, fraction = 0.6): number {
  // Rough heuristic: ~4 chars per token; keep headroom via fraction
  return Math.floor((tokens * 4) * Math.max(0.1, Math.min(1, fraction)));
}

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
