import * as vscode from 'vscode';
import { DEFAULT_CHANGE_ANALYSIS_EXCLUDES } from './tools';

export interface InvestigationSettings {
    enabled: boolean;
    maxSteps: number;
    excludePatterns: string[];
}

export const DEFAULT_INVESTIGATION_MAX_STEPS = 12;

export function resolveInvestigationSettings(): InvestigationSettings {
    const config = vscode.workspace.getConfiguration('gitCommitGenie.chain.investigation');
    const configuredSteps = config.get<number>('maxSteps', DEFAULT_INVESTIGATION_MAX_STEPS);
    const userExcludes = config.get<string[]>('excludePatterns', []);

    return {
        enabled: config.get<boolean>('enabled', true),
        maxSteps: Number.isInteger(configuredSteps) && configuredSteps > 0
            ? configuredSteps
            : DEFAULT_INVESTIGATION_MAX_STEPS,
        excludePatterns: Array.from(new Set([
            ...DEFAULT_CHANGE_ANALYSIS_EXCLUDES,
            ...(Array.isArray(userExcludes) ? userExcludes.filter(pattern => typeof pattern === 'string' && pattern.trim()) : []),
        ])),
    };
}
