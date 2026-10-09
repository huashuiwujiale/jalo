import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { gitPatch } from '../engine/git-review';
import { ToolRegistry } from '../engine/tools';
import { defaults } from '../shared/types';
const require = createRequire(import.meta.url);

test('queued Git review rejects changed targets before contacting a model and never offers mutation tools', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-git-worker-'));
  const Module = require('node:module'), originalLoad = Module._load, originalPort = (process as any).parentPort;
  const port = new EventEmitter() as any; let contacted = false;
  try {
    await promisify(execFile)('/usr/bin/git', ['-C', root, 'init', '-q']); await fs.writeFile(path.join(root, 'a.txt'), 'captured');
    const target = await gitPatch(root, 'a.txt'); await fs.writeFile(path.join(root, 'a.txt'), 'external change while queued');
    class Provider { async list() { contacted = true; throw new Error('must not contact model'); } }
    Module._load = function (id: string, ...args: any[]) { return id === './providers' ? { createProvider: () => new Provider() } : id === './provider' ? { LMStudioProvider: Provider } : originalLoad.call(this, id, ...args); };
    (process as any).parentPort = port;
    delete require.cache[require.resolve('../engine/worker.ts')]; require('../engine/worker.ts');
    let timer: ReturnType<typeof setTimeout>;
    const done = new Promise<any>((resolve, reject) => { timer = setTimeout(() => reject(new Error('worker timeout')), 5000); port.postMessage = (event: any) => { if (event.type === 'done') resolve(event); }; });
    try {
      port.emit('message', { data: { type: 'start', root, backupDir: path.join(root, 'backups'), settings: defaults, input: { projectId: 'p', model: 'mock', messages: [], changes: [], reviewChanges: [{ path: target.path, patch: target.patch }], run: { id: 'r', mode: 'review', references: [], gitReview: { path: target.path, version: target.version } } } } });
      const result = await done; assert.equal(result.status, 'failed'); assert.match(result.error, /差异已变化/); assert.equal(contacted, false);
    } finally { clearTimeout(timer!); }
    const tools = new ToolRegistry({ root, backupDir: '', mode: 'review', reviewChanges: [{ path: target.path, patch: target.patch }], signal: new AbortController().signal, timeout: 1, emit: () => {}, approve: async () => { throw new Error('must not ask approval'); } });
    await tools.init();
    assert.ok(tools.toolDefinitions().every(t => !['run_command', 'write_file', 'edit_file', 'replace_lines', 'edit_vue_element'].includes(t.function.name)));
    for (const name of ['run_command', 'write_file']) await assert.rejects(tools.execute(name, {}), /只读模式/);
    assert.equal(await tools.execute('show_changes', {}), target.patch);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'external change while queued');
  } finally {
    Module._load = originalLoad; (process as any).parentPort = originalPort; delete require.cache[require.resolve('../engine/worker.ts')]; port.removeAllListeners();
    await fs.rm(root, { recursive: true, force: true });
  }
});
