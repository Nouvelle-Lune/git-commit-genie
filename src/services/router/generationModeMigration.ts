import * as vscode from 'vscode';
import { GenerationMode, migrateGenerationMode } from './generationMode';

const SETTING = 'generationMode';
const SECTION = 'gitCommitGenie';

/**
 * Rewrites a pre-rename `gitCommitGenie.generationMode` value in place.
 *
 * `parseGenerationMode` already understands `onePrompt`/`chain`, so the extension works either way;
 * what this fixes is the settings editor, which validates the stored string against the published
 * `enum` (`auto` | `fast` | `deep`) and would otherwise mark the user's existing configuration as
 * invalid until they re-pick it by hand.
 *
 * Each level is normalised **in place** and independently: a workspace setting is never promoted to a
 * global one, and a lower-priority level is still rewritten, because `onePrompt` left in the global
 * file would resurface as an invalid value the moment the workspace override is removed. The rename is
 * semantically identity, so rewriting it cannot change which mode is in effect.
 *
 * No version key guards this: the check is three reads, the write only happens while a legacy value is
 * actually present, and that converges after one run.
 */
export async function migrateGenerationModeSetting(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(SECTION);
    const inspected = configuration.inspect<unknown>(SETTING);
    if (!inspected) {
        return;
    }

    const levels: Array<[vscode.ConfigurationTarget, unknown]> = [
        [vscode.ConfigurationTarget.WorkspaceFolder, inspected.workspaceFolderValue],
        [vscode.ConfigurationTarget.Workspace, inspected.workspaceValue],
        [vscode.ConfigurationTarget.Global, inspected.globalValue],
    ];
    for (const [target, value] of levels) {
        const migrated: GenerationMode | undefined = migrateGenerationMode(value);
        if (!migrated) {
            continue;
        }
        try {
            await configuration.update(SETTING, migrated, target);
        } catch (error) {
            // A read-only settings file must not break activation: the mode still parses as `fast`/`deep`.
            console.warn(`[Genie] Could not migrate the ${SETTING} setting: ${String(error)}`);
        }
    }
}
