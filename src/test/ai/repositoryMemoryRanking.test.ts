import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { bm25Scores } from '../../services/memory/ranking';

describe('memory ranking', () => {
    it('scores documents containing all query terms above partial matches', () => {
        const scores = bm25Scores(
            [['repository'], ['repositoryMemory'], ['unrelated']],
            ['Repository-Memory'],
        );

        assert.equal(scores.length, 3);
        assert.ok(scores[1] > scores[0]);
        assert.ok(scores[0] > scores[2]);
        assert.ok(scores.every(score => Number.isFinite(score) && score >= 0));
    });

    it('returns stable zero scores for empty queries and non-matching terms', () => {
        assert.deepEqual(bm25Scores([], ['parser']), []);
        assert.deepEqual(bm25Scores([['parser'], []], []), [0, 0]);
        assert.deepEqual(bm25Scores([['parser'], ['store']], ['network']), [0, 0]);
    });

    it('handles empty documents without producing non-finite scores', () => {
        const scores = bm25Scores([[], ['parser']], ['parser']);

        assert.equal(scores.length, 2);
        assert.equal(scores[0], 0);
        assert.ok(Number.isFinite(scores[1]) && scores[1] > 0);
    });
});
