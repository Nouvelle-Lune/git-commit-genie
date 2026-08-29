/** Parses provider output that is contractually required to contain JSON. */
export function parseStructuredText(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) {
        return undefined;
    }
    return JSON.parse(trimmed);
}

export function assertHttpBaseUrl(value: string): string {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Custom provider base URL must use HTTP or HTTPS.');
    }
    return url.toString().replace(/\/$/, '');
}
