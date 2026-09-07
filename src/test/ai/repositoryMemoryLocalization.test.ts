import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'mocha';

describe('Repository Memory localization catalogs', () => {
    it('contains every literal Memory command and service message in all locale catalogs', () => {
        const sourceFiles = [
            path.resolve(__dirname, '../../../src/commands/MemoryCommands.ts'),
            path.resolve(__dirname, '../../../src/services/memory/service.ts'),
        ];
        const sourceKeys = new Set<string>();
        for (const sourceFile of sourceFiles) {
            const source = fs.readFileSync(sourceFile, 'utf8');
            for (const match of source.matchAll(/vscode\.l10n\.t\('((?:\\.|[^'\\])*)'/g)) {
                sourceKeys.add(unescapeSourceString(match[1]));
            }
            for (const match of source.matchAll(/vscode\.l10n\.t\("((?:\\.|[^"\\])*)"/g)) {
                sourceKeys.add(unescapeSourceString(match[1]));
            }
        }
        assert.ok(sourceKeys.size > 0);

        const catalogs = ['bundle.l10n.json', 'bundle.l10n.zh-cn.json', 'bundle.l10n.zh-tw.json']
            .map(file => ({ file, values: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../l10n', file), 'utf8')) as Record<string, unknown> }));
        const base = catalogs[0].values;
        for (const key of sourceKeys) {
            assert.equal(typeof base[key], 'string', `Base catalog is missing '${key}'.`);
            const placeholders = (String(base[key]).match(/\{\d+\}/g) ?? []).sort();
            for (const catalog of catalogs.slice(1)) {
                assert.equal(typeof catalog.values[key], 'string', `${catalog.file} is missing '${key}'.`);
                assert.notEqual(String(catalog.values[key]).trim(), '', `${catalog.file} has an empty '${key}'.`);
                assert.deepEqual(
                    (String(catalog.values[key]).match(/\{\d+\}/g) ?? []).sort(),
                    placeholders,
                    `${catalog.file} changed placeholders for '${key}'.`,
                );
            }
        }
    });
});

function unescapeSourceString(value: string): string {
    return value.replace(/\\(['"])/g, '$1').replace(/\\\\/g, '\\');
}
