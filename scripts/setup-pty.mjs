// Explicit opt-in setup for Linux, where node-pty does not ship a prebuilt addon.
// This only compiles the dependency; it never builds or packages Jalo.
import './prepare-pty.mjs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const probe = () => spawnSync(process.execPath, ['-e', "require('node-pty')"], { cwd: root, encoding: 'utf8' });
let result = probe();
if (result.status !== 0) {
  if (process.platform !== 'linux') {
    throw new Error('node-pty 预编译依赖不可用，请先运行 npm ci。' + (result.stderr || result.error || ''));
  }
  const env = { ...process.env };
  // Official Node distributions already include matching headers. Reuse them
  // instead of requiring another download through node-gyp's own HTTP client.
  if (!env.npm_config_nodedir) {
    const nodeRoot = path.resolve(path.dirname(process.execPath), '..');
    try { await access(path.join(nodeRoot, 'include/node/node.h')); env.npm_config_nodedir = nodeRoot; } catch {}
  }
  console.log('为 Linux 准备 node-pty 原生依赖（需要 Python、make 和 C++ 编译器）。');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['rebuild', 'node-pty', '--foreground-scripts'], { cwd: root, env, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
  result = probe();
  if (result.status !== 0) throw new Error('node-pty 准备后仍无法加载：' + (result.stderr || result.error || ''));
}
console.log(`node-pty 已就绪：${process.platform}/${process.arch}，Node ${process.versions.node}`);
