import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch, root } from './launch.mjs';
import { recordTestApi } from './record-test-api.mjs';
const time = '2026-09-26T00:00:00.000Z';
const prefix = 'Talk:孫中山/ReviewTool/';

test('Check writing overlays a revision picker, imports the chosen comments, and preserves the form on cancellation or failure', async () => {
  const records = await recordTestApi(), sources = new Map(), pages = new Map();
  for (const id of [9, 10, 100]) {
    const section = id === 9 ? '舊章節' : '新章節', quote = id === 9 ? '舊版原文' : '新版原文';
    const source = `前言。\n== ${section} ==\n${quote}。`;
    sources.set(id, source);
    const comment = (key, text, replies = []) => ({ id: key, text, author: 'Example', createdAt: time, replies });
    const rootComment = comment('root-' + id, `版本 ${id} 的評論`, [comment('reply-' + id, `版本 ${id} 的回覆`)]);
    const start = Buffer.byteLength(source.slice(0, source.indexOf(quote)));
    const doc = records.AnnotationDocument.seed('fixture-' + id, [{ id: 'h-' + id, color: 'yellow', anchor: { unit: 'utf8-byte', start, end: start + Buffer.byteLength(quote) }, author: 'Example', createdAt: time, threads: [rootComment] }], () => true);
    pages.set(prefix + id, records.encodePage({ wiki: 'zhwiki', pageId: 139, revisionId: id }, { baseline: 0, prefix: '{{ReviewTool annotation data page}}\n<syntaxhighlight lang="json">\n', suffix: '\n</syntaxhighlight>' }, doc)); doc.destroy();
  }
  const profile = await fs.mkdtemp(path.join(root, '.cache/revision-picker-test-'));
  const { context } = await launch({ dryRun: true, headless: true, profile });
  let empty = false, failSource = false, sourceGate;
  const reads = [], externalWrites = [];
  try {
    await context.route('https://**.wikipedia.org/w/api.php*', async route => {
      const request = route.request(), url = new URL(request.url());
      const params = Object.fromEntries(new URLSearchParams(request.postData() || url.search));
      const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (params.action && !['query', 'parse', 'compare', 'paraminfo', 'help', 'expandtemplates', 'opensearch'].includes(params.action)) { externalWrites.push(params.action); return route.abort(); }
      if (params.action === 'query' && params.titles === '孫中山' && params.prop === 'info') return json({ query: { pages: [{ pageid: 139, ns: 0, title: '孫中山' }] } });
      if (params.action === 'query' && params.list === 'allpages' && params.apprefix === '孫中山/ReviewTool/') {
        reads.push(params);
        const available = empty ? [] : ['10', 'notes'].map(id => ({ pageid: 7000, ns: 1, title: prefix + id })).filter(p => p.title.slice(5) >= (params.apcontinue || ''));
        const limit = params.aplimit === 'max' ? 500 : Number(params.aplimit || 10), next = available[limit];
        return json({ query: { allpages: available.slice(0, limit) }, ...(next ? { continue: { continue: '-||', apcontinue: next.title.slice(5) } } : {}) });
      }
      if (params.action === 'query' && params.revids?.split('|').every(id => sources.has(Number(id)))) {
        reads.push(params); return json({ query: { pages: [{ pageid: 139, title: '孫中山', revisions: params.revids.split('|').map(id => ({ revid: Number(id), timestamp: time })) }] } });
      }
      if (params.action === 'query' && params.titles?.startsWith(prefix)) {
        const text = params.titles === prefix + '10' ? pages.get(params.titles) : undefined;
        return json({ query: { pages: [text ? { pageid: 7000, title: params.titles, revisions: [{ revid: 8000, timestamp: time, slots: { main: { content: text } } }] } : { missing: true, title: params.titles }] } });
      }
      if (params.action === 'parse' && sources.has(Number(params.oldid))) {
        reads.push(params);
        if (sourceGate) await sourceGate;
        if (failSource) return json({ error: { code: 'missingtitle', info: 'Test unavailable revision' } }).catch(() => {});
        return json({ parse: { pageid: 139, title: '孫中山', revid: Number(params.oldid), wikitext: sources.get(Number(params.oldid)) } }).catch(() => {});
      }
      return route.fallback();
    });
    const page = context.pages()[0]; page.setDefaultTimeout(15000); await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('https://zh.wikipedia.org/wiki/Talk:孫中山?uselang=zh-tw', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => Boolean(window.__reviewToolDev && document.getElementById('review-tool-buttons-added')));
    await page.evaluate(() => {
      const content = document.querySelector('#mw-content-text .mw-parser-output');
      const heading = document.createElement('div'); heading.className = 'mw-heading mw-heading2'; heading.id = 'reviewtool-import-fixture';
      heading.innerHTML = '<h2 id="乙級評審">乙級評審</h2><span class="mw-editsection"><a href="/w/index.php?title=Talk:孫中山&amp;action=edit&amp;section=1">編輯</a></span>';
      // DiscussionTools hides native edit-section spans on talk pages; keep this fixture entry visible.
      heading.querySelector('.mw-editsection').style.setProperty('display', 'inline', 'important');
      content.prepend(heading); document.getElementById('review-tool-buttons-added').remove(); mw.hook('wikipage.content').fire($(content));
    });
    await page.evaluate(async entries => { for (const [title, text] of entries) await __reviewToolDev.createApi().postWithToken('csrf', { action: 'edit', title, text, summary: '/* ReviewTool */' }); }, [...pages].filter(([title]) => title !== prefix + '10'));
    // Dry-run prefix pagination must combine remote and local pages without losing or duplicating entries.
    const listed = await page.evaluate(async () => {
      const api = __reviewToolDev.createApi(), titles = []; let continuation = {};
      do { const r = await api.get({ action: 'query', list: 'allpages', apnamespace: 1, apprefix: '孫中山/ReviewTool/', aplimit: 1, formatversion: 2, ...continuation }); titles.push(...r.query.allpages.map(p => p.title)); continuation = r.continue; } while (continuation?.apcontinue);
      return titles;
    });
    assert.deepEqual(listed, [prefix + '10', prefix + '100', prefix + '9', prefix + 'notes']);
    // Trigger the synthetic review entry; the picker itself is exercised with normal mouse/keyboard input.
    await page.locator('#reviewtool-import-fixture').getByRole('link', { name: '檢查文筆', exact: true }).dispatchEvent('click');
    const main = page.locator('.review-tool-check-writing-dialog'), picker = page.getByRole('dialog', { name: '選擇批註版本', exact: true });
    await main.waitFor({ state: 'visible' });
    await main.locator('.suggestion-area textarea').fill('保留原來的意見');
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByRole('radio').first().waitFor();
    assert.deepEqual(await picker.getByRole('radio').evaluateAll(inputs => inputs.map(input => input.value)), ['100', '10', '9']);
    assert.equal(await picker.getByRole('radio').first().isChecked(), true);
    assert.ok((await picker.boundingBox()).width < (await main.boundingBox()).width);
    assert.equal(await picker.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true);
    assert.equal(reads.filter(p => p.action === 'parse').length, 0, 'listing does not fetch every article source');
    await page.screenshot({ path: path.join(root, '.cache/annotation-revision-picker.png'), animations: 'disabled' });
    const lightBackground = await picker.evaluate(element => getComputedStyle(element).backgroundColor);
    await page.evaluate(() => { document.documentElement.classList.remove('skin-theme-clientpref-day', 'skin-theme-clientpref-os'); document.documentElement.classList.add('skin-theme-clientpref-night'); });
    await page.screenshot({ path: path.join(root, '.cache/annotation-revision-picker-dark.png'), animations: 'disabled' });
    assert.notEqual(await picker.evaluate(element => getComputedStyle(element).backgroundColor), lightBackground);
    await page.evaluate(() => { document.documentElement.classList.remove('skin-theme-clientpref-night'); document.documentElement.classList.add('skin-theme-clientpref-day'); });
    await picker.getByRole('radio').first().press('Escape');
    await picker.waitFor({ state: 'hidden' }); assert.equal(await main.isVisible(), true);
    assert.equal(await main.locator('.suggestion-area textarea').inputValue(), '保留原來的意見');
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByRole('radio', { name: /^版本 9 ·/ }).check();
    await picker.getByRole('button', { name: '載入', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    assert.deepEqual(await main.locator('.chapter-title-input input').evaluateAll(inputs => inputs.map(input => input.value)), ['舊章節']);
    assert.deepEqual(await main.locator('.suggestion-area textarea').evaluateAll(inputs => inputs.map(input => input.value)), ['版本 9 的評論', '版本 9 的回覆']);
    assert.deepEqual(await main.locator('.quote-area textarea').evaluateAll(inputs => inputs.map(input => input.value)), ['舊版原文', '舊版原文']);
    failSource = true;
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByRole('radio').first().waitFor(); assert.equal(await picker.getByRole('radio').first().isChecked(), true);
    await picker.getByRole('button', { name: '載入', exact: true }).click();
    await picker.getByRole('alert').waitFor();
    assert.equal(await main.locator('.suggestion-area textarea').first().inputValue(), '版本 9 的評論');
    await picker.getByRole('button', { name: '取消', exact: true }).click(); failSource = false;
    let release;
    sourceGate = new Promise(resolve => { release = resolve; });
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByRole('radio').first().waitFor(); await picker.getByRole('button', { name: '載入', exact: true }).click();
    await picker.getByRole('button', { name: '取消', exact: true }).click(); release(); sourceGate = undefined;
    await picker.waitFor({ state: 'hidden' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await main.locator('.suggestion-area textarea').first().inputValue(), '版本 9 的評論');
    empty = true;
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('reviewtool-dry-run-v1', 2); r.onsuccess = () => resolve(r.result); });
      await new Promise((resolve, reject) => { const tx = db.transaction('pages', 'readwrite'); tx.objectStore('pages').clear(); tx.oncomplete = resolve; tx.onerror = reject; }); db.close();
    });
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByText('這個條目還沒有批註。', { exact: true }).waitFor();
    assert.equal(await picker.getByRole('radio').count(), 0); assert.equal(await picker.getByRole('button', { name: '載入', exact: true }).count(), 0);
    await picker.getByRole('button', { name: '關閉', exact: true }).last().click();
    assert.equal(await main.locator('.suggestion-area textarea').first().inputValue(), '版本 9 的評論');
    await main.getByRole('button', { name: '取消', exact: true }).click(); await main.waitFor({ state: 'hidden' });
    await page.locator('#review-tool-dialog-mount').waitFor({ state: 'detached' });
    assert.deepEqual(externalWrites.filter(action => action !== 'options'), []);
  } catch (error) { await context.pages()[0]?.screenshot({ path: path.join(root, '.cache/import-ui-failure.png'), animations: 'disabled' }).catch(() => {}); throw error; }
  finally { await context.close(); }
});
