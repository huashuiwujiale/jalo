import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { SearchAccess } from './file-search';

export type IgnoreRule = { directory: string; matcher: Ignore };
export async function directoryRules(access: SearchAccess, directory: string, inherited: IgnoreRule[], observed?: (full: string) => Promise<void>): Promise<IgnoreRule[]> {
  let full: string;
  try { full = await access.resolve(path.join(directory, '.gitignore')); }
  catch (error: any) { if (error.code === 'ENOENT') return inherited; throw error; }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: any) { if (error.code === 'ENOENT') return inherited; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('忽略规则必须是项目内不超过 64 KiB 的普通文件');
    const buffer = Buffer.alloc(65537), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error('忽略规则过大');
    await observed?.(full);
    return [...inherited, { directory, matcher: ignore().add(buffer.subarray(0, bytesRead).toString('utf8')) }];
  } finally { await handle.close(); }
}
export function ignoredPath(rules: IgnoreRule[], relative: string, directory: boolean) {
  let ignored = false;
  for (const rule of rules) {
    const local = path.relative(rule.directory, relative).split(path.sep).join('/') + (directory ? '/' : '');
    if (!local || local.startsWith('../')) continue;
    const result = rule.matcher.test(local);
    if (result.ignored) ignored = true; else if (result.unignored) ignored = false;
  }
  return ignored;
}
