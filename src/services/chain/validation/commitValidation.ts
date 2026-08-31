import { LLMExecution } from '../../llm/llmTypes';
import {
    buildEnforceStrictFixMessages,
    buildValidateAndFixMessages,
} from './prompts';

export interface CommitValidationResult {
    validMessage: string;
    notes?: string;
    violations?: string[];
}

export async function validateAndFixCommit(
    commitMessage: string,
    checklistText: string,
    execution: LLMExecution,
    userTemplate?: string
): Promise<CommitValidationResult> {
    const messages = buildValidateAndFixMessages(commitMessage, checklistText, userTemplate);
    const session = execution.createSession(messages);
    const parsed = await execution.run<any>(session, messages, { requestType: 'fix' });
    // A valid verdict is an assertion about the original message, not a new
    // message to reconstruct. Keeping the original preserves its body and
    // footers when a validator echoes only the header.
    const validMessage = parsed.status === 'valid' ? commitMessage : parsed.commitMessage;

    return {
        validMessage,
        notes: parsed.notes,
        violations: parsed.violations,
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

export async function enforceStrictCommitFormat(
    current: string,
    problems: string[],
    execution: LLMExecution,
    userTemplate?: string
): Promise<string> {
    const messages = buildEnforceStrictFixMessages(current, problems, userTemplate);
    const session = execution.createSession(messages);
    const parsed = await execution.run<any>(session, messages, { requestType: 'strictFix' });
    return parsed.commitMessage;
}
