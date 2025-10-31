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
  'gpt-5': 200_000,
  'gpt-5-mini': 200_000,
  'gpt-5-nano': 200_000,
  'gpt-4.1': 128_000,
  'gpt-4.1-mini': 128_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'o4-mini': 128_000,

  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,

  // Anthropic
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-7-sonnet-20250219': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-1-20250805': 200_000,
  'claude-opus-4-20250514': 200_000,

  // Google Gemini
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.5-flash-preview-09-2025': 1_000_000,
  'gemini-2.5-pro': 1_000_000,

  // Qwen
  'qwen3-max': 128_000,
  'qwen3-max-preview': 128_000,
  'qwen-plus': 128_000,
  'qwen-plus-latest': 128_000,
  'qwen3-coder-plus': 128_000,
  'qwen-flash': 128_000,
  'qwen3-coder-flash': 128_000,
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
