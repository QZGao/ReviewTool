import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './launch.mjs';
import { recordTestApi } from './record-test-api.mjs';
let api, records;
before(async () => {
  const file = path.join(root, `.cache/revision-import-test-${process.pid}.mjs`);
  await build({ stdin: { contents: "export * from './src/annotation/revision-import';", resolveDir: root }, outfile: file, bundle: true, format: 'esm', platform: 'node' });
  api = await import(pathToFileURL(file)); records = await recordTestApi();
});
const article = { pageId: 139, title: '孫中山' }, prefix = { namespace: 1, mainText: '孫中山/ReviewTool/', title: 'Talk:孫中山/ReviewTool/' };
const page = (id, ns = 1) => ({ ns, title: prefix.title + id });
const time = '2026-09-26T00:00:00.000Z';

test('resolves canonical article identity before constructing its annotation-page prefix', async () => {
  const calls = [];
  const result = await api.resolveAnnotationArticle(async params => { calls.push(params); return { query: { pages: [{ pageid: 139, title: '孫中山' }] } }; }, '孙中山');
  assert.deepEqual(result, article); assert.equal(calls[0].redirects, true); assert.equal(calls[0].converttitles, true);
  assert.equal(await api.resolveAnnotationArticle(async () => ({ query: { pages: [{ missing: true }] } }), 'Missing'), null);
});

test('enumerates continued prefix results, rejects unrelated suffixes, and sorts revision numbers newest first', async () => {
  const calls = [];
  const choices = await api.listAnnotatedRevisions(async params => {
    calls.push(params);
    if (params.list) {
      assert.equal(params.apprefix, prefix.mainText); assert.equal(params.apnamespace, 1);
      return params.apcontinue ? { query: { allpages: [page('9'), page('100'), page('10'), page('01'), page('100/notes'), page('9007199254740992'), page('99', 0)] } }
        : { query: { allpages: [page('100'), page('notes'), { ns: 1, title: 'Talk:別的條目/ReviewTool/999' }] }, continue: { apcontinue: prefix.mainText + '9', continue: '-||' } };
    }
    assert.equal(params.rvprop, 'ids|timestamp'); assert.equal(params.revids, '100|10|9');
    return { query: { pages: [{ pageid: 139, revisions: [{ revid: 9, timestamp: time }, { revid: 100, timestamp: '2026-09-27T00:00:00Z' }] }] } };
  }, article, prefix);
  assert.deepEqual(choices.map(c => c.revisionId), [100, 10, 9]); assert.equal(choices[0].timestamp, '2026-09-27T00:00:00Z');
  assert.equal(calls.length, 3); assert.equal(calls[1].continue, '-||');
});

test('metadata queries stay within the ordinary-user batch limit and empty listings need no metadata read', async () => {
  const batches = [];
  const choices = await api.listAnnotatedRevisions(async params => {
    if (params.list) return { query: { allpages: Array.from({ length: 65 }, (_, i) => page(String(i + 1))) } };
    batches.push(params.revids.split('|').length); return { query: { pages: [] } };
  }, article, prefix);
  assert.equal(choices.length, 65); assert.deepEqual(batches, [50, 15]);
  let reads = 0;
  assert.deepEqual(await api.listAnnotatedRevisions(async () => { reads++; return { query: { allpages: [] } }; }, article, prefix), []);
  assert.equal(reads, 1);
});

function fixture(revisionId = 100) {
  const source = '前言。\n== 生平 ==\n[[頁面|原文😀]]。';
  const start = Buffer.byteLength(source.slice(0, source.indexOf('[['))), end = Buffer.byteLength(source.slice(0, source.indexOf(']]') + 2));
  const comment = (id, text, replies = []) => ({ id, text, author: 'Example', createdAt: time, replies });
  const threads = [comment('root', 'Root review', [comment('reply', 'Reply review', [comment('nested', 'Nested review')])]), { ...comment('closed', 'Resolved review'), resolved: { by: 'Example', at: time } }];
  const model = records.AnnotationDocument.seed('test-generation', [{ id: 'h', color: 'yellow', author: 'Example', createdAt: time, anchor: { unit: 'utf8-byte', start, end }, threads }], () => true);
  const text = records.encodePage({ wiki: 'zhwiki', pageId: 139, revisionId }, { baseline: 0, prefix: '{{ReviewTool annotation data page}}\n<syntaxhighlight lang="json">\n', suffix: '\n</syntaxhighlight>' }, model); model.destroy();
  return { source, text, choice: { revisionId, dataTitle: prefix.title + revisionId } };
}
const dataResponse = text => ({ query: { pages: [{ revisions: [{ revid: 1000000001, timestamp: time, slots: { main: { content: text } } }] }] } });

test('imports every saved root and reply from the selected revision with its readable quote and source section', async () => {
  const { source, text, choice } = fixture(), calls = [];
  const groups = await api.loadAnnotationRevision(async params => {
    calls.push(params);
    return params.action === 'parse' ? { parse: { pageid: 139, revid: 100, wikitext: source } } : dataResponse(text);
  }, 'zhwiki', article, choice);
  assert.deepEqual(calls.map(c => c.action), ['parse', 'query']); assert.equal(calls[0].oldid, 100); assert.equal(calls[1].titles, choice.dataTitle);
  assert.deepEqual(groups.map(g => g.sectionPath), ['生平']);
  assert.deepEqual(groups[0].annotations.map(a => a.opinion), ['Root review', 'Reply review', 'Nested review', 'Resolved review']);
  assert.ok(groups[0].annotations.every(a => a.sentenceText === '原文😀'));
  assert.equal(groups[0].annotations[1].parentId, 'root'); assert.equal(groups[0].annotations[3].resolved, true);
});

test('rejects missing, malformed, foreign and source-mismatched data instead of importing the wrong revision', async () => {
  const { source, text, choice } = fixture();
  for (const [sourcePageId, sourceRevisionId, data] of [[1, 100, text], [139, 9, text], [139, 100, 'broken'], [139, 100, fixture(9).text], [139, 100, undefined]]) {
    await assert.rejects(api.loadAnnotationRevision(async params => params.action === 'parse'
      ? { parse: { pageid: sourcePageId, revid: sourceRevisionId, wikitext: source } }
      : data === undefined ? { query: { pages: [{ missing: true }] } } : dataResponse(data), 'zhwiki', article, choice));
  }
});
