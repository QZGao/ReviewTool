import { waitForAnnotation, waitForSaved } from './ui.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readSnapshot } from './record-test-api.mjs';
import { launch, root } from './launch.mjs';

const url = 'https://zh.wikipedia.org/wiki/孫中山?reviewtool_annotation_view=1&oldid=94447348&uselang=zh-tw';

test('the Chrome extension preserves moderator summaries and edited dates locally without remote writes', async () => {
  const profile = await fs.mkdtemp(path.join(root, '.cache/live-test-'));
  const launched = await launch({ dryRun: true, headless: true, profile });
  let context = launched.context;
  const extensionId = launched.extensionId;
  const blockedWrites = [];
  const blockedOptions = [];
  try {
    const page = context.pages()[0]; page.setDefaultTimeout(15000);
    await context.addInitScript(() => {
      let config;
      Object.defineProperty(window, 'RLCONF', {
        configurable: true, get: () => config,
        set: value => { config = value; if (value && typeof value === 'object') { value.wgUserName = localStorage.getItem('reviewtool-test-actor'); value.wgUserGroups = ['*', 'user', 'sysop']; } },
      });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors = []; page.on('pageerror', error => { if (error.message.includes('ReviewTool')) errors.push(error.message); });
    context.on('request', request => {
      const u = new URL(request.url()); if (u.pathname !== '/w/api.php') return;
      const action = new URLSearchParams(request.postData() ?? '').get('action') ?? u.searchParams.get('action') ?? 'query';
      if (!['query', 'parse', 'compare', 'paraminfo', 'help', 'expandtemplates', 'opensearch'].includes(action)) blockedWrites.push(action);
    });
    context.on('requestfailed', request => {
      const u = new URL(request.url()); if (u.pathname !== '/w/api.php') return;
      const action = new URLSearchParams(request.postData() ?? '').get('action') ?? u.searchParams.get('action');
      if (action === 'options' && request.failure()?.errorText.startsWith('net::ERR_BLOCKED_BY_CLIENT')) blockedOptions.push(action);
    });
    const cdp = await context.newCDPSession(page); await cdp.send('Debugger.enable');
    let mapUrl; cdp.on('Debugger.scriptParsed', event => { if (event.url === `chrome-extension://${extensionId}/bundle.js`) mapUrl = event.sourceMapURL; });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForAnnotation(page);
    assert.ok(await page.evaluate(() => mw.config.get('wgUserGroups').includes('sysop')), 'the isolated test response supplies the simulated role');
    assert.match(mapUrl, /^data:application\/json/);
    const map = JSON.parse(Buffer.from(mapUrl.split(',')[1], 'base64').toString());
    assert.ok(map.sources.some(source => source.endsWith('src/annotation/live.ts')));
    assert.ok(map.sources.some(source => source.endsWith('src/mediawiki-dry-run.ts')));
    assert.ok(map.sourcesContent.every(source => typeof source === 'string'));
    await page.locator('.annotation-document [data-source-run]').first().scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('.annotation-document [data-source-run]').first().evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.locator('[data-annotation-toolbar]').getByRole('button', { name: '綠色高亮', exact: true }).click();
    assert.equal(await page.locator('.annotation-highlight-attribution').textContent(), '高亮：Example');
    await page.locator('.annotation-comments').getByRole('button', { name: '新增評論…' }).click();
    await page.locator('.annotation-comments textarea').fill('A local-only live Wikipedia test.');
    await page.locator('.annotation-comments').getByRole('button', { name: '送出', exact: true }).click();
    await waitForSaved(page, 'A local-only live Wikipedia test.');
    assert.equal(await page.locator('.annotation-highlight-attribution').count(), 0);
    const originalText = await page.evaluate(async () => {
      const api = window.__reviewToolDev.createApi();
      const title = `Wikipedia:ReviewTool/data/${mw.config.get('wgRevisionId')}.json`;
      const result = await api.get({ action: 'query', titles: title, prop: 'revisions', rvslots: 'main', rvprop: 'content', formatversion: 2 });
      const raw = result.query.pages[0].revisions[0].slots.main.content;
      return raw;
    });
    const originalHighlight = (await readSnapshot(originalText))[0];
    assert.match(originalHighlight.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(originalHighlight.editedAt, undefined); assert.equal(originalHighlight.editedBy, undefined);
    await page.evaluate(() => localStorage.setItem('reviewtool-test-actor', 'Example2'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAnnotation(page);
    assert.equal(await page.evaluate(() => mw.config.get('wgUserName')), 'Example2');
    await page.locator('.annotation-comment-body').hover();
    await page.locator('.annotation-comments').getByRole('button', { name: '編輯', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '編輯原因', exact: true });
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.annotation-comments textarea').count(), 0, 'prompt appears before the editor');
    // No Playwright native-dialog handler: this was the interactive-launcher failure.
    await page.waitForTimeout(400); assert.equal(await dialog.isVisible(), true);
    const proceed = dialog.getByRole('button', { name: '繼續編輯', exact: true });
    assert.equal(await proceed.isDisabled(), true);
    await dialog.getByRole('textbox', { name: '原因', exact: true }).fill('   '); assert.equal(await proceed.isDisabled(), true);
    await dialog.getByRole('textbox', { name: '原因', exact: true }).fill('😀'.repeat(501)); assert.equal(await proceed.isDisabled(), true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.locator('.annotation-comments textarea').count(), 0);
    await page.locator('.annotation-comment-body').hover();
    await page.locator('.annotation-comments').getByRole('button', { name: '編輯', exact: true }).click();
    await dialog.getByRole('textbox', { name: '原因', exact: true }).fill('修正引用，保留原作者');
    assert.equal(await dialog.evaluate(element => {
      const input = element.querySelector('input'), box = input.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    }), true, 'the Codex reason prompt receives input above existing popups');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(root, '.cache/codex-reason-dialog.png') });
    await proceed.click();
    await page.locator('.annotation-comments textarea').fill('A local-only live Wikipedia test. Edited with a reason.');
    await page.locator('.annotation-comments').getByRole('button', { name: '儲存修改', exact: true }).click();
    await waitForSaved(page, 'A local-only live Wikipedia test. Edited with a reason.');
    assert.equal(await page.locator('[data-annotation-reason-dialog]').count(), 0, 'saving does not prompt again');
    assert.equal(await page.locator('.annotation-comment-author').textContent(), 'Example（由 Example2 編輯）');
    assert.match(await page.locator('.annotation-comment-date').textContent(), /（已編輯）$/);
    assert.equal(await page.locator('.vector-column-end > .vector-sticky-pinned-container').count(), 0);
    assert.equal(await page.locator('.vector-column-start .vector-sticky-pinned-container').count(), 1);
    assert.equal(await page.locator('.annotation-left-pinned > .vector-appearance-landmark').isVisible(), true);
    const alignment = await page.evaluate(() => {
      const element = document.querySelector('.annotation-document [data-source-run]');
      const range = document.createRange(); range.selectNodeContents(element);
      return Math.abs(document.querySelector('.annotation-comment-thread').getBoundingClientRect().top - range.getClientRects()[0].top);
    });
    assert.ok(alignment <= 1, 'live appearance controls do not displace comments');
    const data = await page.evaluate(async () => {
      const api = window.__reviewToolDev.createApi();
      const title = `Wikipedia:ReviewTool/data/${mw.config.get('wgRevisionId')}.json`;
      const result = await api.get({ action: 'query', titles: title, prop: 'revisions', rvslots: 'main', rvprop: 'ids|timestamp|content|comment', curtimestamp: true, formatversion: 2 });
      return { title, page: result.query.pages[0], readAt: result.curtimestamp };
    });
    const stored = data.page.revisions[0].slots.main.content;
    assert.equal(JSON.parse(stored).format, 'reviewtool.annotation-records/1');
    assert.equal(data.page.revisions[0].slots.main.contentmodel, 'json');
    assert.match(stored, /A local-only live Wikipedia test/);
    assert.match(data.page.revisions[0].comment, /^(?:\/\* ReviewTool \*\/ )?修正引用，保留原作者$/);
    const savedHighlight = (await readSnapshot(stored))[0];
    const savedComment = savedHighlight.threads[0];
    assert.equal(savedHighlight.author, 'Example');
    assert.equal(savedHighlight.createdAt, originalHighlight.createdAt);
    assert.equal(savedHighlight.editedAt, undefined, 'editing a comment does not edit its highlight');
    assert.equal(savedHighlight.editedBy, undefined);
    assert.equal(savedComment.author, 'Example'); assert.ok(savedComment.editedAt);
    assert.equal(savedComment.editedBy, 'Example2');
    assert.ok(Date.parse(savedComment.editedAt) >= Date.parse(savedComment.createdAt));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAnnotation(page);
    assert.equal(await page.locator('.annotation-comment-text').textContent(), 'A local-only live Wikipedia test. Edited with a reason.');
    assert.equal(await page.locator('.annotation-comment-date').getAttribute('datetime'), savedComment.editedAt);
    assert.match(await page.locator('.annotation-comment-date').textContent(), /（已編輯）$/);
    assert.equal(await page.locator('.annotation-comment-author').textContent(), 'Example（由 Example2 編輯）');
    const conflicts = await page.evaluate(async ({ title, revid, content }) => {
      const api = window.__reviewToolDev.createApi();
      const edit = text => new Promise(resolve => api.postWithToken('csrf', { action: 'edit', title, text, baserevid: revid, formatversion: 2 }).done(result => resolve(result.edit.result)).fail(code => resolve(code)));
      const first = await edit(content + '\n'); const second = await edit(content + '\n\n');
      const unsupported = await new Promise(resolve => api.postWithToken('csrf', { action: 'delete', title }).done(() => resolve('unexpected')).fail(code => resolve(code)));
      return { first, second, unsupported };
    }, { title: data.title, revid: data.page.revisions[0].revid, content: stored });
    assert.deepEqual(conflicts, { first: 'Success', second: 'editconflict', unsupported: 'dryrun-unsupported' });
    assert.deepEqual(blockedWrites.filter(action => action !== 'options'), [], 'the annotation API never attempts a remote write');
    assert.equal(blockedOptions.length, blockedWrites.filter(action => action === 'options').length, 'Wikipedia preference writes for the simulated identity are blocked');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(root, '.cache/live-dry-run.png') });
    await page.evaluate(() => localStorage.removeItem('reviewtool-test-actor'));
    await context.close();
    context = (await launch({ dryRun: true, headless: true, profile })).context;
    const reopened = context.pages()[0]; await reopened.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForAnnotation(reopened);
    assert.equal(await reopened.locator('.annotation-comment-text').textContent(), 'A local-only live Wikipedia test. Edited with a reason.');
    assert.equal(await reopened.locator('.annotation-comment-date').getAttribute('datetime'), savedComment.editedAt);
    assert.equal(await reopened.locator('.annotation-comment-author').textContent(), 'Example（由 Example2 編輯）');
    assert.equal(await reopened.locator('.annotation-highlight-attribution').count(), 0, 'moderator edits preserve the original matching highlight/comment authors');
    await reopened.locator('.annotation-document [data-source-run]').first().scrollIntoViewIfNeeded();
    await reopened.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await reopened.locator('.annotation-document [data-source-run]').first().evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element); getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await reopened.locator('[data-annotation-toolbar]').getByRole('button', { name: '藍色高亮', exact: true }).click();
    await waitForSaved(reopened, '"color":"blue"');
    await reopened.reload({ waitUntil: 'domcontentloaded' }); await waitForAnnotation(reopened);
    const recoloredText = await reopened.evaluate(async () => {
      const api = window.__reviewToolDev.createApi();
      const title = `Wikipedia:ReviewTool/data/${mw.config.get('wgRevisionId')}.json`;
      const result = await api.get({ action: 'query', titles: title, prop: 'revisions', rvslots: 'main', rvprop: 'content', formatversion: 2 });
      return result.query.pages[0].revisions[0].slots.main.content;
    });
    const recolored = (await readSnapshot(recoloredText))[0];
    assert.equal(recolored.id, originalHighlight.id); assert.equal(recolored.createdAt, originalHighlight.createdAt);
    assert.equal(recolored.color, 'blue'); assert.equal(recolored.editedBy, 'Example');
    assert.match(recolored.editedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.deepEqual(recolored.threads?.[0], savedComment);
  } catch (error) { console.error(error); throw error; }
  finally { await context.close(); }
});

test('normal is the default build and delegates writes to the real mw.Api (intercepted test response)', async () => {
  const profile = await fs.mkdtemp(path.join(root, '.cache/normal-test-'));
  const { context } = await launch({ headless: true, profile });
  const edits = [];
  try {
    await context.route('https://**.wikipedia.org/w/api.php*', route => {
      const request = route.request(), url = new URL(request.url());
      const params = new URLSearchParams(request.postData() ?? url.search);
      const action = params.get('action') ?? url.searchParams.get('action') ?? 'query';
      if (action === 'edit') {
        edits.push(Object.fromEntries(params));
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ edit: { result: 'Success', newrevid: 123 } }) });
      }
      if (!['query', 'parse', 'compare', 'paraminfo', 'help', 'expandtemplates', 'opensearch'].includes(action)) return route.abort('blockedbyclient');
      return route.continue();
    });
    const page = context.pages()[0]; await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => Boolean(window.__reviewToolDev));
    const result = await page.evaluate(async () => {
      const api = window.__reviewToolDev.createApi();
      const response = await api.post({ action: 'edit', title: 'Wikipedia:ReviewTool/data/1.json', text: '{}', contentmodel: 'json', token: 'not-a-real-token' });
      return { mode: window.__reviewToolDev.mode, native: Object.getPrototypeOf(api) === mw.Api.prototype, result: response.edit.result };
    });
    assert.deepEqual(result, { mode: 'normal', native: true, result: 'Success' });
    assert.equal(edits.length, 1); assert.equal(edits[0].text, '{}'); assert.equal(edits[0].contentmodel, 'json');
  } finally { await context.close(); }
});
