import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { recordTestApi } from './record-test-api.mjs';
import { codexTestRuntime } from './codex-test-runtime.mjs';

let browser, script, main, api, runtime, productStyles;
const identity = { wiki: 'zhwiki', pageId: 1, revisionId: 2 }, at = '2026-10-06T00:00:00.000Z';
const source = 'First passage.\n\nSecond passage.';
const comment = (id, author = 'Bob') => ({ id, author, text: id + ' example comment', createdAt: at, replies: [] });
const seed = () => api.AnnotationDocument.seed('test', [
  { id: 'highlight', color: 'green', author: 'Bob', createdAt: at, anchor: { unit: 'utf8-byte', start: 0, end: 14 }, threads: [comment('old')] },
  { id: 'other', color: 'yellow', author: 'Alice', createdAt: at, anchor: { unit: 'utf8-byte', start: 16, end: 31 } },
], () => true);
const encode = model => api.encodePage(identity, { baseline: 0 }, model);
const add = (model, id, author = 'Bob', parentId) => model.dispatch({ type: 'add-comment', id: 'highlight', comment: comment(id, author), ...(parentId ? { parentId } : {}) }, { name: author });

before(async () => {
  api = await recordTestApi(); runtime = await codexTestRuntime();
  productStyles = await readFile('src/styles.css', 'utf8');
  const result = await build({ stdin: { contents: "import { initLiveAnnotation } from './src/annotation/live.ts'; import { pageAnnotationNotifications } from './src/annotation/notifications.ts'; window.startView = initLiveAnnotation; window.checkNotifications = pageAnnotationNotifications;", resolveDir: process.cwd() }, bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false });
  script = result.outputFiles[0].text;
  const built = spawnSync(process.execPath, ['build.mjs'], { encoding: 'utf8' }); assert.equal(built.status, 0, built.stderr);
  main = await readFile('dist/bundled.js', 'utf8');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(run, { width = 1400, skin = 'vector-2022', records = [encode(seed())], viewed, subscribed = false, mainEntry = false, namespace = 0, dark = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="${dark ? 'skin-theme-clientpref-night' : ''}"><head><style>${runtime.style}
      body{margin:0;background:${dark ? '#101418' : '#fff'};color:${dark ? '#eaecf0' : '#202122'};font-family:sans-serif} .fixture{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:30px;margin:40px} @media(max-width:900px){.fixture{display:block;margin:24px}}
      #notices{position:fixed;right:12px;top:12px;z-index:10000;max-width:320px}.mw-notification{background:${dark ? '#202122' : '#fff'};padding:14px;border:1px solid #a2a9b1;margin:8px;box-shadow:0 2px 6px #0002;font-size:14px}.mw-notification-title{font-weight:bold;margin-bottom:6px}</style></head><body>
      <ul id="p-views"></ul><ul id="p-cactions"></ul><h1 id="firstHeading">Test</h1><div style="height:1100px"></div><div class="fixture"><div id="mw-content-text"><div class="mw-parser-output">Original article</div></div><div class="vector-column-end no-font-mode-scale"></div></div><div style="height:1100px"></div><div id="notices"></div></body></html>` }));
    await page.goto('http://localhost/w/index.php?oldid=2&reviewtool_annotation_view=1');
    await page.addStyleTag({ content: productStyles });
    await page.addScriptTag({ content: runtime.script });
    await page.evaluate(({ records, viewed, subscribed, skin, namespace, source }) => {
      document.body.classList.add('skin-' + skin); if (skin === 'minerva') document.querySelector('.vector-column-end').remove();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      const dataTitle = 'Wikipedia:ReviewTool/data/2.json';
      const config = { wgNamespaceNumber: namespace, wgAction: 'view', wgRevisionId: 2, wgArticleId: 1, wgPageName: namespace === 4 ? dataTitle : namespace === 2 ? 'User:Other' : 'Test', wgTitle: namespace === 4 ? 'ReviewTool/data/2.json' : 'Test', wgDBname: 'zhwiki', wgUserName: 'Alice', wgUserGroups: ['user'], skin };
      window.config = config; window.calls = []; window.notifications = []; window.versions = []; window.timerCount = 0;
      const interval = window.setInterval; window.setInterval = (...args) => { timerCount++; return interval(...args); };
      window.appendVersion = text => versions.push({ revid: 100 * (versions.length + 1), parentid: versions.length * 100, timestamp: '2026-10-06T00:00:00.000Z', tags: [], comment: '/* ReviewTool */', slots: { main: { content: text } } });
      records.forEach(appendVersion);
      if (viewed !== undefined || subscribed) localStorage.setItem('reviewtool-annotation-visits/normal/zhwiki/2', JSON.stringify({ pageName: 'Test', oldid: 2, subscribed, ...(viewed === undefined ? {} : { viewedRevision: viewed }) }));
      const wrap = promise => ({ done(fn) { promise.then(fn, () => {}); return this; }, fail(fn) { promise.catch(fn); return this; } });
      window.mw = {
        config: { get: key => config[key] },
        hook: () => ({ add() {} }),
        Title: { newFromText: () => ({ getTalkPage: () => ({ getPrefixedText: () => 'Talk:Test' }) }) },
        loader: { using: async () => name => name === 'vue' ? testCodex.Vue : name === 'ext.gadget.HanAssist' ? { convByVar: text => text.hant } : testCodex.Codex },
        Api: class {
          get(params) {
            calls.push(params);
            if (params.action === 'parse') return wrap(Promise.resolve({ parse: { pageid: 1, revid: 2, title: 'Test', wikitext: source } }));
            if (params.list === 'tags') return wrap(Promise.resolve({ query: { tags: [] } }));
            if (params.titles === 'Talk:Test') return wrap(Promise.resolve({ query: { pages: [{ title: 'Talk:Test', revisions: [{ ...versions[0], slots: { main: { content: '{{ReviewTool talk page notice|2}}', contentmodel: 'wikitext' } } }] }] } }));
            const selected = params.revids ? versions.filter(v => v.revid === params.revids) : params.rvlimit ? [...versions].reverse().filter(v => v.revid <= params.rvstartid && (!params.rvendid || v.revid >= params.rvendid)) : versions.slice(-1);
            return wrap(Promise.resolve({ query: { pages: [{ title: dataTitle, revisions: selected }] } }));
          }
          abort() {}
          postWithToken() { throw new Error('Unexpected write'); }
        },
        notify: (message, options) => {
          const element = document.createElement('div'); element.className = 'mw-notification ' + (options.classes ?? '');
          const title = document.createElement('div'); title.className = 'mw-notification-title'; title.textContent = options.title ?? ''; element.append(title, message); document.getElementById('notices').append(element);
          notifications.push({ text: typeof message === 'string' ? message : message.textContent, options });
          return Promise.resolve({ close: () => element.remove() });
        },
        util: { addPortletLink: (target, href, text, id) => {
          const li = document.createElement('li'); li.id = id; const link = document.createElement('a'); link.href = href; link.textContent = text; li.append(link); document.getElementById(target)?.append(li); return li;
        } },
      };
    }, { records, viewed, subscribed, skin, namespace, source });
    await page.addScriptTag({ content: mainEntry ? main : script });
    if (!mainEntry) await page.evaluate(() => startView());
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

test('real Codex subscription button persists locally and cleans up with the view', async () => {
  await fixture(async page => {
    const button = page.getByRole('button', { name: '訂閱本頁', exact: true }); await button.waitFor();
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    const firstIcon = await button.locator('svg').innerHTML(); await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true'); assert.notEqual(await button.locator('svg').innerHTML(), firstIcon);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('reviewtool-annotation-visits/normal/zhwiki/2'))), { pageName: 'Test', oldid: 2, subscribed: true, viewedRevision: 100 });
    assert.equal(await page.locator('.annotation-subscription-controls').evaluate(element => element.nextElementSibling.classList.contains('mw-parser-output')), true);
    await page.locator('#ca-annotate a').click(); await button.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.mw-parser-output').evaluate(element => getComputedStyle(element).display), 'block');
    await page.locator('#ca-annotate a').click(); await button.waitFor(); assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.mw-notification').count(), 0);
    await button.click(); assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reviewtool-annotation-visits/normal/zhwiki/2')).subscribed), false);
  });
});

test('notification close buttons dismiss only their own notice without following its link', async () => {
  const model = seed(), initial = encode(model); add(model, 'new'); add(model, 'reply', 'Carol', 'new');
  await fixture(async page => {
    await page.evaluate(text => { appendVersion(text); document.dispatchEvent(new Event('visibilitychange')); }, encode(model));
    await page.waitForFunction(() => notifications.length === 2);
    const notices = page.locator('.mw-notification');
    const location = page.url(), scroll = await page.evaluate(() => scrollY);
    await notices.first().getByRole('button', { name: '關閉通知', exact: true }).click();
    assert.equal(await notices.count(), 1); assert.equal(await notices.locator('.mw-notification-title').textContent(), 'Carol');
    assert.equal(page.url(), location); assert.equal(await page.evaluate(() => scrollY), scroll);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.commentId), undefined);
    await notices.getByRole('button', { name: '關閉通知', exact: true }).focus(); await page.keyboard.press('Enter');
    assert.equal(await notices.count(), 0); assert.equal(page.url(), location);
  }, { records: [initial] });
});

for (const skin of ['vector-2022', 'minerva']) test(`${skin}: remote notifications reveal the right comment with scrolling, expansion and emphasis`, async () => {
  const model = seed(); const initial = encode(model); add(model, 'new'); add(model, 'reply', 'Carol', 'new'); add(model, 'mine', 'Alice');
  await fixture(async page => {
    assert.equal(await page.locator('.mw-notification').count(), 0);
    await page.evaluate(text => { appendVersion(text); document.dispatchEvent(new Event('visibilitychange')); }, encode(model));
    await page.waitForFunction(() => notifications.length === 2);
    assert.deepEqual(await page.evaluate(() => notifications.map(n => [n.options.title, n.options.autoHide])), [['Bob', false], ['Carol', false]]);
    await page.locator('.mw-notification a').filter({ hasText: 'reply example comment' }).click();
    await page.waitForFunction(() => document.activeElement.dataset.commentId === 'reply');
    assert.ok(await page.evaluate(() => scrollY > 500));
    assert.equal(await page.locator('[data-comment-id="reply"] .annotation-comment-text').isVisible(), true);
    assert.equal(await page.locator('.annotation-highlight-backgrounds [data-engaged]').getAttribute('data-annotation-marker'), 'highlight');
    assert.equal(await page.locator('[data-annotation-marker="other"]').evaluate(element => getComputedStyle(element).opacity), '0.175');
    if (skin === 'minerva') assert.equal(await page.locator('.annotation-comments').evaluate(element => element.matches(':popover-open')), true);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reviewtool-annotation-visits/normal/zhwiki/2')).viewedRevision), 200);
    await page.locator('.annotation-subscription-controls').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.cache/notifications-${skin}.png` });
  }, { records: [initial], width: skin === 'minerva' ? 420 : 1400, skin, dark: skin === 'minerva' });
});

test('catch-up groups missed ancestors and descendants once, with all actor names', async () => {
  const model = seed(); const initial = encode(model); add(model, 'new'); add(model, 'reply', 'Carol', 'new'); add(model, 'last', 'Dan', 'reply');
  await fixture(async page => {
    await page.waitForFunction(() => notifications.length === 1);
    assert.equal(await page.locator('.mw-notification-title').textContent(), 'Bob、Carol和Dan');
    assert.match(await page.locator('.mw-notification a').textContent(), /3 項新動態/);
    assert.equal(await page.evaluate(() => calls.filter(call => call.revids === 100).length), 1);
    await page.locator('.mw-notification a').click(); await page.waitForFunction(() => document.activeElement.dataset.commentId === 'new');
    await page.locator('#ca-annotate a').click(); await page.locator('#ca-annotate a').click();
    assert.equal(await page.locator('.mw-notification').count(), 0); assert.equal(await page.evaluate(() => notifications.length), 1);
  }, { records: [initial, encode(model)], viewed: 100 });
});

test('highlight-only actions reveal their card and deleted targets still scroll to the passage', async () => {
  const model = seed(); const initial = encode(model);
  model.dispatch({ type: 'recolor-highlight', id: 'highlight', color: 'blue', editedAt: at }, { name: 'Bob' });
  const recolored = encode(model);
  model.dispatch({ type: 'delete-highlight', id: 'highlight', at }, { name: 'Bob' });
  await fixture(async page => {
    await page.evaluate(text => { appendVersion(text); document.dispatchEvent(new Event('visibilitychange')); }, recolored);
    await page.locator('.mw-notification a').filter({ hasText: '更改了高亮顏色' }).click();
    await page.waitForFunction(() => document.activeElement.dataset.annotationId === 'highlight');
    assert.equal(await page.locator('.annotation-comments').isVisible(), true);
    await page.evaluate(text => { scrollTo(0, 0); appendVersion(text); document.dispatchEvent(new Event('visibilitychange')); }, encode(model));
    await page.locator('.mw-notification a').filter({ hasText: '刪除了高亮' }).click();
    await page.waitForFunction(() => scrollY > 500);
    assert.equal(await page.locator('[data-annotation-id="highlight"].annotation-comment-thread').count(), 0);
  }, { records: [initial], skin: 'minerva', width: 420 });
});

test('the production quick-exit path checks subscriptions once, uses metadata only, and keeps the viewed marker', async () => {
  const model = seed(), initial = encode(model); add(model, 'new');
  await fixture(async page => {
    await page.locator('.mw-notification a').waitFor();
    assert.equal(await page.locator('.mw-notification-title').textContent(), 'Test的2批註頁');
    assert.match(await page.locator('.mw-notification a').textContent(), /1 次更新/);
    const url = new URL(await page.locator('.mw-notification a').getAttribute('href'));
    assert.equal(url.searchParams.get('oldid'), '2'); assert.equal(url.searchParams.get('reviewtool_annotation_view'), '1');
    assert.equal(await page.evaluate(() => timerCount), 0);
    assert.equal(await page.evaluate(() => calls.every(call => call.rvprop === 'ids')), true);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('reviewtool-annotation-visits/normal/zhwiki/2')).viewedRevision), 100);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await page.evaluate(() => calls.length), 2);
  }, { mainEntry: true, namespace: 2, records: [initial, encode(model)], viewed: 100, subscribed: true });
});

test('JSON pages expose a persistent ReviewTool link with no data requests', async () => {
  await fixture(async page => {
    await page.locator('.mw-notification a').waitFor();
    assert.equal(await page.locator('.mw-notification-title').textContent(), 'ReviewTool');
    assert.equal(await page.locator('.mw-notification a').textContent(), '快速跳轉至批註頁');
    const url = new URL(await page.locator('.mw-notification a').getAttribute('href'));
    assert.equal(url.pathname, '/w/index.php'); assert.equal(url.searchParams.get('oldid'), '2'); assert.equal(url.searchParams.get('reviewtool_annotation_view'), '1');
    assert.equal(await page.evaluate(() => calls.length), 0); assert.equal(await page.evaluate(() => notifications[0].options.autoHide), false);
  }, { mainEntry: true, namespace: 4 });
});
