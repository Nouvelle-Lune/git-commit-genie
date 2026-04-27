import { describe, it } from 'mocha';
import { shouldExclude } from '../../services/analysis/tools/utils';
import * as assert from 'assert';

const DEFAULT_PATTERNS = ['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store', 'dist', 'build', 'out', '.vscode-test', 'coverage'];

describe('shouldExclude', () => {
    describe('default patterns match expected paths', () => {
        it('should exclude .git directory contents', () => {
            assert.strictEqual(shouldExclude('.git/HEAD', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('.git/config', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('.git/refs/heads/main', DEFAULT_PATTERNS), true);
        });

        it('should exclude node_modules', () => {
            assert.strictEqual(shouldExclude('node_modules/express/index.js', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('node_modules', DEFAULT_PATTERNS), true);
        });

        it('should exclude .venv', () => {
            assert.strictEqual(shouldExclude('.venv/lib/python3.12/site-packages/requests/__init__.py', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('.venv', DEFAULT_PATTERNS), true);
        });

        it('should exclude __pycache__', () => {
            assert.strictEqual(shouldExclude('__pycache__/foo.cpython-312.pyc', DEFAULT_PATTERNS), true);
        });

        it('should exclude .DS_Store', () => {
            assert.strictEqual(shouldExclude('.DS_Store', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('some/dir/.DS_Store', DEFAULT_PATTERNS), true);
        });

        it('should exclude dist', () => {
            assert.strictEqual(shouldExclude('dist/bundle.js', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('dist', DEFAULT_PATTERNS), true);
        });

        it('should exclude build', () => {
            assert.strictEqual(shouldExclude('build/output.o', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('build', DEFAULT_PATTERNS), true);
        });

        it('should exclude out', () => {
            assert.strictEqual(shouldExclude('out/test/foo.test.js', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('out', DEFAULT_PATTERNS), true);
        });

        it('should exclude .vscode-test', () => {
            assert.strictEqual(shouldExclude('.vscode-test/vscode-darwin-arm64-1.103.2', DEFAULT_PATTERNS), true);
        });

        it('should exclude coverage', () => {
            assert.strictEqual(shouldExclude('coverage/lcov.info', DEFAULT_PATTERNS), true);
            assert.strictEqual(shouldExclude('coverage', DEFAULT_PATTERNS), true);
        });
    });

    describe('legitimate project files are not excluded', () => {
        it('should not exclude source files', () => {
            assert.strictEqual(shouldExclude('src/index.ts', DEFAULT_PATTERNS), false);
            assert.strictEqual(shouldExclude('src/services/analysis/repositoryAnalysisService.ts', DEFAULT_PATTERNS), false);
        });

        it('should not exclude config files at root', () => {
            assert.strictEqual(shouldExclude('package.json', DEFAULT_PATTERNS), false);
            assert.strictEqual(shouldExclude('README.md', DEFAULT_PATTERNS), false);
            assert.strictEqual(shouldExclude('tsconfig.json', DEFAULT_PATTERNS), false);
        });

        it('should not exclude .gitignore (only .git directory)', () => {
            assert.strictEqual(shouldExclude('.gitignore', DEFAULT_PATTERNS), false);
        });

        it('should not exclude files that happen to contain a pattern name in their extension', () => {
            assert.strictEqual(shouldExclude('dist.js', DEFAULT_PATTERNS), false);
            assert.strictEqual(shouldExclude('build.config.ts', DEFAULT_PATTERNS), false);
            assert.strictEqual(shouldExclude('coverage.html', DEFAULT_PATTERNS), false);
            assert.strictEqual(shouldExclude('something.out', DEFAULT_PATTERNS), false);
        });
    });

    describe('user patterns', () => {
        it('should apply user patterns in addition to defaults', () => {
            const patterns = [...DEFAULT_PATTERNS, '*.log'];
            assert.strictEqual(shouldExclude('debug.log', patterns), true);
            assert.strictEqual(shouldExclude('logs/error.log', patterns), true);
        });

        it('should exclude user-only patterns when defaults are empty', () => {
            assert.strictEqual(shouldExclude('secret/config.yml', ['secret']), true);
        });
    });

    describe('edge cases', () => {
        it('should return false for empty patterns', () => {
            assert.strictEqual(shouldExclude('node_modules/foo', []), false);
        });

        it('should handle null patterns gracefully', () => {
            const patterns = null as unknown as string[];
            assert.strictEqual(shouldExclude('node_modules/foo', patterns), false);
        });

        it('should handle undefined patterns gracefully', () => {
            const patterns = undefined as unknown as string[];
            assert.strictEqual(shouldExclude('node_modules/foo', patterns), false);
        });

        it('should allow subdirectories with same name as source dir', () => {
            const patterns = ['.git'];
            assert.strictEqual(shouldExclude('.gitignore', patterns), false);
        });

        it('should normalize Windows backslashes', () => {
            assert.strictEqual(shouldExclude('node_modules\\express\\index.js', DEFAULT_PATTERNS), true);
        });
    });
});
