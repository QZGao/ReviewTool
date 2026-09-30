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
  const model = api.AnnotationDocument.seed('entry-test', [{ id: 'h', color: 'green', author: 'Example', createdAt: at, anchor: { unit: 'utf8-byte', start: 0, end: 15 }, threads: [{ id: 'root', text: 'Saved root', author: 'Example', createdAt: at, resolution: { resolved: true, by: 'Example', at }, replies: [{ id: 'linked-reply', text: 'Linked reply', author: 'Other', createdAt: at, replies: [] }] }] }, { id: 'other', color: 'yellow', author: 'Example', createdAt: at, anchor: { unit: 'utf8-byte', start: 17, end: 29 }, threads: [] }], () => true);
  data = api.encodePage({ wiki: 'zhwiki', pageId: 1, revisionId: 2 }, { baseline: 0 }, model); model.destroy();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(run, { width = 1400, skin = 'vector-2022', tall = false, longThread = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<style>.fixture{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:30px;margin:60px} @media(max-width:900px){.fixture{display:block;margin:16px}}</style><div id="p-views"><ul class="vector-menu-content-list"></ul></div><ul id="p-cactions"></ul><h1 id="firstHeading">Test</h1>${tall ? '<div style="height:1200px"></div>' : ''}<div class="fixture"><div id="mw-content-text"><div class="mw-parser-output">Original</div></div><div class="vector-column-end no-font-mode-scale"></div></div>${tall ? '<div style="height:1200px"></div>' : ''}` }));
    await page.goto('http://localhost/?oldid=2&reviewtool_annotation_view=1&reviewtool_annotation_comment_id=linked-reply');
    await page.evaluate(({ data, skin }) => {
      document.body.classList.add('skin-' + skin);
      if (skin === 'minerva') document.querySelector('.vector-column-end').remove();
      const gate = new Promise(resolve => { window.releaseSource = resolve; });
      const revision = { revid: 100, parentid: 0, timestamp: '2026-09-29T00:00:00.000Z', comment: '/* ReviewTool */', tags: [], slots: { main: { content: data } } };
      const wrap = promise => ({ done(fn) { promise.then(fn, () => {}); return this; }, fail(fn) { promise.catch(fn); return this; } });
      const config = { wgNamespaceNumber: 0, wgAction: 'view', wgRevisionId: 2, wgArticleId: 1, wgPageName: 'Test', wgDBname: 'zhwiki', wgUserName: 'Example', wgUserGroups: ['user'], skin };
      window.requestTitles = [];
      window.notifications = [];
      window.mw = {
        config: { get: key => config[key] },
        Title: { newFromText: () => ({ getTalkPage: () => ({ getPrefixedText: () => 'Talk:Test' }) }) },
        Api: class {
          get(params) {
            if (params.action === 'parse') return wrap(gate.then(() => ({ parse: { pageid: 1, revid: 2, title: 'Test', wikitext: '段落內容。\n\n第二段。' } })));
            if (params.list === 'tags') return wrap(Promise.resolve({ query: { tags: [] } }));
            if (params.titles) requestTitles.push(params.titles);
            if (params.titles === 'Talk:Test') return wrap(Promise.resolve({ query: { pages: [{ title: 'Talk:Test', revisions: [{ ...revision, revid: 101, slots: { main: { content: '{{ReviewTool talk page notice|2}}\nExisting discussion', contentmodel: 'wikitext' } } }] }] } }));
            return wrap(Promise.resolve({ query: { pages: [{ revisions: [revision] }] } }));
          }
          postWithToken() { throw new Error('Unexpected publication'); }
          abort() {}
        },
        notify: (message, options) => { notifications.push({ message, options }); return Promise.resolve({ close() {} }); },
        util: { addPortletLink: (target, href, text, id) => {
          const li = document.createElement('li'); li.id = id; const a = document.createElement('a'); a.href = href; a.textContent = text; li.append(a); document.getElementById(target)?.append(li); return li;
        } },
      };
    }, { data: longThread ? data.replace('Saved root', 'Saved root '.repeat(100)) : data, skin });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => { window.boot = startView(); });
    await page.getByRole('progressbar').waitFor();
    assert.equal(await page.locator('.mw-parser-output').evaluate(element => getComputedStyle(element).display), 'none');
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

test('live entry waits with progress, loads JSON data and the talk notice, and navigates to the comment UUID', async () => {
  await fixture(async page => {
    await page.evaluate(async () => { releaseSource(); await boot; });
    assert.equal(await page.getByRole('progressbar').count(), 0);
    assert.equal(await page.locator('.annotation-document').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.commentId), 'linked-reply');
    assert.deepEqual([...new Set(await page.evaluate(() => requestTitles))], ['Wikipedia:ReviewTool/data/2.json', 'Talk:Test']);
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

for (const skin of ['vector-2022', 'minerva']) test(`${skin}: a comment permalink opens its floating thread before focus, without requiring highlight hover`, async () => {
  await fixture(async page => {
    await page.evaluate(async () => { releaseSource(); await boot; });
    await page.waitForTimeout(250);
    const panel = page.locator('.annotation-comments');
    const reply = page.locator('[data-comment-id="linked-reply"]');
    assert.equal(await panel.getAttribute('data-layout'), 'floating');
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.evaluate(element => element.matches(':popover-open')), true);
    assert.equal(await reply.locator('.annotation-comment-text').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.commentId), 'linked-reply');
    assert.equal(await page.locator('[data-comment-id="root"]').getAttribute('data-resolved'), '', 'revealing does not unresolve the discussion');
    const rect = await reply.boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 901, 'linked comment is inside the viewport');
    const passage = await page.locator('.annotation-document p').first().boundingBox();
    assert.ok(passage.y >= 0 && passage.y + passage.height <= 901, 'the corresponding source passage is also visible');
    await page.mouse.move(5, 5); await page.waitForTimeout(230);
    assert.equal(await panel.isVisible(), true, 'initial focus holds the panel open without pointer hover');
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
  }, { width: 390, skin, tall: true });
});

for (const width of [1400, 390]) test(`comment-link focus applies hover emphasis at ${width}px and releases it on blur`, async () => {
  await fixture(async page => {
    await page.evaluate(async () => { releaseSource(); await boot; });
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => ({
      card: document.querySelector('.annotation-comment-thread[data-engaged]')?.dataset.annotationId,
      outline: document.querySelector('.annotation-comment-highlight-outline')?.dataset.annotationId,
      dimCard: getComputedStyle(document.querySelector('.annotation-comment-thread[data-annotation-id="other"]')).opacity,
      dimConnector: getComputedStyle(document.querySelector('.annotation-comment-connectors path[data-annotation-id="other"]')).opacity,
      dimHighlight: getComputedStyle(document.querySelector('[data-annotation-marker="other"]')).opacity,
      focusedHighlight: getComputedStyle(document.querySelector('[data-annotation-marker="h"]')).opacity,
    }));
    assert.deepEqual(state, { card: 'h', outline: 'h', dimCard: '0.35', dimConnector: '0.35', dimHighlight: '0.175', focusedHighlight: '0.5' });
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.annotation-comment-thread[data-engaged]').count(), 0);
    assert.equal(await page.locator('[data-annotation-marker="other"]').evaluate(el => getComputedStyle(el).opacity), '0.5');
  }, { width, tall: true });
});

for (const skin of ['vector-2022', 'minerva']) test(`${skin}: a linked reply below a long resolved root scrolls into the floating panel and can be dismissed`, async () => {
  await fixture(async page => {
    await page.evaluate(async () => { releaseSource(); await boot; });
    await page.waitForTimeout(250);
    const panel = page.locator('.annotation-comments');
    const content = panel.locator('[data-annotation-id="h"] > .annotation-comment-content');
    const reply = panel.locator('[data-comment-id="linked-reply"]');
    assert.equal(await panel.isVisible(), true);
    assert.ok(await content.evaluate(element => element.scrollTop > 0), 'the panel scrolls past the long parent');
    const clip = await content.boundingBox(), box = await reply.boundingBox();
    assert.ok(box.y >= clip.y - 1 && box.y + box.height <= clip.y + clip.height + 1, 'the actual linked reply is visible inside the panel');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.commentId), 'linked-reply');
    assert.equal(await panel.locator('.annotation-resolved-summary').isVisible(), false);
    if (skin === 'vector-2022') await page.mouse.click(5, 800);
    else await page.evaluate(() => { document.activeElement.blur(); window.scrollBy(0, 50); });
    await panel.waitFor({ state: 'hidden' });
  }, { width: skin === 'minerva' ? 1400 : 390, skin, tall: true, longThread: true });
});

test('copying a comment link reports success or clipboard failure through MediaWiki notifications', async () => {
  await fixture(async page => {
    await page.evaluate(async () => {
      releaseSource(); await boot;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedLink = text; } } });
    });
    const comment = page.locator('[data-comment-id="linked-reply"]');
    await comment.locator('.annotation-comment-text').hover();
    const copy = comment.getByRole('button', { name: '複製評論連結', exact: true });
    await copy.click();
    assert.equal(new URL(await page.evaluate(() => copiedLink)).searchParams.get('reviewtool_annotation_comment_id'), 'linked-reply');
    assert.deepEqual(await page.evaluate(() => notifications.at(-1)), {
      message: '已複製評論連結', options: { tag: 'reviewtool-comment-link', type: 'success', autoHide: true },
    });
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('Clipboard denied', 'NotAllowedError'); }; });
    await copy.click();
    assert.deepEqual(await page.evaluate(() => notifications.at(-1)), {
      message: '無法複製連結，請允許存取剪貼簿。', options: { tag: 'reviewtool-comment-link', type: 'error', autoHide: true },
    });
  });
});
