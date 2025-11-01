/**
 * Context compression tools for managing LLM context limits
 * 
 * This module provides intelligent compression capabilities to help manage
 * conversation context and prevent token limit overflow. It uses LLM-based
 * compression to create meaningful summaries while preserving important information.
 */

import { z } from 'zod';
import {
    ToolResult,
    CompressContextOptions,
    CompressContextResult
} from './toolTypes';
import { ChatMessage } from '../../llm/llmTypes';
import { compressionResponseSchema } from '../../llm/providers/schemas/common';

/**
 * Interface for LLM chat function dependency injection
 */
export interface CompressionChatFnResult {
    parsedResponse?: any;
    usage?: any;
    parsedAssistantResponse?: ChatMessage;
}

export interface CompressionChatFn {
    (messages: ChatMessage[]): Promise<CompressionChatFnResult>;
}

/**
 * Compress context using LLM-based intelligent summarization
 * 
 * This function uses an LLM to intelligently compress conversation history,
 * analysis results, or any text content to fit within context limits while
 * preserving the most important information.
 * 
 * Target: 40-60% size reduction while keeping core concepts.
 * 
 * @param content - Content to compress (conversation history, analysis results, etc.)
 * @param chatFn - LLM chat function for performing compression
 * @param options - Compression configuration
 * @returns Tool result containing compressed content and metadata
 * 
 * @example
 * // Compress conversation history
 * compressContext(conversationHistory, chatFn, {
 *   preserveStructure: true
 * })
 * 
 * @example
 * // Compress with target token count
 * compressContext(analysisResults, chatFn, {
 *   targetTokens: 500
 * })
 */
export async function compressContext(
    content: string,
    chatFn: CompressionChatFn,
    options: CompressContextOptions & { maxRetries?: number } = {}
): Promise<ToolResult<CompressContextResult>> {
    const {
        targetTokens,
        preserveStructure = true,
        language
    } = options;

    try {
        if (!content || content.trim().length === 0) {
            return {
                success: false,
                error: 'Content to compress cannot be empty'
            };
        }

        const originalSize = content.length;

        // Build compression prompt
        const prompt = buildCompressionPrompt(
            content,
            targetTokens,
            preserveStructure,
            language
        );

        // Call LLM to perform compression
        const validationSchema = compressionResponseSchema;
        const maxRetries = Math.max(1, options.maxRetries ?? 2);

        let msgs: ChatMessage[] = [
            { role: 'system', content: 'You are an expert at compressing and summarizing information while preserving essential meaning and context. Your goal is to compress the content window for an AI agent. IMPORTANT: Return ONLY a strict JSON object of the form { "compressed_content": string } with the compressed text. Do NOT include extra fields, code fences, markdown wrappers, or explanations.' },
            { role: 'user', content: prompt }
        ];

        const allUsages: any[] = [];

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            let result: CompressionChatFnResult | undefined;
            try {
                result = await chatFn(msgs);
            } catch (e: any) {
                const em = String(e?.message || '').toLowerCase();
                const looksLikeJsonParseErr = em.includes('json') || em.includes('parse') || em.includes('unexpected token') || em.includes('after json');
                if (looksLikeJsonParseErr && attempt < maxRetries - 1) {
                    const jsonSchemaString = JSON.stringify(z.toJSONSchema(validationSchema), null, 2);
                    msgs = [
                        ...msgs,
                        { role: 'user', content: `Your previous response was not valid JSON. Respond with STRICT JSON only matching this schema: ${jsonSchemaString}. Do not include any markdown or explanation.` }
                    ];
                    continue;
                }
                throw e;
            }

            if (Array.isArray(result?.usage)) {
                for (const u of result!.usage) { allUsages.push(u); }
            } else if (result?.usage) {
                allUsages.push(result.usage);
            }

            const safe = validationSchema.safeParse(result?.parsedResponse);
            if (safe.success) {
                let cleanedCompressed = String(safe.data.compressed_content || '').trim();

                // Minimal guard: if model expands, keep original to avoid bloat
                let compressedSize = cleanedCompressed.length;
                if (compressedSize >= originalSize) {
                    cleanedCompressed = content;
                    compressedSize = originalSize;
                }
                const compressionRatio = 1 - (compressedSize / originalSize);

                const summary = generateCompressionSummary(
                    originalSize,
                    compressedSize,
                    preserveStructure
                );

                return {
                    success: true,
                    data: {
                        compressed: cleanedCompressed,
                        originalSize,
                        compressedSize,
                        compressionRatio,
                        summary
                    },
                    usage: allUsages
                };
            }

            if (attempt < maxRetries - 1) {
                try {
                    const jsonSchemaString = JSON.stringify(z.toJSONSchema(validationSchema), null, 2);
                    const assistantEcho: ChatMessage = result?.parsedAssistantResponse || {
                        role: 'assistant',
                        content: result?.parsedResponse ? JSON.stringify(result.parsedResponse) : ''
                    };
                    msgs = [
                        ...msgs,
                        assistantEcho,
                        {
                            role: 'user',
                            content: `The previous response did not conform to the required format, the zod error is ${safe.error}. Please try again and ensure the response matches the specified JSON format: ${jsonSchemaString}.`
                        }
                    ];
                    continue;
                } catch {
                    // Fall through
                }
            }

            return { success: false, error: 'Compression response failed validation after retries', usage: allUsages };
        }

        return { success: false, error: 'Compression validation loop terminated unexpectedly', usage: allUsages };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error compressing context'
        };
    }
}

/**
 * Build compression prompt
 */
function buildCompressionPrompt(
    content: string,
    targetTokens?: number,
    preserveStructure?: boolean,
    language?: string
): string {
    const parts: string[] = [];

    // Add compression instructions
    parts.push(
        'Compress the following content by summarizing details.',
        'Keep core concepts, important decisions, and key findings.',
        'Remove examples unless they are crucial for understanding.',
        'Focus on the most relevant information.',
        'Do NOT add new information or expand descriptions.',
        'Output MUST be strictly shorter than the input (fewer characters).'
    );

    // Add structure preservation instruction
    if (preserveStructure) {
        parts.push(
            '',
            'Preserve the logical structure and organization of the content.',
            'Maintain clear sections and hierarchical relationships.'
        );
    }

    // Add language-specific instructions
    if (language) {
        parts.push(
            '',
            `The content contains ${language} code.`,
            'When compressing code, focus on:',
            '- Keep function/class signatures and their purposes',
            '- Summarize implementation details',
            '- Preserve important logic and algorithms',
            '- Remove boilerplate and repetitive patterns'
        );
    }

    // Add target token guidance
    if (targetTokens) {
        parts.push(
            '',
            `Target output: approximately ${targetTokens} tokens (rough estimate: ${Math.floor(targetTokens * 4)} characters).`,
            'If needed to satisfy brevity, prefer concise wording and remove redundancies.'
        );
    }

    // Add content and output contract reminder
    parts.push(
        '',
        '---',
        '',
        'Content to compress:',
        '',
        content,
        '',
        '---',
        '',
        'Return only a strict JSON object: { "compressed_content": string }. No code fences or commentary.'
    );

    return parts.join('\n');
}

/**
 * Generate a summary of the compression operation
 */
function generateCompressionSummary(
    originalSize: number,
    compressedSize: number,
    preserveStructure: boolean
): string {
    const delta = compressedSize - originalSize;
    const pct = originalSize > 0 ? Math.abs((delta / originalSize) * 100) : 0;
    const pctText = `${pct.toFixed(1)}%`;

    const changed = delta === 0
        ? `No size change (${originalSize} chars)`
        : delta < 0
            ? `Reduced from ${originalSize} to ${compressedSize} characters (${pctText} reduction)`
            : `Increased from ${originalSize} to ${compressedSize} characters (${pctText} increase)`;

    const parts: string[] = [changed];

    if (preserveStructure) {
        parts.push('Preserved logical structure');
    }

    parts.push('Summarized details, retained core concepts');

    return parts.join('. ') + '.';
}

/**
 * Check if compression should be triggered
 * 
 * @param contentSize - Size of content in characters
 * @param maxTokens - Maximum allowed tokens
 * @param threshold - Usage threshold to trigger compression (default: 0.9)
 * @returns True if compression should be triggered
 */
export function shouldCompress(
    contentSize: number,
    maxTokens: number,
    threshold: number = 0.9
): boolean {
    // Rough estimate: 4 characters per token
    const estimatedTokens = contentSize / 4;
    const usage = estimatedTokens / maxTokens;

    return usage >= threshold;
}
