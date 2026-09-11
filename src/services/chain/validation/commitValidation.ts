import { LLMExecution } from '../../llm/llmTypes';
import { buildValidateAndFixMessages } from './prompts';

export interface CommitFactContext {
    requiredFacts: Array<{ id: string; text: string }>;
    optionalFacts: Array<{ id: string; text: string }>;
}

export interface CommitValidationResult {
    validMessage: string;
    notes?: string;
    violations?: string[];
    preservedFactIds?: string[];
}

export async function validateAndFixCommit(
    commitMessage: string,
    checklistText: string,
    execution: LLMExecution,
    userTemplate?: string,
    factContext?: CommitFactContext,
): Promise<CommitValidationResult> {
    const messages = buildValidateAndFixMessages(commitMessage, checklistText, userTemplate, factContext);
    const session = execution.createSession(messages);
    let requestMessages = messages;
    let parsed: any;
    for (let attempt = 0; attempt <= execution.maxRetries; attempt += 1) {
        parsed = await execution.run<any>(session, requestMessages, { requestType: 'fix' });
        const requiredIds = factContext?.requiredFacts.map(fact => fact.id) ?? [];
        const preservedIds = Array.isArray(parsed.preservedFactIds) ? parsed.preservedFactIds : [];
        const missing = requiredIds.filter(id => !preservedIds.includes(id));
        if (!missing.length) {
            break;
        }
        if (attempt === execution.maxRetries) {
            throw new Error(`Fact-aware commit fixer omitted required fact ids: ${missing.join(', ')}.`);
        }
        requestMessages = [{
            role: 'user',
            content: [
                '<fact_binding_rejected>',
                `The previous response did not bind every required fact. Missing ids: ${missing.join(', ')}.`,
                'Return the complete JSON object again. Preserve the current message wording where possible, repair only the missing fact coverage, and list every required id in preservedFactIds.',
                '</fact_binding_rejected>',
            ].join('\n'),
        }];
    }
    // A valid verdict is an assertion about the original message, not a new
    // message to reconstruct. Keeping the original preserves its body and
    // footers when a validator echoes only the header.
    const validMessage = parsed.status === 'valid' ? commitMessage : parsed.commitMessage;

    return {
        validMessage,
        notes: parsed.notes,
        violations: parsed.violations,
        preservedFactIds: parsed.preservedFactIds,
    };
}

function firstLine(text: string): string {
    const index = text.indexOf('\n');
    return index === -1 ? text : text.slice(0, index);
}

export function checkConventionalCommitHeader(message: string): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const header = firstLine(message).trim();
    const headerPattern = /^([a-z]+)(\([A-Za-z0-9_.-]+\))?(!)?:\s[^\n\r]+$/;

    if (!headerPattern.test(header)) {
        problems.push('Header must match <type>[optional scope][!]: <description>.');
    }
    if (header.length > 72) {
        problems.push('Header length must be <= 72 characters.');
    }

    return { ok: problems.length === 0, problems };
}
