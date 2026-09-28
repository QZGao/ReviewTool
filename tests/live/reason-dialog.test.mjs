import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { root } from './launch.mjs';
import { startServer } from '../annotation/serve.mjs';

let browser, server, script, css;
before(async () => {
  const output = path.join(root, '.cache/codex-reason-fixture.js');
  await build({ stdin: { contents: `
    import * as Vue from 'vue';
    import * as Codex from '@wikimedia/codex';
    import { createCodexReasonPrompt } from './src/annotation/codex-reason-dialog';
    window.mw = { loader: { using: () => Promise.resolve(name => name === 'vue' ? { ...Vue, createMwApp: Vue.createApp } : Codex) } };
    window.prepareReasonPrompt = async () => {
      const prompt = await createCodexReasonPrompt(document);
      window.showReason = action => {
        window.reasonResult = 'pending'; window.reasonController = new AbortController();
        void prompt(action, reasonController.signal).then(value => { window.reasonResult = value; });
      };
    };
  `, resolveDir: root, loader: 'ts' }, outfile: output, bundle: true, format: 'iife', platform: 'browser' });
  script = await readFile(output, 'utf8');
  css = await readFile(path.join(root, 'node_modules/@wikimedia/codex/dist/codex.style.css'), 'utf8');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  server = await startServer();
});
after(async () => { await browser?.close(); await server?.close(); });

test('the real Codex prompt stays open without native-dialog handlers, validates reasons, and cleans up', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.url + '/?article=sun-yat-sen');
    await page.waitForFunction(() => Boolean(window.annotationPageLab));
    await page.evaluate(() => { const button = document.createElement('button'); button.id = 'trigger'; button.textContent = '編輯'; document.body.prepend(button); });
    await page.addStyleTag({ content: css });
    await page.route(server.url + '/codex-reason-fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: script }));
    await page.addScriptTag({ url: server.url + '/codex-reason-fixture.js' });
    await page.evaluate(() => prepareReasonPrompt());
    const show = async action => {
      await page.locator('#trigger').focus();
      await page.evaluate(action => showReason(action), action);
    };
    await page.evaluate(() => {
      const popup = document.createElement('div'); popup.id = 'existing-source-popup'; popup.setAttribute('popover', 'manual');
      popup.style.cssText = 'position:fixed;inset:350px auto auto 400px;width:450px;height:250px';
      popup.textContent = 'An existing source tooltip'; document.body.append(popup); popup.showPopover();
    });
    await show('edit-comment');
    const dialog = page.getByRole('dialog', { name: '編輯原因', exact: true });
    await dialog.waitFor({ state: 'visible' }); await page.waitForTimeout(400);
    assert.equal(await dialog.isVisible(), true);
    const input = dialog.getByRole('textbox', { name: '原因', exact: true });
    const proceed = dialog.getByRole('button', { name: '繼續編輯', exact: true });
    assert.equal(await proceed.isDisabled(), true);
    await input.fill('   '); assert.equal(await proceed.isDisabled(), true);
    await input.fill('😀'.repeat(501)); assert.equal(await proceed.isDisabled(), true);
    await input.fill('Correct a quotation'); assert.equal(await proceed.isEnabled(), true);
    assert.equal(await input.evaluate(element => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element;
    }), true);
    await page.locator('#existing-source-popup').evaluate(element => element.remove());
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(root, '.cache/codex-reason-dialog-local.png') });
    const lightBackground = await dialog.evaluate(element => getComputedStyle(element).backgroundColor);
    await page.evaluate(() => annotationPageLab.setTheme('dark'));
    await page.waitForTimeout(250);
    assert.notEqual(await dialog.evaluate(element => getComputedStyle(element).backgroundColor), lightBackground);
    await page.screenshot({ path: path.join(root, '.cache/codex-reason-dialog-dark.png') });
    await page.evaluate(() => annotationPageLab.setTheme('light'));
    await proceed.click();
    assert.equal(await page.evaluate(() => reasonResult), 'Correct a quotation');
    assert.equal(await page.locator('[data-annotation-reason-dialog]').count(), 0);
    assert.equal(await page.locator('#trigger').evaluate(element => element === document.activeElement), true);

    await show('resolve-comment');
    const resolve = page.getByRole('dialog', { name: '結束討論的原因', exact: true });
    await resolve.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.evaluate(() => reasonResult), null);
    await show('confirm-close');
    const confirmation = page.getByRole('dialog', { name: '結束這個討論？', exact: true });
    assert.equal(await confirmation.getByRole('textbox').count(), 0);
    await confirmation.getByRole('button', { name: '結束討論', exact: true }).click();
    assert.equal(await page.evaluate(() => reasonResult), '');
    await show('delete-highlight');
    const remove = page.getByRole('dialog', { name: '刪除原因', exact: true });
    await remove.getByRole('textbox', { name: '原因', exact: true }).fill('Duplicate thread');
    await remove.getByRole('button', { name: '刪除高亮', exact: true }).click();
    assert.equal(await page.evaluate(() => reasonResult), 'Duplicate thread');

    await show('edit-comment');
    await input.dispatchEvent('compositionstart'); await input.press('Escape');
    assert.equal(await dialog.isVisible(), true, 'Escape cancels IME composition without closing the dialog');
    await input.dispatchEvent('compositionend'); await page.waitForTimeout(550); await input.press('Escape');
    await dialog.waitFor({ state: 'detached' }); assert.equal(await page.evaluate(() => reasonResult), null);
    await show('edit-comment'); await dialog.waitFor({ state: 'visible' });
    await page.evaluate(() => reasonController.abort());
    assert.equal(await page.locator('[data-annotation-reason-dialog]').count(), 0);
    assert.equal(await page.evaluate(() => reasonResult), null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
