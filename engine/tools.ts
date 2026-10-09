import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CommandOutputWriter } from './command-output';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createTwoFilesPatch } from 'diff';
import { checkSyntax, version } from './syntax';
import { findVueElements } from './vue-elements';
import { searchIgnored as ignored, walkSearchFiles } from './file-search';
import type { Approval, Change, EngineEvent, RunEvidence, Mode, RunChange, CommandSession } from '../shared/types';
import type { ToolDefinition } from './provider';

const str = z.string().max(48000);
const relative = z.string().min(1).max(1024);
const vueSelector = z.object({ tag: z.string().min(1).max(100), attributes: z.record(z.string().max(200), z.string().max(2000)).optional(), text: z.string().max(1000).optional() }).strict();
const specs = {
  find_vue_elements: { description: '读取并定位 Vue template 中的完整元素。按 tag、attributes 中的属性原名和字面值精确匹配，例如 {tag:"el-button",attributes:{"@click":"handleAdd"}}。text 可精确匹配直接文本（去除首尾空白）。返回完整原文、行号和版本；多个匹配时收窄条件，不猜行号。', schema: z.object({ path: relative, selector: vueSelector }).strict() },
  edit_vue_element: { description: '替换唯一匹配的完整 Vue 元素。必须先 find_vue_elements 用相同 selector 得到唯一且完整显示的结果，expectedVersion 使用返回版本。newText 为空表示删除；保留周围元素。多个匹配、过期版本或语法错误均不写入。', schema: z.object({ path: relative, selector: vueSelector, expectedVersion: z.string().length(64), newText: str }).strict() },
  list_directory: { description: '列出项目内目录；最多 200 项。', schema: z.object({ path: relative.default('.') }).strict() },
  search_files: { description: '按文件名或文本字面量搜索项目，遵守 .gitignore，忽略依赖目录及符号链接。可按 path 目录和 extensions 扩展名过滤。', schema: z.object({ query: z.string().min(1).max(200), mode: z.enum(['name', 'content']), path: relative.default('.'), extensions: z.array(z.string().regex(/^[a-zA-Z0-9]+$/)).max(10).optional() }).strict() },
  read_file: { description: '读取 UTF-8 文本并建立修改前的版本检查。大文件可分页读取。', schema: z.object({ path: relative, startLine: z.number().int().min(1).default(1), lines: z.number().int().min(1).max(400).default(200) }).strict() },
  write_file: { description: '创建或替换 UTF-8 文件。修改现有文件前必须 read_file；遇到外部修改须重新读取。', schema: z.object({ path: relative, content: str }).strict() },
  edit_file: { description: '精确原文替换，不支持正则。必须先 read_file。oldText 保留原有空格与换行，不包含显示用行号。存在多处相同文本时，同时传 startLine/endLine 限定已读取的目标行范围，范围内仍须唯一匹配。', schema: z.object({ path: relative, oldText: str.min(1).describe('直接复制文件原文，不要添加正则转义或行号'), newText: str, startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }).strict().refine(a => (a.startLine === undefined && a.endLine === undefined) || (a.startLine !== undefined && a.endLine !== undefined && a.endLine >= a.startLine), 'startLine 和 endLine 必须同时传入，且 endLine 不小于 startLine') },
  replace_lines: { description: '按最近一次 read_file 已完整显示的行号替换整行，包含 startLine 和 endLine。删除代码块时优先使用；newText 为空字符串表示删除。无需复制 oldText，替换内容须自行保留正确缩进。每次修改后必须重新读取才能再次按行编辑。', schema: z.object({ path: relative, startLine: z.number().int().min(1), endLine: z.number().int().min(1), newText: str }).strict().refine(a => a.endLine >= a.startLine, 'endLine 不得小于 startLine') },
  run_command: { description: '申请用户确认后在指定项目目录执行 zsh 命令。每次执行都需要确认；非系统沙箱。', schema: z.object({ command: z.string().min(1).max(8000), cwd: relative.default('.') }).strict() },
  show_changes: { description: '查看本次会话通过文件工具产生的修改；不包含原有 Git 改动或命令造成的改动。', schema: z.object({}).strict() },
};
export const definitions: ToolDefinition[] = Object.entries(specs).map(([name, spec]) => ({
  type: 'function', function: { name, description: spec.description, parameters: zodToJsonSchema(spec.schema, { $refStrategy: 'none' }) as Record<string, unknown> },
}));
const mutations = new Set(['write_file', 'edit_file', 'replace_lines', 'edit_vue_element', 'run_command']);
export const toolsForMode = (mode: Mode = 'execute') => definitions.filter(t => mode === 'execute' || !mutations.has(t.function.name));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const isMissing = (e: any) => e?.code === 'ENOENT';
export class EditMatchError extends Error {
  constructor(public file: string, message: string) { super(message); this.name = 'EditMatchError'; }
}
export interface ToolOptions {
  commandDirectory?: string;
  root: string; signal: AbortSignal; timeout: number; backupDir: string;
  emit: (event: EngineEvent) => void;
  approve: (approval: Approval) => Promise<boolean>;
  changes?: Change[]; mode?: Mode; runId?: string; reviewChanges?: Pick<Change, 'path' | 'patch'>[]; checkpoint?: (change: RunChange) => Promise<void>;
}
export class ToolRegistry {
  private root = '';
  private blocked = new Set<string>();
  mode() { return this.options.mode || 'execute'; }
  toolDefinitions() { return toolsForMode(this.mode()); }
  private seen = new Map<string, string>();
  private vueTargets = new Map<string, { version: string; selector: string; start: number; end: number }>();
  private readRanges = new Map<string, { start: number; end: number }>();
  private instructions = new Map<string, string>();
  private changes = new Map<string, Change>();
  private successfulTools = new Set<string>();
  private runChanges = new Map<string, { before: string | null; after: string }>();
  evidence(): RunEvidence {
    return { successfulTools: [...this.successfulTools], changedFiles: [...this.runChanges].filter(([, c]) => c.before !== c.after).map(([file]) => file) };
  }
  constructor(private options: ToolOptions) { for (const c of options.changes || []) this.changes.set(c.path, c); }
  async init() { this.root = await fs.realpath(this.options.root); }
  private check(full: string) {
    const rel = path.relative(this.root, full);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('路径越出项目范围');
    if (rel.split(path.sep).includes('.git')) throw new Error('文件工具不允许修改或读取 .git 内部数据');
  }
  async resolve(input: string) {
    if (path.isAbsolute(input) || input.includes('\0')) throw new Error('请使用项目内的相对路径');
    const target = path.resolve(this.root, input); this.check(target);
    // Resolve the closest existing ancestor as well as the target, so symlink parents cannot escape.
    let cursor = target;
    for (;;) {
      try {
        const info = await fs.lstat(cursor);
        const real = await fs.realpath(cursor); this.check(real);
        if (info.isSymbolicLink()) throw new Error('文件工具不访问符号链接，请使用实际项目路径');
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = path.dirname(cursor); if (parent === cursor) throw error; cursor = parent;
      }
    }
    // Reject all symlink components, including links pointing within the project.
    let current = this.root;
    for (const segment of path.relative(this.root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('路径包含符号链接'); } catch (e) { if (!isMissing(e)) throw e; }
    }
    return target;
  }
  async read(full: string): Promise<string> {
    const handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 262144) throw new Error('仅支持 256 KB 以内的普通文本文件');
      const buffer = await handle.readFile();
      if (buffer.includes(0)) throw new Error('不支持二进制文件');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } finally { await handle.close(); }
  }
  async projectInstructions(input = '.') {
    const full = await this.resolve(input);
    let directory = full;
    try { if (!(await fs.stat(full)).isDirectory()) directory = path.dirname(full); } catch (e) { if (!isMissing(e)) throw e; directory = path.dirname(full); }
    const dirs = [this.root];
    let current = this.root;
    for (const segment of path.relative(this.root, directory).split(path.sep).filter(Boolean)) { current = path.join(current, segment); dirs.push(current); }
    const found: string[] = [];
    for (const dir of dirs) {
      const agentPath = path.join(dir, 'AGENTS.md');
      try {
        const safe = await this.resolve(path.relative(this.root, agentPath));
        const text = await this.read(safe);
        if (text.length > 16000) throw new Error('AGENTS.md 过长，请缩短项目指令');
        if (this.instructions.get(safe) !== hash(text)) {
          this.instructions.set(safe, hash(text));
          found.push(`项目指令 ${path.relative(this.root, safe)}（适用于该目录及子目录）：\n${text}`);
        }
      } catch (e) { if (!isMissing(e)) throw e; }
    }
    return found.join('\n\n');
  }
  async execute(name: string, raw: unknown): Promise<string> {
    this.options.signal.throwIfAborted();
    if (this.mode() !== 'execute' && mutations.has(name)) throw new Error('只读模式禁止文件写入和终端命令');
    const spec = specs[name as keyof typeof specs];
    if (!spec) throw new Error(`未知工具：${name}`);
    const args: any = spec.schema.parse(raw);
    const instructions = await this.projectInstructions(args.path || args.cwd || '.');
    if (instructions && mutations.has(name)) {
      return `尚未执行操作。请先遵守以下新发现的项目指令，然后重新调用工具：\n${instructions}`;
    }
    let result: string;
    if (name === 'find_vue_elements' || name === 'edit_vue_element') {
      if (!args.path.endsWith('.vue')) throw new Error('结构化元素工具仅支持 .vue 文件');
      const full = await this.resolve(args.path), source = await this.read(full), currentVersion = hash(source);
      const selectorKey = JSON.stringify([args.selector.tag, Object.entries(args.selector.attributes || {}).sort(([a], [b]) => a.localeCompare(b)), args.selector.text ?? null]);
      if (name === 'find_vue_elements') this.vueTargets.delete(full);
      const matches = findVueElements(source, args.selector);
      if (name === 'find_vue_elements') {
        const visible = matches.slice(0, 20).map(m => ({ startLine: m.startLine, endLine: m.endLine, source: m.source.slice(0, 1000), truncated: m.source.length > 1000 }));
        if (matches.length === 1 && matches[0].source.length <= 20000) {
          visible[0] = { startLine: matches[0].startLine, endLine: matches[0].endLine, source: matches[0].source, truncated: false };
          this.seen.set(full, currentVersion);
          this.vueTargets.set(full, { version: currentVersion, selector: selectorKey, start: matches[0].start, end: matches[0].end });
        }
        result = JSON.stringify({ version: currentVersion, count: matches.length, candidates: visible, editable: this.vueTargets.has(full), message: matches.length === 1 ? '仅完整显示的唯一元素可以编辑；newText 为空可删除。' : '请按候选原文补充属性或 text，重新查找直至唯一匹配。' });
      } else {
        const target = this.vueTargets.get(full);
        if (!target || target.version !== currentVersion || args.expectedVersion !== currentVersion || target.selector !== selectorKey) throw new Error('定位记录失效或文件已更改，请用相同条件重新 find_vue_elements，得到唯一完整元素后再编辑');
        if (matches.length !== 1 || matches[0].start !== target.start || matches[0].end !== target.end) throw new EditMatchError(args.path, '元素不是唯一匹配，请收窄条件重新查找');
        const content = source.slice(0, target.start) + args.newText + source.slice(target.end);
        // Reuse all existing version, syntax, backup, checkpoint and write verification gates.
        result = await this.write(args.path, { content }, false);
        this.vueTargets.delete(full);
      }
    } else if (name === 'list_directory') {
      const entries: string[] = []; let truncated = false;
      const handle = await fs.opendir(await this.resolve(args.path));
      for await (const entry of handle) {
        this.options.signal.throwIfAborted();
        if (ignored.has(entry.name)) continue;
        if (entries.length >= 200) { truncated = true; break; }
        entries.push(`${entry.isDirectory() ? '[目录]' : entry.isSymbolicLink() ? '[链接，不访问]' : '[文件]'} ${entry.name}`);
      }
      result = entries.join('\n');
      if (truncated) result += '\n结果已截断';
    } else if (name === 'read_file') {
      const full = await this.resolve(args.path), text = await this.read(full);
      this.seen.set(full, hash(text));
      const lines = text.split('\n');
      const displayed: string[] = []; let length = 0;
      for (let i = args.startLine - 1; i < Math.min(lines.length, args.startLine - 1 + args.lines); i++) {
        const line = `${i + 1}: ${lines[i]}`;
        if (length + line.length + 1 > 24000) break;
        displayed.push(line); length += line.length + 1;
      }
      this.readRanges.set(full, { start: args.startLine, end: args.startLine + displayed.length - 1 });
      result = `共 ${lines.length} 行；版本 ${hash(text).slice(0, 12)}。下列行号仅供定位，不属于原文。删除整段代码优先使用 replace_lines，newText 传空字符串。edit_file 使用精确原文，不支持正则。\n${displayed.join('\n')}${displayed.length < Math.min(args.lines, Math.max(0, lines.length - args.startLine + 1)) ? '\n输出已截断，只能按行编辑上方完整显示的行。' : ''}`;
    } else if (name === 'write_file' || name === 'edit_file' || name === 'replace_lines') {
      result = await this.write(args.path, args, name !== 'write_file', name === 'replace_lines');
    } else if (name === 'search_files') {
      const results: string[] = [], budget = { maxEntries: 3000, visited: 0, truncated: false };
      const needle = args.query.toLowerCase(), signal = this.options.signal;
      for await (const rel of walkSearchFiles(this, args.path, budget, signal)) {
        if (args.extensions?.length && !args.extensions.map((s: string) => s.toLowerCase()).includes(path.extname(rel).slice(1).toLowerCase())) continue;
        if (args.mode === 'name') { if (rel.toLowerCase().includes(needle)) results.push(rel); }
        else {
          try {
            const contents = await this.read(await this.resolve(rel));
            // Walk lines without allocating a full split array, stopping at the cap.
            let start = 0, lineNumber = 1;
            while (start <= contents.length && results.length < 50) {
              signal.throwIfAborted();
              const newline = contents.indexOf('\n', start), end = newline < 0 ? contents.length : newline;
              const line = contents.slice(start, end);
              if (line.includes(args.query)) results.push(`${rel}:${lineNumber}: ${line.slice(0, 240)}`);
              if (newline < 0) break;
              start = newline + 1; lineNumber++;
            }
          } catch { signal.throwIfAborted(); } // Unreadable/non-text files are skipped.
        }
        if (results.length >= 50) { budget.truncated = true; break; }
      }
      result = results.join('\n') || '没有匹配结果';
      if (budget.truncated) result += '\n搜索未遍历全部文件（达到上限或目录不可访问），请缩小目录或查询范围';
    } else if (name === 'run_command') {
      result = await this.command(args.command, await this.resolve(args.cwd));
    } else {
      result = (this.options.reviewChanges || [...this.changes.values()]).map(c => c.patch).join('\n').slice(0, 32000) || '本次任务暂无文件工具修改';
    }
    if (!result.startsWith('用户拒绝了该命令')) this.successfulTools.add(name);
    return instructions ? `${instructions}\n\n${result}` : result;
  }
  private async write(input: string, args: any, edit: boolean, lineEdit = false) {
    const full = await this.resolve(input);
    if (this.blocked.has(full)) throw new EditMatchError(input, '原文件已有语法错误，本轮已暂停此文件自动写入，请人工修复后重新提交');
    let before: string | null = null;
    try { before = await this.read(full); } catch (e) { if (!isMissing(e)) throw e; }
    if (before !== null && this.seen.get(full) !== hash(before)) throw new Error('文件尚未读取或被外部修改，请重新 read_file 后再编辑');
    if (edit && before === null) throw new Error('文件不存在，请使用 write_file 创建');
    if (before !== null && (await fs.stat(full)).nlink > 1) throw new Error('不修改具有多个硬链接的文件');
    let after = args.content;
    if (edit) {
      const original = before!;
      const starts = [0];
      for (let i = 0; i < original.length; i++) if (original[i] === '\n') starts.push(i + 1);
      if (args.startLine !== undefined && (args.startLine > starts.length || args.endLine > starts.length)) {
        throw new EditMatchError(path.relative(this.root, full), `目标行范围越界，文件共 ${starts.length} 行。请重新 read_file 获取当前行号。`);
      }
      const start = args.startLine === undefined ? 0 : starts[args.startLine - 1];
      const end = args.endLine === undefined ? original.length : (starts[args.endLine] ?? original.length);
      if (lineEdit) {
        const readRange = this.readRanges.get(full);
        if (!readRange || args.startLine < readRange.start || args.endLine > readRange.end || start === end) {
          throw new Error('replace_lines 只能编辑最近一次 read_file 完整显示的非空行范围。请重新读取目标行后再修改。');
        }
        const oldText = original.slice(start, end);
        const eol = original.includes('\r\n') ? '\r\n' : '\n';
        let newText = args.newText.replace(/\r\n|\n/g, eol);
        if (newText && !newText.endsWith('\n') && (end < original.length || oldText.endsWith('\n'))) newText += eol;
        args = { ...args, oldText, newText };
      }
      const positions: number[] = [];
      const region = original.slice(start, end);
      let offset = 0, count = 0;
      while ((offset = region.indexOf(args.oldText, offset)) >= 0) {
        count++; if (positions.length < 8) positions.push(start + offset); offset++;
      }
      if (count !== 1) {
        const range = this.readRanges.get(full) || { start: 1, end: Math.min(20, starts.length) };
        const hintStart = Math.max(1, Math.min(args.startLine ?? range.start, starts.length));
        const hintEnd = Math.min(starts.length, args.endLine ?? range.end, hintStart + 39);
        const raw = original.slice(starts[hintStart - 1], starts[hintEnd] ?? original.length);
        const matchLines = positions.map(position => {
          let line = 0; while (line + 1 < starts.length && starts[line + 1] <= position) line++; return line + 1;
        });
        const problem = count === 0 ? 'oldText 没有匹配到文件原文。' : `oldText 匹配了 ${count} 次，候选行：${matchLines.join('、')}。请按用户要求选择目标，并用 startLine/endLine 限定范围。`;
        throw new EditMatchError(path.relative(this.root, full), `${problem}\nedit_file 只做精确文本替换，不支持正则表达式。不要把 \\s+、\\. 或显示用行号加入 oldText；不要原样重试失败的参数。请重新读取目标位置，复制原文后修正调用；删除或替换整段代码可改用 replace_lines，使用刚读取的 startLine/endLine，删除时 newText 传空字符串。\n以下为文件第 ${hintStart}–${hintEnd} 行的当前原文（JSON 字符串，按 JSON 解码后复制）：\n${JSON.stringify(raw.slice(0, 4000))}${raw.length > 4000 ? '\n原文已截断，请缩小范围重新读取。' : ''}`);
      }
      const position = positions[0];
      after = original.slice(0, position) + args.newText + original.slice(position + args.oldText.length);
    }
    if (Buffer.byteLength(after) > 262144) throw new Error('修改后文件超过 256 KB');
    const rel = path.relative(this.root, full);
    if (this.changes.has(rel) && this.changes.get(rel)!.after !== before) throw new Error('本任务已修改的文件又被外部更改。为避免混入他人改动，请在新任务中继续编辑该文件。');
    if (after === before) return `文件内容未改变：${rel}`;
    let vueMajor: 2 | 3 | undefined;
    if (rel.endsWith('.vue')) {
      // Read dependency declarations only. Do not import any project package.
      let dir = path.dirname(full);
      for (;;) {
        try { const pkg = JSON.parse(await this.read(await this.resolve(path.relative(this.root, path.join(dir, 'package.json'))))); const dep = pkg.dependencies?.vue || pkg.devDependencies?.vue || pkg.peerDependencies?.vue; const major = String(dep || '').match(/(?:^|[^0-9])([23])\./)?.[1]; if (major) { vueMajor = Number(major) as 2 | 3; break; } }
        catch (e: any) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
        if (dir === this.root) break; dir = path.dirname(dir);
      }
    }
    if (before !== null) {
      const originalCheck = checkSyntax(rel, before, vueMajor);
      if (originalCheck.status === 'failed') {
        this.blocked.add(full); originalCheck.message = '原文件已有语法错误，暂停自动写入：' + originalCheck.message;
        this.options.emit({ type: 'check', check: originalCheck });
        throw new EditMatchError(rel, originalCheck.message);
      }
    }
    const check = checkSyntax(rel, after, vueMajor);
    this.options.emit({ type: 'check', check });
    if (check.status === 'failed') throw new EditMatchError(rel, '候选内容语法检查失败，未写入：' + check.message);
    const runBefore = this.runChanges.has(rel) ? this.runChanges.get(rel)!.before : before;
    const checkpoint: RunChange = { id: hash((this.options.runId || '') + rel), runId: this.options.runId || '', path: rel, before: runBefore, after, beforeVersion: runBefore === null ? null : version(runBefore), afterVersion: version(after), check, state: 'prepared', patch: createTwoFilesPatch(runBefore === null ? '/dev/null' : `a/${rel}`, `b/${rel}`, runBefore || '', after) };
    // Main process persists this checkpoint to SQLite and acknowledges it before commit.
    await this.options.checkpoint?.(checkpoint);
    const baseline = this.changes.has(rel) ? this.changes.get(rel)!.before : before;
    // Write the original to a private backup before touching the project, even if the app crashes.
    await fs.mkdir(this.options.backupDir, { recursive: true, mode: 0o700 });
    const backup = path.join(this.options.backupDir, hash(rel) + '.json');
    try { await fs.writeFile(backup, JSON.stringify({ path: rel, before: baseline }), { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as any).code !== 'EEXIST') throw e; }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await this.resolve(input);
    this.options.signal.throwIfAborted();
    const mode = before === null ? 0o644 : (await fs.stat(full)).mode & 0o777;
    const temp = path.join(path.dirname(full), `.local-code-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, after, { flag: 'wx', mode });
      // Recheck immediately before commit. Existing user changes are never silently overwritten.
      let latest: string | null = null;
      try { latest = await this.read(await this.resolve(input)); } catch (e) { if (!isMissing(e)) throw e; }
      if (latest !== before) throw new Error('写入前检测到外部修改，请重新读取');
      this.options.signal.throwIfAborted();
      if (before === null) { await fs.link(temp, full); await fs.unlink(temp); }
      else await fs.rename(temp, full);
    } finally { await fs.unlink(temp).catch(() => {}); }
    if (await this.read(await this.resolve(input)) !== after) throw new Error('写入后核对失败，请检查磁盘内容；本轮检查点未标记为成功');
    checkpoint.state = 'written';
    this.seen.set(full, hash(after));
    this.readRanges.delete(full); // Line numbers become stale after any write.
    this.runChanges.set(rel, { before: this.runChanges.has(rel) ? this.runChanges.get(rel)!.before : before, after });
    const change: Change = { path: rel, before: baseline, after, patch: createTwoFilesPatch(baseline === null ? '/dev/null' : `a/${rel}`, `b/${rel}`, baseline || '', after) };
    this.changes.set(rel, change); this.options.emit({ type: 'change', change, checkpoint });
    return `已修改 ${rel}（${check.message}）\n${change.patch.slice(0, 12000)}`;
  }
  private async command(command: string, cwd: string) {
    const approval: Approval = { id: randomUUID(), command, cwd, timeout: this.options.timeout };
    const approved = await this.options.approve(approval);
    this.options.signal.throwIfAborted();
    if (!approved) return '用户拒绝了该命令。未执行，不得尝试通过其他工具绕过。';
    await this.resolve(path.relative(this.root, cwd) || '.');
    const record: CommandSession = { id: randomUUID(), command, cwd, startedAt: Date.now(), status: 'running' };
    const log = this.options.commandDirectory ? new CommandOutputWriter(this.options.commandDirectory, record.id) : undefined;
    this.options.emit({ type: 'command', command: { ...record } });
    return new Promise<string>((resolve, reject) => {
      const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER'].filter(k => process.env[k]).map(k => [k, process.env[k]!]));
      const child = spawn('/bin/zsh', ['-f', '-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid) this.options.emit({ type: 'process', pid: child.pid, running: true });
      let output = '', tail = '', displayed = 0, totalBytes = 0, clipped = false, timedOut = false, failure: unknown, escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
      const stop = () => { kill('SIGTERM'); escalation ??= setTimeout(() => kill('SIGKILL'), 700); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, this.options.timeout * 1000);
      const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); this.options.signal.removeEventListener('abort', stop); kill('SIGKILL'); if (child.pid) this.options.emit({ type: 'process', pid: child.pid, running: false }); };
      this.options.signal.addEventListener('abort', stop, { once: true });
      if (this.options.signal.aborted) stop();
      const append = (text: string) => {
        totalBytes += Buffer.byteLength(text); output += text.slice(0, Math.max(0, 32000 - output.length)); tail = (tail + text).slice(-16000);
        const chunk = text.slice(0, Math.max(0, 32000 - displayed)); displayed += chunk.length;
        if (chunk) this.options.emit({ type: 'event', event: { id: randomUUID(), at: Date.now(), kind: 'output', text: chunk } });
        if (chunk.length < text.length) clipped = true;
        if (!failure) try { log?.append(text); } catch (error) { failure = error; stop(); }
      };
      const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
      child.stdout.on('data', data => append(stdout.write(data))); child.stderr.on('data', data => append(stderr.write(data)));
      child.on('error', error => { failure = error; });
      child.on('close', (code, signal) => { append(stdout.end()); append(stderr.end()); cleanup(); this.seen.clear(); this.readRanges.clear();
        try { log?.close(); } catch (error) { failure ??= error; }
        this.options.emit({ type: 'command', command: { ...record, status: signal || failure || this.options.signal.aborted ? 'interrupted' : 'completed', endedAt: Date.now(), exitCode: code ?? undefined, timedOut, totalBytes, outputBytes: log?.bytes, outputTruncated: log?.truncated, tail } });
        if (failure) reject(failure);
        else if (this.options.signal.aborted) reject(new Error('任务已停止'));
        else resolve(`退出码：${code}${timedOut ? '；命令超时，已终止' : ''}\n${clipped ? output.slice(0, 16000) + '\n[中段省略；可在命令日志查看]\n' + tail : output}`);
      });
    });
  }
}
