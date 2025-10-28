/**
 * File reading tools for repository content access
 * 
 * This module provides utilities to read file content with support for partial
 * reading, enabling LLMs to handle large files by reading them in segments.
 */

import * as fs from 'fs';
import {
    ToolResult,
    ReadFileOptions,
    ReadFileResult
} from './toolTypes';

/**
 * Read file content with support for partial reading
 * 
 * This function enables LLMs to read files efficiently:
 * - Small files: Read entirely in one call
 * - Large files: Read in segments to avoid context overflow
 * 
 * The function always returns metadata about total file size, allowing
 * LLMs to decide whether to read the entire file or process it in chunks.
 * 
 * Default behavior:
 * - Reads up to 1000 lines by default
 * - No upper limit on maxLines (LLM decides)
 * - Returns information about remaining content
 * 
 * @param filePath - Absolute path to the file to read
 * @param options - Optional reading configuration
 * @returns Tool result containing file content and metadata
 * 
 * @example
 * // Read entire small file
 * readFileContent('/repo/config.json')
 * 
 * @example
 * // Read first 1000 lines of large file
 * readFileContent('/repo/large.ts')
 * // Returns: { totalLines: 5000, startLine: 1, endLine: 1000, hasMore: true }
 * 
 * @example
 * // Read next segment
 * readFileContent('/repo/large.ts', { startLine: 1001, maxLines: 1000 })
 * 
 * @example
 * // Read specific range
 * readFileContent('/repo/file.ts', { startLine: 50, maxLines: 100 })
 */
export async function readFileContent(
    filePath: string,
    options?: ReadFileOptions
): Promise<ToolResult<ReadFileResult>> {
    const {
        startLine = 1,
        maxLines = 1000,
        encoding = 'utf-8'
    } = options || {};

    try {
        // Validate file exists
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) {
            return {
                success: false,
                error: `Path is not a file: ${filePath}`
            };
        }

        // Validate line numbers
        if (startLine < 1) {
            return {
                success: false,
                error: 'startLine must be >= 1'
            };
        }

        if (maxLines < 1) {
            return {
                success: false,
                error: 'maxLines must be >= 1'
            };
        }

        // Read file content
        let content: string;
        try {
            content = await fs.promises.readFile(filePath, encoding as BufferEncoding);
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read file',
                warnings: ['File may not be text, may be binary, or encoding is incorrect']
            };
        }

        const lines = content.split('\n');
        const totalLines = lines.length;

        // Calculate actual read range
        const actualStartLine = Math.min(startLine, totalLines);
        const actualEndLine = Math.min(startLine + maxLines - 1, totalLines);
        const hasMore = actualEndLine < totalLines;

        // Extract requested lines (convert to 0-based index)
        const selectedLines = lines.slice(actualStartLine - 1, actualEndLine);
        const resultContent = selectedLines.join('\n');

        const warnings: string[] = [];

        // Add warnings if needed
        if (startLine > totalLines) {
            warnings.push(`Requested startLine (${startLine}) exceeds total lines (${totalLines})`);
        }

        if (maxLines > 10000) {
            warnings.push(`Reading ${maxLines} lines may consume significant context tokens`);
        }

        return {
            success: true,
            data: {
                filePath,
                content: resultContent,
                totalLines,
                startLine: actualStartLine,
                endLine: actualEndLine,
                hasMore
            },
            warnings: warnings.length > 0 ? warnings : undefined
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error reading file'
        };
    }
}