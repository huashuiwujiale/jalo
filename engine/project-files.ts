import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolRegistry } from './tools';
import { version } from './syntax';
import type { Project, FileReference, CapturedReference, FilePage, RunChange } from '../shared/types';
import { createTwoFilesPatch } from 'diff';
import { randomUUID } from 'node:crypto';
export async function projectFiles(root: string) {
  const tools = new ToolRegistry({ root, backupDir: '', signal: new AbortController().signal, timeout: 1, mode: 'review', emit: () => {}, approve: async () => false });
  await tools.init(); return tools;
}
export async function searchFiles(root: string, query: string) {
  const tools = await projectFiles(root), paths: string[] = [];
  const ignored = new Set(['.git','node_modules','dist','build','.next','.venv','coverage']);
  let visited = 0, truncated = false;
  async function walk(relative = '.') {
    for (const e of await fs.readdir(await tools.resolve(relative), { withFileTypes: true })) {
      if (++visited > 10000 || paths.length >= 80) { truncated = true; return; }
      if (e.isSymbolicLink() || ignored.has(e.name)) continue;
      const file = path.join(relative, e.name);
      if (e.isDirectory()) await walk(file);
      else if (e.isFile() && file.toLowerCase().includes(query.toLowerCase())) paths.push(file);
      if (truncated) return;
    }
  }
  await walk(); return { paths, truncated };
}
export async function previewFile(root: string, file: string, startLine = 1): Promise<FilePage> {
  const tools = await projectFiles(root), text = await tools.read(await tools.resolve(file));
  const lines = text.split('\n');
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > lines.length) throw new Error('预览起始行越界');
  const selected: string[] = []; let size = 0;
  for (const line of lines.slice(startLine - 1, startLine + 99)) {
    if (size + line.length > 16000) break;
    selected.push(line); size += line.length + 1;
  }
  if (!selected.length) throw new Error('单行超过预览上限，无法完整引用该行');
  const endLine = startLine + selected.length - 1;
  return { path: file, version: version(text), totalLines: lines.length, startLine, endLine, content: selected.join('\n'), hasMore: endLine < lines.length };
}
export async function captureReferences(project: Project, references: FileReference[]): Promise<CapturedReference[]> {
  const tools = await projectFiles(project.path), captured: CapturedReference[] = []; let size = 0;
  for (const ref of references) {
    if (ref.projectId !== project.id) throw new Error(`文件引用属于其他项目，请移除或重新选择：${ref.path}`);
    let text: string;
    try { text = await tools.read(await tools.resolve(ref.path)); }
    catch (e: any) { throw new Error(`文件引用失效 ${ref.path}：${e.code === 'ENOENT' ? '文件不存在' : e.message}`); }
    if (version(text) !== ref.version) throw new Error(`文件已被外部修改，请重新预览并选择引用：${ref.path}`);
    const lines = text.split('\n');
    if (!Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine || ref.endLine > lines.length || ref.endLine - ref.startLine >= 400) throw new Error(`引用行范围越界：${ref.path}`);
    const content = lines.slice(ref.startLine - 1, ref.endLine).join('\n'); size += content.length;
    if (size > 12000) throw new Error('引用总内容超过 12000 字符，请缩小行范围');
    captured.push({ ...ref, content });
  }
  return captured;
}
export async function rollbackPreview(root: string, change: RunChange) {
  if (change.state !== 'written' || !change.runId) throw new Error('没有可核验的写入记录，无法安全回退');
  const tools = await projectFiles(root), full = await tools.resolve(change.path);
  if ((await fs.stat(full)).nlink > 1) throw new Error('不能回退具有多个硬链接的文件');
  const current = await tools.read(full);
  if (version(current) !== change.afterVersion || current !== change.after) throw new Error('回退冲突：当前文件包含后续轮次或外部修改，拒绝覆盖');
  return createTwoFilesPatch(`a/${change.path}`, change.before === null ? '/dev/null' : `b/${change.path}`, current, change.before || '');
}
export async function restoreFile(root: string, change: RunChange, recoveryDir: string) {
  await rollbackPreview(root, change);
  const tools = await projectFiles(root), full = await tools.resolve(change.path);
  await fs.mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  const log = path.join(recoveryDir, randomUUID() + '.json');
  // A recoverable copy is persisted before removal/replacement, including new files.
  const record = { ...change, rollbackAt: Date.now(), state: 'prepared' };
  const handle = await fs.open(log, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  const temp = path.join(path.dirname(full), `.jalo-restore-${randomUUID()}`);
  try {
    if (change.before !== null) await fs.writeFile(temp, change.before, { flag: 'wx', mode: (await fs.stat(full)).mode & 0o777 });
    await rollbackPreview(root, change); // Final comparison after preparing the replacement.
    if (change.before === null) await fs.unlink(full); else await fs.rename(temp, full);
    if (change.before === null) { try { await fs.lstat(full); throw new Error('回退后文件仍存在，需人工检查'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } }
    else if (await tools.read(await tools.resolve(change.path)) !== change.before) throw new Error('回退后核对失败，需人工检查');
    await fs.writeFile(log, JSON.stringify({ ...record, state: 'restored' }), { mode: 0o600 });
    return log;
  } finally { await fs.unlink(temp).catch(() => {}); }
}
