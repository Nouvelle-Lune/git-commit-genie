import { AIMessage } from '../../llm/providers';
import { RagRetrievalQuery } from '../types';

export function buildRagRerankMessages(
    query: RagRetrievalQuery,
    candidates: Array<{
        id: string;
        message: string;
        matchedBy: string[];
        type?: string | null;
        scope?: string | null;
        hybridScore: number;
        featureScore: number;
    }>,
    maxResults: number
): AIMessage[] {
    const system: AIMessage = {
        role: 'system',
        content: [
            '<role>',
            'You rerank historical commit messages for a style-aware RAG pipeline.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only.',
            'Select candidates that are genuinely similar in change scope or functional area and whose writing style is useful for drafting the new commit message.',
            'Do not optimize for shared nouns alone.',
            '</critical>'
        ].join('\n')
    };

    const user: AIMessage = {
        role: 'user',
        content: [
            '<instructions>',
            `Select up to ${maxResults} historical commit messages.`,
            'Prioritize candidates that satisfy both of these goals:',
            '1. The change scope, affected area, or functional intent is close to the current change.',
            '2. The commit message style is useful as a writing reference for the new message.',
            '',
            'Selection rules:',
            '- Prefer candidates whose type/scope framing matches the current change.',
            '- Prefer candidates with clean, reusable commit-writing style.',
            '- Avoid near-duplicate examples.',
            '- Reject candidates that are topically unrelated even if token overlap is high.',
            '- Return an empty selected array when none of the candidates is a useful style reference.',
            '- The selected examples will later be used for style reference only, so focus your reason on style and scope fit.',
            '- Return ONLY the candidate "id" values (e.g., "c1", "c7"); do not echo full commit hashes or messages.',
            '</instructions>',
            '',
            '<schema>',
            '{',
            '  "selected": [',
            '    {',
            '      "id": string,',
            '      "reason": string',
            '    }',
            '  ],',
            '  "notes": string|null',
            '}',
            '</schema>',
            '',
            '<current_change>',
            JSON.stringify(query, null, 2),
            '</current_change>',
            '',
            '<candidates>',
            JSON.stringify(candidates, null, 2),
            '</candidates>'
        ].join('\n')
    };

    return [system, user];
}
