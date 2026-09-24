import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { migrateGenerationModeSetting } from '../../../services/router/generationModeMigration';

interface Write {
    key: string;
    value: unknown;
    target: vscode.ConfigurationTarget;
}

/**
 * The rename (`onePrompt`→`fast`, `chain`→`deep`) has to be invisible to users: their stored value
 * keeps working, and VS Code stops flagging it as "not accepted" in the settings editor. These tests
 * pin the three properties that matter — the write happens, it happens at the level that owns the
 * value, and a read-only settings file never breaks activation.
 */
describe('generation mode migration', () => {
    afterEach(() => sinon.restore());

    it('rewrites a legacy global value to its new name', async () => {
        const writes = stubConfiguration({ globalValue: 'onePrompt' });
        await migrateGenerationModeSetting();
        assert.deepEqual(writes, [
            { key: 'generationMode', value: 'fast', target: vscode.ConfigurationTarget.Global },
        ]);
    });

    it('writes at the level that actually holds the legacy value', async () => {
        // A workspace setting must not be promoted to a global one just because it needed renaming.
        const writes = stubConfiguration({ globalValue: 'auto', workspaceValue: 'chain' });
        await migrateGenerationModeSetting();
        assert.deepEqual(writes, [
            { key: 'generationMode', value: 'deep', target: vscode.ConfigurationTarget.Workspace },
        ]);
    });

    it('rewrites every level that holds a legacy value, each in place', async () => {
        // Levels are independent settings, and a stale `onePrompt` left in the global file would come
        // back as an invalid value once the workspace override is removed. Renaming is semantically
        // identity (onePrompt === fast), so normalising all levels cannot change the effective mode.
        const writes = stubConfiguration({
            globalValue: 'onePrompt',
            workspaceValue: 'chain',
            workspaceFolderValue: 'chain',
        });
        await migrateGenerationModeSetting();
        assert.deepEqual(writes, [
            { key: 'generationMode', value: 'deep', target: vscode.ConfigurationTarget.WorkspaceFolder },
            { key: 'generationMode', value: 'deep', target: vscode.ConfigurationTarget.Workspace },
            { key: 'generationMode', value: 'fast', target: vscode.ConfigurationTarget.Global },
        ]);
    });

    it('leaves current values untouched', async () => {
        const writes = stubConfiguration({ globalValue: 'auto', workspaceValue: 'fast', workspaceFolderValue: 'deep' });
        await migrateGenerationModeSetting();
        assert.deepEqual(writes, []);
    });

    it('does not fail activation when the settings file cannot be written', async () => {
        const writes = stubConfiguration({ globalValue: 'chain' }, { failWrites: true });
        await migrateGenerationModeSetting();
        assert.deepEqual(writes, [
            { key: 'generationMode', value: 'deep', target: vscode.ConfigurationTarget.Global },
        ]);
    });

    it('does nothing when the setting was never configured', async () => {
        const writes = stubConfiguration({});
        await migrateGenerationModeSetting();
        assert.deepEqual(writes, []);
    });
});

function stubConfiguration(
    inspected: Record<string, unknown>,
    options: { failWrites?: boolean } = {},
): Write[] {
    const writes: Write[] = [];
    const configuration = {
        inspect: () => inspected,
        update: async (key: string, value: unknown, target: vscode.ConfigurationTarget) => {
            writes.push({ key, value, target });
            if (options.failWrites) {
                throw new Error('read-only settings');
            }
        },
    };
    sinon.stub(vscode.workspace, 'getConfiguration')
        .returns(configuration as unknown as vscode.WorkspaceConfiguration);
    return writes;
}
