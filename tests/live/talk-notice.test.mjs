import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
let api;
before(async () => {
  const file = path.resolve(`.cache/talk-notice-test-${process.pid}.mjs`);
  await build({ stdin: { contents: "export * from './src/annotation/talk-notice'; export * from './src/annotation/wiki-source';", resolveDir: process.cwd() }, outfile: file, bundle: true, format: 'esm', platform: 'node' });
  api = await import(pathToFileURL(file));
});

test('notice parsing ignores examples and collects real positional revision parameters', () => {
  const source = '<!-- {{ReviewTool talk page notice|999}} -->\n<nowiki>{{ReviewTool talk page notice|998}}</nowiki>\n<pre>{{ReviewTool talk page notice|997}}</pre>\n{{tl|ReviewTool talk page notice|996}}\n{{Other|{{ReviewTool talk page notice|995}}}}\n{{Template:ReviewTool_talk_page_notice|9|2=100|3=10|named=994|4=0|5=01|6=9007199254740992}}\n{{ReviewTool talk page notice|100|7}}';
  assert.deepEqual(api.noticeRevisions(source), [100, 10, 9, 7]);
});

test('adding a notice preserves talk text and existing fields, handles numbered arguments, and is idempotent', () => {
  const discussion = '<!-- header -->\r\n== Discussion ==\r\nKeep {{other|x=y}} and [[Page|text]].\r\n';
  assert.equal(api.addNoticeRevision(discussion, 100), '{{ReviewTool talk page notice|100}}\n' + discussion);
  assert.equal(api.addNoticeRevision('', 100), '{{ReviewTool talk page notice|100}}\n');
  const existing = 'Before\n{{ ReviewTool talk page notice\n|1=9\n|2=10\n|note={{keep|a=b}}\n}}\nAfter';
  const updated = api.addNoticeRevision(existing, 100);
  assert.equal(updated, existing.replace('}}\nAfter', '|3=100}}\nAfter'));
  assert.deepEqual(api.noticeRevisions(updated), [100, 10, 9]);
  assert.equal(api.addNoticeRevision(updated, 10), updated);
  assert.throws(() => api.addNoticeRevision('', -1));
});

function server(initial) {
  let revision = 10, text = initial;
  const calls = [], edits = [];
  let conflict;
  return {
    calls, edits, get text() { return text; }, race(change) { conflict = change; },
    request: async (params, write) => {
      calls.push(params);
      if (params.list === 'tags') return { query: { tags: [] } };
      assert.equal(params.title ?? params.titles, 'Talk:Page');
      if (!write) return { query: { pages: [text === undefined ? { title: 'Talk:Page', missing: true } : { title: 'Talk:Page', revisions: [{ revid: revision, parentid: revision - 1, timestamp: '2026-10-01T00:00:00Z', slots: { main: { content: text, contentmodel: 'wikitext' } } }] }] } };
      if (conflict) { text = conflict(text); revision++; conflict = undefined; }
      if (params.createonly && text !== undefined) throw new Error('articleexists');
      if (params.nocreate && text === undefined) throw new Error('missingtitle');
      if (params.baserevid !== undefined && params.baserevid !== revision) throw new Error('editconflict');
      assert.equal(params.contentmodel, 'wikitext'); assert.equal(params.contentformat, 'text/x-wiki');
      assert.equal(params.basetimestamp, undefined);
      text = params.text; revision++; edits.push(params);
      return { edit: { result: 'Success' } };
    },
  };
}

test('concurrent first data revisions create one notice containing both IDs', async () => {
  const wiki = server();
  const a = api.wikiSource(wiki.request, 'Wikipedia:ReviewTool/data/100.json', { talkTitle: 'Talk:Page', revisionId: 100 });
  const b = api.wikiSource(wiki.request, 'Wikipedia:ReviewTool/data/200.json', { talkTitle: 'Talk:Page', revisionId: 200 });
  await Promise.all([a.ensureIndexed(), b.ensureIndexed()]);
  assert.deepEqual(api.noticeRevisions(wiki.text), [200, 100]);
  assert.equal(wiki.text.match(/ReviewTool talk page notice/g).length, 1);
  const calls = wiki.calls.length; await a.ensureIndexed(); await b.ensureIndexed();
  assert.equal(wiki.calls.length, calls, 'confirmed indexes need no extra requests in this session');
});

test('a conflicting talk edit is reread and preserved while adding the missing revision', async () => {
  const wiki = server('{{ReviewTool talk page notice|9}}\nOriginal discussion');
  wiki.race(text => text.replace('|9', '|9|10') + '\nA concurrent reply');
  const source = api.wikiSource(wiki.request, 'Wikipedia:ReviewTool/data/100.json', { talkTitle: 'Talk:Page', revisionId: 100 });
  await source.ensureIndexed();
  assert.deepEqual(api.noticeRevisions(wiki.text), [100, 10, 9]);
  assert.ok(wiki.text.endsWith('Original discussion\nA concurrent reply'));
  assert.equal(wiki.edits.length, 1);
});
