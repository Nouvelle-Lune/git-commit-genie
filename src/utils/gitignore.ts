export const GIT_GENIE_IGNORE_ENTRY = '.gitgenie/**';

/**
 * Builds an idempotent .gitignore section with a blank line boundary.
 *
 * Keeping this formatting in one place prevents repository analysis and
 * workspace templates from producing different ignore-file layouts.
 *
 * @param existing Existing .gitignore content.
 * @param sectionLabel Human-readable comment for the generated section.
 * @returns Content to append, or null when Git Commit Genie is already ignored.
 */
export function buildGitGenieIgnoreAppend(
    existing: string,
    sectionLabel: string
): string | null {
    const existingEntries = existing
        .split(/\r?\n/)
        .map(line => line.trim());

    if (existingEntries.includes(GIT_GENIE_IGNORE_ENTRY) || existingEntries.includes('.gitgenie/')) {
        return null;
    }

    const lineEnding = existing.includes('\r\n') ? '\r\n' : '\n';
    const section = `# ${sectionLabel}${lineEnding}${GIT_GENIE_IGNORE_ENTRY}${lineEnding}`;

    if (existing.length === 0 || existing.endsWith(`${lineEnding}${lineEnding}`)) {
        return section;
    }
    if (existing.endsWith(lineEnding)) {
        return `${lineEnding}${section}`;
    }
    return `${lineEnding}${lineEnding}${section}`;
}
