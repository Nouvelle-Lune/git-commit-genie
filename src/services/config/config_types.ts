/**
 * Defines the structure of the plugin's settings.
 */
export interface PluginSettings {
  /**
   * The currently selected LLM provider.
   */
  provider: string;

  /**
   * Path to the user-defined commit message templates.
   */
  templatesPath: string;

  /**
   * OpenAI model to use when provider is OpenAI.
   */
  openaiModel: string;

  /**
   * DeepSeek model to use when provider is DeepSeek.
   */
  deepseekModel: string;

  /**
   * OpenAI API key stored in VS Code settings.
   */
  openaiApiKey: string;

  /**
   * DeepSeek API key stored in VS Code settings.
   */
  deepseekApiKey: string;
}
