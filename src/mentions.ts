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
