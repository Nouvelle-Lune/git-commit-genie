/**
 * Context compression tools for managing LLM context limits
 * 
 * This module provides intelligent compression capabilities to help manage
 * conversation context and prevent token limit overflow. It uses LLM-based
 * compression to create meaningful summaries while preserving important information.
 */

import {
    ToolResult,
    CompressContextOptions,
    CompressContextResult
} from './toolTypes';
import { ChatMessage } from '../../llm/llmTypes';

/**
 * Interface for LLM chat function dependency injection
 */
export interface CompressionChatFn {
    (messages: ChatMessage[]): Promise<string>;
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
    options: CompressContextOptions = {}
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
        const compressed = await chatFn([
            {
                role: 'system',
                content: 'You are an expert at compressing and summarizing information while preserving essential meaning and context. Your goal is to compress the content window for an AI agent. IMPORTANT: Return ONLY the compressed text content directly, without any JSON formatting, code blocks, or markdown wrappers.'
            },
            {
                role: 'user',
                content: prompt
            }
        ]);

        // Clean up potential markdown code fences or JSON wrappers
        let cleanedCompressed = compressed.trim();

        // Remove markdown code fences if present
        if (cleanedCompressed.startsWith('```')) {
            cleanedCompressed = cleanedCompressed
                .replace(/^```(?:text|markdown|json)?\n?/i, '')
                .replace(/\n?```$/i, '')
                .trim();
        }

        // Remove JSON wrappers if present (e.g., {"compressed": "..."})
        if (cleanedCompressed.startsWith('{') && cleanedCompressed.endsWith('}')) {
            try {
                const parsed = JSON.parse(cleanedCompressed);
                if (typeof parsed.compressed === 'string') {
                    cleanedCompressed = parsed.compressed;
                } else if (typeof parsed.content === 'string') {
                    cleanedCompressed = parsed.content;
                }
            } catch {
                // Not valid JSON, keep as is
            }
        }

        const compressedSize = cleanedCompressed.length;
        const compressionRatio = 1 - (compressedSize / originalSize);

        // Generate summary of what was done
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
            }
        };
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
        'Focus on the most relevant information.'
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
            `Target output: approximately ${targetTokens} tokens (rough estimate: ${Math.floor(targetTokens * 4)} characters).`
        );
    }

    // Add content
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
        'Provide only the compressed version without any preamble or explanation.'
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
    const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    const parts: string[] = [
        `Reduced from ${originalSize} to ${compressedSize} characters (${reduction}% reduction)`
    ];

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
