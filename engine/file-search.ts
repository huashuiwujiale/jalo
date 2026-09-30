import fs from 'node:fs/promises';
import path from 'node:path';

export const searchIgnored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'coverage']);
export interface SearchAccess { resolve(relative: string): Promise<string> }
export interface SearchBudget { maxEntries: number; visited: number; truncated: boolean }
type DirectoryStamp = { path: string; stamp: string };
const stamp = (info: Awaited<ReturnType<typeof fs.lstat>>) => `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

// A bounded breadth-first walk keeps only one directory handle open. A consumer
// stopping at its result limit closes that handle and never visits queued folders.
export async function* walkSearchFiles(access: SearchAccess, directory: string, budget: SearchBudget, signal?: AbortSignal,
  onDirectory?: (full: string) => Promise<void>) {
  const pending = [directory];
  for (let i = 0; i < pending.length; i++) {
    signal?.throwIfAborted();
    if (budget.visited >= budget.maxEntries) { budget.truncated = true; return; }
    let full: string, handle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      full = await access.resolve(pending[i]);
      await onDirectory?.(full);
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
      const relative = path.join(pending[i], entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) yield relative;
    }
  }
}

type Index = { files: { path: string; lower: string }[]; directories: DirectoryStamp[]; truncated: boolean; builtAt: number };
type Cached = { index?: Index; pending?: Promise<Index> };

export class FileNameIndex {
  private projects = new Map<string, Cached>();
  constructor(private options: { maxEntries?: number; maxProjects?: number; maxAgeMs?: number; now?: () => number } = {}) {}
  clear(root?: string) { if (root === undefined) this.projects.clear(); else this.projects.delete(root); }
  async search(root: string, query: string, access: SearchAccess, limit = 80) {
    let cached = this.projects.get(root);
    if (!cached) { cached = {}; this.projects.set(root, cached); }
    // Refresh LRU position. Each project has at most one scan/validation in flight.
    this.projects.delete(root); this.projects.set(root, cached);
    while (this.projects.size > (this.options.maxProjects ?? 8)) this.projects.delete(this.projects.keys().next().value!);
    if (!cached.pending) {
      const entry = cached;
      entry.pending = this.load(entry.index, access).then(index => { entry.index = index; return index; })
        .catch(error => { entry.index = undefined; throw error; }).finally(() => { entry.pending = undefined; });
    }
    const index = await cached.pending, needle = query.toLowerCase(), paths: string[] = [];
    let truncated = index.truncated;
    for (const file of index.files) {
      if (!file.lower.includes(needle)) continue;
      if (paths.length === limit) { truncated = true; break; }
      paths.push(file.path);
    }
    return { paths, truncated };
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private async load(index: Index | undefined, access: SearchAccess): Promise<Index> {
    // Directory timestamps detect creates, deletes, renames and link replacements.
    // Incomplete scans expire sooner, since unvisited folders have no timestamps.
    const maxAge = index?.truncated ? 1000 : (this.options.maxAgeMs ?? 30000);
    if (index && this.now() - index.builtAt < maxAge) {
      let valid = true;
      for (let i = 0; valid && i < index.directories.length; i += 8) {
        const batch = await Promise.all(index.directories.slice(i, i + 8).map(async directory => {
          try { const info = await fs.lstat(directory.path); return info.isDirectory() && stamp(info) === directory.stamp; }
          catch { return false; }
        }));
        valid = batch.every(Boolean);
      }
      if (valid) return index;
    }
    const files: Index['files'] = [], directories: DirectoryStamp[] = [];
    const budget = { maxEntries: this.options.maxEntries ?? 10000, visited: 0, truncated: false };
    for await (const file of walkSearchFiles(access, '.', budget, undefined, async full => {
      directories.push({ path: full, stamp: stamp(await fs.lstat(full)) });
    })) files.push({ path: file, lower: file.toLowerCase() });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, directories, truncated: budget.truncated, builtAt: this.now() };
  }
}

export const fileNameIndex = new FileNameIndex();
