export interface ApiLogLike {
    type: string;
    requestType?: string;
}

/** Identifies transport rows whose response payload must never be exposed in the log UI. */
export function isApiRequestLog(log: ApiLogLike): boolean {
    return log.type === 'apiRequest'
        || (log.type === 'finalResult' && Boolean(log.requestType));
}
