import type { LogEntry } from './types/messages';

/** Remove ephemeral debugging data before a log crosses a disabled or persistent boundary. */
export function stripRawData(log: LogEntry): LogEntry {
    const { rawData: _rawData, ...visible } = log;
    return visible;
}

/** Select the exact log shape allowed to cross the Extension-to-WebUI boundary. */
export function projectLogForWebview(log: LogEntry, rawDataEnabled: boolean): LogEntry {
    return rawDataEnabled ? log : stripRawData(log);
}
