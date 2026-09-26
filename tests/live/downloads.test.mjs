import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { launch, root } from './launch.mjs';

test('interactive exports use their suggested filename in the Chrome download directory and survive browser close', async () => {
  const directory = await fs.mkdtemp(path.join(root, '.cache/native-download-test-'));
  const profile = path.join(directory, 'profile'), downloads = path.join(directory, 'downloads');
  await fs.mkdir(path.join(profile, 'Default'), { recursive: true });
  await fs.mkdir(downloads);
  await fs.writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  const bundle = await build({ stdin: { contents: "import { downloadAnnotationExport } from './src/annotation/export'; window.exportAnnotations = downloadAnnotationExport;", resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', write: false });
  // Exercise the actual interactive launcher branch; headless tests intentionally capture downloads.
  const { context } = await launch({ dryRun: true, headless: false, profile });
  let exportedPath;
  const payload = { format: 'reviewtool.annotation-export/1', exportedAt: Date.parse('2026-09-26T00:00:00Z'), pageName: 'Download test', document: { wiki: 'zhwiki', pageId: 1, revisionId: 2, offsetUnit: 'utf8-byte' }, highlights: [], groups: [] };
  try {
    await context.route('**/*', route => route.abort());
    const page = context.pages()[0];
    await page.setContent('<button id="export">Export annotations</button>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(payload => { document.querySelector('#export').onclick = () => exportAnnotations(document, payload); }, payload);
    const event = page.waitForEvent('download', { timeout: 15000 });
    await page.locator('#export').click();
    const download = await event;
    assert.equal(await download.failure(), null);
    assert.equal(download.suggestedFilename(), 'review-tool-annotations-2-2026-09-26T000000000Z.json');
    exportedPath = path.join(downloads, download.suggestedFilename());
    assert.deepEqual(JSON.parse(await fs.readFile(exportedPath, 'utf8')), payload);
  } finally { await context.close(); }
  assert.deepEqual(JSON.parse(await fs.readFile(exportedPath, 'utf8')), payload, 'Chrome retains the user download after Playwright closes');
});
