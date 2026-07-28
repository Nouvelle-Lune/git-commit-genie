import { describe, it } from 'mocha';
import * as assert from 'assert';

import {
    buildGitGenieIgnoreAppend,
    GIT_GENIE_IGNORE_ENTRY
} from '../../utils/gitignore';

describe('buildGitGenieIgnoreAppend', () => {
    it('should create the section without a leading blank line for an empty file', () => {
        assert.strictEqual(
            buildGitGenieIgnoreAppend('', 'Ignore Git Commit Genie data'),
            `# Ignore Git Commit Genie data\n${GIT_GENIE_IGNORE_ENTRY}\n`
        );
    });

    it('should add a blank line when existing content has no trailing newline', () => {
        assert.strictEqual(
            buildGitGenieIgnoreAppend('__pycache__/', 'Ignore Git Commit Genie data'),
            `\n\n# Ignore Git Commit Genie data\n${GIT_GENIE_IGNORE_ENTRY}\n`
        );
    });

    it('should add one newline when existing content has one trailing newline', () => {
        assert.strictEqual(
            buildGitGenieIgnoreAppend('__pycache__/\n', 'Ignore Git Commit Genie data'),
            `\n# Ignore Git Commit Genie data\n${GIT_GENIE_IGNORE_ENTRY}\n`
        );
    });

    it('should not add another blank line when one already exists', () => {
        assert.strictEqual(
            buildGitGenieIgnoreAppend('__pycache__/\n\n', 'Ignore Git Commit Genie data'),
            `# Ignore Git Commit Genie data\n${GIT_GENIE_IGNORE_ENTRY}\n`
        );
    });

    it('should preserve CRLF line endings', () => {
        assert.strictEqual(
            buildGitGenieIgnoreAppend('__pycache__/\r\n', 'Ignore Git Commit Genie data'),
            `\r\n# Ignore Git Commit Genie data\r\n${GIT_GENIE_IGNORE_ENTRY}\r\n`
        );
    });

    it('should skip an existing generated entry', () => {
        assert.strictEqual(
            buildGitGenieIgnoreAppend(`${GIT_GENIE_IGNORE_ENTRY}\n`, 'Ignore Git Commit Genie data'),
            null
        );
    });

    it('should skip an existing directory entry', () => {
        assert.strictEqual(
            buildGitGenieIgnoreAppend('.gitgenie/\n', 'Ignore Git Commit Genie data'),
            null
        );
    });

    it('should not treat a comment mentioning the entry as an ignore rule', () => {
        assert.strictEqual(
            buildGitGenieIgnoreAppend(
                '# Keep .gitgenie/ local\n',
                'Ignore Git Commit Genie data'
            ),
            `\n# Ignore Git Commit Genie data\n${GIT_GENIE_IGNORE_ENTRY}\n`
        );
    });
});
