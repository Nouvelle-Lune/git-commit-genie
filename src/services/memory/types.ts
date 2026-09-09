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
    arguments: z.record(z.string(), z.unknown()), ok: z.boolean(), summary: z.string(), error: z.string().optional(),
    evidence: z.array(z.object({ id: z.string().regex(/^E\d+$/), source: sourceObservationSchema }).strict()),
    durationMs: z.number().nonnegative(), truncated: z.boolean(),
}).strict();

export const investigationEpisodeSchema = z.object({
    version: z.literal(2), id: z.uuid(), createdAt: z.number().int().nonnegative(), snapshot: snapshotIdentitySchema,
    changedPaths: z.array(safePath), changedSymbols: z.array(z.string()), questions: z.array(z.string()),
    observations: z.array(recordedObservationSchema),
    claims: z.array(z.object({ claim: z.string(), evidenceRefs: z.array(z.string()), disposition: z.enum(['must_express', 'optional', 'omit']) }).strict()),
    status: z.enum(['complete', 'degraded', 'unavailable', 'cancelled', 'error']),
    // Pin the experience protocol used to record these immutable observations.
    // Old unreleased formats must be explicitly cleared, never migrated on read.
    model: z.string(), promptVersion: z.literal('memory-experience-1'), toolsetVersion: z.literal('snapshot-memory-experience-1'),
}).strict();

export type InvestigationEpisode = z.infer<typeof investigationEpisodeSchema>;
export type RecordedObservation = z.infer<typeof recordedObservationSchema>;

// An observation can support a historical limitation without returning source code.
export const memorySupportSchema = z.object({
    episodeId: z.uuid(), observationIndex: z.number().int().nonnegative(),
    evidenceId: z.string().regex(/^E\d+$/).optional(),
    questionIndex: z.number().int().nonnegative().optional(), claimIndex: z.number().int().nonnegative().optional(),
}).strict();
export type MemorySupport = z.infer<typeof memorySupportSchema>;
const text = z.string().trim().min(1).max(600);
const supported = { supports: z.array(memorySupportSchema).min(2).max(32), snapshotCount: z.number().int().min(2) };
export const investigationStepSchema = z.object({
    path: safePath, symbol: z.string().min(1).optional(), purpose: text,
    operation: z.string().min(1), ...supported,
}).strict();
export const historicalLessonSchema = z.object({
    observation: text, implication: text, limitation: text, ...supported,
}).strict();
export const experienceRetirementSchema = z.object({
    reason: text, supports: z.array(memorySupportSchema).min(2).max(32), snapshotCount: z.number().int().min(2),
    replacementEntryId: z.uuid().nullable(),
}).strict();
export const handbookEntrySchema = z.object({
    id: z.uuid(), situation: text, retirement: experienceRetirementSchema.nullable(),
    steps: z.array(investigationStepSchema).max(4), lessons: z.array(historicalLessonSchema).max(4),
    targetPaths: z.array(safePath), triggers: z.array(z.string().min(1)),
}).strict().refine(entry => entry.steps.length + entry.lessons.length > 0, 'An experience needs steps or lessons.');
export type HandbookEntry = z.infer<typeof handbookEntrySchema>;

const observationIds = z.array(z.string().regex(/^O\d+$/)).min(2).max(32);
export const consolidationGroupProposalSchema = z.object({
    groupId: z.string().regex(/^G\d+$/), outcome: z.enum(['findings', 'no-findings']), rationale: text,
    entries: z.array(z.object({
        existingEntryId: z.string().regex(/^H\d+$/).nullable(), situation: text,
        steps: z.array(z.object({
            sourceId: z.string().regex(/^S\d+$/), symbol: z.string().min(1).nullable(),
            purpose: text, findings: z.array(z.object({
                observationId: z.string().regex(/^O\d+$/),
                questionIndex: z.number().int().nonnegative(), claimIndex: z.number().int().nonnegative(),
            }).strict()).min(2).max(32),
        }).strict()).max(4),
        lessons: z.array(z.object({ observation: text, implication: text, limitation: text, observationIds }).strict()).max(4),
    }).strict()).max(6),
    retirements: z.array(z.object({
        existingEntryId: z.string().regex(/^H\d+$/), reason: text,
        replacementEntryIndex: z.number().int().nonnegative().nullable(),
        findings: z.array(z.object({
            observationId: z.string().regex(/^O\d+$/), sourceId: z.string().regex(/^S\d+$/),
            questionIndex: z.number().int().nonnegative(), claimIndex: z.number().int().nonnegative(),
        }).strict()).min(2).max(32),
    }).strict()).max(6),
}).strict();
export const consolidationProposalSchema = z.object({ groups: z.array(consolidationGroupProposalSchema).length(1) }).strict();

export interface MemoryAvailability {
    snapshotId: string;
    location: 'available' | 'needs_revalidation' | 'unavailable' | 'historical_only';
    experience: 'unverified' | 'retired' | 'retirement_unmatched';
    targets: Array<{ path: string; state: 'available' | 'needs_revalidation' | 'unavailable' }>;
    retirement: { reason: string; replacementEntryId: string | null } | null;
}
export interface MemoryNavigation {
    id: string;
    origin: 'handbook' | 'episode';
    availability: MemoryAvailability;
    situation: string;
    targetPaths: string[];
    steps: Array<Omit<HandbookEntry['steps'][number], 'supports'>>;
    lessons: Array<Omit<HandbookEntry['lessons'][number], 'supports'>>;
    sourceCount: number;
    observationCount: number;
    snapshotCount: number;
}

/** Keep item provenance as the only authority; there is no entry-wide support shortcut. */
export function entrySupports(entry: HandbookEntry): MemorySupport[] {
    return [...new Map([...entry.steps, ...entry.lessons, ...(entry.retirement ? [entry.retirement] : [])].flatMap(item => item.supports)
        .map(support => [JSON.stringify(support), support])).values()];
}
export function entryTerms(entry: HandbookEntry): string[] {
    return [entry.situation, ...entry.targetPaths, ...entry.triggers,
        ...entry.steps.flatMap(step => [step.path, step.symbol ?? '', step.purpose]),
        ...entry.lessons.flatMap(lesson => [lesson.observation, lesson.implication, lesson.limitation]),
        ...(entry.retirement ? [entry.retirement.reason] : [])];
}

export interface MemoryUsage {
    recalled: number; expanded: number; adopted: number; unavailable: number; retrievalMs: number;
    sourceAttempts: number; invalidReferences: number; budgetRejections: number;
}

export interface MemoryQuery { paths: string[]; symbols: string[]; keywords: string[] }
