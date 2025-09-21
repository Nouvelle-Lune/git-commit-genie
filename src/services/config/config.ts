import * as vscode from 'vscode';
import { PluginSettings } from './config_types';

const CONFIG_SECTION = 'gitCommitGenie';

/**
 * Manages reading and writing plugin settings from/to VS Code's configuration.
 */
export class ConfigurationService {
  /**
   * Retrieves the full plugin settings object.
   * @returns {PluginSettings} The current plugin settings.
   */
  public getSettings(): PluginSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      provider: config.get<string>('provider', 'openai'), // Default to 'openai'
      templatesPath: config.get<string>('templatesPath', ''),
      openaiModel: config.get<string>('openaiModel', 'gpt-3.5-turbo'),
      deepseekModel: config.get<string>('deepseekModel', 'deepseek-chat'),
      openaiApiKey: config.get<string>('openaiApiKey') || '',
      deepseekApiKey: config.get<string>('deepseekApiKey') || '',
    };
  }

  /**
   * Saves the provided settings to the workspace configuration.
   * @param {PluginSettings} settings The settings object to save.
   * @returns {Promise<void>}
   */
  public async saveSettings(settings: PluginSettings): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('provider', settings.provider, vscode.ConfigurationTarget.Global);
    await config.update('templatesPath', settings.templatesPath, vscode.ConfigurationTarget.Global);
    await config.update('openaiModel', settings.openaiModel, vscode.ConfigurationTarget.Global);
    await config.update('deepseekModel', settings.deepseekModel, vscode.ConfigurationTarget.Global);
    await config.update('openaiApiKey', settings.openaiApiKey, vscode.ConfigurationTarget.Global);
    await config.update('deepseekApiKey', settings.deepseekApiKey, vscode.ConfigurationTarget.Global);
  }
}
