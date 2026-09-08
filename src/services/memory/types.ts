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
    // These are historical provenance labels, not model-call protocol negotiation.
    // Immutable episodes retain their original labels after the active tool contract changes.
    model: z.string(), promptVersion: z.enum(['memory-1', 'memory-2']), toolsetVersion: z.enum(['snapshot-1', 'snapshot-memory-handles-3']),
}).strict();

export type InvestigationEpisode = z.infer<typeof investigationEpisodeSchema>;
export type RecordedObservation = z.infer<typeof recordedObservationSchema>;

export const handbookEntrySchema = z.object({
    id: z.uuid(), triggers: z.array(z.string().min(1)).min(1),
    targetPaths: z.array(safePath).min(1).max(8),
    // Concerns are cross-episode, repository-level behaviors/risks/invariants,
    // distilled by consolidation; they are never task-specific run questions.
    concerns: z.array(z.string().min(1).max(600)).max(6),
    supports: z.array(z.object({
        episodeId: z.uuid(), evidenceId: z.string().regex(/^E\d+$/)
    }).strict()).min(1).max(32),
    kind: z.enum(['navigation', 'procedure']),
}).strict();

export type HandbookEntry = z.infer<typeof handbookEntrySchema>;

export const consolidationGroupProposalSchema = z.object({
    groupId: z.string().regex(/^G\d+$/).describe('Exactly one supplied G* group identifier.'),
    outcome: z.enum(['findings', 'no-findings']).describe('Use findings only when at least one concern has valid cross-snapshot support.'),
    rationale: z.string().trim().min(1).max(600),
    concerns: z.array(z.object({
        text: z.string().trim().min(1).max(600).describe('A repository-level concern directly supported by every cited source.'),
        sourceIds: z.array(z.string().regex(/^S\d+$/)).min(2).max(32)
            .describe('S* IDs from this G* group only; the selected sources must cover at least two distinct V* snapshots.'),
    }).strict()).max(6),
}).strict();

export const consolidationProposalSchema = z.object({
    groups: z.array(consolidationGroupProposalSchema).min(1).max(12)
}).strict();

export interface MemoryNavigation {
    id: string;
    targetPaths: string[];
    /** Historical concerns, not investigation instructions for the current change. */
    concerns: string[];
    sourceCount: number;
}

export interface MemoryUsage {
    recalled: number; expanded: number; adopted: number; unavailable: number; retrievalMs: number;
    sourceAttempts: number; invalidReferences: number; budgetRejections: number;
}

export interface MemoryQuery { paths: string[]; symbols: string[]; keywords: string[] }
