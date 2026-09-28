import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { articles } from './articles.mjs';

test('pinned real article source and ordinary rendered HTML load into the visual model', async () => {
  const server = await startServer();
  const channel = process.env.ANNOTATION_BROWSER_CHANNEL ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const results = [];
  try {
    for (const article of articles) {
      const fixture = JSON.parse(await readFile(new URL(`../../.cache/annotation-articles/${article.key}.json`, import.meta.url), 'utf8'));
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // Mapping tests are offline; image loading is inspected separately in the running demo.
      await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
      await page.goto(`${server.url}/?article=${article.key}`);
      await page.waitForFunction(key => window.annotationPageLab?.fixture.key === key, article.key);
      const linkExample = {
        earth: { invocation: '{{tsl|en|Biogenic substance|生源物质|生源}}', label: '生源', target: 'Biogenic substance', language: 'en' },
        javascript: { invocation: '{{le|膠水語言|glue code}}', label: '膠水語言', target: '膠水語言' },
        liyue: { invocation: '[[蒙德 (原神)|蒙德]]', label: '蒙德', target: '蒙德 (原神)' },
        'sun-yat-sen': { invocation: '[[博濟醫學堂|博濟醫院附設醫科學校]]', label: '博濟醫院附設醫科學校', target: '博濟醫學堂' },
      }[article.key];
      const result = await page.evaluate(example => {
        const view = annotationPageLab.view;
        const source = annotationPageLab.fixture.wikitext;
        const encoder = new TextEncoder();
        const candidate = view.projection.runs.find(run => {
          const node = view.element.querySelector(`[data-source-run="${run.id}"]`);
          const phrase = run.text.slice(0, 20);
          return run.mapping === 'identity' && run.text.length >= 30 && node?.closest('p') && !node.closest('pre') && source.indexOf(phrase) === source.lastIndexOf(phrase);
        });
        if (!candidate) throw new Error('No unique prose selection fixture found.');
        const node = view.element.querySelector(`[data-source-run="${candidate.id}"]`).firstChild;
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 20);
        const selected = view.readRange(range);
        const at = source.indexOf(selected.quote);
        const expected = { unit: 'utf8-byte', start: encoder.encode(source.slice(0, at)).length, end: encoder.encode(source.slice(0, at + selected.quote.length)).length };
        const groups = [...view.element.querySelectorAll('[data-inspect="image"]')];
        const imageCode = groups.map(code => {
          const codeRange = document.createRange(); codeRange.selectNodeContents(code);
          const read = view.readRange(codeRange);
          code.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
          const original = new TextDecoder().decode(encoder.encode(source).slice(read.anchor.start, read.anchor.end));
          return { sourceText: read.sourceText, selectionMatchesCode: read.quote === code.textContent && read.sourceText === original && /^\[\[(?:File|Image|文件|檔案|档案|图像|圖像):/i.test(original) && original.endsWith(']]'), restored: view.readRange(view.restoreRange(read.anchor)), selection: read, hasImage: Boolean(view.element.querySelector('[data-annotation-popup] img')), loading: view.element.querySelector('[data-annotation-image]')?.textContent === '正在載入圖片…', inline: getComputedStyle(code).display === 'inline' };
        });
        view.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const href = `https://${example.language ?? 'zh'}.wikipedia.org/wiki/` + encodeURIComponent(example.target.replace(/ /g, '_'));
        const articleLink = [...view.element.querySelectorAll('a')].find(link => link.textContent === example.label && link.dataset.targetUrl === href);
        if (!articleLink) throw new Error('Known article link was not rendered as a link.');
        const linkRange = document.createRange(); linkRange.selectNodeContents(articleLink);
        const linkSelection = view.readRange(linkRange);
        const invocationAt = source.indexOf(example.invocation);
        if (invocationAt < 0) throw new Error('Expected link source missing from fixture.');
        const labelAt = invocationAt + example.invocation.lastIndexOf(example.label);
        const expectedLinkAnchor = { unit: 'utf8-byte', start: encoder.encode(source.slice(0, labelAt)).length, end: encoder.encode(source.slice(0, labelAt + example.label.length)).length };
        const templatePattern = annotationPageLab.fixture.key === 'liyue' ? /\{\{r\|[^{}]*\}\}/g : /\{\{rp\|[^{}<>\[\]]*\}\}/gi;
        // Gallery bodies are deliberately source-only, and rich/dynamic locators are not collapsed.
        const galleries = [...source.matchAll(/<gallery\b[^>]*>[\s\S]*?<\/gallery>/gi)];
        const referenceTemplates = {
          expected: [...source.matchAll(templatePattern)].filter(match => !galleries.some(gallery => match.index >= gallery.index && match.index < gallery.index + gallery[0].length)).map(match => ({ sourceText: match[0], anchor: { unit: 'utf8-byte', start: encoder.encode(source.slice(0, match.index)).length, end: encoder.encode(source.slice(0, match.index + match[0].length)).length } })),
          actual: [...view.element.querySelectorAll('[data-inspect="reference"]')].map(marker => {
            const range = document.createRange(); range.selectNodeContents(marker);
            const selected = view.readRange(range);
            return { selected, restored: view.readRange(view.restoreRange(selected.anchor)) };
          }).filter(item => new RegExp(templatePattern.source, 'i').test(item.selected.sourceText)),
        };
        let videoList = null;
        let fileCaption = null;
        let conversionFiles = null;
        if (annotationPageLab.fixture.key === 'earth') {
          const file = [...view.element.querySelectorAll('[data-raw-kind="file"]')].find(node => node.textContent.startsWith('[[File:Earth2014shape SouthAmerica small-zh.jpg|'));
          if (!file?.querySelector('[data-file-caption]')) throw new Error('Earth2014 image caption was not parsed.');
          const captionLink = [...file.querySelectorAll('[data-inspect="link"]')].find(link => link.textContent === '安第斯山脉');
          const captionRange = document.createRange(); captionRange.selectNodeContents(captionLink);
          const read = view.readRange(captionRange);
          const fileAt = source.indexOf('[[File:Earth2014shape SouthAmerica small-zh.jpg|');
          const wordAt = source.indexOf('安第斯山脉', fileAt);
          fileCaption = { selected: read, expected: { unit: 'utf8-byte', start: encoder.encode(source.slice(0, wordAt)).length, end: encoder.encode(source.slice(0, wordAt + 5)).length }, reference: file.querySelector('[data-inspect="reference"]')?.textContent, restored: view.readRange(view.restoreRange(read.anchor)) };
          const conversion = [...view.element.querySelectorAll('[data-source-kind="conversion"]')].find(node => node.textContent.includes('Phylogenetic_tree-zh-tw.svg'));
          if (!conversion) throw new Error('Phylogenetic image conversion block was not parsed.');
          conversionFiles = { files: conversion.querySelectorAll('[data-raw-kind="file"]').length, previews: conversion.querySelectorAll('[data-inspect="image"]').length, captions: [...conversion.querySelectorAll('[data-file-caption]')].map(node => node.textContent) };
          const parent = [...view.element.querySelectorAll('li')].find(item => item.querySelector(':scope > [data-source-run]')?.textContent === '國際太空站的相关影片：');
          const nested = parent?.querySelector(':scope > ul, :scope > .annotation-block-container > ul');
          if (!nested) throw new Error('Earth video entries must be a nested unordered list.');
          videoList = [...nested.children].map(item => {
            const label = item.querySelector('a');
            const range = document.createRange(); range.selectNodeContents(label);
            const selected = view.readRange(range);
            const position = source.indexOf(label.textContent);
            return {
              selected,
              restored: view.readRange(view.restoreRange(selected.anchor)),
              expected: { unit: 'utf8-byte', start: encoder.encode(source.slice(0, position)).length, end: encoder.encode(source.slice(0, position + label.textContent.length)).length },
              indented: label.getBoundingClientRect().left > parent.querySelector(':scope > [data-source-run]').getBoundingClientRect().left,
            };
          });
        }
        return {
          article: { key: annotationPageLab.fixture.key, title: annotationPageLab.fixture.title, revisionId: annotationPageLab.fixture.revisionId },
          inputSourceUnchanged: view.projection.source === source,
          sourceBytes: encoder.encode(source).length,
          runs: view.projection.runs.length,
          rawRegions: view.projection.fallbacks.length,
          images: groups.length,
          imageCode,
          linkSelection,
          expectedLinkAnchor,
          restoredLink: view.readRange(view.restoreRange(linkSelection.anchor)),
          referenceTemplates,
          videoList,
          fileCaption,
          conversionFiles,
          selected,
          expected,
          restored: view.readRange(view.restoreRange(selected.anchor)),
          error: document.querySelector('.annotation-page-tools[data-error]')?.textContent ?? '',
          overflow: document.documentElement.scrollWidth > innerWidth,
          parsoidDataPresent: annotationPageLab.original.innerHTML.includes('data-parsoid'),
        };
      }, linkExample);
      assert.equal(result.article.revisionId, article.revisionId);
      assert.equal(result.inputSourceUnchanged, true);
      assert.equal(result.sourceBytes, Buffer.byteLength(fixture.wikitext));
      assert.equal(result.error, '');
      assert.equal(result.overflow, false);
      assert.equal(result.parsoidDataPresent, false);
      assert.deepEqual(result.selected.anchor, result.expected);
      assert.deepEqual(result.restored, result.selected);
      assert.deepEqual(result.linkSelection.anchor, result.expectedLinkAnchor);
      assert.equal(result.linkSelection.quote, linkExample.label);
      assert.deepEqual(result.restoredLink, result.linkSelection);
      assert.deepEqual(result.referenceTemplates.actual.map(item => ({ sourceText: item.selected.sourceText, anchor: item.selected.anchor })), result.referenceTemplates.expected);
      for (const item of result.referenceTemplates.actual) assert.deepEqual(item.restored, item.selected);
      if (article.key === 'liyue') assert.equal(result.referenceTemplates.actual.length, 73);
      if (article.key === 'earth') assert.equal(result.referenceTemplates.actual[0].selected.quote, ':8, 31');
      if (article.key === 'sun-yat-sen') assert.equal(result.referenceTemplates.actual.length, 592);
      assert.ok(result.imageCode.every(item => (item.hasImage || item.loading) && item.selectionMatchesCode && item.inline));
      for (const item of result.imageCode) assert.deepEqual(item.restored, item.selection);
      if (article.key === 'earth') {
        assert.deepEqual(result.fileCaption.selected.anchor, result.fileCaption.expected);
        assert.deepEqual(result.fileCaption.restored, result.fileCaption.selected);
        assert.equal(result.fileCaption.reference, '[Earth2014]');
        assert.equal(result.conversionFiles.files, 2);
        assert.equal(result.conversionFiles.previews, 2);
        assert.deepEqual(result.conversionFiles.captions, ['基于rRNA分析而重建出的地球生命演化树', '基於rRNA分析而重建出的地球生命演化樹']);
        assert.ok(result.images > 0, 'Earth must demonstrate actual filename-based image reuse.');
        assert.deepEqual(result.videoList.map(item => item.selected.quote), ['影片 (01:02)', '影片 (00:27)']);
        for (const item of result.videoList) {
          assert.equal(item.indented, true);
          assert.deepEqual(item.selected.anchor, item.expected);
          assert.deepEqual(item.restored, item.selected);
        }
      }
      assert.deepEqual(errors, []);
      results.push(result);
      console.log(`${article.title} @ ${article.revisionId}: ${result.runs} runs, ${result.rawRegions} raw regions, ${result.images} image triggers (${result.imageCode.filter(item => item.hasImage).length} reused); source/selection checks passed.`);
      await page.close();
    }
    await mkdir(new URL('../../.cache/annotation-rnd/', import.meta.url), { recursive: true });
    await writeFile(new URL('../../.cache/annotation-rnd/real-article-results.json', import.meta.url), JSON.stringify(results, null, 2));
  } finally { await browser.close(); await server.close(); }
});
