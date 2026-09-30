import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
let pending;
export function recordTestApi() {
  return pending ??= (async () => {
    const file = path.join(root, `.cache/record-test-api-${process.pid}.mjs`);
    await build({ stdin: { contents: ['record-document', 'record-json', 'record-types', 'live-storage'].map(name => `export * from './src/annotation/${name}.ts';`).join('\n'), resolveDir: root }, outfile: file, bundle: true, format: 'esm', platform: 'node' });
    return import(pathToFileURL(file));
  })();
}
export async function readSnapshot(text) {
  const payload = JSON.parse(text);
  const api = await recordTestApi();
  const stored = api.decodePage({ text, revision: 0, parentId: 0, timestamp: '', summary: '/* ReviewTool */', tags: [] }, payload.document, a => a.unit === 'utf8-byte' && a.start >= 0 && a.end > a.start);
  const result = stored.annotations; stored.document.destroy(); return result;
}
