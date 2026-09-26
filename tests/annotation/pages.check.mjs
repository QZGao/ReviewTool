import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { articles } from './articles.mjs';

async function headingInView(page, id, original = false) {
  await page.waitForFunction(({ id, original }) => {
    const lab = window.annotationPageLab, node = document.getElementById(id);
    if (!lab || !node || !(original ? lab.original : lab.view?.element)?.contains(node)) return false;
    const rect = node.getBoundingClientRect();
    const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    return rect.height > 0 && rect.top >= -1 && (rect.top <= 160 || (atBottom && rect.top < innerHeight));
  }, { id, original }, { timeout: 5000 });
}

test('pinned controls move beside the contents without losing widget state and return to their original positions', async () => {
  const server = await startServer();
  const channel = process.env.ANNOTATION_BROWSER_CHANNEL ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
    await page.goto(`${server.url}/?article=sun-yat-sen&view=original`);
    await page.waitForFunction(() => Boolean(window.annotationPageLab));
    await page.evaluate(() => {
      // The downloaded page has no runtime: supply an interactive widget in its native slot.
      document.documentElement.classList.replace('client-nojs', 'client-js');
      document.documentElement.classList.remove('vector-feature-appearance-pinned-clientpref-0');
      document.documentElement.classList.add('vector-feature-appearance-pinned-clientpref-1');
      const left = document.querySelector('.vector-column-start'), right = document.querySelector('.vector-column-end');
      const input = document.createElement('input'); input.id = 'pinned-widget';
      input.setAttribute('aria-label', 'Pinned widget');
      document.querySelector('#vector-appearance').append(input);
      const extra = document.createElement('div'); extra.className = 'vector-sticky-pinned-container';
      const button = document.createElement('button'); button.textContent = 'Pinned action';
      window.pinnedCalls = 0; button.addEventListener('click', () => pinnedCalls++);
      extra.append(button); right.append(extra);
      window.pinnedFixture = { left, right, input, button, leftNodes: [...left.childNodes], rightNodes: [...right.childNodes],
        stack: left.querySelector(':scope > .vector-sticky-pinned-container'),
        contents: [...right.querySelectorAll(':scope > .vector-sticky-pinned-container')].map(node => ({ node, children: [...node.childNodes] })) };
      annotationPageLab.setEnabled(true);
    });
    assert.equal(await page.locator('.vector-column-end > .vector-sticky-pinned-container').count(), 0);
    assert.equal(await page.evaluate(() => pinnedFixture.stack === document.querySelector('.annotation-left-pinned') && pinnedFixture.contents.every(({ children }) => children.every(node => pinnedFixture.stack.contains(node)))), true);
    assert.equal(await page.locator('.vector-column-start .vector-sticky-pinned-container').count(), 1);
    await page.getByRole('textbox', { name: 'Pinned widget' }).fill('Kept across view changes');
    await page.getByRole('button', { name: 'Pinned action', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const boxes = await page.locator('.annotation-left-pinned > #mw-panel-toc, .annotation-left-pinned > .vector-appearance-landmark').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    for (const [index, box] of boxes.entries()) {
      assert.ok(box.height > 0);
      if (index) assert.ok(box.top >= boxes[index - 1].bottom, 'pinned panels do not overlap while scrolling');
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.evaluate(() => annotationPageLab.setEnabled(false));
      assert.deepEqual(await page.evaluate(() => {
        const { left, right, input, button, leftNodes, rightNodes, contents } = pinnedFixture;
        const sameNodes = (parent, nodes) => parent.childNodes.length === nodes.length && nodes.every((node, index) => parent.childNodes[index] === node);
        return { left: sameNodes(left, leftNodes), right: sameNodes(right, rightNodes),
          input: document.getElementById('pinned-widget') === input, button: right.contains(button),
          value: input.value, contents: contents.every(({ node, children }) => sameNodes(node, children)) };
      }), { left: true, right: true, input: true, button: true, value: 'Kept across view changes', contents: true });
      await page.getByRole('button', { name: 'Pinned action', exact: true }).click();
      await page.evaluate(() => annotationPageLab.setEnabled(true));
      assert.equal(await page.locator('.annotation-left-pinned').count(), 1);
    }
    assert.equal(await page.evaluate(() => pinnedCalls), 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.annotation-left-pinned').isVisible(), false, 'native narrow-screen visibility still applies');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await browser.close(); await server.close(); }
});

test('Wikipedia contents links and fragment history follow the visible headings in both article modes', async () => {
  const server = await startServer();
  const channel = process.env.ANNOTATION_BROWSER_CHANNEL ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  try {
    for (const article of articles) {
      const fixture = JSON.parse(await readFile(new URL(`../../.cache/annotation-articles/${article.key}.json`, import.meta.url), 'utf8'));
      const anchors = fixture.headingAnchors;
      assert.ok(anchors.length > 2);
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
      const initial = anchors[2], next = anchors[Math.floor(anchors.length / 2)];
      await page.goto(`${server.url}/?article=${article.key}&theme=dark#${encodeURIComponent(initial.id)}`);
      await page.waitForFunction(() => Boolean(window.annotationPageLab));
      await headingInView(page, initial.id);
      const assigned = await page.evaluate(anchors => anchors.map(anchor => {
        const node = document.getElementById(anchor.id);
        return { id: anchor.id, active: annotationPageLab.view.element.contains(node), tag: node?.tagName, start: Number(node?.dataset.headingStart), count: [...document.querySelectorAll('[id]')].filter(element => element.id === anchor.id).length };
      }), anchors);
      for (const [index, item] of assigned.entries()) {
        assert.equal(item.active, true, `${article.title}: ${item.id}`);
        assert.equal(item.tag, 'H' + anchors[index].level);
        assert.equal(item.start, anchors[index].start);
        assert.equal(item.count, 1);
      }
      await page.evaluate(async id => {
        const changed = new Promise(resolve => document.addEventListener('selectionchange', () => resolve(), { once: true }));
        const range = document.createRange(); range.selectNodeContents(document.getElementById(id));
        getSelection().removeAllRanges(); getSelection().addRange(range); await changed;
        window.tocSelection = annotationPageLab.view.selection;
      }, initial.id);
      const index = await page.locator('#vector-toc a[href]').evaluateAll((links, id) => links.findIndex(link => decodeURIComponent(new URL(link.href).hash.slice(1)) === id), next.id);
      assert.ok(index >= 0);
      const link = page.locator('#vector-toc a[href]').nth(index);
      await link.click();
      await headingInView(page, next.id);
      assert.equal(decodeURIComponent(new URL(page.url()).hash.slice(1)), next.id);
      assert.equal(await page.evaluate(() => JSON.stringify(annotationPageLab.view.selection) === JSON.stringify(tocSelection)), true);
      await page.goBack(); await headingInView(page, initial.id);
      await page.goForward(); await headingInView(page, next.id);
      // Clicking the current fragment again must still scroll after manual movement.
      await page.evaluate(() => window.scrollTo(0, 0));
      await link.click(); await headingInView(page, next.id);
      await page.evaluate(() => annotationPageLab.setEnabled(false));
      await headingInView(page, next.id, true);
      const restored = await page.evaluate(anchors => anchors.every(anchor => {
        const owners = [...document.querySelectorAll('[id]')].filter(node => node.id === anchor.id);
        return owners.length === 1 && annotationPageLab.original.contains(owners[0]);
      }), anchors);
      assert.equal(restored, true);
      await page.evaluate(() => annotationPageLab.setEnabled(true));
      await headingInView(page, next.id);
      await page.locator('#annotation-page-theme').selectOption('light');
      await link.click(); await headingInView(page, next.id);
      assert.deepEqual(errors, []);
      console.log(`${article.title}: ${anchors.length} unique heading anchors, contents clicks, deep links, history and restoration passed.`);
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});

function contrast(foreground, background) {
  const luminance = color => {
    const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test('annotation colors follow Wikipedia in light, dark and automatic modes without remounting', async () => {
  const server = await startServer();
  const channel = process.env.ANNOTATION_BROWSER_CHANNEL ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  try {
    for (const article of articles) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
      await page.goto(`${server.url}/?article=${article.key}&theme=dark`);
      await page.waitForFunction(() => Boolean(window.annotationPageLab));
      assert.equal(await page.locator('#annotation-page-theme').inputValue(), 'dark');
      await page.evaluate(async () => {
        const view = annotationPageLab.view;
        window.themeView = view;
        window.themeRun = view.element.querySelector('[data-source-run]');
        const changed = new Promise(resolve => document.addEventListener('selectionchange', () => resolve(), { once: true }));
        const range = document.createRange(); range.selectNodeContents(themeRun);
        getSelection().removeAllRanges(); getSelection().addRange(range); await changed;
        window.themeSelection = view.selection;
      });
      const cases = [
        { theme: 'light', os: 'light', dark: false },
        { theme: 'dark', os: 'light', dark: true },
        { theme: 'light', os: 'dark', dark: false },
        { theme: 'auto', os: 'dark', dark: true },
        { theme: 'auto', os: 'light', dark: false },
      ];
      let lightColor;
      for (const scenario of cases) {
        await page.emulateMedia({ colorScheme: scenario.os });
        await page.locator('#annotation-page-theme').selectOption(scenario.theme);
        const colors = await page.evaluate(() => {
          const lab = annotationPageLab, root = lab.view.element;
          root.querySelector('[data-inspect="reference"]').focus({ preventScroll: true });
          const popup = root.querySelector('[data-annotation-popup]');
          const color = element => getComputedStyle(element).color;
          const nativeP = [...lab.original.querySelectorAll(':scope > p')].find(paragraph => paragraph.querySelector('a[href]:not(.new)'));
          const nativeLink = nativeP.querySelector('a[href]:not(.new)');
          const span = root.querySelector('[data-source-run]');
          const selection = getComputedStyle(span, '::selection');
          const highlight = getComputedStyle(span, '::highlight(reviewtool-annotation-selection)');
          return {
            nativeText: color(nativeP), text: color(root.querySelector('p')), code: color(root.querySelector('code')),
            nativeHeading: color(lab.original.querySelector('h2')), heading: color(root.querySelector('h2')),
            nativeLink: color(nativeLink), link: color(root.querySelector('a')),
            nativeReference: color(lab.original.querySelector('.reference a')), reference: color(root.querySelector('[data-inspect="reference"]')),
            surface: getComputedStyle(document.querySelector('.mw-page-container')).backgroundColor,
            popup: color(popup), popupCode: color(popup.querySelector('pre')), popupBackground: getComputedStyle(popup).backgroundColor,
            popupHeading: color(popup.querySelector('.annotation-popup-heading')),
            controls: color(document.querySelector('.annotation-page-tools')), controlsBackground: getComputedStyle(document.querySelector('.annotation-page-tools')).backgroundColor,
            button: color(document.querySelector('#annotation-page-toggle')), buttonBackground: getComputedStyle(document.querySelector('#annotation-page-toggle')).backgroundColor,
            inspector: color(document.querySelector('#annotation-page-source')), inspectorBackground: getComputedStyle(document.querySelector('#annotation-page-source')).backgroundColor,
            selection: { color: selection.color, background: selection.backgroundColor },
            highlight: { color: highlight.color, background: highlight.backgroundColor },
            sameView: lab.view === themeView && themeRun.isConnected,
            preserved: JSON.stringify(lab.view.selection) === JSON.stringify(themeSelection),
          };
        });
        for (const name of ['text', 'code', 'popup', 'popupCode', 'controls', 'button', 'inspector']) assert.equal(colors[name], colors.nativeText, `${article.title} ${scenario.theme}/${scenario.os}: ${name}`);
        assert.equal(colors.heading, colors.nativeHeading);
        assert.equal(colors.link, colors.nativeLink);
        assert.equal(colors.reference, colors.nativeReference);
        assert.equal(colors.popupBackground, colors.surface);
        assert.deepEqual(colors.highlight, colors.selection);
        assert.equal(colors.sameView, true);
        assert.equal(colors.preserved, true);
        for (const [foreground, background] of [
          [colors.text, colors.surface], [colors.link, colors.surface], [colors.reference, colors.surface],
          [colors.popup, colors.popupBackground], [colors.popupHeading, colors.popupBackground],
          [colors.controls, colors.controlsBackground], [colors.button, colors.buttonBackground],
          [colors.inspector, colors.inspectorBackground], [colors.highlight.color, colors.highlight.background],
        ]) assert.ok(contrast(foreground, background) >= 4.5, `${article.title} ${scenario.theme}/${scenario.os}: low contrast ${foreground} on ${background}`);
        if (scenario.theme === 'light' && scenario.os === 'light') lightColor = colors.nativeText;
        assert.equal(colors.text === lightColor, !scenario.dark);
      }
      await page.locator('#annotation-page-theme').selectOption('dark');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${article.title}: dark narrow viewport`);
      await page.locator('#annotation-page-toggle').click();
      assert.equal(await page.evaluate(() => getComputedStyle(annotationPageLab.original).display !== 'none'), true);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('skin-theme-clientpref-night')), true);
      console.log(`${article.title}: Wikipedia colors and contrast passed for light/dark/automatic modes.`);
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});

test('downloaded Wikipedia pages support reversible sibling mounting, scoped selection and original skin styles', async () => {
  const server = await startServer();
  const channel = process.env.ANNOTATION_BROWSER_CHANNEL ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  try {
    for (const article of articles) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [], missing = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.url().startsWith(server.url) && response.status() >= 400) missing.push(response.url()); });
      await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
      await page.goto(`${server.url}/?article=${article.key}&view=original`);
      await page.waitForFunction(() => Boolean(window.annotationPageLab));
      const result = await page.evaluate(async () => {
        const lab = annotationPageLab, original = lab.original;
        window.savedOriginal = original;
        const html = original.innerHTML, style = original.getAttribute('style');
        const indicators = [...document.querySelectorAll('.mw-parser-output')].filter(node => node !== original && !original.contains(node));
        const indicatorStyles = indicators.map(node => node.getAttribute('style'));
        let listenerCalls = 0;
        original.addEventListener('fixture-listener', () => listenerCalls++);
        const originalVisible = getComputedStyle(original).display !== 'none';
        const skinHeading = getComputedStyle(document.querySelector('.mw-first-heading')).fontFamily;
        lab.setEnabled(true); lab.setEnabled(true);
        const view = lab.view;
        const code = view.element.querySelector('code');
        const heading = view.element.querySelector('h2');
        const before = {
          originalVisible, hidden: getComputedStyle(original).display,
          sibling: view.element.previousElementSibling === original && view.element.parentElement === original.parentElement,
          count: document.querySelectorAll('#mw-content-text > .annotation-document').length,
          indicatorsPreserved: indicators.every((node, index) => node.getAttribute('style') === indicatorStyles[index]),
          skin: document.body.classList.contains('skin-vector-2022'),
          codeBackground: getComputedStyle(code).backgroundColor, codeBorder: getComputedStyle(code).borderTopWidth,
          codePadding: getComputedStyle(code).padding, codeFont: getComputedStyle(code).fontFamily,
          headingBorder: getComputedStyle(heading).borderBottomWidth, headingPadding: getComputedStyle(heading).padding,
          headingFont: getComputedStyle(heading).fontFamily, skinHeading,
          skinHeadingUnchanged: skinHeading === getComputedStyle(document.querySelector('.mw-first-heading')).fontFamily,
          sheetsLocal: [...document.styleSheets].every(sheet => !sheet.href || sheet.href.startsWith(location.origin + '/')),
          noWikiRuntime: typeof window.mw === 'undefined',
        };
        const run = view.projection.runs.find(run => run.mapping === 'identity' && run.text.length >= 20);
        const node = view.element.querySelector(`[data-source-run="${run.id}"]`).firstChild;
        const setRange = async range => {
          const changed = new Promise(resolve => document.addEventListener('selectionchange', () => resolve(), { once: true }));
          getSelection().removeAllRanges(); getSelection().addRange(range); await changed;
        };
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 10); await setRange(range);
        const selected = view.selection;
        const outside = document.createRange(); outside.selectNodeContents(document.querySelector('.mw-first-heading')); await setRange(outside);
        const selectionPreserved = JSON.stringify(view.selection) === JSON.stringify(selected);
        const nativeOutside = getSelection().toString();
        lab.setEnabled(false); lab.setEnabled(false);
        original.dispatchEvent(new Event('fixture-listener'));
        const after = {
          sameNode: lab.original === window.savedOriginal, htmlPreserved: original.innerHTML === html,
          stylePreserved: original.getAttribute('style') === style, visible: getComputedStyle(original).display !== 'none',
          count: document.querySelectorAll('#mw-content-text > .annotation-document').length,
          popupCount: document.querySelectorAll('[data-annotation-popup]').length,
          highlightGone: !CSS.highlights.has('reviewtool-annotation-selection'), listenerCalls,
        };
        lab.setEnabled(true);
        const restored = lab.view.readRange(lab.view.restoreRange(selected.anchor));
        return { before, after, selectionPreserved, nativeOutside, selected, restored, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(result.before.originalVisible, true, article.title);
      assert.equal(result.before.hidden, 'none');
      assert.equal(result.before.sibling, true);
      assert.equal(result.before.count, 1);
      assert.equal(result.before.indicatorsPreserved, true);
      assert.equal(result.before.skin, true);
      assert.equal(result.before.sheetsLocal, true);
      assert.equal(result.before.noWikiRuntime, true);
      assert.equal(result.before.codeBackground, 'rgba(0, 0, 0, 0)');
      assert.equal(result.before.codeBorder, '0px');
      assert.equal(result.before.codePadding, '0px');
      assert.match(result.before.codeFont, /monospace/);
      assert.equal(result.before.headingBorder, '0px');
      assert.equal(result.before.headingPadding, '0px');
      assert.match(result.before.headingFont, /system-ui/);
      assert.equal(result.before.skinHeadingUnchanged, true);
      assert.equal(result.selectionPreserved, true);
      assert.ok(result.nativeOutside.includes(article.title));
      assert.deepEqual(result.after, { sameNode: true, htmlPreserved: true, stylePreserved: true, visible: true, count: 0, popupCount: 0, highlightGone: true, listenerCalls: 1 });
      assert.deepEqual(result.restored, result.selected);
      assert.equal(result.overflow, false);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${article.title}: narrow viewport`);
      assert.deepEqual(errors, []);
      assert.deepEqual(missing, []);
      console.log(`${article.title}: Wikipedia skin, CSS isolation, selection and reversible mount passed.`);
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});
