import { logger } from '../services/logger';

/**
 * Run a non-critical side effect that should not abort the calling flow,
 * but whose failures must NOT be silently swallowed.
 *
 * On failure the error is logged via the project logger with a contextual
 * label so it appears in the OutputChannel, while the caller continues.
 *
 * Use this for telemetry, logging fan-out, UI notification updates, or other
 * fire-and-forget operations whose failure must surface but must not crash
 * the main path.
 */
export function safeRun<T>(label: string, fn: () => T): T | undefined {
    try {
        return fn();
    } catch (err) {
        logger.warn(`[safeRun] ${label} failed: ${err}`);
        return undefined;
    }
}

/**
 * Async variant of {@link safeRun}. Awaits the promise and reports rejection
 * via the project logger without rethrowing.
 */
export async function safeRunAsync<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        logger.warn(`[safeRun] ${label} failed: ${err}`);
        return undefined;
    }
}
