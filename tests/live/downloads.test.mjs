import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { launch, root } from './launch.mjs';

async function completedFile(page, file) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    // A completed download followed by a crashed browser must still fail this check.
    await page.evaluate(() => document.readyState);
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('The native Chrome download did not finish.');
}

test('interactive exports retain filenames and contents and remain usable after two browser restarts with download history', async () => {
  const directory = await fs.mkdtemp(path.join(root, '.cache/native-download-test-'));
  const profile = path.join(directory, 'profile'), downloads = path.join(directory, 'downloads');
  await fs.mkdir(path.join(profile, 'Default'), { recursive: true }); await fs.mkdir(downloads);
  await fs.writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  const bundle = await build({ stdin: { contents: "import { downloadAnnotationExport } from './src/annotation/export'; window.exportAnnotations = downloadAnnotationExport;", resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', write: false });
  const files = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const { context } = await launch({ dryRun: true, headless: false, profile });
    try {
      await context.route('**/*', route => route.abort());
      const page = context.pages()[0] ?? await context.newPage();
      await page.setContent('<button id="export">Export annotations</button>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const payload = { format: 'reviewtool.annotation-export/1', exportedAt: Date.parse('2026-09-26T00:00:00Z') + cycle * 1000, pageName: 'Download test', document: { wiki: 'zhwiki', pageId: 1, revisionId: 2, offsetUnit: 'utf8-byte' }, highlights: [], groups: [{ sectionPath: 'Test', annotations: [{ id: 'comment', highlightId: 'highlight', rootId: 'comment', parentId: null, opinion: 'A comment with Unicode 字詞. '.repeat(600) }] }] };
      await page.evaluate(payload => { document.querySelector('#export').onclick = () => exportAnnotations(document, payload); }, payload);
      await page.locator('#export').click();
      const file = path.join(downloads, `review-tool-annotations-2-2026-09-26T00000${cycle}000Z.json`);
      const expected = { ...payload, format: 'reviewtool.annotation-export/2' };
      assert.deepEqual(await completedFile(page, file), expected);
      files.push({ file, payload: expected });
      // Chrome previously crashed shortly after emitting its download event on the second launch.
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => document.querySelector('#export').textContent), 'Export annotations');
    } finally { await context.close(); }
    for (const { file, payload } of files) assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), payload);
  }
});
