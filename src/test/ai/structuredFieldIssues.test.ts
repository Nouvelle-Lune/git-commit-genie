import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { z } from 'zod';
import {
    AGENT_TERMINAL_LIMITS,
    createInvestigationPlanResponseSchema,
    factAwareCommitMessageSchema,
    validateAndFixResponseSchema,
    changeAnalysisAgentFinalResponseSchema,
} from '../../services/llm/providers/schemas/common';
import { buildTerminalContractLines } from '../../services/analysis/change/investigation/terminalContract';
import { buildStructuredFieldIssues } from '../../services/llm/structuredFieldIssues';

function minimalTerminal(overrides: Record<string, unknown> = {}) {
    return {
        investigation: {
            findings: [],
            unresolvedQuestions: [],
            stopReason: 'Enough evidence.',
        },
        claims: [{
            category: 'observed_change' as const,
            claim: 'the diff changes one parser branch',
            evidenceRefs: ['D1'],
            disposition: 'must_express' as const,
        }],
        behaviorAnalysis: { before: null, after: null, observableEffect: null },
        changeClassification: {
            existingBehaviorCorrected: false,
            newCapabilityAdded: false,
            externalBehaviorChanged: false,
            structuralOnly: true,
            recommendedType: 'refactor',
            reason: null,
        },
        suggestedScope: null,
        selectionNotes: null,
        uncertainties: [],
        ...overrides,
    };
}

describe('structured field issue diagnostics', () => {
    it('reports claim evidence overflow as tooManyItems', () => {
        // An evidence reference array above the shared limit must produce one field-level overflow diagnostic.
        const input = minimalTerminal({
            claims: [{
                category: 'observed_change',
                claim: 'changes many parser branches',
                evidenceRefs: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'],
                disposition: 'must_express',
            }],
        });
        const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(input);
        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }

        const issues = buildStructuredFieldIssues(parsed.error, input);

        assert.deepEqual(issues, [{
            path: 'claims[0].evidenceRefs',
            kind: 'tooManyItems',
            count: 9,
            limit: 8,
        }]);
    });

    it('reports simultaneous evidence ref overflows with exact paths', () => {
        // Every evidence-bearing terminal field must report its own overflow path without truncating diagnostics.
        const input = minimalTerminal({
            investigation: {
                findings: [{
                    target: 'parse',
                    question: 'Who calls parse?',
                    answer: 'The client calls parse.',
                    evidenceRefs: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'],
                }],
                unresolvedQuestions: [],
                stopReason: 'Enough evidence.',
            },
            claims: Array.from({ length: 6 }, (_, index) => ({
                    category: 'observed_change',
                    claim: `changes branch ${index + 1}`,
                    evidenceRefs: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'],
                    disposition: 'must_express',
            })),
        });
        const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(input);
        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }

        const issues = buildStructuredFieldIssues(parsed.error, input);
        const tooMany = issues.filter(issue => issue.kind === 'tooManyItems');

        assert.deepEqual(tooMany.map(issue => issue.path), [
            'investigation.findings[0].evidenceRefs',
            'claims[0].evidenceRefs',
            'claims[1].evidenceRefs',
            'claims[2].evidenceRefs',
            'claims[3].evidenceRefs',
            'claims[4].evidenceRefs',
            'claims[5].evidenceRefs',
        ]);
        for (const issue of tooMany) {
            assert.equal(issue.count, 9);
            assert.equal(issue.limit, 8);
        }
    });

    it('reports D-only finding evidence as invalidFormat', () => {
        // A finding that cites a diff id must expose the repository-only E* format violation.
        const input = minimalTerminal({
            investigation: {
                findings: [{
                    target: 'parse',
                    question: 'Who calls parse?',
                    answer: 'The diff mentions parse.',
                    evidenceRefs: ['D1'],
                }],
                unresolvedQuestions: [],
                stopReason: 'Enough evidence.',
            },
        });
        const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(input);
        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }

        const issues = buildStructuredFieldIssues(parsed.error, input);
        const invalid = issues.find(issue => issue.kind === 'invalidFormat');

        assert.ok(invalid);
        assert.equal(invalid?.path, 'investigation.findings[0].evidenceRefs[0]');
        assert.equal(invalid?.expected, '/^E[0-9]+$/');
        assert.equal(invalid?.actual, '"D1"');
    });
});

describe('exported finding evidence schema', () => {
    it('matches Zod bounds and E* pattern in JSON Schema export', () => {
        // The exported finding schema must expose the same one-to-eight E* bounds enforced by local Zod validation.
        const exported = z.toJSONSchema(changeAnalysisAgentFinalResponseSchema) as {
            properties: {
                investigation: {
                    properties: {
                        findings: {
                            items: {
                                properties: {
                                    evidenceRefs: {
                                        minItems: number;
                                        maxItems: number;
                                        items: { pattern: string };
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
        const evidenceRefs = exported.properties.investigation.properties.findings.items.properties.evidenceRefs;

        assert.equal(evidenceRefs.minItems, AGENT_TERMINAL_LIMITS.minFindingEvidenceRefs);
        assert.equal(evidenceRefs.maxItems, AGENT_TERMINAL_LIMITS.maxEvidenceRefs);
        assert.equal(evidenceRefs.items.pattern, '^E[0-9]+$');
    });

    it('exports digit-class ledger patterns without JavaScript shorthand escapes', () => {
        // Provider-facing schemas must spell ledger id digits as [0-9] so every JSON Schema consumer sees the same contract.
        const schemas = [
            createInvestigationPlanResponseSchema(['D1', 'D2'], 4),
            validateAndFixResponseSchema,
            factAwareCommitMessageSchema,
            changeAnalysisAgentFinalResponseSchema,
        ];

        for (const schema of schemas) {
            const serialized = JSON.stringify(z.toJSONSchema(schema));
            assert.doesNotMatch(serialized, /\\\\d/);
        }
    });

    it('agrees with Zod on legal E*, empty, D-only, mixed, and overflow arrays', () => {
        // Local validation must accept only bounded non-empty E* finding references and reject every other namespace shape.
        const cases = [
            { refs: ['E1'], valid: true },
            { refs: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'], valid: true },
            { refs: [], valid: false },
            { refs: ['D1'], valid: false },
            { refs: ['E1', 'D1'], valid: false },
            { refs: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'], valid: false },
        ];
        for (const testCase of cases) {
            const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(minimalTerminal({
                investigation: {
                    findings: [{
                        target: 'parse',
                        question: 'Who calls parse?',
                        answer: 'Answer.',
                        evidenceRefs: testCase.refs,
                    }],
                    unresolvedQuestions: [],
                    stopReason: 'Enough evidence.',
                },
            }));
            assert.equal(parsed.success, testCase.valid, JSON.stringify(testCase.refs));
        }
    });
});

describe('claim category visibility contract', () => {
    it('exports category and disposition guidance in JSON Schema descriptions', () => {
        // The existing single claims object must expose generic D*/E* syntax plus category-specific routing guidance.
        const exported = z.toJSONSchema(changeAnalysisAgentFinalResponseSchema) as {
            properties: {
                claims: {
                    items: {
                        properties: {
                            category: { description: string };
                            evidenceRefs: {
                                maxItems: number;
                                items: { pattern: string };
                            };
                            disposition: { description: string };
                        };
                    };
                };
            };
        };
        const categoryDescription = exported.properties.claims.items.properties.category.description;
        const claimEvidenceRefs = exported.properties.claims.items.properties.evidenceRefs;
        const dispositionDescription = exported.properties.claims.items.properties.disposition.description;

        assert.equal(claimEvidenceRefs.maxItems, AGENT_TERMINAL_LIMITS.maxEvidenceRefs);
        assert.equal(claimEvidenceRefs.items.pattern, '^[DE][0-9]+$');

        for (const category of [
            'observed_change',
            'repository_fact',
            'supported_inference',
            'uncertain_inference',
        ]) {
            assert.match(categoryDescription, new RegExp(category));
        }
        assert.match(categoryDescription, /observed_change:[^.]*diff alone[^.]*only D\*/);
        assert.match(categoryDescription, /repository_fact:[^.]*repository tool result[^.]*(?:only E\*|E\*[^.]*only)/i);
        assert.match(categoryDescription, /supported_inference:[^.]*D\* and\/or E\*[^.]*(?:requires|requiring) at least one/i);
        assert.match(categoryDescription, /uncertain_inference:[^.]*empty evidenceRefs array[^.]*disposition "omit"/);

        assert.match(
            dispositionDescription,
            new RegExp(String(AGENT_TERMINAL_LIMITS.maxMustExpressClaims)),
        );
        assert.match(
            dispositionDescription,
            new RegExp(String(AGENT_TERMINAL_LIMITS.maxOptionalClaims)),
        );
    });

    it('repeats the four claim categories in the terminal contract prompt', () => {
        // The terminal contract prompt must name every claim category before the model assembles the JSON object.
        const contract = buildTerminalContractLines().join('\n');

        for (const category of [
            'observed_change',
            'repository_fact',
            'supported_inference',
            'uncertain_inference',
        ]) {
            assert.match(contract, new RegExp(category));
        }
        assert.match(contract, /<evidence_categories>/);
    });

    it('rejects observed_change without D* locally with an accurate field issue', () => {
        // An observed change supported only by repository evidence must be rejected with the category-specific rule.
        const input = minimalTerminal({
            claims: [{
                category: 'observed_change',
                claim: 'only repository evidence cited',
                evidenceRefs: ['E1'],
                disposition: 'must_express',
            }],
        });
        const parsed = changeAnalysisAgentFinalResponseSchema.safeParse(input);

        assert.equal(parsed.success, false);
        if (parsed.success) {
            return;
        }

        const issues = buildStructuredFieldIssues(parsed.error, input);
        const evidenceIssue = issues.find(issue => issue.path === 'claims[0].evidenceRefs');

        assert.ok(evidenceIssue);
        assert.equal(evidenceIssue?.kind, 'custom');
        assert.match(evidenceIssue?.message ?? '', /requires at least one D\*/);
    });
});
