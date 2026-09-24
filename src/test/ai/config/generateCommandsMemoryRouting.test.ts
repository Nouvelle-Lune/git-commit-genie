import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { GenerateCommands } from '../../../commands/GenerateCommands';
import type { ServiceRegistry } from '../../../core/ServiceRegistry';
import type { StatusBarManager } from '../../../ui/StatusBarManager';
import { RepositoryMemoryService } from '../../../services/memory/service';
import type { AIModelConfig } from '../../../services/llm/providers';
import type { LLMService } from '../../../services/llm/llmTypes';
import type { RepositorySnapshotReader } from '../../../services/git/repositorySnapshot';

const REPOSITORY_PATH = '/tmp/generate-commands-memory-routing';

describe('GenerateCommands memory routing', () => {
    afterEach(() => sinon.restore());

    it('calls memory prepare and lets gitCommitGenie.memory.enabled decide while ignoring residual chain keys', async () => {
        // The command entry point must prepare memory unconditionally, let RepositoryMemoryService return undefined when memory is disabled, and never read the removed chain gate.
        const reads: ConfigurationRead[] = [];
        stubWorkspaceConfiguration(reads);
        const context = makeContext();
        const memoryService = new RepositoryMemoryService(context);
        const prepare = sinon.spy(memoryService, 'prepare');
        const snapshot = { isCurrent: async () => true } as unknown as RepositorySnapshotReader;
        const diff = {
            fileName: 'src/service.ts',
            status: 'modified' as const,
            diffHunks: [],
            rawDiff: 'diff --git a/src/service.ts b/src/service.ts\n+const value = 1;',
        };
        const model: AIModelConfig = {
            id: 'memory-routing-model',
            label: 'Local',
            provider: 'custom',
            model: 'local-model',
            baseUrl: 'http://127.0.0.1:9/v1',
        };
        const repository = {
            rootUri: vscode.Uri.file(REPOSITORY_PATH),
            inputBox: { value: '' },
        };
        let receivedMemoryRun: unknown = Symbol('not-called');
        const llmService = {
            generateCommitMessage: async (_diffs: unknown, options?: { memoryRun?: unknown }) => {
                receivedMemoryRun = options?.memoryRun;
                return { content: 'feat: generated locally' };
            },
        } as unknown as LLMService;
        const registry = {
            getGenerationModel: () => model,
            getMemoryService: () => memoryService,
            getRepoService: () => ({
                getRepositoryByUri: () => repository,
                getActiveRepository: () => repository,
            }),
            getDiffService: () => ({
                captureSnapshot: async () => snapshot,
                getDiff: async () => [diff],
            }),
            getCurrentLLMService: () => llmService,
            getRagRetrievalService: () => ({}),
            getRagHistoricalIndexService: () => ({}),
        } as unknown as ServiceRegistry;
        const handlers = registerCommandHandlers();
        const commands = new GenerateCommands(context, registry, {} as StatusBarManager);

        try {
            await commands.register();
            const handler = handlers.get('git-commit-genie.generateCommitMessage');
            assert.ok(handler, 'Generate command must be registered before invoking the command entry point.');
            await handler();

            assert.equal(prepare.calledOnce, true);
            assert.equal(prepare.firstCall.args[0], snapshot);
            assert.equal(prepare.firstCall.args[1], model.model);
            assert.equal(receivedMemoryRun, undefined);
            assert.equal(repository.inputBox.value, 'feat: generated locally');
            assert.equal(
                reads.some(read => read.section === 'gitCommitGenie.memory' && read.key === 'enabled'),
                true,
                'RepositoryMemoryService.prepare must read its own enabled setting',
            );
            assert.equal(
                reads.some(read => read.section === 'gitCommitGenie.chain' && read.key === 'enabled'),
                false,
                'GenerateCommands must not read the removed gitCommitGenie.chain.enabled gate',
            );
            assert.equal(
                reads.some(read => read.section === 'gitCommitGenie' && read.key === 'useChainPrompts'),
                false,
                'GenerateCommands must not read the removed gitCommitGenie.useChainPrompts setting',
            );
        } finally {
            memoryService.dispose();
        }
    });
});

interface ConfigurationRead {
    section: string | undefined;
    key: string;
}

function makeContext(): vscode.ExtensionContext {
    return {
        subscriptions: [],
        secrets: { get: async () => 'test-key' },
        globalStorageUri: { fsPath: REPOSITORY_PATH },
    } as unknown as vscode.ExtensionContext;
}

function stubWorkspaceConfiguration(reads: ConfigurationRead[]): void {
    sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => ({
        get<T>(key: string, defaultValue?: T): T {
            reads.push({ section, key });
            if (section === 'gitCommitGenie.memory' && key === 'enabled') {
                return false as T;
            }
            if (section === 'gitCommitGenie.chain' && key === 'enabled') {
                return false as T;
            }
            if (section === 'gitCommitGenie' && key === 'useChainPrompts') {
                return true as T;
            }
            if (section === undefined && key === 'gitCommitGenie.chain.enabled') {
                return false as T;
            }
            if (section === undefined && key === 'gitCommitGenie.useChainPrompts') {
                return true as T;
            }
            return defaultValue as T;
        },
    } as vscode.WorkspaceConfiguration));
}

function registerCommandHandlers(): Map<string, (...args: unknown[]) => unknown> {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    sinon.stub(vscode.commands, 'registerCommand').callsFake((command, callback) => {
        handlers.set(command, callback as (...args: unknown[]) => unknown);
        return { dispose: () => undefined };
    });
    sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
    sinon.stub(vscode.window, 'withProgress').callsFake(async (_options, task) => {
        const progress = { report: () => undefined } as vscode.Progress<{ message?: string; increment?: number }>;
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined }),
        } as vscode.CancellationToken;
        return task(progress, token);
    });
    return handlers;
}
