import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { directoryRules, ignoredPath, type IgnoreRule } from './search-ignore';

export const searchIgnored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'coverage']);
export interface SearchAccess { resolve(relative: string): Promise<string> }
export interface SearchBudget { maxEntries: number; visited: number; truncated: boolean }
type DirectoryStamp = { path: string; stamp: string };
const stamp = (info: Awaited<ReturnType<typeof fs.lstat>>) => `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

// A bounded breadth-first walk keeps only one directory handle open. A consumer
// stopping at its result limit closes that handle and never visits queued folders.
export async function* walkSearchFiles(access: SearchAccess, directory: string, budget: SearchBudget, signal?: AbortSignal,
  onDirectory?: (full: string) => Promise<void>) {
  let inherited: IgnoreRule[] = [];
  const ancestors = directory.split(path.sep).filter(part => part && part !== '.');
  for (let i = 0; i < ancestors.length; i++) inherited = await directoryRules(access, i ? ancestors.slice(0, i).join(path.sep) : '.', inherited, onDirectory);
  const pending = [{ directory, rules: inherited }];
  for (let i = 0; i < pending.length; i++) {
    signal?.throwIfAborted();
    if (budget.visited >= budget.maxEntries) { budget.truncated = true; return; }
    let rules: IgnoreRule[], full: string, handle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      full = await access.resolve(pending[i].directory);
      await onDirectory?.(full);
      rules = await directoryRules(access, pending[i].directory, pending[i].rules, onDirectory);
      handle = await fs.opendir(full);
    } catch (error) {
      signal?.throwIfAborted();
      if (i === 0) throw error;
      budget.truncated = true; // A disappearing or unreadable folder is incomplete.
      continue;
    }
    for await (const entry of handle) {
      signal?.throwIfAborted();
      if (++budget.visited > budget.maxEntries) { budget.truncated = true; return; }
      if (entry.isSymbolicLink() || searchIgnored.has(entry.name)) continue;
      const relative = path.join(pending[i].directory, entry.name);
      if (ignoredPath(rules!, relative, entry.isDirectory())) continue;
      if (entry.isDirectory()) pending.push({ directory: relative, rules: rules! });
      else if (entry.isFile()) yield relative;
    }
  }
}

type Index = { files: { path: string; lower: string }[]; directories: DirectoryStamp[]; truncated: boolean; builtAt: number;
  dirty: boolean; watchers: Map<string, FSWatcher> };
type Cached = { index?: Index; pending?: Promise<Index>; disposed?: boolean };

function release(index?: Index) {
  if (!index) return;
  index.dirty = true;
  for (const watcher of index.watchers.values()) watcher.close();
  index.watchers.clear();
}

export class FileNameIndex {
  private projects = new Map<string, Cached>();
  constructor(private options: { maxEntries?: number; maxProjects?: number; maxAgeMs?: number; now?: () => number } = {}) {}
  clear(root?: string) {
    for (const [key, entry] of this.projects) if (root === undefined || key === root) {
      entry.disposed = true; release(entry.index); this.projects.delete(key);
    }
  }
  async search(root: string, query: string, access: SearchAccess, limit = 80) {
    let cached = this.projects.get(root);
    if (!cached) { cached = {}; this.projects.set(root, cached); }
    // Refresh LRU position. Each project has at most one scan/validation in flight.
    this.projects.delete(root); this.projects.set(root, cached);
    while (this.projects.size > (this.options.maxProjects ?? 8)) this.clear(this.projects.keys().next().value!);
    if (!cached.pending) {
      const entry = cached;
      entry.pending = this.load(entry.index, access).then(index => { if (entry.disposed) release(index); else entry.index = index; return index; })
        .catch(error => { entry.index = undefined; throw error; }).finally(() => { entry.pending = undefined; });
    }
    const index = await cached.pending, tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean), paths: string[] = [];
    const extensions = tokens.filter(t => t.startsWith('ext:')).map(t => t.slice(4).replace(/^\./, ''));
    const directories = tokens.filter(t => t.startsWith('in:')).map(t => t.slice(3).replace(/\/$/, ''));
    const words = tokens.filter(t => !t.startsWith('ext:') && !t.startsWith('in:'));
    const ranked = index.files.filter(file => words.every(word => file.lower.includes(word)) &&
      (!extensions.length || extensions.includes(path.extname(file.lower).slice(1))) &&
      directories.every(dir => file.lower.startsWith(dir + '/'))).sort((a, b) => {
        const score = (file: typeof a) => { const name = path.basename(file.lower); return words.reduce((n, word) => n + (name === word ? 0 : name.startsWith(word) ? 1 : name.includes(word) ? 2 : 3), 0); };
        return score(a) - score(b) || a.path.localeCompare(b.path);
      });
    let truncated = index.truncated;
    for (const file of ranked) {
      if (paths.length === limit) { truncated = true; break; }
      paths.push(file.path);
    }
    return { paths, truncated };
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private async load(index: Index | undefined, access: SearchAccess): Promise<Index> {
    // Watch notifications cover changes within one filesystem timestamp tick.
    // Metadata remains a fallback for missed events and replaced directories.
    // Incomplete scans expire sooner, since unvisited folders have no timestamps.
    const maxAge = index?.truncated ? 1000 : (this.options.maxAgeMs ?? 30000);
    if (index && !index.dirty && this.now() - index.builtAt < maxAge) {
      let valid = true;
      for (let i = 0; valid && i < index.directories.length; i += 8) {
        const batch = await Promise.all(index.directories.slice(i, i + 8).map(async directory => {
          try { const info = await fs.lstat(directory.path); return (info.isDirectory() || info.isFile()) && stamp(info) === directory.stamp; }
          catch { return false; }
        }));
        valid = batch.every(Boolean);
      }
      if (valid && !index.dirty) return index;
    }
    release(index);
    const files: Index['files'] = [], directories: DirectoryStamp[] = [];
    const next: Index = { files, directories, truncated: false, builtAt: this.now(), dirty: false, watchers: new Map() };
    const budget = { maxEntries: this.options.maxEntries ?? 10000, visited: 0, truncated: false };
    try {
      for await (const file of walkSearchFiles(access, '.', budget, undefined, async full => {
        const info = await fs.lstat(full);
        directories.push({ path: full, stamp: stamp(info) });
        if (!info.isDirectory() || next.dirty || next.watchers.has(full)) return;
        // Bound OS handles independently of the traversal budget. If monitoring
        // is unavailable or exceeds this cap, rescan instead of reusing stale data.
        if (next.watchers.size >= 128) { release(next); return; }
        try {
          const watcher = watch(full, { persistent: false }, () => { next.dirty = true; });
          next.watchers.set(full, watcher);
          watcher.on('error', () => release(next));
        } catch { release(next); }
      })) files.push({ path: file, lower: file.toLowerCase() });
    } catch (error) { release(next); throw error; }
    files.sort((a, b) => a.path.localeCompare(b.path));
    next.truncated = budget.truncated;
    return next;
  }
}

export const fileNameIndex = new FileNameIndex();
