/**
 * Repository analysis tools for LLM-powered repository understanding
 * 
 * This module provides a collection of tools that enable LLMs to explore,
 * analyze, and understand repository structure and content. These tools are
 * designed to work together to help generate better commit messages by
 * providing comprehensive repository context.
 * 
 * Core Tools:
 * - Directory Tools: Navigate and explore repository structure
 * - Search Tools: Find files and content using patterns or text
 * - File Tools: Read file content with support for partial reading
 * - Compression Tools: Intelligently compress context to manage token limits
 * - Utilities: Helper functions for common operations
 * 
 * Design Philosophy:
 * - LLM-driven: Let the LLM decide what to read and how to explore
 * - Context-aware: All tools consider token limits and provide metadata
 * - Flexible: Support for incremental exploration and partial reads
 * - Simple: Minimal API surface, maximum utility
 */

export * from './toolTypes';
export * from './directoryTools';
export * from './searchTools';
export * from './fileTools';
export * from './compressionTools';
export * from './utils';
export * from './modelContext';
