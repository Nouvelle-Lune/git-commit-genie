import { describe, it } from 'mocha';
import * as assert from 'assert';
import { estimateTokens } from '../../services/analysis/tools/modelContext';
import {
    assertChatMessagesWithinTokenBudget,
    estimateChatMessagesTokens,
    resolveChainInputTokenBudget,
} from '../../services/chain/tokenBudget';
import { ChatMessage } from '../../services/llm/llmTypes';

describe('Thinking token budget', () => {
    it('reuses the shared CJK-aware token estimator for complete chat messages', () => {
        const messages: ChatMessage[] = [{ role: 'user', content: '修复 parser 的边界条件' }];

        assert.strictEqual(
            estimateChatMessagesTokens(messages),
            Math.ceil(estimateTokens(JSON.stringify(messages)))
        );
    });

    it('accepts custom budgets above 32000 for unregistered models', () => {
        assert.strictEqual(resolveChainInputTokenBudget('local/custom-model', 96_000), 96_000);
    });

    it('rejects a budget above a registered model context limit', () => {
        assert.throws(
            () => resolveChainInputTokenBudget('gpt-5', 400_001),
            /exceeds the registered context limit/
        );
    });

    it('rejects non-positive and fractional budgets', () => {
        assert.throws(() => resolveChainInputTokenBudget('gpt-5', 0), /positive integer/);
        assert.throws(() => resolveChainInputTokenBudget('gpt-5', 4096.5), /positive integer/);
    });

    it('fails before dispatch when a Thinking request exceeds its budget', () => {
        const messages: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];

        assert.throws(
            () => assertChatMessagesWithinTokenBudget(messages, 10, 'draft'),
            /Thinking request 'draft'.*exceeds/
        );
    });
});
