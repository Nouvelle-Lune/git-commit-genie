import { describe, it, beforeEach, afterEach } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { RagRuntimeService } from '../../../services/rag/ragRuntimeService';
import { RepoService } from '../../../services/repo/repo';
import { RAG_EMBEDDING_API_KEY_SECRET } from '../../../services/rag/ragShared';

describe('RagRuntimeService.isRagEnabled', () => {
    let sandbox: sinon.SinonSandbox;
    let context: vscode.ExtensionContext;
    let repoService: RepoService;
    let getConfigurationStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;
    let secretsGetStub: sinon.SinonStub;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        configGetStub = sandbox.stub();
        secretsGetStub = sandbox.stub().resolves('');
        getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: configGetStub,
        } as unknown as vscode.WorkspaceConfiguration);

        context = {
            subscriptions: [],
            secrets: {
                get: secretsGetStub,
                store: sandbox.stub().resolves(),
                delete: sandbox.stub().resolves(),
                onDidChange: sandbox.stub(),
            },
        } as unknown as vscode.ExtensionContext;

        repoService = {
            getRepositoryGitDir: sandbox.stub().resolves('/fake/.git'),
        } as unknown as RepoService;
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('should return true when rag.enabled is true even without embedding credentials', async () => {
        configGetStub.callsFake((section: string, defaultValue: unknown) => {
            if (section === 'enabled') {
                return true;
            }
            return defaultValue;
        });

        const service = new RagRuntimeService(context, repoService);
        const enabled = await service.isRagEnabled();

        assert.strictEqual(enabled, true);
        assert.strictEqual(getConfigurationStub.calledOnceWithExactly('gitCommitGenie.rag'), true);
        assert.strictEqual(configGetStub.calledWith('enabled', false), true);
        assert.strictEqual(secretsGetStub.calledOnceWithExactly(RAG_EMBEDDING_API_KEY_SECRET), true);
    });

    it('should return false when rag.enabled is false even if embedding settings are present', async () => {
        configGetStub.callsFake((section: string, defaultValue: unknown) => {
            if (section === 'enabled') {
                return false;
            }
            if (section === 'embedding.baseUrl') {
                return 'https://embeddings.example.com';
            }
            if (section === 'embedding.model') {
                return 'text-embedding-3-large';
            }
            if (section === 'embedding.dimensions') {
                return 3072;
            }
            if (section === 'embedding.batchSize') {
                return 32;
            }
            return defaultValue;
        });
        secretsGetStub.resolves('secret-key');

        const service = new RagRuntimeService(context, repoService);
        const enabled = await service.isRagEnabled();

        assert.strictEqual(enabled, false);
        assert.strictEqual(configGetStub.calledWith('enabled', false), true);
    });
});
