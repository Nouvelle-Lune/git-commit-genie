/**
 * Represents the status of a file in the diff.
 */
export type DiffStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked' | 'ignored';

/**
 * A "hunk" is a contiguous block of changes in a diff.
 */
export interface DiffHunk {
  header: string; // The hunk header, e.g., @@ -1,3 +1,9 @@
  content: string; // The actual lines of the hunk
  additions: string[]; // Lines added in this hunk
  deletions: string[]; // Lines removed in this hunk
}

/**
 * Represents the complete, parsed diff for a single file.
 * This is the data contract between the DiffService and the LLMService.
 */
export interface DiffData {
  fileName: string;
  status: DiffStatus;
  diffHunks: DiffHunk[];
  rawDiff: string; // Keep the raw diff for context or fallback
  userPrompt?: string;
}
