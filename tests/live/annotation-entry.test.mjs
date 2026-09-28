import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { recordTestApi } from './record-test-api.mjs';

let browser, script, data;
before(async () => {
  const bundle = await build({ stdin: { contents: "import { initLiveAnnotation } from './src/annotation/live.ts'; window.startView = initLiveAnnotation;", resolveDir: process.cwd() }, bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false });
  script = bundle.outputFiles[0].text;
  const api = await recordTestApi(), at = '2026-09-29T00:00:00.000Z';
  const model = api.AnnotationDocument.seed('entry-test', [{ id: 'h', color: 'green', author: 'Example', createdAt: at, anchor: { unit: 'utf8-byte', start: 0, end: 15 }, threads: [{ id: 'root', text: 'Saved root', author: 'Example', createdAt: at, resolution: { resolved: true, by: 'Example', at }, replies: [{ id: 'linked-reply', text: 'Linked reply', author: 'Other', createdAt: at, replies: [] }] }] }], () => true);
  data = api.encodePage({ wiki: 'zhwiki', pageId: 1, revisionId: 2 }, { baseline: 0, prefix: '{{ReviewTool annotation data page}}\n<syntaxhighlight lang="json">\n', suffix: '\n</syntaxhighlight>' }, model); model.destroy();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(run) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="p-views"><ul class="vector-menu-content-list"></ul></div><ul id="p-cactions"></ul><h1 id="firstHeading">Test</h1><div style="display:grid;grid-template-columns:1fr 260px;gap:30px;margin:60px"><div id="mw-content-text"><div class="mw-parser-output">Original</div></div><div class="vector-column-end no-font-mode-scale"></div></div>' }));
    await page.goto('http://localhost/?oldid=2&reviewtool_annotation_view=1&reviewtool_annotation_comment_id=linked-reply');
    await page.evaluate(data => {
      const gate = new Promise(resolve => { window.releaseSource = resolve; });
      const revision = { revid: 100, parentid: 0, timestamp: '2026-09-29T00:00:00.000Z', comment: '/* ReviewTool */', tags: [], slots: { main: { content: data } } };
      const wrap = promise => ({ done(fn) { promise.then(fn, () => {}); return this; }, fail(fn) { promise.catch(fn); return this; } });
      const config = { wgNamespaceNumber: 0, wgAction: 'view', wgRevisionId: 2, wgArticleId: 1, wgPageName: 'Test', wgDBname: 'zhwiki', wgUserName: 'Example', wgUserGroups: ['user'], skin: 'vector-2022' };
      window.requestTitles = [];
      window.mw = {
        config: { get: key => config[key] },
        Title: { newFromText: () => ({ getTalkPage: () => ({ getPrefixedText: () => 'Talk:Test' }) }) },
        Api: class {
          get(params) {
            if (params.action === 'parse') return wrap(gate.then(() => ({ parse: { pageid: 1, revid: 2, title: 'Test', wikitext: '段落內容。\n\n第二段。' } })));
            if (params.list === 'tags') return wrap(Promise.resolve({ query: { tags: [] } }));
            if (params.titles) requestTitles.push(params.titles);
            return wrap(Promise.resolve({ query: { pages: [{ revisions: [revision] }] } }));
          }
          postWithToken() { throw new Error('Unexpected publication'); }
          abort() {}
        },
        notify: () => Promise.resolve({ close() {} }),
        util: { addPortletLink: (target, href, text, id) => {
          const li = document.createElement('li'); li.id = id; const a = document.createElement('a'); a.href = href; a.textContent = text; li.append(a); document.getElementById(target)?.append(li); return li;
        } },
      };
    }, data);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => { window.boot = startView(); });
    await page.getByRole('progressbar').waitFor();
    assert.equal(await page.locator('.mw-parser-output').evaluate(element => getComputedStyle(element).display), 'none');
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

test('live entry waits with progress, loads the existing Talk data page, and navigates to the comment UUID', async () => {
  await fixture(async page => {
    await page.evaluate(async () => { releaseSource(); await boot; });
    assert.equal(await page.getByRole('progressbar').count(), 0);
    assert.equal(await page.locator('.annotation-document').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.commentId), 'linked-reply');
    assert.ok((await page.evaluate(() => requestTitles)).every(title => title === 'Talk:Test/ReviewTool/2'));
    await page.locator('#ca-annotate a').click();
    await page.waitForFunction(() => !document.querySelector('.annotation-document'));
    assert.equal(await page.locator('.mw-parser-output').evaluate(element => getComputedStyle(element).display), 'block');
    assert.equal(new URL(page.url()).searchParams.has('reviewtool_annotation_comment_id'), false);
  });
});

test('closing while the live source request is pending immediately restores the original article', async () => {
  await fixture(async page => {
    await page.locator('#ca-annotate a').click();
    assert.equal(await page.getByRole('progressbar').count(), 0);
    assert.equal(await page.locator('.mw-parser-output').evaluate(element => getComputedStyle(element).display), 'block');
    await page.evaluate(async () => { releaseSource(); await boot; });
    assert.equal(await page.locator('.annotation-document').count(), 0);
  });
});
