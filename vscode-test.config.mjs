import { defineConfig } from '@vscode/test-cli';
import { readdirSync } from 'node:fs';

// Enumerate source tests recursively (scope subdirectories included) so removed
// tests cannot survive as stale build output.
const sourceTests = readdirSync('src/test/ai', { recursive: true })
    .filter(file => file.endsWith('.test.ts'))
    .map(file => `out/test/ai/${file.replace(/\.ts$/, '.js')}`);

export default defineConfig({
    files: sourceTests,
    mocha: { timeout: 30000, ui: 'bdd' },
});
