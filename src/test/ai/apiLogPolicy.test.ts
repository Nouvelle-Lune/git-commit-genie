import * as assert from 'assert';
import { isApiRequestLog } from '../../ui/apiLogPolicy';

describe('API log display policy', () => {
    it('identifies every API request row as transport activity', () => {
        assert.equal(isApiRequestLog({ type: 'apiRequest' }), true);
        assert.equal(isApiRequestLog({ type: 'apiRequest', requestType: 'summary' }), true);
        assert.equal(isApiRequestLog({ type: 'finalResult', requestType: 'draft' }), true);
    });

    it('does not classify ordinary final results as API request rows', () => {
        assert.equal(isApiRequestLog({ type: 'finalResult' }), false);
        assert.equal(isApiRequestLog({ type: 'toolCall' }), false);
    });
});
