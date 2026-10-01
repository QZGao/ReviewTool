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

const comment = (id, text, replies = [], author = 'Example') => ({ id, text, author, createdAt: time, replies });
const closed = { by: 'Example', at: time };
function fixture(revisionId = 100, { threads, deletedThreads = [] } = {}) {
  const source = '前言。\n== 生平 ==\n[[頁面|原文😀]]。';
  const start = Buffer.byteLength(source.slice(0, source.indexOf('[['))), end = Buffer.byteLength(source.slice(0, source.indexOf(']]') + 2));
  threads ??= [comment('root', 'Root review', [comment('reply', 'Reply review', [comment('nested', 'Nested review')])]), { ...comment('closed', 'Closed review'), resolved: closed }];
  const annotation = { id: 'h', color: 'yellow', author: 'Example', createdAt: time, anchor: { unit: 'utf8-byte', start, end }, threads };
  const model = records.AnnotationDocument.seed('test-generation', [annotation, ...(deletedThreads.length ? [{ ...annotation, id: 'deleted', deleted: closed, threads: deletedThreads }] : [])], () => true);
  const text = records.encodePage({ wiki: 'zhwiki', pageId: 139, revisionId }, { baseline: 0 }, model); model.destroy();
  return { source, text, choice: { revisionId, dataTitle: records.dataPageTitle(revisionId) } };
}
const dataResponse = text => ({ query: { pages: [{ revisions: [{ revid: 1000000001, timestamp: time, slots: { main: { content: text } } }] }] } });
const importFixture = ({ source, text, choice }, options) => api.loadAnnotationRevision(async params => params.action === 'parse'
  ? { parse: { pageid: 139, revid: choice.revisionId, wikitext: source } } : dataResponse(text), 'zhwiki', article, choice, options);
const opinions = groups => groups.flatMap(group => group.annotations.map(annotation => annotation.opinion));

test('defaults to own unresolved roots while preserving the chosen revision, readable quote and source section', async () => {
  const { source, text, choice } = fixture(), calls = [];
  const groups = await api.loadAnnotationRevision(async params => {
    calls.push(params);
    return params.action === 'parse' ? { parse: { pageid: 139, revid: 100, wikitext: source } } : dataResponse(text);
  }, 'zhwiki', article, choice, { currentUser: 'Example' });
  assert.deepEqual(calls.map(c => c.action), ['parse', 'query']); assert.equal(calls[0].oldid, 100); assert.equal(calls[1].titles, choice.dataTitle);
  assert.deepEqual(groups.map(g => g.sectionPath), ['生平']);
  assert.deepEqual(opinions(groups), ['Root review']);
  assert.ok(groups[0].annotations.every(a => a.sentenceText === '原文😀'));
  const withReplies = await importFixture({ source, text, choice }, { currentUser: 'Example', topLevelOnly: false });
  assert.deepEqual(opinions(withReplies), ['Root review / Reply review / Nested review']);
});

test('Bob imports his reply under Example; including other authors attributes each of their comments', async () => {
  const data = fixture(100, { threads: [comment('root', 'Needs a source.', [
    comment('reply', 'Try reference 3.', [comment('nested', 'That reference supports it.')], 'Bob'),
  ])] });
  assert.deepEqual(await importFixture(data, { currentUser: 'Bob' }), []);
  assert.deepEqual(opinions(await importFixture(data, { currentUser: 'Bob', topLevelOnly: false })), ['Try reference 3.']);
  assert.deepEqual(opinions(await importFixture(data, { currentUser: 'Bob', onlyOwn: false, topLevelOnly: false })), [
    '@[[User:Example|]]: Needs a source. / Try reference 3. / @[[User:Example|]]: That reference supports it.',
  ]);
  // A second import must not carry text or attribution from the previous filter choice.
  assert.deepEqual(opinions(await importFixture(data, { currentUser: 'Example', topLevelOnly: false })), ['Needs a source. / That reference supports it.']);
});

test('all filter combinations keep independent discussions separate and always omit closed or deleted data', async t => {
  const data = fixture(100, {
    threads: [
      comment('own', 'Own root', [comment('their-reply', 'Their reply')], 'Bob'),
      comment('their', 'Their root', [comment('own-reply', 'Own reply', [], 'Bob')]),
      { ...comment('resolved', 'Resolved root', [comment('resolved-reply', 'Resolved reply')], 'Bob'), resolution: { ...closed, resolved: true } },
      { ...comment('closed', 'Closed root', [comment('closed-reply', 'Closed reply', [], 'Bob')], 'Bob'), resolved: closed },
    ],
    deletedThreads: [comment('deleted-root', 'Deleted root', [comment('deleted-reply', 'Deleted reply')], 'Bob')],
  });
  const cases = [
    [true, true, true, ['Own root']],
    [true, true, false, ['Own root', 'Resolved root']],
    [true, false, true, ['Own root', 'Own reply']],
    [true, false, false, ['Own root', 'Own reply', 'Resolved root']],
    [false, true, true, ['Own root', '@[[User:Example|]]: Their root']],
    [false, true, false, ['Own root', '@[[User:Example|]]: Their root', 'Resolved root']],
    [false, false, true, ['Own root / @[[User:Example|]]: Their reply', '@[[User:Example|]]: Their root / Own reply']],
    [false, false, false, ['Own root / @[[User:Example|]]: Their reply', '@[[User:Example|]]: Their root / Own reply', 'Resolved root / @[[User:Example|]]: Resolved reply']],
  ];
  for (const [onlyOwn, topLevelOnly, unresolvedOnly, expected] of cases) {
    await t.test(`onlyOwn=${onlyOwn}, topLevelOnly=${topLevelOnly}, unresolvedOnly=${unresolvedOnly}`, async () => {
      const groups = await importFixture(data, { currentUser: 'Bob', onlyOwn, topLevelOnly, unresolvedOnly });
      assert.deepEqual(opinions(groups), expected);
      assert.deepEqual(groups.map(group => group.sectionPath), ['生平']);
      assert.ok(groups[0].annotations.every(entry => entry.sentenceText === '原文😀'));
    });
  }
});

test('ownership follows the original author, normalizes username spaces, and handles a logged-out viewer', async () => {
  const data = fixture(100, { threads: [
    { ...comment('edited-own', 'My edited comment', [], 'Bob Smith'), editedBy: 'Example', editedAt: time },
    { ...comment('edited-other', 'Their edited comment'), editedBy: 'Bob Smith', editedAt: time },
  ] });
  assert.deepEqual(opinions(await importFixture(data, { currentUser: 'Bob_Smith' })), ['My edited comment']);
  assert.deepEqual(await importFixture(data, { currentUser: null }), []);
  assert.deepEqual(opinions(await importFixture(data, { currentUser: null, onlyOwn: false })), [
    '@[[User:Bob Smith|]]: My edited comment', '@[[User:Example|]]: Their edited comment',
  ]);
});

test('rejects missing, malformed, foreign and source-mismatched data instead of importing the wrong revision', async () => {
  const { source, text, choice } = fixture();
  for (const [sourcePageId, sourceRevisionId, data] of [[1, 100, text], [139, 9, text], [139, 100, 'broken'], [139, 100, fixture(9).text], [139, 100, undefined]]) {
    await assert.rejects(api.loadAnnotationRevision(async params => params.action === 'parse'
      ? { parse: { pageid: sourcePageId, revid: sourceRevisionId, wikitext: source } }
      : data === undefined ? { query: { pages: [{ missing: true }] } } : dataResponse(data), 'zhwiki', article, choice, { currentUser: 'Example' }));
  }
});
