import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { formatWebviewApiResult } from '../../services/llm/chatWebviewFormatting';

describe('chat webview logging', () => {
    it('wraps repo-analysis tool actions for the legacy Webview formatter', () => {
        const payload = formatWebviewApiResult({
            action: 'tool',
            toolName: 'readFileContent',
            args: { filePath: 'src/index.ts' },
            reason: 'Inspect entry point',
        }, 'repoAnalysisAction');

        assert.deepEqual(payload.result, {
            action: 'tool',
            toolName: 'readFileContent',
            args: { filePath: 'src/index.ts' },
            reason: 'Inspect entry point',
        });
        assert.equal(payload.isFinal, false);
    });

    it('marks repo-analysis finalize actions as final results', () => {
        const payload = formatWebviewApiResult({
            action: 'final',
            final: { summary: 'Done', projectType: 'Library', technologies: ['ts'], insights: ['modular'] },
        }, 'repoAnalysisAction');

        assert.equal((payload.result as { action: string }).action, 'final');
        assert.equal(payload.isFinal, true);
    });

    it('keeps investigation actions in their native shape', () => {
        const action = {
            action: 'tool',
            tool: 'readDefinition',
            reason: 'Find callers',
            symbol: 'foo',
            filePath: null,
            dirPath: null,
            query: null,
            searchType: null,
            useRegex: null,
            startLine: null,
            maxLines: null,
            maxResults: null,
            final: null,
        };
        const payload = formatWebviewApiResult(action, 'investigationAction');
        assert.deepEqual(payload.result, action);
        assert.equal(payload.isFinal, false);
    });

    it('reports empty structured output explicitly', () => {
        const payload = formatWebviewApiResult(undefined, 'draft');
        assert.deepEqual(payload.result, { warning: 'Provider returned empty structured output.' });
        assert.equal(payload.isFinal, false);
    });
});
