import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch, root } from './launch.mjs';
import { waitForAnnotation, waitForSaved } from './ui.mjs';
import { recordTestApi, readSnapshot } from './record-test-api.mjs';
const url = 'https://zh.wikipedia.org/wiki/孫中山?oldid=94447348&uselang=zh-tw';
const title = 'Talk:孫中山/ReviewTool/94447348';

async function storedDrafts(page) {
  return page.evaluate(async () => {
    const scope = ['dry-run', mw.config.get('wgDBname'), mw.config.get('wgArticleId'), mw.config.get('wgRevisionId'), 'Example'].join('/');
    const session = sessionStorage.getItem('reviewtool-draft-session/' + scope);
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('reviewtool-annotation-records-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise((resolve, reject) => { const r = db.transaction('drafts').objectStore('drafts').get(scope + '/drafts/' + session); r.onsuccess = () => resolve(r.result ?? []); r.onerror = () => reject(r.error); }); }
    finally { db.close(); }
  });
}
async function waitDrafts(page, expected) {
  let actual;
  for (let i = 0; i < 40; i++) {
    actual = (await storedDrafts(page)).map(d => d.text);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(actual, expected);
}

async function fixture(run) {
  const profile = await fs.mkdtemp(path.join(root, '.cache/draft-lifecycle-'));
  const { context } = await launch({ dryRun: true, headless: true, profile });
  try {
    const page = context.pages()[0]; page.setDefaultTimeout(10000); await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.locator('#ca-annotate').waitFor();
    const api = await recordTestApi(), time = '2026-09-26T00:00:00.000Z';
    const doc = api.AnnotationDocument.seed('draft-lifecycle', [{ id: 'h', color: 'yellow', author: 'Example', createdAt: time, anchor: { unit: 'utf8-byte', start: 0, end: 14 } }], () => true);
    const text = api.encodePage({ wiki: 'zhwiki', pageId: 139, revisionId: 94447348 }, { baseline: 0, prefix: '{{ReviewTool annotation data page}}\n<syntaxhighlight lang="json">\n', suffix: '\n</syntaxhighlight>' }, doc); doc.destroy();
    await page.evaluate(async ({ title, text }) => { await __reviewToolDev.createApi().postWithToken('csrf', { action: 'edit', title, text, summary: '/* ReviewTool */' }); }, { title, text });
    await page.locator('#ca-annotate a').click(); await waitForAnnotation(page);
    await run(page, context);
  } finally { await context.close(); }
}

async function newDraft(page, text) {
  const card = page.locator('.annotation-comment-thread'); await card.hover();
  await card.getByRole('button', { name: /^(新增評論|另寫評論)…$/ }).click();
  await card.getByRole('textbox').fill(text);
  // Wait until the draft really exists on disk. Immediate send after fill masked the bug.
  await waitDrafts(page, [text]);
  return card;
}
const reload = async page => { await page.reload({ waitUntil: 'domcontentloaded' }); await waitForAnnotation(page); };

test('sending a persisted comment clears its private draft before refresh and does not duplicate the saved comment', async () => {
  await fixture(async page => {
    const text = 'A sent review must not return as a draft.';
    const card = await newDraft(page, text);
    await card.getByRole('button', { name: '送出', exact: true }).click();
    await waitForSaved(page, text);
    await waitDrafts(page, []);
    await reload(page); assert.equal(await page.locator('.annotation-comments textarea').count(), 0);
    assert.equal(await page.locator('.annotation-comment-text').textContent(), text);
    await reload(page); assert.equal(await page.locator('.annotation-comments textarea').count(), 0);
    const stored = await page.evaluate(async title => { const r = await __reviewToolDev.createApi().get({ action: 'query', titles: title, prop: 'revisions', rvslots: 'main', rvprop: 'content', formatversion: 2 }); return r.query.pages[0].revisions[0].slots.main.content; }, title);
    assert.equal((await readSnapshot(stored))[0].threads.length, 1);
  });
});

test('discarding a restored draft clears it before refresh while another tab keeps its own draft', async () => {
  await fixture(async (page, context) => {
    const text = 'This discarded draft must stay discarded.';
    await newDraft(page, text); await reload(page);
    assert.equal(await page.locator('.annotation-comments textarea').inputValue(), text);
    const other = await context.newPage(); await other.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 45000 }); await waitForAnnotation(other);
    await newDraft(other, 'A separate private draft in another tab.');
    await page.locator('.annotation-comments').getByRole('button', { name: '放棄草稿', exact: true }).click();
    await waitDrafts(page, []);
    await reload(page); assert.equal(await page.locator('.annotation-comments textarea').count(), 0);
    await reload(page); assert.equal(await page.locator('.annotation-comments textarea').count(), 0);
    await reload(other); assert.equal(await other.locator('.annotation-comments textarea').inputValue(), 'A separate private draft in another tab.');
    await other.close();
  });
});

test('reply submission and edit save or cancel clear persisted drafts through keyboard and button actions', async () => {
  await fixture(async page => {
    const card = await newDraft(page, 'Original comment');
    await card.getByRole('button', { name: '送出', exact: true }).click();
    await waitForSaved(page, 'Original comment');
    const root = page.locator('.annotation-comment-node').first();
    const rootBody = root.locator(':scope > .annotation-comment-body');
    await rootBody.hover(); await rootBody.getByRole('button', { name: '回覆', exact: true }).click();
    await card.getByRole('textbox').fill('A keyboard-submitted reply');
    await waitDrafts(page, ['A keyboard-submitted reply']);
    await card.getByRole('textbox').press('Control+Enter');
    await waitDrafts(page, []); await waitForSaved(page, 'A keyboard-submitted reply');
    await reload(page);
    assert.equal(await card.getByRole('textbox').count(), 0);
    assert.deepEqual(await card.locator('.annotation-comment-text').allTextContents(), ['Original comment', 'A keyboard-submitted reply']);

    await rootBody.hover(); await rootBody.getByRole('button', { name: '編輯', exact: true }).click();
    await waitDrafts(page, ['Original comment']);
    await card.getByRole('textbox').fill('An edit to cancel');
    // Cancel immediately: an earlier queued input save must not restore this draft later.
    await card.getByRole('textbox').press('Escape');
    await waitDrafts(page, []); await reload(page);
    assert.equal(await card.getByRole('textbox').count(), 0);
    assert.equal(await card.locator('.annotation-comment-text').first().textContent(), 'Original comment');

    await rootBody.hover(); await rootBody.getByRole('button', { name: '編輯', exact: true }).click();
    await card.getByRole('textbox').fill('Saved edit'); await waitDrafts(page, ['Saved edit']);
    await card.getByRole('button', { name: '儲存修改', exact: true }).click();
    await waitDrafts(page, []); await waitForSaved(page, 'Saved edit'); await reload(page);
    assert.equal(await card.getByRole('textbox').count(), 0);
    assert.deepEqual(await card.locator('.annotation-comment-text').allTextContents(), ['Saved edit', 'A keyboard-submitted reply']);
  });
});
