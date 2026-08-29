export interface WebviewApiLogPayload {
    result: unknown;
    isFinal: boolean;
}

/**
 * Shapes structured provider responses for the Webview log list.
 */
export function formatWebviewApiResult(data: unknown): WebviewApiLogPayload {
    if (data && typeof data === 'object' && 'action' in data) {
        const value = data as Record<string, unknown>;
        if (value.action === 'final') {
            return {
                result: { action: 'final', final: value.final ?? value },
                isFinal: true,
            };
        }
        if (value.action === 'tool') {
            const toolName = value.toolName ?? value.tool;
            const args = value.args ?? Object.fromEntries(
                Object.entries(value).filter(([key]) => !['action', 'toolName', 'tool', 'reason', 'final'].includes(key)),
            );
            return {
                result: {
                    action: 'tool',
                    toolName,
                    args,
                    reason: value.reason,
                },
                isFinal: false,
            };
        }
    }

    if (data === undefined) {
        return {
            result: { warning: 'Provider returned empty structured output.' },
            isFinal: false,
        };
    }

    return { result: data, isFinal: false };
}
