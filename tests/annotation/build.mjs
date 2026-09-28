import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(root, '.cache/annotation-rnd'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/annotation/index.ts')],
  outfile: path.join(root, '.cache/annotation-rnd/index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
});
console.log('Built isolated src/annotation renderer.');
