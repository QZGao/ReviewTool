import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './launch.mjs';
let api;
before(async () => {
  const file = path.join(root, `.cache/export-test-${process.pid}.mjs`);
  await build({ stdin: { contents: "export * from './src/annotation/export'; export * from './src/annotation/projection';", resolveDir: root }, outfile: file, bundle: true, platform: 'node', format: 'esm' });
  api = await import(pathToFileURL(file));
});
const identity = { wiki: 'zhwiki', pageId: 139, revisionId: 94447348 };
const time = '2026-09-26T00:00:00.000Z';
const comment = (id, replies = []) => ({ id, text: 'Comment ' + id, author: 'Example', createdAt: time, replies });
const anchor = (source, quote) => ({ unit: 'utf8-byte', start: Buffer.byteLength(source.slice(0, source.indexOf(quote))), end: Buffer.byteLength(source.slice(0, source.indexOf(quote) + quote.length)) });

test('exports every root and reply, including resolved/deleted discussions, with independent attribution and source anchors', () => {
  const source = '前言。\n== 第一節 ==\n[[頁面|文字]]。\n=== 子節 ===\n細節😀。\n== 另一節 ==\n末尾。';
  const removal = { by: 'Example', at: time, reason: 'Done' };
  const input = [
    { id: 'bare', color: 'blue', anchor: anchor(source, '前言'), threads: [] },
    { id: 'h', author: 'Someone', createdAt: time, color: 'yellow', anchor: anchor(source, '[[頁面|文字]]'), threads: [
      comment('one', [comment('reply', [comment('grandchild')])]),
      { ...comment('two'), resolved: removal, editedAt: time, editedBy: 'Moderator' },
    ] },
    { id: 'deleted', author: 'Example', color: 'red', anchor: anchor(source, '細節😀'), deleted: removal, threads: [comment('hidden')] },
    { id: 'last', color: 'green', anchor: anchor(source, '末尾'), threads: [comment('last')] },
  ];
  const original = structuredClone(input);
  const result = api.buildAnnotationExport(identity, '孫中山', api.createProjection(source), input);
  const entries = result.groups.flatMap(group => group.annotations);
  assert.equal(entries.length, 6); assert.equal(result.highlights.length, 4);
  assert.deepEqual(result.groups.map(group => group.sectionPath), ['第一節', '第一節 / 子節', '另一節']);
  assert.deepEqual(entries.map(c => [c.id, c.rootId, c.parentId]), [
    ['one', 'one', null], ['reply', 'one', 'one'], ['grandchild', 'one', 'reply'], ['two', 'two', null], ['hidden', 'hidden', null], ['last', 'last', null],
  ]);
  assert.equal(entries[0].sentenceText, '文字');
  assert.equal(entries[0].createdBy, 'Example'); assert.equal(entries[0].createdAt, Date.parse(time));
  assert.equal(entries[3].editedBy, 'Moderator'); assert.deepEqual(entries[3].resolution, removal);
  assert.equal(entries[3].resolved, true); assert.equal(entries[0].resolved, false);
  assert.equal(result.highlights[1].author, 'Someone');
  assert.equal(result.highlights[1].sourceText, '[[頁面|文字]]');
  assert.equal(result.highlights[2].sourceText, '細節😀'); assert.deepEqual(result.highlights[2].deleted, removal);
  assert.equal(result.highlights[0].createdAt, undefined);
  assert.deepEqual(result.document, { ...identity, offsetUnit: 'utf8-byte' });
  assert.deepEqual(input, original, 'export does not mutate shared state');
  assert.equal('threads' in result.highlights[1], false, 'comments are represented once, with parent/root IDs');
});

test('bare highlights and empty documents can be exported without inventing comments', () => {
  const projection = api.createProjection('plain');
  assert.deepEqual(api.buildAnnotationExport(identity, 'Page', projection, []).groups, []);
  const result = api.buildAnnotationExport(identity, 'Page', projection, [{ id: 'bare', color: 'blue', anchor: anchor('plain', 'plain') }]);
  assert.equal(result.highlights.length, 1); assert.deepEqual(result.groups, []);
});
