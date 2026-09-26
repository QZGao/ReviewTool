import { waitForAnnotation as waitReady } from './ui.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readSnapshot } from './record-test-api.mjs';
import { launch, root } from './launch.mjs';
const url = 'https://zh.wikipedia.org/wiki/孫中山?reviewtool_annotation_view=1&oldid=94447348&uselang=zh-tw';
async function readData(page) {
  const result = await page.evaluate(async () => {
    const title = `Talk:${mw.config.get('wgPageName').replace(/_/g, ' ')}/ReviewTool/${mw.config.get('wgRevisionId')}`;
    const result = await __reviewToolDev.createApi().get({ action: 'query', titles: title, prop: 'revisions', rvslots: 'main', rvprop: 'ids|content|tags|comment', formatversion: 2 });
    const revision = result.query.pages[0].revisions[0], match = revision.slots.main.content.match(/<syntaxhighlight lang="json">\s*([\s\S]*?)\s*<\/syntaxhighlight>/); return { title, revision, data: match ? JSON.parse(match[1]) : null };
  });
  return { ...result, annotations: result.data ? await readSnapshot(result.revision.slots.main.content) : null };
}
test('live dry-run peers receive concurrent roots within ten seconds, retain a draft, and repair manual damage', async () => {
  const profile = await fs.mkdtemp(path.join(root, '.cache/records-live-peers-'));
  const { context } = await launch({ dryRun: true, headless: true, profile });
  try {
    const pages = [];
    for (const name of ['Alice', 'Bob']) {
      const page = await context.newPage(); await page.setViewportSize({ width: 1440, height: 1000 }); page.setDefaultTimeout(12000);
      await page.addInitScript(name => {
        let config; Object.defineProperty(window, 'RLCONF', { configurable: true, get: () => config, set: value => { config = value; if (value && typeof value === 'object') { value.wgUserName = name; value.wgUserGroups = ['*', 'user']; } } });
      }, name);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await waitReady(page); pages.push(page);
    }
    const [alice, bob] = pages;
    // Both test pages stay foreground-visible for the active-tab refresh contract.
    for (const page of pages) await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
    await alice.locator('.annotation-document [data-source-run]').first().scrollIntoViewIfNeeded();
    await alice.locator('.annotation-document [data-source-run]').first().evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); getSelection().removeAllRanges(); getSelection().addRange(range); });
    await alice.locator('[data-annotation-toolbar]').getByRole('button', { name: '綠色高亮', exact: true }).click();
    await bob.locator('.annotation-comment-thread').waitFor({ state: 'attached', timeout: 10000 });
    for (const [page, text] of [[alice, 'Alice root'], [bob, 'Bob root']]) {
      await page.locator('.annotation-comment-thread').scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: '新增評論…', exact: true }).click(); await page.locator('.annotation-comments textarea').fill(text);
    }
    const started = Date.now();
    await Promise.all(pages.map(page => page.locator('.annotation-comments').getByRole('button', { name: '送出', exact: true }).click()));
    await Promise.all(pages.map(page => page.waitForFunction(() => document.querySelectorAll('.annotation-comment-content > .annotation-comment-node').length === 2, undefined, { timeout: 10000 })));
    const latency = Date.now() - started; assert.ok(latency < 10000, `concurrent publication took ${latency}ms`);
    await alice.locator('.annotation-comment-thread').hover();
    await alice.getByRole('button', { name: '另寫評論…', exact: true }).click(); await alice.locator('.annotation-comments textarea').fill('A private unfinished draft');
    await alice.locator('.annotation-comments textarea').evaluate(input => input.setSelectionRange(2, 8));
    const rootBody = bob.getByText('Alice root', { exact: true }).locator('..'); await rootBody.hover(); await rootBody.getByRole('button', { name: '回覆', exact: true }).click();
    await bob.locator('.annotation-comments textarea').fill('Bob reply'); await bob.locator('.annotation-comments').getByRole('button', { name: '送出', exact: true }).click();
    await alice.getByText('Bob reply', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(await alice.locator('.annotation-comments textarea').evaluate(input => ({ value: input.value, start: input.selectionStart, end: input.selectionEnd, focus: document.activeElement === input })), { value: 'A private unfinished draft', start: 2, end: 8, focus: true });
    await alice.reload({ waitUntil: 'domcontentloaded' }); await waitReady(alice);
    await alice.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
    assert.equal(await alice.locator('.annotation-comments textarea').inputValue(), 'A private unfinished draft');
    const before = await readData(alice);
    assert.equal(before.revision.slots.main.content.includes('A private unfinished draft'), false, 'private drafts are not published to the annotation page');
    assert.equal(before.data.format, 'reviewtool.annotation-records/1'); assert.equal(before.annotations[0].threads.length, 2);
    await bob.evaluate(async ({ title, revision }) => { await __reviewToolDev.createApi().postWithToken('csrf', { action: 'edit', title, text: 'Malformed manual test edit', summary: 'Manual test edit', baserevid: revision.revid }); }, before);
    let repaired;
    const repairStart = Date.now();
    do {
      repaired = await readData(alice);
      if (repaired.data?.format === 'reviewtool.annotation-records/1') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() - repairStart < 10000);
    assert.ok(repaired.data, JSON.stringify({ latest: repaired.revision, alice: await alice.locator('.mw-notification').allTextContents(), bob: await bob.locator('.mw-notification').allTextContents() }));
    assert.deepEqual(repaired.annotations, before.annotations);
    assert.equal(await alice.locator('.annotation-comments textarea').inputValue(), 'A private unfinished draft');
    console.log(`Two-peer concurrent publication and refresh: ${latency}ms. Manual damage repaired with both roots and reply retained.`);
  } finally { await context.close(); }
});
