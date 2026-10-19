import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [...process.argv.slice(2), 'scripts/session-smoke.cjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: 'inherit',
});
const forwards = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
for (const [signal, forward] of forwards) process.on(signal, forward);
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  for (const [name, forward] of forwards) process.off(name, forward);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
