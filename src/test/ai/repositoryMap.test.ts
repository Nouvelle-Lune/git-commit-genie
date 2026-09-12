import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { buildRepositoryMap, REPOSITORY_MAP_MAX_DIRECTORIES } from '../../services/analysis/change/repositoryMap';
import { SnapshotEntry } from '../../services/git/repositorySnapshot';

/** The map groups and counts paths only, so a manifest entry needs nothing but a path. */
function entry(path: string): SnapshotEntry {
    return { path, mode: '100644', oid: 'oid' };
}

/** One manifest of `directoryCount` single-file directories, named so name order matches byte order. */
function directoryEntries(directoryCount: number): SnapshotEntry[] {
    return Array.from({ length: directoryCount }, (_, index) => (
        entry(`dir${String(index).padStart(2, '0')}/f.ts`)
    ));
}

describe('repository map', () => {
    it('aggregates files by direct parent directory and labels root files (root)', () => {
        // Files are counted per immediate parent, so src/parser.ts and src/client.ts share one row while root files
        // get the synthetic (root) label; the header counts every file and every distinct directory once.
        const entries = [
            entry('README.md'),
            entry('package.json'),
            entry('src/parser.ts'),
            entry('src/client.ts'),
            entry('test/parser.test.ts'),
        ];

        assert.equal(
            buildRepositoryMap(entries, new Set(['src/client.ts'])),
            [
                '5 files, 3 directories (.ts 3, .json 1, .md 1)',
                'src     2 files   [1 changed]',
                '(root)  2 files',
                'test    1 file',
            ].join('\n'),
        );
    });

    it('counts changed files per directory and appends the marker only to those rows', () => {
        // The changed marker is a per-directory count, not a flag: two changed files in one directory read as
        // [2 changed], and a directory without changed files carries no marker at all.
        const entries = [
            entry('src/one.ts'),
            entry('src/two.ts'),
            entry('src/three.ts'),
            entry('docs/guide.md'),
            entry('docs/image.png'),
        ];

        assert.equal(
            buildRepositoryMap(entries, new Set(['src/one.ts', 'src/two.ts'])),
            [
                '5 files, 2 directories (.ts 3, .md 1, .png 1)',
                'src   3 files   [2 changed]',
                'docs  2 files',
            ].join('\n'),
        );
    });

    it('lists a changed directory before larger unchanged ones', () => {
        // Changed directories are the "you are here" marker, so the partition ordering outranks the file-count rule:
        // the untouched directory holds three times as many files and still comes second.
        const entries = [entry('src/a.ts'), entry('src/b.ts'), entry('src/c.ts'), entry('docs/x.md')];

        assert.equal(
            buildRepositoryMap(entries, new Set(['docs/x.md'])),
            [
                '4 files, 2 directories (.ts 3, .md 1)',
                'docs  1 file   [1 changed]',
                'src   3 files',
            ].join('\n'),
        );
    });

    it('ignores a changed path that is absent from the manifest', () => {
        // The map is built from the snapshot manifest, so a changed path the manifest does not contain cannot
        // invent a directory row; the count stays a count of the manifest only.
        const entries = [entry('src/a.ts'), entry('lib/b.ts')];

        assert.equal(
            buildRepositoryMap(entries, new Set(['src/deleted.ts'])),
            [
                '2 files, 2 directories (.ts 2)',
                'lib  1 file',
                'src  1 file',
            ].join('\n'),
        );
    });

    it('caps the rows at the directory limit and summarises the rest', () => {
        // A map that grows with the repository would spend planner context on directories it never reads, so the
        // 62-directory manifest is truncated to the limit and the omitted count is stated instead of dropped.
        const lines = buildRepositoryMap(directoryEntries(62), new Set(['dir61/f.ts'])).split('\n');
        const rows = lines.slice(1, -1);

        assert.equal(REPOSITORY_MAP_MAX_DIRECTORIES, 60);
        assert.equal(rows.length, REPOSITORY_MAP_MAX_DIRECTORIES);
        assert.equal(lines[0], '62 files, 62 directories (.ts 62)');
        assert.equal(rows[0], 'dir61  1 file   [1 changed]');
        assert.equal(rows[1], 'dir00  1 file');
        assert.equal(lines[lines.length - 1], '(+ 2 more directories)');
    });

    it('lists a changed directory first when the manifest exceeds the cap', () => {
        // Changed directories are emitted from their own partition before the rest, so a diff that touches one
        // directory keeps that directory visible even in a 70-directory manifest: the cap only ever drops rows from
        // the untouched partition here.
        const lines = buildRepositoryMap(directoryEntries(70), new Set(['dir69/f.ts'])).split('\n');

        assert.equal(lines[1], 'dir69  1 file   [1 changed]');
        assert.equal(lines.length - 2, REPOSITORY_MAP_MAX_DIRECTORIES);
        assert.equal(lines[lines.length - 1], `(+ ${70 - REPOSITORY_MAP_MAX_DIRECTORIES} more directories)`);
    });

    it('drops a changed directory once the diff itself touches more directories than the cap', () => {
        // The guarantee is bounded by the cap, not absolute: with 62 changed directories the changed partition is
        // itself truncated, so the last two of them are dropped and counted in the summary line like any other row.
        const entries = directoryEntries(62);
        const lines = buildRepositoryMap(entries, new Set(entries.map(item => item.path))).split('\n');

        assert.equal(lines[0], '62 files, 62 directories (.ts 62)');
        assert.equal(lines[1], 'dir00  1 file   [1 changed]');
        assert.equal(lines[60], 'dir59  1 file   [1 changed]');
        assert.equal(lines.some(line => line.startsWith('dir6')), false, 'dir60 and dir61 must be dropped.');
        assert.equal(lines[61], '(+ 2 more directories)');
    });

    it('orders equal-sized directories by code unit instead of locale collation', () => {
        // The map is prompt text a replay has to reproduce byte for byte, so the tie-break is the code-unit order:
        // 'B' sorts before 'a' even though a locale-aware comparison would put alpha first.
        assert.equal(
            buildRepositoryMap([entry('alpha/a.ts'), entry('Beta/b.ts')], new Set()),
            '2 files, 2 directories (.ts 2)\nBeta   1 file\nalpha  1 file',
        );
    });

    it('orders equal-count extensions by code unit instead of locale collation', () => {
        // The language hints use the same code-unit tie-break as the directory rows, so '.TS' precedes '.ts'
        // rather than comparing equal under collation.
        assert.equal(
            buildRepositoryMap([entry('a.TS'), entry('b.ts')], new Set()).split('\n')[0],
            '2 files, 1 directory (.TS 1, .ts 1)',
        );
    });

    it('ignores entries whose mode the snapshot reader cannot return content for', () => {
        // Symlinks (120000) and submodule gitlinks (160000) are in the manifest but read/readBatch refuse them, so
        // the map must neither count them nor give their directory a row: it exists to name openable files only.
        const entries = [
            entry('src/a.ts'),
            { path: 'src/link.ts', mode: '120000', oid: 'oid' },
            { path: 'vendor/dependency.ts', mode: '160000', oid: 'oid' },
            entry('docs/readme.md'),
        ];

        assert.equal(
            buildRepositoryMap(entries, new Set()),
            '2 files, 2 directories (.md 1, .ts 1)\ndocs  1 file\nsrc   1 file',
        );
        // A changed symlink cannot mark a directory as changed either, because that directory row never counts it.
        assert.equal(
            buildRepositoryMap(entries, new Set(['src/link.ts'])),
            buildRepositoryMap(entries, new Set()),
        );
    });

    it('reports the three most common extensions and skips dotfiles and extension-less names', () => {
        // Language hints rank extensions by file count and name, but a dotfile (leading dot) and an extension-less
        // name are not languages, so they never occupy one of the three hint slots. 9 files, 1 directory, etc.
        const entries = [
            entry('.gitignore'),
            entry('LICENSE'),
            entry('a.ts'),
            entry('b.ts'),
            entry('c.ts'),
            entry('d.md'),
            entry('e.md'),
            entry('f.json'),
            entry('g.yaml'),
        ];

        assert.equal(
            buildRepositoryMap(entries, new Set()),
            '9 files, 1 directory (.ts 3, .md 2, .json 1)\n(root)  9 files',
        );
    });

    it('omits the parenthesised language hints when no file carries an extension', () => {
        // With nothing to rank, the header ends after the directory count instead of printing empty parentheses.
        assert.equal(
            buildRepositoryMap([entry('Makefile'), entry('LICENSE')], new Set()),
            '2 files, 1 directory\n(root)  2 files',
        );
    });

    it('uses singular forms for one file, one directory, and one changed file', () => {
        // Counts are user-facing text, so 1 file / 1 directory / [1 changed] must not be pluralised.
        assert.equal(
            buildRepositoryMap([entry('a.ts'), entry('src/b.ts')], new Set(['src/b.ts'])),
            [
                '2 files, 2 directories (.ts 2)',
                'src     1 file   [1 changed]',
                '(root)  1 file',
            ].join('\n'),
        );
    });

    it('caps the padded path column so one long directory cannot push every count off the row', () => {
        // Padding aligns the counts, but it is capped at 44 characters: a deeper directory keeps its full name and
        // the remaining rows pad to the cap rather than to that outlier.
        const deep = `very/${'nested/'.repeat(6)}deep`;

        assert.equal(
            buildRepositoryMap([entry(`${deep}/f.ts`), entry('src/a.ts')], new Set()),
            [
                '2 files, 2 directories (.ts 2)',
                `${'src'.padEnd(44)}  1 file`,
                `${deep}  1 file`,
            ].join('\n'),
        );
    });

    it('returns the same bytes for the same manifest on every call', () => {
        // The map is a pure function of its inputs: two calls build the identical string and neither call mutates
        // the manifest or the changed-path set it was given.
        const entries = [
            ...directoryEntries(12),
            entry('README.md'),
            entry('src/a.ts'),
            entry('src/b.ts'),
        ];
        const changedPaths = new Set(['dir03/f.ts', 'src/b.ts']);

        const first = buildRepositoryMap(entries, changedPaths);
        const second = buildRepositoryMap(entries, changedPaths);

        assert.equal(first, second);
        assert.equal(entries.length, 15);
        assert.deepEqual([...changedPaths], ['dir03/f.ts', 'src/b.ts']);
    });

    it('reports an empty manifest as zero files and zero directories', () => {
        // An empty snapshot still has to render: the header states both zeros and no rows or summary follow.
        assert.equal(buildRepositoryMap([], new Set()), '0 files, 0 directories');
    });
});
