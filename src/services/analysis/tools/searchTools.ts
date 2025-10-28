/**
 * File search tools for repository exploration
 * 
 * This module provides powerful search capabilities to help LLMs locate files
 * and content within the repository, supporting both name-based and content-based searches.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    ToolResult,
    SearchFilesOptions,
    SearchFilesResult,
    FileSearchResult,
    ContentMatch
} from './toolTypes';
import { shouldExclude } from './utils';

/**
 * Search for files in the repository by name or content
 * 
 * This function provides flexible search capabilities:
 * - Name search: Find files by filename pattern (supports regex)
 * - Content search: Find files containing specific text or patterns **(supports regex)
 * 
 * Results are limited to prevent context overflow, with configurable limits
 * for maximum results and matches per file.
 * 
 * @param repositoryPath - Absolute path to the repository root
 * @param query - Search query (filename pattern or content text)
 * @param options - Search configuration options
 * @returns Tool result containing search results
 * 
 * @example
 * // Search for TypeScript files by name
 * searchFiles('/repo', '*.ts', { searchType: 'name' })
 * 
 * @example
 * // Search for imports using regex
 * searchFiles('/repo', 'import.*from', { 
 *   searchType: 'content',
 *   useRegex: true,
 *   maxResults: 20
 * })
 */
export async function searchFiles(
    repositoryPath: string,
    query: string,
    options: SearchFilesOptions
): Promise<ToolResult<SearchFilesResult>> {
    const {
        searchType,
        useRegex = false,
        searchPath = repositoryPath,
        maxResults = 50,
        caseSensitive = false,
        excludePatterns = [],
        maxMatchesPerFile = 5,
        contextLines = 2
    } = options;

    try {
        // Validate search path
        const stats = await fs.promises.stat(searchPath);
        if (!stats.isDirectory()) {
            return {
                success: false,
                error: `Search path is not a directory: ${searchPath}`
            };
        }

        const results: FileSearchResult[] = [];
        let totalMatches = 0;
        let truncated = false;

        // Create search pattern
        const pattern = useRegex
            ? new RegExp(query, caseSensitive ? '' : 'i')
            : null;
        const searchText = caseSensitive ? query : query.toLowerCase();

        // Perform search
        await searchDirectory(
            repositoryPath,
            searchPath,
            searchType,
            pattern,
            searchText,
            caseSensitive,
            excludePatterns,
            maxResults,
            maxMatchesPerFile,
            contextLines,
            results,
            { totalMatches: 0 }
        );

        totalMatches = results.reduce((sum, r) =>
            sum + (r.matches ? r.matches.length : 1), 0
        );

        truncated = totalMatches >= maxResults;

        return {
            success: true,
            data: {
                query,
                searchType,
                totalMatches,
                results,
                truncated
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error searching files'
        };
    }
}

/**
 * Recursively search directory for matching files
 */
async function searchDirectory(
    repositoryPath: string,
    currentPath: string,
    searchType: 'name' | 'content',
    pattern: RegExp | null,
    searchText: string,
    caseSensitive: boolean,
    excludePatterns: string[],
    maxResults: number,
    maxMatchesPerFile: number,
    contextLines: number,
    results: FileSearchResult[],
    counter: { totalMatches: number }
): Promise<void> {
    // Stop if we've reached the limit
    if (counter.totalMatches >= maxResults) {
        return;
    }

    try {
        const items = await fs.promises.readdir(currentPath);

        for (const item of items) {
            // Check result limit
            if (counter.totalMatches >= maxResults) {
                break;
            }

            const itemPath = path.join(currentPath, item);
            const relativePath = path.relative(repositoryPath, itemPath);

            // Check exclusions
            if (shouldExclude(relativePath, excludePatterns)) {
                continue;
            }

            try {
                const stats = await fs.promises.stat(itemPath);

                if (stats.isDirectory()) {
                    // Recursively search subdirectory
                    await searchDirectory(
                        repositoryPath,
                        itemPath,
                        searchType,
                        pattern,
                        searchText,
                        caseSensitive,
                        excludePatterns,
                        maxResults,
                        maxMatchesPerFile,
                        contextLines,
                        results,
                        counter
                    );
                } else if (stats.isFile()) {
                    // Search this file
                    const match = await searchFile(
                        itemPath,
                        relativePath,
                        searchType,
                        pattern,
                        searchText,
                        caseSensitive,
                        maxMatchesPerFile,
                        contextLines
                    );

                    if (match) {
                        results.push(match);
                        counter.totalMatches += match.matches ? match.matches.length : 1;
                    }
                }
            } catch (error) {
                // Skip files we can't access
                continue;
            }
        }
    } catch (error) {
        // Skip directories we can't read
    }
}

/**
 * Search a single file for matches
 */
async function searchFile(
    filePath: string,
    relativePath: string,
    searchType: 'name' | 'content',
    pattern: RegExp | null,
    searchText: string,
    caseSensitive: boolean,
    maxMatchesPerFile: number,
    contextLines: number
): Promise<FileSearchResult | null> {
    const fileName = path.basename(filePath);

    // Name search
    if (searchType === 'name') {
        const nameToSearch = caseSensitive ? fileName : fileName.toLowerCase();
        const matches = pattern
            ? pattern.test(fileName)
            : nameToSearch.includes(searchText);

        if (matches) {
            return { filePath: relativePath };
        }
        return null;
    }

    // Content search
    if (searchType === 'content') {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            const matches: ContentMatch[] = [];

            for (let i = 0; i < lines.length && matches.length < maxMatchesPerFile; i++) {
                const line = lines[i];
                const lineToSearch = caseSensitive ? line : line.toLowerCase();

                const isMatch = pattern
                    ? pattern.test(line)
                    : lineToSearch.includes(searchText);

                if (isMatch) {
                    const context: string[] = [];

                    // Get context lines
                    if (contextLines > 0) {
                        const startIdx = Math.max(0, i - contextLines);
                        const endIdx = Math.min(lines.length - 1, i + contextLines);

                        for (let j = startIdx; j <= endIdx; j++) {
                            if (j !== i) {
                                context.push(lines[j]);
                            }
                        }
                    }

                    matches.push({
                        line: i + 1, // 1-based line numbers
                        content: line,
                        context: context.length > 0 ? context : undefined
                    });
                }
            }

            if (matches.length > 0) {
                return {
                    filePath: relativePath,
                    matches
                };
            }
        } catch (error) {
            // Skip files we can't read (binary files, permission issues, etc.)
            return null;
        }
    }

    return null;
}
