import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('dry-run JSON pages keep their content model and reject invalid JSON without changing the stored head', async () => {
  const bundle = await build({ stdin: { contents: "import { LocalWiki } from './src/mediawiki-local'; window.wiki = new LocalWiki(); export { syncJournal } from './src/annotation/sync-journal';", resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'fixtureApi', write: false });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<p>Local JSON storage fixture</p>' }));
    await page.goto('http://localhost/'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const title = 'Wikipedia:ReviewTool/data/123.json';
      const created = await wiki.edit(title, '{"value":1}', { contentmodel: 'json', contentformat: 'application/json', createonly: true });
      const before = await wiki.read(title);
      let invalid;
      try { await wiki.edit(title, 'not JSON', { baserevid: before.revid }); } catch (error) { invalid = error.code; }
      const after = await wiki.read(title);
      const edited = await wiki.edit(title, '{"value":2}', { baserevid: before.revid });
      const latest = await wiki.read(title), history = await wiki.history(title);
      await wiki.edit('Talk:Page', '{{ReviewTool talk page notice|123}}\nDiscussion', { contentmodel: 'wikitext', createonly: true });
      return { created, invalid, before, after, edited, latest, history, talk: await wiki.read('Talk:Page') };
    });
    assert.equal(result.created.edit.contentmodel, 'json');
    assert.equal(result.invalid, 'invalid-content-data'); assert.deepEqual(result.before, result.after);
    assert.equal(result.latest.contentmodel, 'json'); assert.equal(result.latest.contentformat, 'application/json');
    assert.equal(result.history.length, 2); assert.ok(result.history.every(page => page.contentmodel === 'json'));
    assert.equal(result.talk.contentmodel, 'wikitext');
    const drafts = await page.evaluate(async () => {
      const old = fixtureApi.syncJournal('old-scope', 'session');
      await old.drafts([{ annotationId: 'h', kind: 'new', text: 'Private draft' }]);
      await old.checkpoint({ generation: 'old', baseline: 0, base: {}, local: {}, revision: { revision: 12 } });
      const next = fixtureApi.syncJournal('old-scope/Wikipedia:ReviewTool/data/123.json', 'session', 'old-scope');
      return { drafts: await next.drafts(), checkpoint: await next.checkpoint(), oldCheckpoint: await old.checkpoint() };
    });
    assert.equal(drafts.drafts[0].text, 'Private draft'); assert.equal(drafts.checkpoint, undefined); assert.equal(drafts.oldCheckpoint.generation, 'old');
  } finally { await browser.close(); }
});
