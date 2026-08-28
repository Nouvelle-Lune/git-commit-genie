/**
 * Utility functions for analysis tools
 * 
 * This module provides minimal utility functions needed for the analysis tools.
 * Following the "LLM-driven" design principle, these utilities are kept simple
 * and do not make decisions on behalf of the LLM.
 */

import * as path from 'path';

/**
 * Check if a file or directory path should be excluded based on patterns
 * 
 * Supports glob-like patterns:
 * - Exact match: 'node_modules'
 * - Wildcard: '*.test.ts', 'test/**'
 * - Extension: '.log'
 * 
 * @param filePath - File or directory path to check
 * @param patterns - Array of exclusion patterns
 * @returns True if the path should be excluded
 */
export function shouldExclude(filePath: string, patterns: string[]): boolean {
    if (!patterns || patterns.length === 0) {
        return false;
    }

    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const pattern of patterns) {
        const normalizedPattern = pattern.replace(/\\/g, '/');

        // Exact match
        if (normalizedPath === normalizedPattern) {
            return true;
        }

        // Check if any path segment matches the pattern
        const pathSegments = normalizedPath.split('/');
        if (pathSegments.some(segment => segment === normalizedPattern)) {
            return true;
        }

        // Wildcard pattern matching
        if (pattern.includes('*')) {
            const regex = patternToRegex(normalizedPattern);
            if (regex.test(normalizedPath)) {
                return true;
            }
        }

        // Extension matching
        if (pattern.startsWith('.') && normalizedPath.endsWith(pattern)) {
            return true;
        }

        // Directory pattern (ends with /)
        if (pattern.endsWith('/') && normalizedPath.startsWith(pattern.slice(0, -1))) {
            return true;
        }
    }

    return false;
}

/**
 * Convert a glob-like pattern to a regular expression
 * 
 * @param pattern - Glob pattern
 * @returns Regular expression for matching
 */
function patternToRegex(pattern: string): RegExp {
    // Escape special regex characters except * and ?
    let regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

    return new RegExp(`^${regexPattern}$`);
}
