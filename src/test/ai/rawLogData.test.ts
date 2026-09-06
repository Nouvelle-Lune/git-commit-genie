import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { StageRawData } from '../../ui/StageNotificationManager';
import { projectLogForWebview, stripRawData } from '../../ui/rawLogData';
import { LogEntry, LogType } from '../../ui/types/messages';

describe('raw Webview log data projection', () => {
    it('removes rawData when the setting is disabled without mutating the source log', () => {
        const rawData: StageRawData = {
            input: { query: 'parse' },
            output: { matches: 2 },
            toolCall: { name: 'searchRepositoryMemory', arguments: { query: 'parse' } },
            toolResult: {
                ok: true,
                rawOutput: '[{"id":"M1"}]',
                modelVisibleOutput: '[{"id":"M1"}]',
                truncated: false,
            },
        };
        const log: LogEntry = {
            id: 'stage-1',
            timestamp: 1,
            type: LogType.ToolCall,
            title: 'Commit stage: memory step',
            content: '{"stage":"memoryStep"}',
            rawData,
        };

        const projected = projectLogForWebview(log, false);

        assert.deepEqual(projected, {
            id: 'stage-1',
            timestamp: 1,
            type: LogType.ToolCall,
            title: 'Commit stage: memory step',
            content: '{"stage":"memoryStep"}',
        });
        assert.deepEqual(log.rawData, rawData);
        assert.deepEqual(stripRawData(log), projected);
    });

    it('keeps the complete raw envelope enabled and leaves the original object unchanged', () => {
        const log: LogEntry = {
            id: 'stage-2',
            timestamp: 2,
            type: LogType.ToolCall,
            title: 'Commit stage: investigation step',
            rawData: {
                input: { changeExtraction: { changedFiles: ['src/parser.ts'] } },
                toolCall: { name: 'readFileContent', arguments: { filePath: 'src/parser.ts', maxLines: 400 } },
                toolResult: {
                    ok: false,
                    rawOutput: 'full output',
                    modelVisibleOutput: 'full output',
                    truncated: false,
                    error: "Tool 'readFileContent' argument 'maxLines' exceeds its grant limit (400).",
                },
            },
        };
        const before = structuredClone(log);

        const projected = projectLogForWebview(log, true);

        assert.deepEqual(projected, before);
        assert.deepEqual(log, before);
        assert.equal(projected.rawData?.toolCall?.name, 'readFileContent');
        assert.equal(projected.rawData?.toolResult?.error?.includes('maxLines'), true);
    });
});
