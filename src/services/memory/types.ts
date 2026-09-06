import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const safePath = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..'));
export const sourceObservationSchema = z.object({
    snapshotId: digest, path: safePath, side: z.enum(['before', 'after']), blobOid: oid,
    startLine: z.number().int().positive(), endLine: z.number().int().positive(),
    excerpt: z.string().max(12000), contentHash: digest, truncated: z.boolean(), sourceType: z.literal('text'),
}).strict().refine(value => value.endLine >= value.startLine);
export const snapshotIdentitySchema = z.object({
    id: digest, repositoryId: digest, worktreeId: digest, head: oid.nullable(),
    beforeTree: oid, afterTree: oid, indexFingerprint: digest, autoStaged: z.boolean(),
}).strict();
export const recordedObservationSchema = z.object({
    step: z.number().int().nonnegative(), tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()), ok: z.boolean(), summary: z.string(),
    evidence: z.array(z.object({ id: z.string().regex(/^E\d+$/), source: sourceObservationSchema }).strict()),
    durationMs: z.number().nonnegative(), truncated: z.boolean(),
}).strict();
export const investigationEpisodeSchema = z.object({
    version: z.literal(1), id: z.uuid(), createdAt: z.number().int().nonnegative(), snapshot: snapshotIdentitySchema,
    changedPaths: z.array(safePath), changedSymbols: z.array(z.string()), questions: z.array(z.string()),
    observations: z.array(recordedObservationSchema),
    claims: z.array(z.object({ claim: z.string(), evidenceRefs: z.array(z.string()), disposition: z.enum(['must_express', 'optional', 'omit']) }).strict()),
    status: z.enum(['complete', 'degraded', 'unavailable', 'cancelled', 'error']),
    model: z.string(), promptVersion: z.literal('memory-1'), toolsetVersion: z.literal('snapshot-1'),
}).strict();
export type InvestigationEpisode = z.infer<typeof investigationEpisodeSchema>;
export type RecordedObservation = z.infer<typeof recordedObservationSchema>;

export const handbookEntrySchema = z.object({
    id: z.uuid(), triggers: z.array(z.string().min(1)).min(1).max(20),
    targetPaths: z.array(safePath).min(1).max(8), questions: z.array(z.string().min(1).max(600)).max(6),
    supports: z.array(z.object({ episodeId: z.uuid(), evidenceId: z.string().regex(/^E\d+$/) }).strict()).min(1).max(32),
    kind: z.enum(['navigation', 'procedure']),
}).strict();
export type HandbookEntry = z.infer<typeof handbookEntrySchema>;
export const consolidationProposalSchema = z.object({ entries: z.array(handbookEntrySchema).max(30) }).strict();
export interface MemoryNavigation {
    id: string;
    targetPaths: string[];
    questions: string[];
    supports: HandbookEntry['supports'];
}
export interface MemoryUsage {
    recalled: number; expanded: number; adopted: number; unavailable: number; retrievalMs: number;
}
export interface MemoryQuery { paths: string[]; symbols: string[]; keywords: string[] }
