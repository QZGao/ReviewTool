import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('loading replaces parser output immediately and restores its exact display state once', async () => {
  const bundle = await build({ stdin: { contents: "export * from './src/annotation/loading-view.ts'", resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'loadingTest', write: false });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="mw-content-text"><div class="mw-parser-output" style="display: grid !important">Original</div></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    assert.deepEqual(await page.evaluate(() => {
      window.stopLoading = loadingTest.showAnnotationLoading(document, '正在載入批註…');
      return { hidden: getComputedStyle(document.querySelector('.mw-parser-output')).display, label: document.querySelector('[role=progressbar]').getAttribute('aria-label') };
    }), { hidden: 'none', label: '正在載入批註…' });
    await page.evaluate(() => { stopLoading(); stopLoading(); });
    assert.equal(await page.locator('[role=progressbar]').count(), 0);
    assert.equal(await page.locator('.mw-parser-output').getAttribute('style'), 'display: grid !important;');
  } finally { await browser.close(); }
});
