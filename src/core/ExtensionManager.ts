import * as vscode from 'vscode';
import { ServiceRegistry } from './ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { CommandManager } from '../commands/CommandManager';
import { EventManager } from '../events/EventManager';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { logger } from '../services/logger';
import { costTracker } from '../services/cost';

export class ExtensionManager {
    private serviceRegistry: ServiceRegistry;
    private statusBarManager: StatusBarManager;
    private commandManager: CommandManager;
    private eventManager: EventManager;
    private configManager: ConfigurationManager;

    constructor(private context: vscode.ExtensionContext) {
        this.serviceRegistry = new ServiceRegistry(context);
        this.configManager = new ConfigurationManager(context);
        this.statusBarManager = new StatusBarManager(context, this.serviceRegistry, this.configManager);
        this.commandManager = new CommandManager(context, this.serviceRegistry, this.statusBarManager);
        this.eventManager = new EventManager(context, this.serviceRegistry, this.statusBarManager);
    }

    async activate(): Promise<void> {
        try {
            logger.info('Git Commit Genie is activating...');

            // Initialize cost tracking service
            costTracker.initialize(this.context);

            // Initialize services
            await this.serviceRegistry.initialize();

            // Initialize managers in correct order
            await this.configManager.initialize();
            await this.statusBarManager.initialize();
            await this.commandManager.initialize();
            await this.eventManager.initialize();

            logger.info('Git Commit Genie activated successfully');
        } catch (error) {
            logger.error('Error during extension activation:', error);
            throw error;
        }
    }

    async deactivate(): Promise<void> {
        try {
            logger.info('Git Commit Genie is deactivating...');

            // Cleanup in reverse order
            await this.eventManager.dispose();
            await this.commandManager.dispose();
            await this.statusBarManager.dispose();
            await this.configManager.dispose();
            await this.serviceRegistry.dispose();

            logger.info('Git Commit Genie deactivated successfully');
        } catch (error) {
            logger.error('Error during extension deactivation:', error);
        }
    }
}