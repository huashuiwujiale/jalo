import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { projectFiles } from './project-files';
import { version } from './syntax';
import type { GitFile, GitStatus, GitPatch } from '../shared/types';

const exec = promisify(execFile), maxFile = 262144;
async function git(root: string, args: string[], maxBuffer = 2 * 1024 * 1024) {
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]!]));
  const { stdout } = await exec('/usr/bin/git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-C', root, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }, timeout: 10000, maxBuffer, encoding: 'buffer',
  });
  return stdout;
}
async function repository(root: string) {
  const real = await fs.realpath(root);
  let top: string;
  try { top = (await git(real, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\n$/, ''); }
  catch (error) {
    if (/not a git repository/.test(String((error as any).stderr))) return undefined;
    throw new Error('无法读取 Git 仓库，请检查 Git 是否可用');
  }
  if (await fs.realpath(top) !== real) throw new Error('请选择 Git 仓库根目录，不能查看项目外的 Git 改动');
  return real;
}
async function head(root: string) {
  try { return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toString('utf8').trim(); }
  catch (error) { if ((error as any).code === 1) return undefined; throw error; }
}
export function parseGitStatus(text: string): GitFile[] {
  const records = text.split('\0'), files: GitFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Git 状态格式无效');
    const file: GitFile = { path: record.slice(3), index: record[0], workingTree: record[1] };
    if ('RC'.includes(file.index) || 'RC'.includes(file.workingTree)) { file.originalPath = records[++i]; if (!file.originalPath) throw new Error('Git 重命名格式无效'); }
    files.push(file);
  }
  return files;
}
async function status(root: string) {
  return parseGitStatus((await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])).toString('utf8'));
}
export async function gitStatus(root: string): Promise<GitStatus> {
  const real = await repository(root);
  if (!real) return { available: false, files: [], truncated: false };
  const files = await status(real);
  return { available: true, files: files.slice(0, 200), truncated: files.length > 200 };
}
function decode(buffer: Buffer) {
  if (buffer.includes(0)) throw new Error('二进制文件不提供文本差异');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('文件不是有效的 UTF-8 文本'); }
}
export async function gitPatch(root: string, file: string, expectedVersion?: string): Promise<GitPatch> {
  const real = await repository(root); if (!real) throw new Error('项目尚未初始化 Git');
  const tools = await projectFiles(real), full = await tools.resolve(file);
  const entry = (await status(real)).slice(0, 200).find(f => f.path === file);
  if (!entry) throw new Error('该文件不在当前 Git 改动列表，请刷新');
  const base = await head(real), original = entry.originalPath || file;
  await tools.resolve(original);
  let before: string | null = null;
  // Untracked/new files have no HEAD blob. Never run diff drivers or textconv.
  if (base && entry.index !== '?' && entry.index !== 'A') {
    const object = `${base}:${original}`;
    const size = Number((await git(real, ['cat-file', '-s', object], 1024)).toString('utf8'));
    if (!Number.isSafeInteger(size) || size > maxFile) throw new Error('仅支持 256 KB 以内文件的文本差异');
    before = decode(await git(real, ['cat-file', 'blob', object], maxFile + 1));
  }
  let after: string | null;
  try { after = await tools.read(full); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; after = null; }
  const patch = createTwoFilesPatch(before === null ? '/dev/null' : `a/${JSON.stringify(original)}`, after === null ? '/dev/null' : `b/${JSON.stringify(file)}`, before || '', after || '');
  // Reject a change during capture; submitting a review checks this version again.
  let latest: string | null;
  try { latest = await tools.read(await tools.resolve(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; latest = null; }
  const latestEntry = (await status(real)).slice(0, 200).find(f => f.path === file);
  if (latest !== after || await head(real) !== base || JSON.stringify(latestEntry) !== JSON.stringify(entry)) throw new Error('读取期间 Git 改动发生变化，请刷新差异');
  const digest = version(JSON.stringify({ base, entry, before, after, patch }));
  if (expectedVersion && digest !== expectedVersion) throw new Error('Git 差异已变化，请重新选择审查目标');
  return { path: file, version: digest, patch: patch.slice(0, 48000), truncated: patch.length > 48000, deleted: after === null };
}
