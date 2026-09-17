import { build as bundle } from 'esbuild';
import { build as frontend } from 'vite';
import { mkdir, copyFile } from 'node:fs/promises';

await frontend({ base: './', build: { outDir: 'dist/renderer', emptyOutDir: true } });
await mkdir('dist/electron', { recursive: true });
await bundle({
  entryPoints: { main: 'electron/main.ts', worker: 'engine/worker.ts' },
  outdir: 'dist/electron', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
});
await copyFile('electron/preload.cjs', 'dist/electron/preload.cjs');
