/** Collects likely JSON substrings from model output that may include fences or prose. */
function collectJsonCandidates(text: string): string[] {
    const candidates: string[] = [];
    const trimmed = text.trim();
    if (!trimmed) {
        return candidates;
    }

    const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = fencePattern.exec(trimmed)) !== null) {
        const block = match[1]?.trim();
        if (block) {
            candidates.push(block);
        }
    }

    candidates.push(trimmed);

    const objectStart = trimmed.indexOf('{');
    const arrayStart = trimmed.indexOf('[');
    const start = objectStart === -1 ? arrayStart
        : arrayStart === -1 ? objectStart
            : Math.min(objectStart, arrayStart);
    if (start >= 0) {
        const endChar = trimmed[start] === '[' ? ']' : '}';
        const end = trimmed.lastIndexOf(endChar);
        if (end > start) {
            candidates.push(trimmed.slice(start, end + 1));
        }
    }

    return [...new Set(candidates)];
}

/** Parses provider output that is contractually required to contain JSON. */
export function parseStructuredText(text: string): unknown {
    for (const candidate of collectJsonCandidates(text)) {
        try {
            return JSON.parse(candidate);
        } catch {
            // Try the next candidate.
        }
    }
    return undefined;
}

/** Parses tool-call argument payloads; throws when the model returns non-object JSON. */
export function parseJsonObject(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (!trimmed || trimmed === '{}') {
        return {};
    }
    const parsed = parseStructuredText(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
    }
    throw new Error(`Failed to parse tool call arguments as a JSON object: ${trimmed.slice(0, 200)}`);
}

export function assertHttpBaseUrl(value: string): string {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Custom provider base URL must use HTTP or HTTPS.');
    }
    return url.toString().replace(/\/$/, '');
}
