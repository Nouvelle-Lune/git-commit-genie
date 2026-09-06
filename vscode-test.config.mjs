import { defineConfig } from '@vscode/test-cli';
import { readdirSync } from 'node:fs';

export default defineConfig({
    // Enumerate source tests so removed tests cannot survive as stale build output.
    files: readdirSync('src/test/ai').filter(file => file.endsWith('.test.ts')).map(file => `out/test/ai/${file.replace(/\.ts$/, '.js')}`),
    mocha: { timeout: 30000, ui: 'bdd' },
});
