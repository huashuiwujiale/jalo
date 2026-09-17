import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } });
await server.listen();
const env = { ...process.env, LOCAL_CODE_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
let exiting = false;
async function close(code = 0) { if (exiting) return; exiting = true; child.kill(); await server.close(); process.exit(code); }
child.on('exit', code => close(code ?? 0));
child.on('error', error => { console.error(error); close(1); });
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
