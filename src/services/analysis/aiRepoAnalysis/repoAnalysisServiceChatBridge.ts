/**
 * Provider-agnostic chat bridge for tool-driven repository analysis
 * 
 * This module offers a minimal wrapper around LLM provider SDKs to send
 * single-turn JSON or text chats. It does NOT decide provider/model; the
 * caller must pass both. API keys are fetched through ProviderConfig-defined
 * secret keys in VS Code SecretStorage.
 */

import * as vscode from 'vscode';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

import { ChatMessage } from '../../llm/llmTypes';
import { getProviderSecretKey } from '../../llm/providers/config/ProviderConfig';

const DEEPSEEK_API_URL = 'https://api.deepseek.com';
const QWEN_API_URL_CHINA = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_API_URL_INTL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

export class RepoAnalysisServiceChatBridge {
  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Single-turn JSON chat. Expects a strict JSON object in the assistant output.
   * 
   * @param provider - Provider key (e.g., 'openai' | 'deepseek' | 'qwen' | 'anthropic' | 'gemini')
   * @param model - Model name configured for repo analysis
   * @param messages - Chat turns with roles 'system' | 'user' | 'assistant'
   * @param opts - Optional execution controls (cancellation token, token budget, region for Qwen)
   * @returns Parsed JSON object from the assistant message
   * 
   * @example
   * chatJson('openai', 'gpt-4.1-mini', [
   *   { role: 'system', content: 'Return JSON only' },
   *   { role: 'user', content: '{"action":"ping"}' }
   * ])
   */
  public async chatJson(provider: string, model: string, messages: ChatMessage[], opts?: { token?: vscode.CancellationToken; region?: 'china' | 'intl' }): Promise<any> {
    switch (provider.toLowerCase()) {
      case 'openai':
        return await this.openAIJson(messages, model, opts);
      case 'deepseek':
        return await this.deepseekJson(messages, model, opts);
      case 'qwen':
        return await this.qwenJson(messages, model, opts?.region);
      case 'anthropic':
        return await this.anthropicJson(messages, model, opts);
      case 'gemini':
        return await this.geminiJson(messages, model, opts);
      default:
        return await this.openAIJson(messages, model, opts);
    }
  }

  /**
   * Single-turn text chat.
   * 
   * @param provider - Provider key (e.g., 'openai' | 'deepseek' | 'qwen' | 'anthropic' | 'gemini')
   * @param model - Model name configured for repo analysis
   * @param messages - Chat turns with roles 'system' | 'user' | 'assistant'
   * @param opts - Optional execution controls (cancellation token, token budget, region for Qwen)
   * @returns Assistant message content as plain text
   * 
   * @example
   * chatText('deepseek', 'deepseek-chat', [
   *   { role: 'system', content: 'Return a short sentence' },
   *   { role: 'user', content: 'hello' }
   * ])
   */
  public async chatText(provider: string, model: string, messages: ChatMessage[], opts?: { token?: vscode.CancellationToken; region?: 'china' | 'intl' }): Promise<string> {
    switch (provider.toLowerCase()) {
      case 'openai':
        return await this.openAIText(messages, model, opts);
      case 'deepseek':
        return await this.deepseekText(messages, model, opts);
      case 'qwen':
        return await this.qwenText(messages, model, opts?.region);
      case 'anthropic':
        return await this.anthropicText(messages, model, opts);
      case 'gemini':
        return await this.geminiText(messages, model, opts);
      default:
        return await this.openAIText(messages, model, opts);
    }
  }

  // -------------------------- Provider implementations --------------------------

  /**
   * OpenAI JSON chat using Chat Completions API with response_format=json_object
   */
  private async openAIJson(messages: ChatMessage[], model: string, _opts?: { token?: vscode.CancellationToken }): Promise<any> {
    const secretKey = getProviderSecretKey('openai');
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('OpenAI API key missing'), { statusCode: 401 }); }
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model,
      messages,
      temperature: this.getTemperature(),
      response_format: { type: 'json_object' }
    });
    const text = res.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text);
  }

  /**
   * OpenAI text chat using Chat Completions API
   */
  private async openAIText(messages: ChatMessage[], model: string, _opts?: { token?: vscode.CancellationToken }): Promise<string> {
    const secretKey = getProviderSecretKey('openai');
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('OpenAI API key missing'), { statusCode: 401 }); }
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({ model, messages, temperature: this.getTemperature() });
    return res.choices?.[0]?.message?.content || '';
  }

  /**
   * DeepSeek JSON chat via OpenAI-compatible endpoint
   */
  private async deepseekJson(messages: ChatMessage[], model: string, _opts?: { token?: vscode.CancellationToken }): Promise<any> {
    const secretKey = getProviderSecretKey('deepseek');
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('DeepSeek API key missing'), { statusCode: 401 }); }
    const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL });
    const res = await client.chat.completions.create({
      model,
      messages,
      temperature: this.getTemperature(),
      response_format: { type: 'json_object' }
    });
    const text = res.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text);
  }

  /**
   * DeepSeek text chat via OpenAI-compatible endpoint
   */
  private async deepseekText(messages: ChatMessage[], model: string, _opts?: { token?: vscode.CancellationToken }): Promise<string> {
    const secretKey = getProviderSecretKey('deepseek');
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('DeepSeek API key missing'), { statusCode: 401 }); }
    const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL });
    const res = await client.chat.completions.create({ model, messages, temperature: this.getTemperature() });
    return res.choices?.[0]?.message?.content || '';
  }

  /**
   * Qwen JSON chat via OpenAI-compatible endpoint
   */
  private async qwenJson(messages: ChatMessage[], model: string, region: 'china' | 'intl' = 'intl', _opts?: { token?: vscode.CancellationToken }): Promise<any> {
    const secretKey = getProviderSecretKey('qwen', region);
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('Qwen API key missing'), { statusCode: 401 }); }
    const baseURL = region === 'china' ? QWEN_API_URL_CHINA : QWEN_API_URL_INTL;
    const client = new OpenAI({ apiKey, baseURL });
    const res = await client.chat.completions.create({
      model,
      messages,
      temperature: this.getTemperature(),
      response_format: { type: 'json_object' }
    });
    const text = res.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text);
  }

  /**
   * Qwen text chat via OpenAI-compatible endpoint
   */
  private async qwenText(messages: ChatMessage[], model: string, region: 'china' | 'intl' = 'intl', _opts?: { token?: vscode.CancellationToken }): Promise<string> {
    const secretKey = getProviderSecretKey('qwen', region);
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('Qwen API key missing'), { statusCode: 401 }); }
    const baseURL = region === 'china' ? QWEN_API_URL_CHINA : QWEN_API_URL_INTL;
    const client = new OpenAI({ apiKey, baseURL });
    const res = await client.chat.completions.create({ model, messages, temperature: this.getTemperature() });
    return res.choices?.[0]?.message?.content || '';
  }

  /**
   * Anthropic Messages API JSON-like chat (parsed from response text)
   */
  private async anthropicJson(messages: ChatMessage[], model: string, _opts?: { token?: vscode.CancellationToken }): Promise<any> {
    const secretKey = getProviderSecretKey('anthropic');
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('Anthropic API key missing'), { statusCode: 401 }); }
    const client = new Anthropic({ apiKey });
    // Anthropic Messages API doesn't enforce json_object; instruct in prompt
    const { system, rest } = this.splitSystem(messages);
    const resp = await client.messages.create({
      model,
      system: system || undefined,
      messages: rest as any,
      // Do not cap output tokens here; rely on provider defaults
      temperature: this.getTemperature()
    } as any);
    const text = (resp.content?.[0] as any)?.text || '';
    return JSON.parse(this.extractFirstJson(text));
  }

  /**
   * Anthropic Messages API text chat
   */
  private async anthropicText(messages: ChatMessage[], model: string, _opts?: { token?: vscode.CancellationToken }): Promise<string> {
    const secretKey = getProviderSecretKey('anthropic');
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('Anthropic API key missing'), { statusCode: 401 }); }
    const client = new Anthropic({ apiKey });
    const { system, rest } = this.splitSystem(messages);
    const resp = await client.messages.create({
      model,
      system: system || undefined,
      messages: rest as any,
      // Do not cap output tokens here; rely on provider defaults
      temperature: this.getTemperature()
    } as any);
    return (resp.content?.[0] as any)?.text || '';
  }

  /**
   * Gemini GenerateContent with responseMimeType=application/json
   */
  private async geminiJson(messages: ChatMessage[], model: string, _opts?: any): Promise<any> {
    const secretKey = getProviderSecretKey('gemini');
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('Gemini API key missing'), { statusCode: 401 }); }
    const client = new GoogleGenAI({ apiKey });
    const modelClient: any = (client as any).getGenerativeModel({ model });
    const contents = this.toGeminiContents(messages, true);
    const result = await modelClient.generateContent({ contents, generationConfig: { responseMimeType: 'application/json' } });
    const text = result?.response?.text?.() || result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return JSON.parse(this.extractFirstJson(typeof text === 'function' ? text() : text));
  }

  /**
   * Gemini GenerateContent returning plain text
   */
  private async geminiText(messages: ChatMessage[], model: string, _opts?: any): Promise<string> {
    const secretKey = getProviderSecretKey('gemini');
    const apiKey = await this.context.secrets.get(secretKey);
    if (!apiKey) { throw Object.assign(new Error('Gemini API key missing'), { statusCode: 401 }); }
    const client = new GoogleGenAI({ apiKey });
    const modelClient: any = (client as any).getGenerativeModel({ model });
    const contents = this.toGeminiContents(messages, false);
    const result = await modelClient.generateContent({ contents });
    const txtFn = (result?.response as any)?.text;
    return typeof txtFn === 'function' ? txtFn.call(result.response) : (result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '');
  }

  // -------------------------- helpers --------------------------

  private splitSystem(messages: ChatMessage[]): { system: string | null; rest: any[] } {
    const systemMsg = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    return { system: systemMsg?.content || null, rest };
  }

  private toGeminiContents(messages: ChatMessage[], includeSystemInFirstUser: boolean): any[] {
    const contents: any[] = [];
    let systemText = '';
    for (const m of messages) {
      if (m.role === 'system') { systemText += (m.content + '\n'); continue; }
      if (m.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: m.content }] });
      } else {
        const text = (includeSystemInFirstUser && systemText) ? `SYSTEM:\n${systemText}\nUSER:\n${m.content}` : m.content;
        contents.push({ role: 'user', parts: [{ text }] });
        systemText = '';
      }
    }
    return contents;
  }

  private extractFirstJson(text: string): string {
    if (!text) { return '{}'; }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) { return text.slice(start, end + 1); }
    return text;
  }

  /**
   * Read temperature from user settings.
   */
  private getTemperature(): number {
    try {
      const cfg = vscode.workspace.getConfiguration();
      const v = cfg.get<number>('gitCommitGenie.llm.temperature');
      if (typeof v === 'number' && !isNaN(v)) { return v; }
      return 0.2;
    } catch {
      return 0.2;
    }
  }
}
