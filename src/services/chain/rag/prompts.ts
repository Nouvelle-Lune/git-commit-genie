import { AIMessage } from '../../llm/providers';
import { ChangeSetSummary, RetrievalFeatures } from '../types';
import { DraftEvidence } from '../../analysis/change/types';

export function buildRagPreparationMessages(
    evidence: DraftEvidence[]
): AIMessage[] {
    const system: AIMessage = {
        role: 'system',
        content: [
            '<role>',
            'You prepare structured retrieval context for a commit-message RAG flow.',
            '</role>',
            '',
            '<critical>',
            'Return STRICT JSON only.',
            'Use the provided raw diffs and structured file evidence as your only evidence.',
            'Prefer stable, reusable labels over verbose prose.',
            'Do not invent details that are not supported by the input.',
            '</critical>'
        ].join('\n')
    };

    const payload = evidence;

    const user: AIMessage = {
        role: 'user',
        content: [
            '<instructions>',
            'Generate two outputs for future retrieval:',
            '1. changeSetSummary: a compact natural-language summary of the whole change set.',
            '2. retrievalFeatures: structured tags that can be used for filtering, recall, and reranking.',
            '',
            'Requirements:',
            '- dominantType and predictedType should only be set when the change strongly suggests a likely Conventional Commit type.',
            '- dominantScope and predictedScope should be short and codebase-oriented when justified, otherwise null.',
            '- areas should represent broad functional areas inferred from paths and summaries.',
            '- fileKinds should be stable buckets like code, docs, test, config, asset.',
            '- changeActions should be concise verbs like add, fix, refactor, validate, rename, remove, optimize, document.',
            '- entities should be concrete technical nouns from the input, not vague abstractions.',
            '- touchedPaths should preserve the most informative changed file paths.',
            '- fileExtensions and statusMix must reflect the actual input exactly.',
            '- fileCount must equal the number of changed files in input.',
            '- Entries with kind="raw" contain complete file diffs.',
            '- Entries with kind="summary" contain structured evidence with source hunk ids.',
            '- breakingLike should be true only if the inputs indicate possible breaking behavior.',
            '</instructions>',
            '',
            '<schema>',
            '{',
            '  "changeSetSummary": {',
            '    "text": string,',
            '    "dominantType": string|null,',
            '    "dominantScope": string|null,',
            '    "areas": string[],',
            '    "fileKinds": string[],',
            '    "changeActions": string[],',
            '    "entities": string[]',
            '  },',
            '  "retrievalFeatures": {',
            '    "predictedType": string|null,',
            '    "predictedScope": string|null,',
            '    "areas": string[],',
            '    "fileKinds": string[],',
            '    "changeActions": string[],',
            '    "entities": string[],',
            '    "touchedPaths": string[],',
            '    "fileExtensions": string[],',
            '    "statusMix": string[],',
            '    "fileCount": number,',
            '    "hasDocs": boolean,',
            '    "hasTests": boolean,',
            '    "hasConfig": boolean,',
            '    "hasRenames": boolean,',
            '    "isCrossLayer": boolean,',
            '    "breakingLike": boolean',
            '  }',
            '}',
            '</schema>',
            '',
            '<input>',
            JSON.stringify(payload, null, 2),
            '</input>'
        ].join('\n')
    };

    return [system, user];
}

export function buildRagRerankMessages(
    changeSetSummary: ChangeSetSummary,
    retrievalFeatures: RetrievalFeatures,
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
            JSON.stringify({
                changeSetSummary,
                retrievalFeatures,
            }, null, 2),
            '</current_change>',
            '',
            '<candidates>',
            JSON.stringify(candidates, null, 2),
            '</candidates>'
        ].join('\n')
    };

    return [system, user];
}
