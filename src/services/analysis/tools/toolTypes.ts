/**
 * Common types and interfaces for repository analysis tools
 * 
 * These tools are designed to provide LLMs with the ability to explore
 * and understand repository structure and content for better commit message generation.
 */

/**
 * Generic tool result wrapper
 */
export interface ToolResult<T = any> {
    /** Operation success status */
    success: boolean;
    /** Result data */
    data?: T;
    /** Error message if operation failed */
    error?: string;
    /** Warnings encountered during execution */
    warnings?: string[];
}

/**
 * Directory entry information
 */
export interface DirectoryEntry {
    /** Entry name (file or directory name) */
    name: string;
    /** Entry type */
    type: 'file' | 'directory';
    /** Relative path from repository root */
    path: string;
    /** File size in bytes (only for files) */
    size?: number;
    /** File extension (only for files) */
    extension?: string;
}

/**
 * Options for listing directory contents
 */
export interface ListDirectoryOptions {
    /** Directory depth to traverse (default: 1) */
    depth?: number;
    /** Patterns to exclude from results */
    excludePatterns?: string[];
}

/**
 * Result of directory listing operation
 */
export interface ListDirectoryResult {
    /** Directory path that was listed */
    dirPath: string;
    /** List of entries in the directory */
    entries: DirectoryEntry[];
    /** Total number of entries found */
    totalCount: number;
}

/**
 * Options for searching files
 */
export interface SearchFilesOptions {
    /** Search type: by file name or file content */
    searchType: 'name' | 'content';
    /** Whether to use regular expression for matching */
    useRegex?: boolean;
    /** Path to search within (default: repository root) */
    searchPath?: string;
    /** Maximum number of results to return (default: 50) */
    maxResults?: number;
    /** Whether search is case-sensitive (default: false) */
    caseSensitive?: boolean;
    /** Patterns to exclude from search */
    excludePatterns?: string[];
    /** Maximum matches per file for content search (default: 5) */
    maxMatchesPerFile?: number;
    /** Number of context lines to include for content search (default: 2) */
    contextLines?: number;
}

/**
 * Match information for content search
 */
export interface ContentMatch {
    /** Line number where match was found */
    line: number;
    /** Content of the matched line */
    content: string;
    /** Context lines around the match */
    context?: string[];
}

/**
 * Search result for a single file
 */
export interface FileSearchResult {
    /** File path relative to repository root */
    filePath: string;
    /** Matches found in the file (only for content search) */
    matches?: ContentMatch[];
}

/**
 * Result of file search operation
 */
export interface SearchFilesResult {
    /** Search query that was used */
    query: string;
    /** Search type that was performed */
    searchType: 'name' | 'content';
    /** Total number of matches found */
    totalMatches: number;
    /** Array of file search results */
    results: FileSearchResult[];
    /** Whether results were truncated due to limits */
    truncated: boolean;
}

/**
 * Options for reading file content
 */
export interface ReadFileOptions {
    /** Starting line number (default: 1) */
    startLine?: number;
    /** Maximum number of lines to read (default: 1000, no upper limit) */
    maxLines?: number;
    /** File encoding (default: 'utf-8') */
    encoding?: string;
}

/**
 * Result of file content reading operation
 */
export interface ReadFileResult {
    /** File path that was read */
    filePath: string;
    /** File content */
    content: string;
    /** Total number of lines in the file */
    totalLines: number;
    /** Starting line number of the returned content */
    startLine: number;
    /** Ending line number of the returned content */
    endLine: number;
    /** Whether there is more content after the returned portion */
    hasMore: boolean;
}

/**
 * Options for compressing context
 */
export interface CompressContextOptions {
    /** Target token count (optional, for guidance) */
    targetTokens?: number;
    /** Whether to preserve structural information */
    preserveStructure?: boolean;
    /** Programming language of the content (helps with better compression) */
    language?: string;
}

/**
 * Result of context compression operation
 */
export interface CompressContextResult {
    /** Compressed content */
    compressed: string;
    /** Original content size in characters */
    originalSize: number;
    /** Compressed content size in characters */
    compressedSize: number;
    /** Compression ratio (0-1, where 0.5 means 50% reduction) */
    compressionRatio: number;
    /** Summary of what was compressed */
    summary?: string;
}
