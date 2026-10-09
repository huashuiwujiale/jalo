// npm's node-pty archive ships the macOS helper without its execute bit.
// Use the supplied prebuilt binaries; never invoke a native compiler here.
import { chmod, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('node-pty/package.json'));
for (const arch of ['arm64', 'x64']) {
  const helper = path.join(root, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
  try { await access(helper); } catch { continue; }
  await chmod(helper, 0o755);
}
