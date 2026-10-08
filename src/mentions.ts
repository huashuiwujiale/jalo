import type { FileReference } from '../shared/types';

export interface Mention { start: number; end: number; query: string }
export function mentionAt(text: string, start: number, end = start): Mention | undefined {
  if (start !== end || start < 0 || start > text.length) return;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0,start));
  if (!match) return;
  return {start:start-match[1].length-1,end:start,query:match[1]};
}
export function insertMention(text: string, mention: Mention, path: string) {
  const inserted = path + ' ';
  return {text:text.slice(0,mention.start)+inserted+text.slice(mention.end),caret:mention.start+inserted.length};
}

export const referenceName = (path: string) => path.split('/').at(-1) || path;
export interface MentionSegment { text: string; reference?: FileReference }

/** Keep the original prompt paths; only their presentation becomes a file-name token. */
export function mentionSegments(text: string, references: FileReference[]): MentionSegment[] {
  const paths = [...new Map(references.map(ref => [ref.path, ref])).values()].filter(ref => ref.path).sort((a,b) => b.path.length-a.path.length);
  const parts: MentionSegment[] = [];
  const pathCharacter = /[\p{L}\p{N}_./\\-]/u;
  let cursor = 0;
  while (cursor < text.length) {
    let found: { at: number; ref: FileReference } | undefined;
    for (const ref of paths) {
      let at = text.indexOf(ref.path,cursor);
      while (at >= 0 && ((at > 0 && pathCharacter.test(text[at-1])) || pathCharacter.test(text[at+ref.path.length] || ''))) at = text.indexOf(ref.path,at+1);
      if (at >= 0 && (!found || at < found.at)) found = {at,ref};
    }
    if (!found) { parts.push({text:text.slice(cursor)}); break; }
    if (found.at > cursor) parts.push({text:text.slice(cursor,found.at)});
    parts.push({text:found.ref.path,reference:found.ref}); cursor = found.at+found.ref.path.length;
  }
  return parts;
}
