export interface DiffLine { text: string; kind: 'addition' | 'deletion' | 'hunk' | 'context' | 'metadata'; oldLine?: number; newLine?: number }
export function diffLines(patch: string): DiffLine[] {
  let oldLine = 0, newLine = 0, body = false;
  return patch.split('\n').map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); body = true; return { text, kind: 'hunk' }; }
    if (!body || text.startsWith('\\') || !/^[ +\-]/.test(text)) return { text, kind: 'metadata' };
    if (text[0] === '+') return { text, kind: 'addition', newLine: newLine++ };
    if (text[0] === '-') return { text, kind: 'deletion', oldLine: oldLine++ };
    return { text, kind: 'context', oldLine: oldLine++, newLine: newLine++ };
  });
}
