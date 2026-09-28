import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { startServer } from '../annotation/serve.mjs';
import { root } from './launch.mjs';

test('state.convByVar supplies both Chinese variants to the reading view, comments, marker toolbar and source popups', async () => {
  const bundle = await build({ stdin: { contents: `
    import state from './src/state';
    import { annotationMessages } from './src/annotation/i18n';
    window.variantMessages = variant => {
      state.convByVar = text => text[variant];
      return annotationMessages(text => state.convByVar(text));
    };
  `, resolveDir: root }, bundle: true, format: 'iife', platform: 'browser', write: false });
  const server = await startServer(), browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const expected of [
      { variant: 'hant', reading: '條目批註', raw: '維基原始碼', edit: '編輯', reply: '回覆', save: '儲存修改', send: '送出', discard: '放棄草稿', commentText: '評論內容', replyText: '回覆內容', placeholder: '輸入回覆…', attribution: '高亮：Creator', editedBy: 'Example（由 Moderator 編輯）', edited: '（已編輯）', link: '連結原始碼', ref: '參考資料原始碼', toolbar: '更改高亮顏色', colors: ['紅色高亮', '黃色高亮', '綠色高亮', '藍色高亮'], add: '另寫評論…' },
      { variant: 'hans', reading: '条目批注', raw: '维基源代码', edit: '编辑', reply: '回复', save: '保存修改', send: '发送', discard: '放弃草稿', commentText: '评论内容', replyText: '回复内容', placeholder: '输入回复…', attribution: '高亮：Creator', editedBy: 'Example（由 Moderator 编辑）', edited: '（已编辑）', link: '链接源代码', ref: '参考资料源代码', toolbar: '更改高亮颜色', colors: ['红色高亮', '黄色高亮', '绿色高亮', '蓝色高亮'], add: '另写评论…' },
    ]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(5000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
      await page.route(server.url + '/i18n.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
      await page.goto(server.url + '/lab'); await page.waitForFunction(() => Boolean(window.annotationLab));
      await page.evaluate(() => { window.mw = { config: { get: () => 'Example' } }; });
      await page.addScriptTag({ url: server.url + '/i18n.js' });
      await page.evaluate(variant => {
        annotationLab.view.destroy(); document.body.innerHTML = '<main style="display:grid;grid-template-columns:700px 300px;gap:30px;margin:60px"><div id="source"></div><div id="comments"></div></main>';
        const api = annotationLab.annotation, source = 'alpha [[Page|label]]<ref name=r>cite</ref> {{template}} <math>x</math>';
        const projection = api.createProjection(source), messages = variantMessages(variant);
        window.localizedView = api.createAnnotationView(document, projection, { messages, commentAuthor: 'Example', commentContainer: document.getElementById('comments'), highlighting: { initial: [{ id: 'h', author: 'Creator', color: 'yellow', anchor: { unit: 'utf8-byte', start: 0, end: 5 }, threads: [{ id: 'c', author: 'Example', createdAt: '2026-09-01T00:00:00.000Z', editedAt: '2026-09-02T00:00:00.000Z', editedBy: 'Moderator', text: 'Saved unchanged 🐈', replies: [] }] }] } });
        document.getElementById('source').append(localizedView.element);
        window.localizedHtml = api.renderToHtml(projection, messages);
      }, expected.variant);
      assert.equal(await page.locator('.annotation-document').getAttribute('aria-label'), expected.reading);
      assert.equal(await page.locator('[data-raw-kind]').first().getAttribute('aria-label'), expected.raw);
      assert.ok((await page.evaluate(() => localizedHtml)).includes(`aria-label="${expected.reading}"`));
      assert.equal(await page.locator('.annotation-comment-author').textContent(), expected.editedBy);
      assert.ok((await page.locator('.annotation-comment-date').textContent()).endsWith(expected.edited));
      assert.equal(await page.locator('.annotation-highlight-attribution').textContent(), expected.attribution);
      assert.equal(await page.locator('.annotation-comment-text').textContent(), 'Saved unchanged 🐈');
      assert.equal(await page.locator('.annotation-comment-placeholder').textContent(), expected.add);
      await page.locator('.annotation-comment-body').hover();
      await page.getByRole('button', { name: expected.edit, exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: expected.commentText }).count(), 1);
      assert.equal(await page.getByRole('button', { name: expected.save }).isDisabled(), true);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.locator('.annotation-comment-body').hover();
      await page.getByRole('button', { name: expected.reply, exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: expected.replyText }).getAttribute('placeholder'), expected.placeholder);
      assert.equal(await page.getByRole('button', { name: expected.send, exact: true }).isVisible(), true);
      await page.getByRole('button', { name: expected.discard, exact: true }).click();
      await page.locator('[data-inspect=link]').focus();
      await page.getByRole('dialog', { name: expected.link, exact: true }).waitFor({ state: 'visible' });
      await page.locator('[data-inspect=reference]').focus();
      await page.getByRole('dialog', { name: expected.ref, exact: true }).waitFor({ state: 'visible' });
      await page.evaluate(() => { const range = localizedView.restoreRange({ unit: 'utf8-byte', start: 0, end: 5 }); getSelection().removeAllRanges(); getSelection().addRange(range); });
      const toolbar = page.getByRole('toolbar', { name: expected.toolbar });
      await toolbar.waitFor({ state: 'visible' });
      assert.deepEqual(await toolbar.locator('[data-color]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), expected.colors);
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});
