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
const article = { pageId: 139, title: '孫中山' }, talkTitle = 'Talk:孫中山';
const talk = content => ({ query: { pages: [{ title: talkTitle, revisions: [{ slots: { main: { content } } }] }] } });
const time = '2026-09-26T00:00:00.000Z';

test('resolves canonical article identity before reading its talk-page notice', async () => {
  const calls = [];
  const result = await api.resolveAnnotationArticle(async params => { calls.push(params); return { query: { pages: [{ pageid: 139, title: '孫中山' }] } }; }, '孙中山');
  assert.deepEqual(result, article); assert.equal(calls[0].redirects, true); assert.equal(calls[0].converttitles, true);
  assert.equal(await api.resolveAnnotationArticle(async () => ({ query: { pages: [{ missing: true }] } }), 'Missing'), null);
});

test('reads the talk notice, ignores invalid IDs and other articles, and sorts revisions newest first', async () => {
  const calls = [];
  const choices = await api.listAnnotatedRevisions(async params => {
    calls.push(params);
    if (params.titles) {
      assert.equal(params.titles, talkTitle); assert.equal(params.redirects, true);
      return talk('<!-- {{ReviewTool talk page notice|999}} -->\n{{ReviewTool talk page notice|9|100|10|10|01|notes|9007199254740992|99}}\nExisting discussion');
    }
    assert.equal(params.rvprop, 'ids|timestamp'); assert.equal(params.revids, '100|99|10|9');
    return { query: { pages: [{ pageid: 139, revisions: [{ revid: 9, timestamp: time }, { revid: 10 }, { revid: 100, timestamp: '2026-09-27T00:00:00Z' }] }, { pageid: 999, revisions: [{ revid: 99, timestamp: time }] }] } };
  }, article, talkTitle);
  assert.deepEqual(choices.map(c => c.revisionId), [100, 10, 9]); assert.equal(choices[0].timestamp, '2026-09-27T00:00:00Z');
  assert.equal(calls.length, 2); assert.equal(choices[0].dataTitle, 'Wikipedia:ReviewTool/data/100.json');
});

test('metadata queries stay within the ordinary-user batch limit and empty listings need no metadata read', async () => {
  const batches = [];
  const choices = await api.listAnnotatedRevisions(async params => {
    if (params.titles) return talk('{{ReviewTool talk page notice|' + Array.from({ length: 65 }, (_, i) => i + 1).join('|') + '}}');
    batches.push(params.revids.split('|').length); return { query: { pages: [{ pageid: 139, revisions: params.revids.split('|').map(id => ({ revid: Number(id), timestamp: time })) }] } };
  }, article, talkTitle);
  assert.equal(choices.length, 65); assert.deepEqual(batches, [50, 15]);
  let reads = 0;
  assert.deepEqual(await api.listAnnotatedRevisions(async () => { reads++; return talk('No notice yet'); }, article, talkTitle), []);
  assert.equal(reads, 1);
  assert.deepEqual(await api.listAnnotatedRevisions(async () => ({ query: { pages: [{ missing: true }] } }), article, talkTitle), []);
});

function fixture(revisionId = 100) {
  const source = '前言。\n== 生平 ==\n[[頁面|原文😀]]。';
  const start = Buffer.byteLength(source.slice(0, source.indexOf('[['))), end = Buffer.byteLength(source.slice(0, source.indexOf(']]') + 2));
  const comment = (id, text, replies = []) => ({ id, text, author: 'Example', createdAt: time, replies });
  const threads = [comment('root', 'Root review', [comment('reply', 'Reply review', [comment('nested', 'Nested review')])]), { ...comment('closed', 'Resolved review'), resolved: { by: 'Example', at: time } }];
  const model = records.AnnotationDocument.seed('test-generation', [{ id: 'h', color: 'yellow', author: 'Example', createdAt: time, anchor: { unit: 'utf8-byte', start, end }, threads }], () => true);
  const text = records.encodePage({ wiki: 'zhwiki', pageId: 139, revisionId }, { baseline: 0 }, model); model.destroy();
  return { source, text, choice: { revisionId, dataTitle: records.dataPageTitle(revisionId) } };
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
  assert.equal(groups[0].annotations[1].parentId, 'root'); assert.equal(groups[0].annotations[3].closed, true);
});

test('rejects missing, malformed, foreign and source-mismatched data instead of importing the wrong revision', async () => {
  const { source, text, choice } = fixture();
  for (const [sourcePageId, sourceRevisionId, data] of [[1, 100, text], [139, 9, text], [139, 100, 'broken'], [139, 100, fixture(9).text], [139, 100, undefined]]) {
    await assert.rejects(api.loadAnnotationRevision(async params => params.action === 'parse'
      ? { parse: { pageid: sourcePageId, revid: sourceRevisionId, wikitext: source } }
      : data === undefined ? { query: { pages: [{ missing: true }] } } : dataResponse(data), 'zhwiki', article, choice));
  }
});
