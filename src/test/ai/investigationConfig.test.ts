import { strict as assert } from 'assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'mocha';
import sinon = require('sinon');
import * as vscode from 'vscode';
import {
    DEFAULT_INVESTIGATION_MAX_STEPS,
    MIN_INVESTIGATION_MAX_STEPS,
    resolveInvestigationSettings,
} from '../../services/analysis/change/investigation/config';

describe('investigation settings contract', () => {
    afterEach(() => sinon.restore());

    it('uses the established default for every configured step count below the minimum', () => {
        // Values below three, including non-integers and non-finite numbers, must resolve to the default without disabling generic zero-step runtimes.
        let configuredSteps: unknown = 0;
        sinon.stub(vscode.workspace, 'getConfiguration').returns({
            get<T>(key: string, defaultValue: T): T {
                return (key === 'maxSteps' ? configuredSteps : defaultValue) as T;
            },
        } as vscode.WorkspaceConfiguration);

        for (const value of [0, 1, 2, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            configuredSteps = value;
            assert.equal(resolveInvestigationSettings().maxSteps, DEFAULT_INVESTIGATION_MAX_STEPS, String(value));
        }
    });

    it('accepts the minimum and larger integral investigation budgets', () => {
        // The resolver must accept the exact minimum and valid larger integers while preserving unrelated configuration defaults.
        let configuredSteps: unknown = MIN_INVESTIGATION_MAX_STEPS;
        sinon.stub(vscode.workspace, 'getConfiguration').returns({
            get<T>(key: string, defaultValue: T): T {
                if (key === 'maxSteps') {
                    return configuredSteps as T;
                }
                if (key === 'enabled') {
                    return false as T;
                }
                return defaultValue;
            },
        } as vscode.WorkspaceConfiguration);

        assert.equal(resolveInvestigationSettings().maxSteps, MIN_INVESTIGATION_MAX_STEPS);
        assert.equal(resolveInvestigationSettings().enabled, false);
        configuredSteps = 40;
        assert.equal(resolveInvestigationSettings().maxSteps, 40);
    });

    it('keeps the manifest minimum synchronized with the resolver contract', () => {
        // The published VS Code setting must reject the same values that the runtime resolver rejects.
        const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as {
            contributes: { configuration: { properties: Record<string, { minimum?: number }> } };
        };
        assert.equal(
            packageJson.contributes.configuration.properties['gitCommitGenie.chain.investigation.maxSteps'].minimum,
            MIN_INVESTIGATION_MAX_STEPS,
        );
    });
});
