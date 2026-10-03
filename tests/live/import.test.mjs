import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch, root } from './launch.mjs';
import { recordTestApi } from './record-test-api.mjs';
const time = '2026-09-26T00:00:00.000Z';
const prefix = 'Wikipedia:ReviewTool/data/';

test('Check writing overlays a revision picker, imports the chosen comments, and preserves the form on cancellation or failure', async () => {
  const records = await recordTestApi(), sources = new Map(), pages = new Map();
  for (const id of [9, 10, 100]) {
    const section = id === 9 ? '舊章節' : '新章節', quote = id === 9 ? '舊版原文' : '新版原文';
    const source = `前言。\n== ${section} ==\n${quote}。`;
    sources.set(id, source);
    const comment = (key, text, replies = [], author = 'Example') => ({ id: key, text, author, createdAt: time, replies });
    const rootComment = comment('root-' + id, `版本 ${id} 的評論`, [comment('reply-' + id, `版本 ${id} 的回覆`)]);
    const start = Buffer.byteLength(source.slice(0, source.indexOf(quote)));
    const threads = id === 10 ? [
      comment('example-root', 'Needs a source.', [comment('bob-reply', 'Try reference 3.', [comment('example-reply', 'That reference supports it.')], 'Bob')]),
      { ...comment('resolved-root', 'Resolved comment.', [], 'Bob'), resolution: { resolved: true, by: 'Bob', at: time } },
      { ...comment('closed-root', 'Closed comment.', [], 'Bob'), resolved: { by: 'Bob', at: time } },
    ] : [rootComment];
    const highlight = { id: 'h-' + id, color: 'yellow', anchor: { unit: 'utf8-byte', start, end: start + Buffer.byteLength(quote) }, author: 'Example', createdAt: time, threads };
    const deleted = { ...highlight, id: 'deleted', deleted: { by: 'Bob', at: time }, threads: [comment('deleted-root', 'Deleted comment.', [], 'Bob')] };
    const doc = records.AnnotationDocument.seed('fixture-' + id, [highlight, ...(id === 10 ? [deleted] : [])], () => true);
    pages.set(prefix + id + '.json', records.encodePage({ wiki: 'zhwiki', pageId: 139, revisionId: id }, { baseline: 0 }, doc)); doc.destroy();
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
      if (params.action === 'query' && params.titles === 'Talk:孫中山') {
        reads.push(params);
        return json({ query: { pages: [{ pageid: 7000, title: 'Talk:孫中山', revisions: [{ revid: 8001, slots: { main: { content: empty ? 'Existing discussion' : '{{ReviewTool talk page notice|9|100|10}}\nExisting discussion', contentmodel: 'wikitext' } } }] }] } });
      }
      if (params.action === 'query' && params.revids?.split('|').every(id => sources.has(Number(id)))) {
        reads.push(params); return json({ query: { pages: [{ pageid: 139, title: '孫中山', revisions: params.revids.split('|').map(id => ({ revid: Number(id), timestamp: time })) }] } });
      }
      if (params.action === 'query' && params.titles?.startsWith(prefix)) {
        const text = params.titles === prefix + '10.json' ? pages.get(params.titles) : undefined;
        return json({ query: { pages: [text ? { pageid: 7000, title: params.titles, revisions: [{ revid: 8000, timestamp: time, slots: { main: { content: text, contentmodel: 'json', contentformat: 'application/json' } } }] } : { missing: true, title: params.titles }] } });
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
    await page.evaluate(async entries => { for (const [title, text] of entries) await __reviewToolDev.createApi().postWithToken('csrf', { action: 'edit', title, text, contentmodel: 'json', summary: '/* ReviewTool */' }); }, [...pages].filter(([title]) => title !== prefix + '10.json'));
    // Trigger the synthetic review entry; the picker itself is exercised with normal mouse/keyboard input.
    await page.locator('#reviewtool-import-fixture').getByRole('link', { name: '檢查文筆', exact: true }).dispatchEvent('click');
    const main = page.locator('.review-tool-check-writing-dialog'), picker = page.getByRole('dialog', { name: '選擇批註版本', exact: true });
    await main.waitFor({ state: 'visible' });
    await main.locator('.suggestion-area textarea').fill('保留原來的意見');
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByRole('radio').first().waitFor();
    assert.deepEqual(await picker.getByRole('radio').evaluateAll(inputs => inputs.map(input => input.value)), ['100', '10', '9']);
    assert.equal(await picker.getByRole('radio').first().isChecked(), true);
    assert.deepEqual(await picker.getByRole('checkbox').evaluateAll(inputs => inputs.map(input => input.checked)), [true, true, true]);
    assert.equal(await main.getByRole('checkbox').count(), 0, 'filters belong only to the revision picker');
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
    assert.deepEqual(await main.locator('.suggestion-area textarea').evaluateAll(inputs => inputs.map(input => input.value)), ['版本 9 的評論']);
    assert.deepEqual(await main.locator('.quote-area textarea').evaluateAll(inputs => inputs.map(input => input.value)), ['舊版原文']);
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
    assert.deepEqual(await picker.getByRole('checkbox').evaluateAll(inputs => inputs.map(input => input.disabled)), [true, true, true]);
    await picker.getByRole('button', { name: '取消', exact: true }).click(); release(); sourceGate = undefined;
    await picker.waitFor({ state: 'hidden' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await main.locator('.suggestion-area textarea').first().inputValue(), '版本 9 的評論');

    // Bob has only a reply and a resolved root in revision 10. Defaults must leave the form intact.
    await page.evaluate(() => mw.config.set('wgUserName', 'Bob'));
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByRole('radio', { name: /^版本 10 ·/ }).check();
    await picker.getByRole('button', { name: '載入', exact: true }).click();
    await picker.getByText('沒有符合條件的評論，請調整選項或選擇其他版本。', { exact: true }).waitFor();
    assert.equal(await main.locator('.suggestion-area textarea').first().inputValue(), '版本 9 的評論');
    await picker.getByRole('checkbox', { name: '只載入各討論串的首則評論', exact: true }).uncheck();
    await picker.getByRole('button', { name: '載入', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    assert.deepEqual(await main.locator('.suggestion-area textarea').evaluateAll(inputs => inputs.map(input => input.value)), ['Try reference 3.']);
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByRole('radio', { name: /^版本 10 ·/ }).check();
    await picker.getByRole('checkbox', { name: '只載入我的評論', exact: true }).uncheck();
    await picker.getByRole('checkbox', { name: '只載入尚未解決的評論', exact: true }).uncheck();
    await picker.getByRole('button', { name: '載入', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    const combined = '@[[User:Example|]]: Needs a source. / Try reference 3. / @[[User:Example|]]: That reference supports it.';
    assert.deepEqual(await main.locator('.suggestion-area textarea').evaluateAll(inputs => inputs.map(input => input.value)), [combined, 'Resolved comment.']);
    assert.deepEqual(await main.locator('.quote-area textarea').evaluateAll(inputs => inputs.map(input => input.value)), ['新版原文', '新版原文']);

    empty = true;
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('reviewtool-dry-run-v1', 2); r.onsuccess = () => resolve(r.result); });
      await new Promise((resolve, reject) => { const tx = db.transaction('pages', 'readwrite'); tx.objectStore('pages').clear(); tx.oncomplete = resolve; tx.onerror = reject; }); db.close();
    });
    await main.getByRole('button', { name: '載入批註', exact: true }).click();
    await picker.getByText('這個條目還沒有批註。', { exact: true }).waitFor();
    assert.equal(await picker.getByRole('radio').count(), 0); assert.equal(await picker.getByRole('button', { name: '載入', exact: true }).count(), 0);
    await picker.getByRole('button', { name: '關閉', exact: true }).last().click();
    assert.equal(await main.locator('.suggestion-area textarea').first().inputValue(), combined);
    // Downloaded compact-ID exports and earlier full-UUID exports both remain importable.
    const commentId = '550e8400-e29b-41d4-a716-446655440001';
    for (const version of [2, 1]) {
      const entry = { id: version === 2 ? Buffer.from(commentId.replaceAll('-', ''), 'hex').toString('base64url') : commentId, sectionPath: '檔案章節', sentencePos: '0', sentenceText: '檔案原文', opinion: `匯出版本 ${version}：${commentId}`, createdBy: 'Example', createdAt: Date.parse(time) };
      await main.locator('input[type=file]').setInputFiles({ name: 'annotations.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: `reviewtool.annotation-export/${version}`, pageName: '孫中山', groups: [{ sectionPath: entry.sectionPath, annotations: [entry] }] })) });
      await page.waitForFunction(opinion => document.querySelector('.suggestion-area textarea')?.value === opinion, entry.opinion);
      assert.equal(await main.locator('.quote-area textarea').inputValue(), entry.sentenceText);
    }
    await main.getByRole('button', { name: '取消', exact: true }).click(); await main.waitFor({ state: 'hidden' });
    await page.locator('#review-tool-dialog-mount').waitFor({ state: 'detached' });
    assert.deepEqual(externalWrites.filter(action => action !== 'options'), []);
  } catch (error) { await context.pages()[0]?.screenshot({ path: path.join(root, '.cache/import-ui-failure.png'), animations: 'disabled' }).catch(() => {}); throw error; }
  finally { await context.close(); }
});
