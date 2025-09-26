// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import { ExtensionManager } from './core/ExtensionManager';
import { logger } from './services/logger';

let extensionManager: ExtensionManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	try {
		extensionManager = new ExtensionManager(context);
		await extensionManager.activate();
	} catch (error) {
		logger.error('Failed to activate Git Commit Genie:', error);
		throw error;
	}
}

// This method is called when extension is deactivated
export async function deactivate(): Promise<void> {
	try {
		if (extensionManager) {
			await extensionManager.deactivate();
		}
		logger.dispose();
	} catch (error) {
		logger.error('Error during deactivation:', error);
	}
}