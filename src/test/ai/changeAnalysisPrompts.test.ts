import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    buildChangeExtractionMessages,
    buildInvestigationPlanMessages,
} from '../../services/analysis/change/prompts';
import { ChangeExtraction } from '../../services/analysis/change/types';

describe('change analysis structured output prompts', () => {
    it('does not embed full JSON schema in change extraction prompts', () => {
        const messages = buildChangeExtractionMessages({
            deterministic: {
                changedFiles: [{ path: 'parser.ts', changeType: 'modified' }],
                changedSymbols: [],
                introducedSymbols: [],
                removedSymbols: [],
                changedCalls: [],
                changedConfigs: [],
                changedTypes: [],
                changedDependencies: [],
                declarationHints: [],
            },
            evidencePayload: [{ id: 'D1', diff: '+stable' }],
        });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /provider response schema/);
        assert.doesNotMatch(content, /"changedSymbols":\s*\{/);
        assert.doesNotMatch(content, /"properties":\s*\{/);
    });

    it('does not embed full JSON schema in investigation plan prompts', () => {
        const changeExtraction: ChangeExtraction = {
            changedFiles: [{ path: 'parser.ts', changeType: 'modified' }],
            changedSymbols: [],
            introducedSymbols: [],
            removedSymbols: [],
            changedCalls: [],
            changedConfigs: [],
            changedTypes: [],
            changedDependencies: [],
        };
        const messages = buildInvestigationPlanMessages({ changeExtraction });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /provider response schema/);
        assert.match(content, /Use kind "file" only for a path in changedFiles/);
        assert.match(content, /set file to that same path/);
        assert.doesNotMatch(content, /"targets":\s*\{/);
        assert.doesNotMatch(content, /"properties":\s*\{/);
    });
});
