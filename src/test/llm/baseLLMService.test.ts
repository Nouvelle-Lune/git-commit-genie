import { describe, it, beforeEach, afterEach } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { BaseLLMService } from '../../services/llm/baseLLMService';
import { DiffData } from '../../services/git/gitTypes';
import { IRepositoryAnalysisService } from '../../services/analysis/analysisTypes';
import { TemplateService } from '../../template/templateService';

// ============================================================================
// Concrete test subclass of BaseLLMService — exposes buildJsonMessage publicly
// ============================================================================
class TestableLLMService extends BaseLLMService {
    constructor(ctx: vscode.ExtensionContext, templateSvc: TemplateService, analysisSvc?: IRepositoryAnalysisService) {
        super(ctx, templateSvc, analysisSvc);
    }

    // Expose protected method for testing
    public async buildJsonMessage(diffs: DiffData[], targetRepo?: any): Promise<string> {
        return super['buildJsonMessage'](diffs, targetRepo);
    }

    // Expose protected method for stubbing in tests
    public getRepositoryPath(repo?: any): string | null {
        return super['getRepositoryPath'](repo);
    }

    // Abstract method stubs — not used in buildJsonMessage tests
    async refreshFromSettings(): Promise<void> {}
    async validateApiKeyAndListModels(_apiKey: string): Promise<string[]> { return []; }
    listSupportedModels(): string[] { return []; }
    async setApiKey(_apiKey: string): Promise<void> {}
    async clearApiKey(): Promise<void> {}
    async generateCommitMessage(): Promise<any> { return null; }
    getClient(): unknown | null { return null; }
    getUtils(): unknown { return {}; }
    protected getProviderName(): string { return 'TestProvider'; }
    protected getCurrentModel(): string { return 'test-model'; }
}

// ============================================================================
// Helper: create a minimal stub ExtensionContext
// ============================================================================
function createStubContext(): vscode.ExtensionContext {
    return {
        subscriptions: [],
        secrets: { onDidChange: sinon.stub() } as any,
        globalState: { get: sinon.stub().returns(undefined), update: sinon.stub().resolves() } as any,
        workspaceState: { get: sinon.stub().returns(undefined), update: sinon.stub().resolves() } as any,
        extensionUri: vscode.Uri.file('/'),
        extensionPath: '/fake',
        storagePath: '/fake/storage',
        globalStoragePath: '/fake/global-storage',
        logPath: '/fake/log',
        extensionMode: vscode.ExtensionMode.Development,
        environmentVariableCollection: {} as any,
        languageModelAccessInformation: {} as any,
    } as unknown as vscode.ExtensionContext;
}

// ============================================================================
// Helper: create a stub TemplateService
// ============================================================================
function createStubTemplateService(): TemplateService {
    return {
        getActiveTemplate: sinon.stub().returns(''),
    } as unknown as TemplateService;
}

// ============================================================================
// Helper: create stub DiffData
// ============================================================================
function createStubDiffData(): DiffData {
    return {
        fileName: 'test.ts',
        status: 'modified',
        diffHunks: [],
        rawDiff: 'diff content',
    };
}

/**
 * P1-16: buildJsonMessage 对空字符串调 JSON.parse 的修复测试
 *
 * 原 bug：getAnalysisForPrompt 返回空字符串 "" 时，
 * buildJsonMessage 直接调用 JSON.parse("")，每次都会抛出 SyntaxError
 * 然后被 catch 吞并，产生无意义的异常噪音。
 *
 * 修复：在 JSON.parse(repositoryAnalysis) 前添加 if (repositoryAnalysis) 检查。
 */
// ============================================================================
describe('buildJsonMessage — P1-16 empty-string JSON.parse guard', () => {
    let service: TestableLLMService;
    let stubContext: vscode.ExtensionContext;
    let stubTemplateService: TemplateService;
    let getConfigStub: sinon.SinonStub;

    beforeEach(() => {
        stubContext = createStubContext();
        stubTemplateService = createStubTemplateService();

        // Default: mock vscode.workspace.getConfiguration to return a shape
        // with commitLanguage = 'en' so buildJsonMessage completes cleanly
        getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
            get: sinon.stub()
                .withArgs('gitCommitGenie.commitLanguage', 'auto').returns('en')
                .withArgs('enabled', true).returns(false),
        } as any);

        service = new TestableLLMService(stubContext, stubTemplateService);
    });

    afterEach(() => {
        getConfigStub.restore();
        sinon.restore();
    });

    // ========================================================================
    // Happy path
    // ========================================================================
    describe('happy path', () => {
        it('should parse valid JSON from getAnalysisForPrompt and include it in the message', async () => {
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves('{"summary":"test analysis"}'),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            const result = await svc.buildJsonMessage([createStubDiffData()]);
            const parsed = JSON.parse(result);

            assert.deepStrictEqual(parsed['repository-analysis'], { summary: 'test analysis' });
            assert.strictEqual(typeof parsed['repository-analysis'], 'object',
                'parsed repository-analysis should be an object, not a raw string');

            getRepoPathStub.restore();
        });

        it('should include diffs, current-time, and target-language fields', async () => {
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves('{"projectType":"Node.js"}'),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            const result = await svc.buildJsonMessage([createStubDiffData()]);
            const parsed = JSON.parse(result);

            assert.ok(Array.isArray(parsed['diffs']));
            assert.strictEqual(typeof parsed['current-time'], 'string');
            assert.strictEqual(typeof parsed['target-language'], 'string');
            assert.ok(typeof parsed['repository-analysis'] === 'object');

            getRepoPathStub.restore();
        });
    });

    // ========================================================================
    // Error path — the core P1-16 fix
    // ========================================================================
    describe('error path — empty repositoryAnalysis', () => {
        it('should NOT call JSON.parse when getAnalysisForPrompt returns empty string', async () => {
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves(''),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            // JSON.parse('') throws SyntaxError. If the guard is working,
            // this should complete without throwing.
            const result = await svc.buildJsonMessage([createStubDiffData()]);
            const parsed = JSON.parse(result);

            // The repository-analysis field should remain as the empty string
            // (the original unparsed value), not be parsed
            assert.strictEqual(parsed['repository-analysis'], '',
                'empty string should remain as-is, not be JSON.parsed');
            assert.strictEqual(typeof parsed['repository-analysis'], 'string',
                'type should be string, confirming JSON.parse was skipped');

            getRepoPathStub.restore();
        });

        it('should NOT throw when getAnalysisForPrompt returns empty string', async () => {
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves(''),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            // The whole method should complete without throwing
            await assert.doesNotReject(async () => {
                await svc.buildJsonMessage([createStubDiffData()]);
            }, 'buildJsonMessage should not throw when repositoryAnalysis is empty string');

            getRepoPathStub.restore();
        });

        it('should NOT throw when getAnalysisForPrompt returns undefined-like falsy value', async () => {
            // Simulate edge case: getAnalysisForPrompt produces '' explicitly
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves(''),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            // Both the outer catch and the inner guard should prevent anything from blowing up
            await assert.doesNotReject(async () => {
                await svc.buildJsonMessage([createStubDiffData()]);
            });

            getRepoPathStub.restore();
        });
    });

    // ========================================================================
    // Edge cases
    // ========================================================================
    describe('edge cases', () => {
        it('should work when getAnalysisForPrompt returns falsy but not JSON.parsed (whitespace-only string)', async () => {
            // A whitespace-only string is truthy, so the guard lets it through.
            // JSON.parse('   ') throws — but this is a different scenario (malformed).
            // The fix is specifically for empty string; whitespace-only is malformed
            // and will correctly throw. We test that the guard still passes truthy values.
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves('   '),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            // '   ' is truthy, so it passes the guard and JSON.parse throws.
            // This is expected behavior — the guard only prevents empty string parsing.
            await assert.rejects(
                async () => await svc.buildJsonMessage([createStubDiffData()]),
                (err: any) => err instanceof SyntaxError,
                'whitespace-only string should still throw SyntaxError since it passes the truthy guard'
            );

            getRepoPathStub.restore();
        });

        it('should handle no analysisService (optional dependency)', async () => {
            // analysisService is optional; when absent, repositoryAnalysis stays ''
            const svc = new TestableLLMService(stubContext, stubTemplateService, undefined);
            const getRepoPathStub = sinon.stub(svc, 'getRepositoryPath').returns('/test-repo');

            const result = await svc.buildJsonMessage([createStubDiffData()]);
            const parsed = JSON.parse(result);

            assert.strictEqual(parsed['repository-analysis'], '',
                'no analysisService means repositoryAnalysis defaults to empty string');
            assert.strictEqual(typeof parsed['repository-analysis'], 'string');

            getRepoPathStub.restore();
        });

        it('should handle null repositoryPath (no active repo)', async () => {
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves('{"should":"not be called"}'),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns(null);
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            // When repoPath is null, getAnalysisForPrompt is never called
            const result = await svc.buildJsonMessage([createStubDiffData()]);
            const parsed = JSON.parse(result);

            assert.strictEqual(parsed['repository-analysis'], '');
            assert.strictEqual(
                (mockAnalysisService.getAnalysisForPrompt as sinon.SinonStub).callCount,
                0,
                'getAnalysisForPrompt should not be called when repositoryPath is null'
            );

            getRepoPathStub.restore();
        });

        it('should handle getAnalysisForPrompt throwing before the guard is reached', async () => {
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().rejects(new Error('network failure')),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            // When getAnalysisForPrompt itself throws, the outer catch resets to ''
            // The JSON.parse guard is never reached, and no SyntaxError is thrown
            const result = await svc.buildJsonMessage([createStubDiffData()]);
            const parsed = JSON.parse(result);

            assert.strictEqual(parsed['repository-analysis'], '',
                'when getAnalysisForPrompt throws, repositoryAnalysis resets to empty string');

            getRepoPathStub.restore();
        });

        it('should handle multiple diffs without issue', async () => {
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves('{"projectType":"multi-diff-test"}'),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);

            const diffs: DiffData[] = [
                { fileName: 'a.ts', status: 'modified', diffHunks: [], rawDiff: 'diff a' },
                { fileName: 'b.ts', status: 'added', diffHunks: [], rawDiff: 'diff b' },
                { fileName: 'c.ts', status: 'deleted', diffHunks: [], rawDiff: 'diff c' },
            ];

            const result = await svc.buildJsonMessage(diffs);
            const parsed = JSON.parse(result);

            assert.strictEqual(parsed['diffs'].length, 3);
            assert.strictEqual(parsed['diffs'][0].fileName, 'a.ts');
            assert.strictEqual(parsed['diffs'][1].fileName, 'b.ts');
            assert.strictEqual(parsed['diffs'][2].fileName, 'c.ts');

            getRepoPathStub.restore();
        });
    });

    // ========================================================================
    // Regression — verify the exact fix is in place
    // ========================================================================
    describe('regression — verify guard exists', () => {
        it('should NOT call JSON.parse when repositoryAnalysis is falsy (direct assertion via spy)', async () => {
            const mockAnalysisService: IRepositoryAnalysisService = {
                getAnalysisForPrompt: sinon.stub().resolves(''),
            } as any;

            const getRepoPathStub = sinon.stub(service, 'getRepositoryPath').returns('/test-repo');
            const parseSpy = sinon.spy(JSON, 'parse');

            const svc = new TestableLLMService(stubContext, stubTemplateService, mockAnalysisService);
            await svc.buildJsonMessage([createStubDiffData()]);

            // The outer JSON.stringify at the end of buildJsonMessage calls JSON.parse on the
            // result, so we need to check if JSON.parse was called with the empty string.
            // Filter calls to find any that pass '' as the first argument.
            const callsWithEmptyString = parseSpy.getCalls().filter(
                call => call.args[0] === ''
            );
            assert.strictEqual(callsWithEmptyString.length, 0,
                'JSON.parse should never be called with empty string argument');

            parseSpy.restore();
            getRepoPathStub.restore();
        });
    });
});
