/**
 * Directory browsing tools for repository exploration
 * 
 * This module provides utilities to navigate and explore repository directory structure,
 * allowing LLMs to understand the organization of files and folders.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    ToolResult,
    DirectoryEntry,
    ListDirectoryOptions,
    ListDirectoryResult
} from './toolTypes';
import { shouldExclude } from './utils';

/**
 * List contents of a directory with configurable depth
 * 
 * This function allows LLMs to explore the repository structure incrementally.
 * By default, it only reads the first level to avoid overwhelming context with
 * large directory trees. LLMs can increase depth or navigate into specific
 * subdirectories as needed.
 * 
 * @param dirPath - Absolute path to the directory to list
 * @param options - Optional configuration for listing behavior
 * @returns Tool result containing directory entries
 * 
 * @example
 * // List root directory (first level only)
 * listDirectory('/path/to/repo')
 * 
 * @example
 * // List with depth of 2
 * listDirectory('/path/to/repo', { depth: 2 })
 * 
 * @example
 * // List specific subdirectory
 * listDirectory('/path/to/repo/src', { depth: 1, excludePatterns: ['*.test.ts'] })
 */
export async function listDirectory(
    dirPath: string,
    options?: ListDirectoryOptions
): Promise<ToolResult<ListDirectoryResult>> {
    const {
        depth = 1,
        excludePatterns = []
    } = options || {};

    try {
        // Verify directory exists
        const stats = await fs.promises.stat(dirPath);
        if (!stats.isDirectory()) {
            return {
                success: false,
                error: `Path is not a directory: ${dirPath}`
            };
        }

        // Recursively collect entries
        const entries = await collectEntries(dirPath, dirPath, depth, excludePatterns, 1);

        return {
            success: true,
            data: {
                dirPath,
                entries,
                totalCount: entries.length
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error listing directory'
        };
    }
}

/**
 * Recursively collect directory entries up to specified depth
 * 
 * @param basePath - Base repository path for calculating relative paths
 * @param currentPath - Current directory being processed
 * @param maxDepth - Maximum depth to traverse
 * @param excludePatterns - Patterns to exclude
 * @param currentDepth - Current depth level
 * @returns Array of directory entries
 */
async function collectEntries(
    basePath: string,
    currentPath: string,
    maxDepth: number,
    excludePatterns: string[],
    currentDepth: number
): Promise<DirectoryEntry[]> {
    const entries: DirectoryEntry[] = [];

    try {
        const items = await fs.promises.readdir(currentPath);

        for (const item of items) {
            const itemPath = path.join(currentPath, item);
            const relativePath = path.relative(basePath, itemPath);

            // Check if item should be excluded
            if (shouldExclude(relativePath, excludePatterns)) {
                continue;
            }

            try {
                const stats = await fs.promises.stat(itemPath);
                const isDirectory = stats.isDirectory();

                const entry: DirectoryEntry = {
                    name: item,
                    type: isDirectory ? 'directory' : 'file',
                    path: relativePath
                };

                // Add file-specific information
                if (!isDirectory) {
                    entry.size = (stats.size / 1024).toString() + 'KB';
                    entry.extension = path.extname(item).toLowerCase();
                }

                entries.push(entry);

                // Recursively process subdirectories if within depth limit
                if (isDirectory && currentDepth < maxDepth) {
                    const subEntries = await collectEntries(
                        basePath,
                        itemPath,
                        maxDepth,
                        excludePatterns,
                        currentDepth + 1
                    );
                    entries.push(...subEntries);
                }
            } catch (error) {
                // Skip items that can't be accessed (permission issues, etc.)
                continue;
            }
        }
    } catch (error) {
        // If we can't read the directory, just return what we have so far
    }

    return entries;
}
