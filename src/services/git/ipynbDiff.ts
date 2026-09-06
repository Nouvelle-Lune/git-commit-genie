type NotebookCell = {
  cell_type: 'code' | 'markdown' | string;
  source?: string[] | string;
};

type Notebook = {
  cells?: NotebookCell[];
};

function normalizeSource(src: string[] | string | undefined): string[] {
  if (!src) { return []; }
  if (Array.isArray(src)) { return src.map(String); }
  return String(src).split(/\r?\n/);
}

function unifiedHeader(aPath: string, bPath: string): string[] {
  return [
    `diff --git a/${aPath} b/${bPath}`,
    `--- a/${aPath}`,
    `+++ b/${bPath}`,
  ];
}

/** Build source-only notebook evidence from the captured before/after blobs. */
export function buildNotebookSourceOnlyDiff(beforeStr: string | null, afterStr: string | null, oldRel: string, newRel: string): string {
    const beforeNb: Notebook = beforeStr === null ? { cells: [] } : JSON.parse(beforeStr);
    const afterNb: Notebook = afterStr === null ? { cells: [] } : JSON.parse(afterStr);
    const beforeCells = Array.isArray(beforeNb.cells) ? beforeNb.cells : [];
    const afterCells = Array.isArray(afterNb.cells) ? afterNb.cells : [];

    const header = unifiedHeader(oldRel, newRel);
    const meta: string[] = [];
    const body: string[] = [];

    const isRename = oldRel !== newRel;
    const isAdded = !beforeStr && !!afterStr;
    const isDeleted = !!beforeStr && !afterStr;

    if (isRename) {
      meta.push(`rename from ${oldRel}`);
      meta.push(`rename to ${newRel}`);
    }
    if (isAdded) {
      meta.push('new file mode 100644');
    }
    if (isDeleted) {
      meta.push('deleted file mode 100644');
    }

    const maxLen = Math.max(beforeCells.length, afterCells.length);
    for (let i = 0; i < maxLen; i++) {
      const b = beforeCells[i];
      const a = afterCells[i];
      const bSrc = b ? normalizeSource(b.source) : [];
      const aSrc = a ? normalizeSource(a.source) : [];
      const bType = b?.cell_type || 'unknown';
      const aType = a?.cell_type || 'unknown';

      const bothPresent = !!b && !!a;
      const sameType = bType === aType;
      const sameSrc = bSrc.join('\n') === aSrc.join('\n');

      if (bothPresent && sameType && sameSrc) { continue; } // unchanged cell

      // Start a simplified hunk per changed/added/removed cell
      body.push(`@@ cell ${i} (${b ? bType : 'none'} -> ${a ? aType : 'none'}) @@`);

      if (b) {
        // Show entire old cell source as deletions
        body.push(`-## cell ${i} (${bType})`);
        for (const line of bSrc) {
          // Guard against leading diff header markers
          if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            body.push(`-${line.replace(/^(-{3}|\+{3}) /, '')}`);
          } else {
            body.push(`-${line}`);
          }
        }
      }
      if (a) {
        // Show entire new cell source as additions
        body.push(`+## cell ${i} (${aType})`);
        for (const line of aSrc) {
          if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            body.push(`+${line.replace(/^(-{3}|\+{3}) /, '')}`);
          } else {
            body.push(`+${line}`);
          }
        }
      }
    }

    // If nothing changed in sources (e.g., only metadata/output changed), indicate so
    if (body.length === 0) {
      return [
        ...header,
        ...meta,
        '@@ notebook @@',
        '# No source changes; outputs/metadata ignored',
      ].join('\n');
    }

    return [...header, ...meta, ...body].join('\n');
}
