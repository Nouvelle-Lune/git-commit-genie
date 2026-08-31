import { LLMExecution } from '../../llm/llmTypes';
import { AIMessage } from '../../llm/providers';
import { z } from 'zod';
import { classifyAndDraftResponseSchema } from '../../llm/providers/schemas/common';

export type StructuredDraft = z.infer<typeof classifyAndDraftResponseSchema>;

export interface DraftResult {
    draft: string;
    notes?: string;
}

/**
 * Builds the only commit-message representation from validated components.
 * Keeping assembly local prevents a model-generated aggregate field from
 * disagreeing with its body, footer, scope, or breaking metadata.
 */
export async function generateDraft(messages: AIMessage[], execution: LLMExecution): Promise<DraftResult> {
    const session = execution.createSession(messages);
    const parsed = await execution.run<StructuredDraft>(session, messages, { requestType: 'draft' });
    return {
        draft: assembleCommitMessage(parsed),
        notes: parsed.notes ?? undefined,
    };
}

/** Deterministically formats Conventional Commit components into one message. */
export function assembleCommitMessage(draft: StructuredDraft): string {
    const type = draft.type.trim();
    const scope = draft.scope?.trim() || null;
    const description = draft.description.trim();
    if (scope && isInternalIdentifier(scope)) {
        throw new Error(`Draft scope '${scope}' is an internal trace identifier.`);
    }

    const footers = draft.footers.map(footer => ({
        token: footer.token.trim(),
        value: footer.value.trim(),
    }));
    const hasBreakingFooter = footers.some(footer => (
        footer.token === 'BREAKING CHANGE' || footer.token === 'BREAKING-CHANGE'
    ));
    const breakingMarker = draft.breaking && !hasBreakingFooter ? '!' : '';
    const header = `${type}${scope ? `(${scope})` : ''}${breakingMarker}: ${description}`;
    const sections = [header];

    if (draft.body) {
        sections.push(draft.body.trim());
    }
    if (footers.length) {
        sections.push(footers.map(footer => formatFooter(footer.token, footer.value)).join('\n'));
    }
    return sections.join('\n\n');
}

function formatFooter(token: string, value: string): string {
    const lines = value.split(/\r?\n/);
    return [
        `${token}: ${lines[0]}`,
        ...lines.slice(1).map(line => ` ${line}`),
    ].join('\n');
}

function isInternalIdentifier(value: string): boolean {
    return /^\[?[CDE]\d+(?:\/P\d+)?\]?$/i.test(value);
}
