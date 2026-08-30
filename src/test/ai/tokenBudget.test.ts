import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    ChainTokenBudgetConflictError,
    InputContextBudgetExceededError,
    OUTPUT_TOKEN_FRACTION,
    assertChatMessagesWithinTokenBudget,
    deriveMaxOutputTokens,
    resolveChainTokenBudget,
} from '../../services/llm/inputTokenBudget';

describe('chain token budget', () => {
    it('starts compaction at 80 percent and targets 90 percent of the trigger', () => {
        const budget = resolveChainTokenBudget({
            provider: 'openai',
            model: 'unknown-openai-model',
            contextWindowTokens: 32_000,
        });

        assert.equal(budget.safetyTokens, 1_600);
        assert.equal(budget.maxOutputTokens, 7_600);
        assert.equal(budget.hardInputTokens, 22_800);
        assert.equal(budget.compressionTriggerTokens, 22_800);
        assert.equal(budget.compressionTargetTokens, 20_520);
    });

    it('reserves output and safety inside one shared context window', () => {
        const budget = resolveChainTokenBudget({
            provider: 'openai',
            model: 'unknown-openai-model',
            contextWindowTokens: 24_576,
        });

        assert.equal(budget.effectiveContextTokens, 24_576);
        assert.equal(budget.safetyTokens, 1_229);
        assert.equal(budget.maxOutputTokens, 5_836);
        assert.equal(budget.hardInputTokens, 17_511);
        assert.equal(budget.compressionTriggerTokens, 17_511);
        assert.equal(budget.compressionTargetTokens, 15_759);
        assert.equal(budget.outputAccounting, 'shared');
    });

    it('reserves Gemini thinking separately from visible output', () => {
        const budget = resolveChainTokenBudget({
            provider: 'google',
            model: 'unknown-gemini-model',
            contextWindowTokens: 32_000,
            thinking: { reasoning: true, level: 'low', budget: 4_096 },
        });

        assert.equal(budget.outputAccounting, 'separate');
        assert.equal(budget.estimatedThinkingTokens, 4_096);
        assert.equal(budget.maxOutputTokens, 6_576);
        assert.equal(budget.hardInputTokens, 19_728);
    });

    it('scales output with large context windows instead of hard-capping it', () => {
        const budget = resolveChainTokenBudget({
            provider: 'custom',
            model: 'local-200k',
            contextWindowTokens: 200_000,
        });

        assert.equal(budget.safetyTokens, 10_000);
        assert.equal(budget.maxOutputTokens, 47_500);
        assert.equal(budget.hardInputTokens, 142_500);
        assert.equal(
            budget.maxOutputTokens,
            Math.floor((200_000 - budget.safetyTokens) * OUTPUT_TOKEN_FRACTION),
        );
    });

    it('keeps the configured Custom window authoritative', () => {
        const budget = resolveChainTokenBudget({
            provider: 'custom',
            model: 'gpt-5.4',
            contextWindowTokens: 24_576,
        });

        assert.equal(budget.effectiveContextTokens, 24_576);
        assert.equal(budget.maxOutputTokens, 5_836);
    });

    it('derives output from the remaining window after safety and input reserve', () => {
        assert.equal(deriveMaxOutputTokens(688), 256);
        assert.equal(deriveMaxOutputTokens(30_400), 7_600);
    });

    it('raises a typed error when a complete request exceeds safe input capacity', () => {
        const budget = resolveChainTokenBudget({
            provider: 'custom',
            model: 'local',
            contextWindowTokens: 2_048,
        });
        assert.throws(
            () => assertChatMessagesWithinTokenBudget([
                { role: 'user', content: 'x'.repeat(20_000) },
            ], budget, 'draft'),
            InputContextBudgetExceededError,
        );
    });

    it('clamps known provider models to the smaller registered context', () => {
        const budget = resolveChainTokenBudget({
            provider: 'anthropic',
            model: 'claude-opus-4-5',
            contextWindowTokens: 320_000,
        });

        assert.equal(budget.effectiveContextTokens, 200_000);
        assert.equal(budget.configuredContextTokens, 320_000);
        assert.equal(budget.maxOutputTokens, 47_500);
        assert.equal(budget.hardInputTokens, 142_500);
    });

    it('accepts a single context window setting without a separate output cap', () => {
        const budget = resolveChainTokenBudget({
            provider: 'custom',
            model: 'local-24k',
            contextWindowTokens: 24_000,
        });

        assert.equal(budget.maxOutputTokens, 5_700);
        assert.ok(budget.hardInputTokens > 0);
    });

    it('explains when the context window is too small for thinking reserves', () => {
        assert.throws(() => resolveChainTokenBudget({
            provider: 'google',
            model: 'local',
            contextWindowTokens: 4_096,
            thinking: { reasoning: true, level: 'high', budget: 24_576 },
        }), (error: unknown) => {
            assert.ok(error instanceof ChainTokenBudgetConflictError);
            assert.match(String((error as Error).message), /context window/);
            assert.match(String((error as Error).message), /contextWindowTokens/);
            return true;
        });
    });

    it('rejects non-positive context settings', () => {
        assert.throws(() => resolveChainTokenBudget({
            provider: 'custom',
            model: 'local',
            contextWindowTokens: 0,
        }), /contextWindowTokens must be a positive integer/);
    });
});
