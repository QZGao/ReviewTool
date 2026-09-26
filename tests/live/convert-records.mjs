import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

// Development conversion only. The application intentionally has no legacy data-file reader.
const [input, output, baselineText = '0'] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node tests/live/convert-records.mjs INPUT OUTPUT [STORAGE_REVISION]');
const baseline = Number(baselineText);
if (!Number.isSafeInteger(baseline) || baseline < 0) throw new Error('Invalid storage baseline revision.');
await mkdir('.cache', { recursive: true });
const bundle = path.resolve('.cache/record-converter.mjs');
await build({ stdin: { contents: "export * from './src/annotation/record-document.ts'; export * from './src/annotation/live-storage.ts';", resolveDir: process.cwd() }, outfile: bundle, bundle: true, format: 'esm', platform: 'node' });
const { AnnotationDocument, encodePage, decodePage, normalizeAnnotations } = await import(pathToFileURL(bundle));
const raw = await readFile(input, 'utf8');
const source = JSON.parse(raw.match(/<syntaxhighlight\s+lang="json">([\s\S]*?)<\/syntaxhighlight>/)?.[1] ?? raw);
if (![1, 2].includes(source.schemaVersion) || !Array.isArray(source.annotations)) throw new Error('Expected an exported development annotation snapshot.');
const identity = { wiki: source.wiki, pageId: source.pageId, revisionId: source.revisionId };
const validate = anchor => anchor?.unit === 'utf8-byte' && Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end) && anchor.start >= 0 && anchor.end > anchor.start;
const expected = normalizeAnnotations(source.annotations, validate);
const doc = AnnotationDocument.seed(crypto.randomUUID(), expected, validate);
const target = encodePage(identity, { baseline, prefix: '{{ReviewTool annotation data page}}\n<syntaxhighlight lang="json">\n', suffix: '\n</syntaxhighlight>\n' }, doc);
const decoded = decodePage({ text: target, revision: baseline, parentId: 0, timestamp: '', summary: '/* ReviewTool */', tags: [] }, identity, validate);
assert.deepStrictEqual(decoded.annotations, [...expected].sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
await writeFile(output, target);
console.log(JSON.stringify({ output, format: 'reviewtool.annotation-records/1', highlights: decoded.annotations.length, threads: decoded.annotations.flatMap(a=>a.threads??[]).length, records: Object.keys(doc.toJSON()).length, bytes: Buffer.byteLength(target), exactSnapshot: true }));
