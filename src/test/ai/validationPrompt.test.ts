import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildEnforceLanguageMessages, buildValidateAndFixMessages } from '../../services/chain/validation/prompts';
import type { CommitFactContext } from '../../services/chain/validation/commitValidation';
import { AIMessage } from '../../services/llm/providers';

const commitMessage = 'fix(parser): normalize empty input to an empty string';

const factContext: CommitFactContext = {
    requiredFacts: [
        { id: 'C1', text: 'empty input normalizes to an empty string' },
        { id: 'C2', text: 'the parser keeps its existing return shape' },
    ],
    optionalFacts: [
        { id: 'C3', text: 'logging moved behind a helper' },
    ],
};

describe('validation stage fact contract', () => {
    it('counts a required fact as expressed when the message semantically entails it', () => {
        // Verify the fixer is told that entailment, including a higher-level statement subsuming several facts,
        // satisfies a required fact, so compressed wording is never treated as a dropped fact.
        const content = render(buildValidateAndFixMessages(commitMessage, '', undefined, factContext));

        assert.match(content, /A required fact counts as expressed when the message semantically entails it, including through a higher-level statement that subsumes several facts\./);
        assert.match(content, /preservedFactIds must list every required fact id that commitMessage entails, however compressed the wording is\./);
        assert.match(content, /Never drop the meaning of a required fact, and never add a fact that is not supplied\./);
        assert.match(content, /Compressed wording is valid: a required fact is preserved when the message entails it, even if no phrase restates it\./);
        assert.doesNotMatch(content, /Never remove a required fact/);
        assert.doesNotMatch(content, /Required facts must remain expressed after any fix, even if their wording changes\./);
    });

    it('forbids expanding the fixed message to reach explicit required-fact coverage', () => {
        // Verify the fixer only repairs facts nothing in the message entails and must not lengthen the message
        // just to make a fact explicit or to repeat one change through before/after/mechanism/effect.
        const content = render(buildValidateAndFixMessages(commitMessage, '', undefined, factContext));

        assert.match(content, /Never expand a message just to make a fact explicit\./);
        assert.match(content, /Do NOT expand the message merely to increase explicit coverage, and do not restate before\/after\/mechanism\/effect separately when they describe the same change\./);
        assert.match(content, /Fix only genuine omissions: a required fact that no part of the message entails\./);
    });

    it('defaults validation to an omitted body and flags a body that only restates the header', () => {
        // Verify the default checklist no longer calls the body optional: a body must be carried by a distinct
        // fact the header cannot hold or by a user template, and a header-only restatement is flagged.
        const content = render(buildValidateAndFixMessages(commitMessage, '', undefined, factContext));

        assert.match(content, /- Body: omitted by default; a body is justified only by a distinct fact the header cannot carry, or by a user template that mandates one\./);
        assert.match(content, /Flag a body that only restates the header unless a user template requires a body/);
        assert.doesNotMatch(content, /Body: optional/);
    });

    it('keeps the 72-character header limit in the default validation checklist', () => {
        // Verify the default checklist still states the 72-character limit, because the code-side header check no
        // longer reports length and the limit survives only as a prompt requirement.
        const content = render(buildValidateAndFixMessages(commitMessage, '', undefined, factContext));

        assert.match(content, /- Header length <= 72; imperative; no trailing period/);
    });

    it('replaces the default checklist wholesale when a non-empty checklist is supplied', () => {
        // Verify a caller-supplied checklist is used verbatim and the defaultChecklist wording disappears
        // entirely. This is the mechanism that made a default-only body-policy edit invisible on the real commit
        // path, because unifiedLLMService always passes the checklist file as validationChecklist.
        const customChecklist = '- Body: follow the repository template';
        const content = render(buildValidateAndFixMessages(commitMessage, customChecklist, undefined, factContext));

        assert.match(content, /- Body: follow the repository template/);
        assert.doesNotMatch(content, /Flag a body that only restates the header/);
        assert.doesNotMatch(content, /- Header length <= 72; imperative; no trailing period/);
    });
});

describe('validation checklist resource', () => {
    it('carries the omitted-body policy and the 72-character limit in the file the service passes', () => {
        // Verify the checklist file read by unifiedLLMService (resources/agentRules/validationChecklist.md, passed
        // as validationChecklist) itself states the omitted-body policy and the 72-character header limit: only
        // this file reaches the real commit path, so a defaultChecklist-only edit changes nothing there.
        const checklist = readFileSync(resolve(__dirname, '../../../resources/agentRules/validationChecklist.md'), 'utf8');

        assert.match(checklist, /^- Body: omitted by default;/m);
        assert.match(checklist, /Flag a body that only restates the header/);
        assert.match(checklist, /length <= 72 chars/);
        assert.doesNotMatch(checklist, /Body: optional/);
    });

    it('keeps the production checklist and the default fallback on the same body policy', () => {
        // Verify both checklist carriers state the same body-policy essentials. They are the two texts the
        // validator can receive, and the earlier defect was exactly a change applied to only one of them, so any
        // future edit must not leave one carrier saying the body is optional while the other omits it by default.
        const checklist = readFileSync(resolve(__dirname, '../../../resources/agentRules/validationChecklist.md'), 'utf8');
        const fallback = render(buildValidateAndFixMessages(commitMessage, '', undefined, factContext));

        for (const carrier of [checklist, fallback]) {
            assert.match(carrier, /Body: omitted by default/);
            assert.match(carrier, /only restates the header/i);
        }
    });
});

describe('language stage fact contract', () => {
    it('counts a required fact as expressed when the translated message semantically entails it', () => {
        // Verify the language fixer shares the validation stage's entailment definition, including subsumption
        // by a higher-level statement, and reports every entailed required id.
        const content = render(buildEnforceLanguageMessages(commitMessage, 'zh', undefined, factContext));

        assert.match(content, /A required fact counts as expressed when the translated message semantically entails it, including through a higher-level statement that subsumes several facts\./);
        assert.match(content, /preservedFactIds must list every required fact id that the translated message entails\./);
    });

    it('restricts the language stage to translation without new facts or redundant expansion', () => {
        // Verify translation preserves fact meanings however compressed the wording is, forbids adding a fact, and
        // forbids expanding wording that already entails its facts, while still protecting the type and footer
        // tokens. The expand prohibition was narrowed this round: the earlier "never expand a message to make a
        // required fact explicit" was replaced by the reviewer fix, which limited it to wording that already
        // entails its facts so it cannot cancel the restore authorization below.
        const content = render(buildEnforceLanguageMessages(commitMessage, 'zh', undefined, factContext));

        assert.match(content, /Preserve the meaning of every required semantic fact and every exact identifier from the fact contract; a fact the message still entails is preserved, however compressed the wording/);
        assert.match(content, /- Translate only: never add a fact, and never expand wording that already entails its facts\./);
        assert.match(content, /Do NOT translate the Conventional Commit <type> token/);
        assert.match(content, /Do NOT translate footer tokens such as BREAKING CHANGE or Refs/);
        assert.doesNotMatch(content, /never expand a message to make a required fact explicit/);
        assert.doesNotMatch(content, /Preserve every required semantic fact and exact identifier from the fact contract/);
    });

    it('authorizes the language stage to restore only facts no part of the message entails', () => {
        // Verify the language contract is no longer one-sided: since a retry only happens when a fact really is
        // missing, the prompt must authorize restoring a required fact that no part of the translated message
        // entails, otherwise "preserve without expanding" plus "report every id" leaves the model no legal move
        // and the meaning is silently dropped while the id is still reported.
        const content = render(buildEnforceLanguageMessages(commitMessage, 'zh', undefined, factContext));

        assert.match(content, /Restore a required fact only when no part of the message entails it/);
        assert.match(content, /Fix only genuine omissions: a required fact that no part of the translated message entails\./);
    });

    it('carries the supplied required and optional facts into both fact contracts', () => {
        // Verify both stages receive the fact payload the entailment rule refers to, so the model can bind ids
        // to meanings and the fixer retries are grounded in the same facts.
        const validation = render(buildValidateAndFixMessages(commitMessage, '', undefined, factContext));
        const language = render(buildEnforceLanguageMessages(commitMessage, 'zh', undefined, factContext));

        for (const content of [validation, language]) {
            assert.match(content, /"required_facts"/);
            assert.match(content, /empty input normalizes to an empty string/);
            assert.match(content, /the parser keeps its existing return shape/);
            assert.match(content, /"optional_facts"/);
            assert.match(content, /logging moved behind a helper/);
        }
    });
});

/**
 * Renders a prompt with whitespace collapsed: prompt sentences wrap across source lines, so a contract sentence
 * can only be matched as one string after newlines and indentation are flattened.
 */
function render(messages: AIMessage[]): string {
    return messages.map(message => message.content).join('\n').replace(/\s+/g, ' ');
}
