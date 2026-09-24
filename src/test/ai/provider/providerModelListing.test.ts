import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { OpenAIProvider } from '../../../services/llm/providers/openai';
import { AnthropicProvider } from '../../../services/llm/providers/anthropic';
import { GoogleProvider } from '../../../services/llm/providers/google';
import { CustomProvider } from '../../../services/llm/providers/custom';

/**
 * Model-discovery contract.
 *
 * The Manage Models flow validates a key by listing the provider's models, so the listing must stay a
 * sorted, prefix-free list of model ids no matter which transport produces it. A replacement transport that
 * returns provider-native names (or an unsorted page) would surface as wrongly ordered or unmatchable
 * entries in the model picker.
 *
 * Migration note: the fake clients below are the only provider-specific part.
 */

describe('provider model discovery', () => {
    it('returns a sorted, plain model id list for every provider', async () => {
        const openai = new OpenAIProvider({ apiKey: 'test' }, {
            models: {
                list: async () => ({ data: [{ id: 'gpt-5.4' }, { id: 'gpt-4o' }, { id: 'o3' }] }),
            },
        } as never);
        const anthropic = new AnthropicProvider({ apiKey: 'test' }, {
            models: {
                list: async () => ({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }),
            },
        } as never);
        const requests: RequestInit[] = [];
        const google = new GoogleProvider({ apiKey: 'test' }, async (_input, init) => {
            requests.push(init ?? {});
            const payload = { models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }] };
            return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as Response;
        });
        const custom = new CustomProvider({ apiKey: 'test', baseUrl: 'http://127.0.0.1:9/v1' }, {
            models: {
                list: async () => ({ data: [{ id: 'qwen3-30b' }, { id: 'llama-3.1-8b' }] }),
            },
        } as never);

        assert.deepEqual(await openai.listModels(), ['gpt-4o', 'gpt-5.4', 'o3']);
        assert.deepEqual(await anthropic.listModels(), ['claude-haiku-4-5', 'claude-sonnet-4-5']);
        assert.deepEqual(await google.listModels(), ['gemini-2.5-flash', 'gemini-2.5-pro']);
        assert.deepEqual(await custom.listModels(), ['llama-3.1-8b', 'qwen3-30b']);
    });

    it('forwards the caller signal to the discovery request', async () => {
        // Discovery is user-initiated and cancellable, so the signal has to reach the network call.
        const signals: Array<AbortSignal | undefined> = [];
        const provider = new GoogleProvider({ apiKey: 'test' }, async (_input, init) => {
            signals.push(init?.signal ?? undefined);
            return { ok: true, status: 200, json: async () => ({ models: [] }), text: async () => '{}' } as Response;
        });
        const controller = new AbortController();

        await provider.listModels(controller.signal);

        assert.equal(signals[0], controller.signal);
    });

    it('surfaces a discovery failure with the upstream status', async () => {
        const provider = new GoogleProvider({ apiKey: 'test' }, async () => ({
            ok: false,
            status: 403,
            json: async () => ({}),
            text: async () => 'API key not valid',
        } as Response));

        await assert.rejects(provider.listModels(), /Google Gemini model listing failed \(403\): API key not valid/);
    });

    it('refuses a non-HTTP custom endpoint before any request is made', () => {
        assert.throws(
            () => new CustomProvider({ apiKey: 'test', baseUrl: 'ftp://127.0.0.1/v1' }),
            /Custom provider base URL must use HTTP or HTTPS\./,
        );
    });
});
