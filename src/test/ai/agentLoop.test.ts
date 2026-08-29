import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { runAgentLoop } from '../../agent';
import { AIRunRequest, AIRunResponse, AISession } from '../../services/llm/providers';

describe('provider-neutral agent loop', () => {
    it('feeds every tool result back into the same session until a final response', async () => {
        const requests: AIRunRequest[] = [];
        const responses: AIRunResponse[] = [
            response([{ id: 'call-1', name: 'lookup', arguments: { value: 1 } }]),
            response([{ id: 'call-2', name: 'lookup', arguments: { value: 2 } }]),
            response([], 'complete'),
        ];
        const session: AISession = {
            provider: 'openai',
            model: 'test',
            run: async request => { requests.push(request); return responses.shift()!; },
            snapshot: () => ({
                provider: 'openai',
                model: 'test',
                continuation: { nativeId: 'resp-final', serverManaged: true },
                transcript: [],
            }),
        };
        const executed: number[] = [];

        const result = await runAgentLoop(session, [{ role: 'user', content: 'start' }], [{
            name: 'lookup',
            description: 'lookup',
            parameters: { type: 'object' },
            execute: async args => { executed.push(args.value as number); return String(args.value); },
        }], { maxSteps: 2 });

        assert.equal(result.text, 'complete');
        assert.equal(result.steps, 2);
        assert.deepEqual(executed, [1, 2]);
        assert.equal(requests.length, 3);
        assert.equal(requests[1].toolResults?.[0].callId, 'call-1');
        assert.equal(requests[2].toolResults?.[0].callId, 'call-2');
    });
});

function response(toolCalls: AIRunResponse['toolCalls'], text = ''): AIRunResponse {
    return {
        text,
        toolCalls,
        continuation: { serverManaged: true },
        raw: {},
    };
}
