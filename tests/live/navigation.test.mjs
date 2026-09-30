import { waitForAnnotation as ready, clickExport } from './ui.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch, root } from './launch.mjs';
import { recordTestApi } from './record-test-api.mjs';

const revision = 94447348;
const url = `https://zh.wikipedia.org/wiki/孫中山?oldid=${revision}&useskin=vector-2022&uselang=zh-tw`;
const time = '2026-09-26T00:00:00.000Z';
const comment = (id, replies = []) => ({ id, text: 'Saved ' + id, author: 'Example', createdAt: time, replies });
async function closed(page) {
  await page.waitForFunction(() => !document.querySelector('.annotation-document') && document.querySelector('#ca-annotate a')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('.annotation-document').count(), 0);
  assert.equal(await page.locator('#ca-reviewtool-export').count(), 0);
  assert.equal(await page.locator('#ca-annotate').evaluate(e => e.classList.contains('selected')), false);
}

test('the custom article tab replaces the old mode, restores the page, retains private drafts and exports all discussions', async () => {
  const profile = await fs.mkdtemp(path.join(root, '.cache/navigation-test-'));
  const { context } = await launch({ dryRun: true, headless: true, profile });
  const errors = [], tagQueries = [];
  const page = context.pages()[0]; page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.stack));
  page.on('request', request => { if (new URL(request.url()).searchParams.get('list') === 'tags') tagQueries.push(request.url()); });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('#ca-annotate').waitFor();
    assert.match(await page.locator('#ca-annotate').innerText(), /^批[註注]模式$/);
    assert.equal(await page.locator('#ca-reviewtool-annotation-view').count(), 0);
    assert.equal(await page.locator('.annotation-document').count(), 0);
    assert.equal(await page.locator('#ca-reviewtool-export').count(), 0);
    await page.evaluate(() => {
      window.originalArticle = document.querySelector('#mw-content-text > .mw-parser-output');
      window.originalRight = [...document.querySelector('.vector-column-end').childNodes];
      window.originalHeading = document.getElementById('求學');
      window.pageInstance = crypto.randomUUID();
    });
    const instance = await page.evaluate(() => pageInstance);
    const api = await recordTestApi();
    const annotation = { id: 'h', color: 'yellow', author: 'Example', createdAt: time, anchor: { unit: 'utf8-byte', start: 0, end: 14 }, threads: [comment('root', [comment('reply', [comment('nested')])]), { ...comment('closed'), resolved: { by: 'Example', at: time } }] };
    const deleted = { ...annotation, id: 'deleted', threads: [comment('removed')], deleted: { by: 'Example', at: time } };
    const model = api.AnnotationDocument.seed('test-generation', [annotation, deleted], () => true);
    const text = api.encodePage({ wiki: 'zhwiki', pageId: 139, revisionId: revision }, { baseline: 0 }, model); model.destroy();
    await page.evaluate(async text => {
      await __reviewToolDev.createApi().postWithToken('csrf', { action: 'edit', title: 'Wikipedia:ReviewTool/data/94447348.json', text, contentmodel: 'json', summary: '/* ReviewTool */' });
    }, text);
    await page.locator('#ca-annotate a').click(); await ready(page);
    assert.equal(await page.locator('#ca-annotate').evaluate(e => e.classList.contains('selected')), true);
    assert.match(await page.locator('#ca-reviewtool-toggle').textContent(), /關閉|关闭/);
    assert.equal(await page.locator('.annotation-document').count(), 1);
    assert.equal(await page.locator('.reviewtool-live-controls').count(), 0);
    assert.equal(await page.locator('.review-tool-global-button, .sentence[data-sentence-pos]').count(), 0);
    assert.equal(await page.evaluate(() => getComputedStyle(originalArticle).display), 'none');
    assert.equal(await page.evaluate(() => document.getElementById('求學') !== originalHeading), true);
    assert.equal(await page.locator('.annotation-comment-thread').count(), 1);
    await page.locator('[data-comment-id="root"] > .annotation-comment-body').hover();
    await page.locator('[data-comment-id="root"] > .annotation-comment-body').getByRole('button', { name: '編輯', exact: true }).click();
    await page.locator('.annotation-comments textarea').fill('PRIVATE UNSENT EDIT');
    const downloadEvent = page.waitForEvent('download');
    await clickExport(page);
    const download = await downloadEvent;
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.match(download.suggestedFilename(), /review-tool-annotations-94447348-/);
    assert.deepEqual(exported.groups.flatMap(g => g.annotations).map(c => c.id).sort(), ['closed', 'nested', 'removed', 'reply', 'root']);
    assert.equal(JSON.stringify(exported).includes('PRIVATE UNSENT EDIT'), false);
    assert.equal(exported.highlights.length, 2);
    assert.equal(exported.groups[0].annotations.find(c => c.id === 'root').opinion, 'Saved root');
    await page.locator('#ca-annotate a').click(); await closed(page);
    assert.equal(await page.evaluate(() => pageInstance), instance, 'pinned toggles do not reload');
    assert.equal(await page.evaluate(() => document.querySelector('#mw-content-text > .mw-parser-output') === originalArticle && getComputedStyle(originalArticle).display !== 'none'), true);
    assert.equal(await page.evaluate(() => document.getElementById('求學') === originalHeading), true);
    assert.equal(await page.evaluate(() => originalRight.every((node, i) => document.querySelector('.vector-column-end').childNodes[i] === node)), true);
    assert.equal(new URL(page.url()).searchParams.get('reviewtool_annotation_view'), null);
    assert.equal(new URL(page.url()).searchParams.get('useskin'), 'vector-2022');
    // Use the action menu as the alternate entry, including its keyboard activation.
    await page.locator('#ca-reviewtool-toggle a').dispatchEvent('keydown', { key: 'Enter' }); await ready(page);
    assert.equal(await page.locator('.annotation-comments textarea').inputValue(), 'PRIVATE UNSENT EDIT');
    assert.equal(await page.locator('#ca-annotate').count(), 1);
    assert.equal(await page.locator('.annotation-document').count(), 1);
    await page.locator('#ca-annotate a').click(); await closed(page);
    assert.equal(await page.evaluate(() => pageInstance), instance);
    assert.equal(tagQueries.length, 1, 'tag availability is checked once across repeated openings');
    // Closing while the source is loading must not mount a late view or duplicate controls.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const parseRoute = async route => {
      if (new URL(route.request().url()).searchParams.get('action') !== 'parse') return route.fallback();
      await gate; await route.continue().catch(() => {});
    };
    await page.route('**/w/api.php*', parseRoute);
    await page.locator('#ca-annotate a').click();
    await page.waitForFunction(() => document.querySelector('#ca-annotate a')?.getAttribute('aria-busy') === 'true');
    await page.locator('#ca-annotate a').click(); release(); await closed(page);
    await page.unroute('**/w/api.php*', parseRoute);
    await page.locator('#ca-annotate a').click(); await ready(page);
    assert.equal(await page.locator('.annotation-document').count(), 1);
    assert.equal(await page.locator('.annotation-comments textarea').inputValue(), 'PRIVATE UNSENT EDIT');
    await page.locator('.annotation-comments').getByRole('button', { name: '取消', exact: true }).click();
    await page.screenshot({ path: path.join(root, '.cache/annotation-tab-integrated.png') });
    await page.locator('#ca-annotate a').click(); await closed(page);
    await page.evaluate(() => {
      const url = new URL(location.href); url.searchParams.delete('oldid'); url.hash = '求學';
      history.replaceState(history.state, '', url);
    });
    await Promise.all([page.waitForURL(url => url.searchParams.get('oldid') === String(revision)), page.locator('#ca-annotate a').click()]);
    await ready(page);
    assert.equal(new URL(page.url()).searchParams.get('reviewtool_annotation_view'), '1');
    assert.equal(decodeURIComponent(new URL(page.url()).hash), '#求學');
    assert.equal(new URL(page.url()).searchParams.get('useskin'), 'vector-2022');
    assert.equal(await page.locator('#ca-annotate.selected').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
