import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { listCases } from './list-cases.mjs';

let server, browser;
before(async () => {
  server = await startServer();
  const channel = process.env.ANNOTATION_BROWSER_CHANNEL ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
});
after(async () => { await browser?.close(); await server?.close(); });

async function inPage(callback) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
  try {
    await page.goto(server.url + '/lab');
    await page.waitForFunction(() => Boolean(window.annotationLab));
    await callback(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function dragText(page, selector, text) {
  const bounds = await page.locator(selector).evaluate((element, text) => {
    const node = element.firstChild;
    const from = node.data.indexOf(text);
    if (from < 0) throw new Error('Drag text missing from fixture.');
    const first = document.createRange(); first.setStart(node, from); first.setEnd(node, from + 1);
    const last = document.createRange(); last.setStart(node, from + text.length - 1); last.setEnd(node, from + text.length);
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
  }, text);
  await page.mouse.move(bounds.x1, bounds.y1); await page.mouse.down();
  await page.mouse.move(bounds.x2, bounds.y2, { steps: 8 }); await page.mouse.up();
}

test('mixed list and indentation structures match captured MediaWiki rendering', async () => {
  await inPage(async page => {
    const results = await page.evaluate(cases => {
      const structural = new Set(['UL', 'OL', 'LI', 'DL', 'DT', 'DD']);
      function signature(root) {
        const children = [];
        let text = '';
        const flush = () => { if (text.trim()) children.push(text.trim()); text = ''; };
        const visit = node => {
          if (node.nodeType === 3) text += node.data;
          else if (node.tagName === 'BR') text += '\n';
          else if (structural.has(node.tagName)) { flush(); children.push([node.tagName.toLowerCase(), ...signature(node)]); }
          else [...node.childNodes].forEach(visit);
        };
        [...root.childNodes].forEach(visit); flush();
        return children;
      }
      return cases.map(fixture => {
        const view = annotationLab.render(fixture.source);
        const reference = document.createElement('template'); reference.innerHTML = fixture.html;
        return { name: fixture.name, actual: signature(view.element), expected: signature(reference.content), fallbacks: view.projection.fallbacks.length };
      });
    }, listCases);
    for (const result of results) {
      assert.deepEqual(result.actual, result.expected, result.name);
      assert.equal(result.fallbacks, 0, result.name);
    }
  });
});

test('native DOM selection across emphasis and links returns the original source slice', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = "甲'''重点'''和[[目标|标签]]乙";
      const view = annotationLab.render(source);
      const start = view.element.querySelector('strong span').firstChild;
      const end = view.element.querySelector('a span').firstChild;
      const range = document.createRange(); range.setStart(start, 0); range.setEnd(end, 2);
      const read = view.readRange(range);
      const restored = view.restoreRange(read.anchor);
      return { read, restored: view.readRange(restored), source, editable: view.element.isContentEditable };
    });
    assert.equal(result.read.quote, '重点和标签');
    assert.equal(result.read.sourceText, "重点'''和[[目标|标签");
    assert.deepEqual(result.restored, result.read);
    assert.equal(result.editable, false);
  });
});

test('element-boundary selections, cross-paragraph quotes, and outside selections behave explicitly', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const view = annotationLab.render('第一段。\n\n第二段。');
      const range = document.createRange(); range.selectNodeContents(view.element);
      const all = view.readRange(range);
      range.selectNodeContents(document.querySelector('header'));
      const outside = view.readRange(range);
      range.setStart(document.querySelector('header'), 0); range.setEnd(view.element, 1);
      return { all, outside, mixed: view.readRange(range) };
    });
    assert.equal(result.all.quote, '第一段。\n\n第二段。');
    assert.equal(result.outside, null);
    assert.equal(result.mixed, null);
  });
});

test('outside text and input selections preserve the article selection, highlight and inspector', async () => {
  await inPage(async page => {
    await page.evaluate(() => annotationLab.render('第一句是背景。第二句用于选择。第三句用于替换。'));
    await dragText(page, '#view p [data-source-run]', '第二句用于选择。');
    await page.waitForFunction(() => annotationLab.view.selection?.quote === '第二句用于选择。');
    const before = await page.evaluate(() => {
      window.originalRun = annotationLab.view.element.querySelector('[data-source-run]').firstChild;
      return annotationLab.view.selection;
    });
    await dragText(page, 'header p', 'Select article text');
    const result = await page.evaluate(() => ({
      native: getSelection().toString(), selected: annotationLab.view.selection,
      mappedOutside: annotationLab.view.readRange(getSelection().getRangeAt(0)),
      highlight: [...CSS.highlights.get('reviewtool-annotation-selection')].map(range => range.toString()),
      stable: originalRun === annotationLab.view.element.querySelector('[data-source-run]').firstChild,
      quote: document.querySelector('#quote').textContent, restoreDisabled: document.querySelector('#restore').disabled,
    }));
    assert.equal(result.native, 'Select article text');
    assert.deepEqual(result.selected, before);
    assert.equal(result.mappedOutside, null);
    assert.deepEqual(result.highlight, ['第二句用于选择。']);
    assert.equal(result.stable, true);
    assert.equal(result.quote, '第二句用于选择。');
    assert.equal(result.restoreDisabled, false);
    await page.locator('#source').selectText();
    assert.deepEqual(await page.evaluate(() => annotationLab.view.selection), before);
    await page.locator('#restore').click();
    assert.equal(await page.evaluate(() => getSelection().toString()), before.quote);
    await dragText(page, '#view p [data-source-run]', '第三句用于替换。');
    assert.equal(await page.evaluate(() => annotationLab.view.selection.quote), '第三句用于替换。');
    await page.locator('#view p').click({ position: { x: 15, y: 12 } });
    await page.waitForFunction(() => annotationLab.view.selection === null);
    assert.equal(await page.evaluate(() => CSS.highlights.has('reviewtool-annotation-selection')), false);
    assert.equal(await page.locator('#restore').isDisabled(), true);
  });
});

test('popup text can be dragged and copied while the original article selection stays highlighted', async () => {
  await inPage(async page => {
    await page.evaluate(() => annotationLab.render('前{{r|甲|乙}}后[[另一頁|另一链接]]'));
    await page.locator('#view [data-inspect="reference"]').click();
    const before = await page.evaluate(() => annotationLab.view.selection);
    assert.equal(before.sourceText, '{{r|甲|乙}}');
    await dragText(page, '[data-annotation-popup] pre', '甲|乙');
    assert.equal(await page.evaluate(() => getSelection().toString()), '甲|乙');
    assert.deepEqual(await page.evaluate(() => annotationLab.view.selection), before);
    await page.evaluate(() => document.addEventListener('copy', event => {
      window.popupCopy = { text: getSelection().toString(), prevented: event.defaultPrevented };
      event.preventDefault(); // Inspect the copy command without writing to the host clipboard.
    }, { once: true }));
    await page.mouse.move(10, 10);
    await page.waitForTimeout(200); // Longer than the popup's pointer-exit dismissal delay.
    assert.equal(await page.locator('[data-annotation-popup]').isVisible(), true);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
    assert.deepEqual(await page.evaluate(() => window.popupCopy), { text: '甲|乙', prevented: false });
    await page.locator('#view [data-inspect="link"]').hover();
    assert.equal(await page.locator('[data-annotation-popup] pre').textContent(), '{{r|甲|乙}}');
    const result = await page.evaluate(async () => {
      const changed = new Promise(resolve => document.addEventListener('selectionchange', () => resolve(), { once: true }));
      const range = document.createRange(); range.selectNodeContents(document.querySelector('[data-annotation-popup] pre'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      await changed;
      return { selected: annotationLab.view.selection, rejected: annotationLab.view.readRange(range), highlight: [...CSS.highlights.get('reviewtool-annotation-selection')].map(range => range.toString()), inspector: document.querySelector('#slice').textContent };
    });
    assert.deepEqual(result.selected, before);
    assert.equal(result.rejected, null);
    assert.deepEqual(result.highlight, ['[甲][乙]']);
    assert.equal(result.inspector, '{{r|甲|乙}}');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-annotation-popup]').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement === annotationLab.view.element.querySelector('[data-inspect="reference"]')), true);
    await page.keyboard.press('Tab');
    // Escape closed the popup; focusing the trigger again reopens it for keyboard inspection.
    await page.locator('#view [data-inspect="reference"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('[data-annotation-popup]')), true);
  });
});

test('selections spanning container boundaries retain the last complete internal selection', async () => {
  await inPage(async page => {
    await page.evaluate(() => annotationLab.render('第一段文字。保存这个句子。最后一段。'));
    await dragText(page, '#view p [data-source-run]', '保存这个句子。');
    const before = await page.evaluate(() => annotationLab.view.selection);
    // A real drag beginning in the article ends in the outside header.
    const points = await page.evaluate(() => {
      const inside = annotationLab.view.element.querySelector('[data-source-run]').getBoundingClientRect();
      const outside = document.querySelector('header p').getBoundingClientRect();
      return { x1: inside.left + 10, y1: inside.top + 10, x2: outside.left + 40, y2: outside.top + 5 };
    });
    await page.mouse.move(points.x1, points.y1); await page.mouse.down();
    await page.mouse.move(points.x2, points.y2, { steps: 10 }); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => annotationLab.view.selection), before);
    assert.equal(await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0))), null);
    const mixed = await page.evaluate(async () => {
      const changed = new Promise(resolve => document.addEventListener('selectionchange', () => resolve(), { once: true }));
      const range = document.createRange();
      range.setStart(annotationLab.view.element.querySelector('[data-source-run]').firstChild, 0);
      range.setEnd(document.querySelector('#quote').firstChild, 3);
      getSelection().removeAllRanges(); getSelection().addRange(range); await changed;
      return { selected: annotationLab.view.selection, rejected: annotationLab.view.readRange(range) };
    });
    assert.equal(mixed.rejected, null);
    assert.deepEqual(mixed.selected, before);
  });
});

test('whole-link source anchors survive outside selection and explicit clearing leaves outside text selected', async () => {
  await inPage(async page => {
    await page.evaluate(() => annotationLab.render('前[[目标|标签]]后'));
    await page.locator('#view [data-inspect="link"]').click();
    const before = await page.evaluate(() => annotationLab.view.selection);
    assert.equal(before.sourceText, '[[目标|标签]]');
    await dragText(page, 'header p', 'Select article text');
    assert.deepEqual(await page.evaluate(() => annotationLab.view.selection), before);
    await page.evaluate(() => annotationLab.view.clearSelection());
    assert.equal(await page.evaluate(() => annotationLab.view.selection), null);
    assert.equal(await page.evaluate(() => getSelection().toString()), 'Select article text');
    assert.equal(await page.evaluate(() => CSS.highlights.has('reviewtool-annotation-selection')), false);
  });
});

test('separate views retain independent selections and destroy removes only the owned highlight', async () => {
  await inPage(async page => {
    const result = await page.evaluate(async () => {
      const a = annotationLab.render('第一视图。');
      const b = annotationLab.annotation.createAnnotationView(document, annotationLab.annotation.createProjection('第二视图。'));
      document.querySelector('#view').append(b.element);
      const select = async view => {
        const changed = new Promise(resolve => document.addEventListener('selectionchange', () => resolve(), { once: true }));
        const range = document.createRange(); range.selectNodeContents(view.element.querySelector('[data-source-run]'));
        getSelection().removeAllRanges(); getSelection().addRange(range); await changed;
      };
      await select(a); await select(b);
      const both = [a.selection.quote, b.selection.quote];
      const highlights = [...CSS.highlights.get('reviewtool-annotation-selection')].map(range => range.toString());
      a.destroy();
      const remaining = [...CSS.highlights.get('reviewtool-annotation-selection')].map(range => range.toString());
      await select(a);
      const destroyed = a.selection;
      const retained = b.selection.quote;
      b.destroy();
      return { both, highlights, remaining, destroyed, retained, cleaned: !CSS.highlights.has('reviewtool-annotation-selection') };
    });
    assert.deepEqual(result.both, ['第一视图。', '第二视图。']);
    assert.deepEqual(result.highlights.sort(), ['第一视图。', '第二视图。'].sort());
    assert.deepEqual(result.remaining, ['第二视图。']);
    assert.equal(result.destroyed, null);
    assert.equal(result.retained, '第二视图。');
    assert.equal(result.cleaned, true);
  });
});

test('Shift-click extends an existing internal selection', async () => {
  await inPage(async page => {
    await page.evaluate(() => annotationLab.render('ABCDEFGHIJKLMNO'));
    await dragText(page, '#view p [data-source-run]', 'BCD');
    const end = await page.evaluate(() => {
      const node = annotationLab.view.element.querySelector('[data-source-run]').firstChild;
      const range = document.createRange(); range.setStart(node, 8); range.setEnd(node, 9);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    });
    await page.keyboard.down('Shift'); await page.mouse.click(end.x, end.y); await page.keyboard.up('Shift');
    await page.waitForFunction(() => annotationLab.view.selection?.quote === 'BCDEFGH');
    assert.deepEqual(await page.evaluate(() => [...CSS.highlights.get('reviewtool-annotation-selection')].map(range => range.toString())), ['BCDEFGH']);
  });
});

test('Wikipedia mount preserves display priority, unrelated styles, original nodes and listeners', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const host = document.createElement('section');
      host.innerHTML = '<aside class="mw-parser-output" id="fixture-indicator">Indicator</aside><div id="mw-content-text"><div class="mw-parser-output" style="display:inline-block!important">Original <span>content</span><div class="mw-parser-output">Nested template output</div></div></div>';
      document.body.append(host);
      const api = annotationLab.annotation;
      const original = host.querySelector('#mw-content-text > .mw-parser-output');
      const nested = original.lastElementChild;
      let events = 0; original.addEventListener('fixture-event', () => events++);
      const model = api.createProjection('甲[[页|标签]]乙');
      const mount = api.mountWikipediaAnnotation(document, model);
      let duplicateRejected = false;
      try { api.mountWikipediaAnnotation(document, model); } catch { duplicateRejected = true; }
      const active = { sibling: original.nextElementSibling === mount.view.element, display: original.style.display, priority: original.style.getPropertyPriority('display'), indicator: host.querySelector('aside').getAttribute('style'), nested: nested.getAttribute('style') };
      original.style.color = 'red'; // Independent changes made while hidden must survive exit.
      mount.destroy(); original.dispatchEvent(new Event('fixture-event'));
      const restored = { display: original.style.display, priority: original.style.getPropertyPriority('display'), color: original.style.color, sameNode: host.querySelector('#mw-content-text').firstElementChild === original, sameChild: original.lastElementChild === nested, events, removed: !mount.view.element.isConnected };
      original.style.display = 'flex'; mount.destroy();
      const idempotent = original.style.display;
      host.remove();
      return { active, restored, duplicateRejected, idempotent };
    });
    assert.deepEqual(result.active, { sibling: true, display: 'none', priority: 'important', indicator: null, nested: null });
    assert.deepEqual(result.restored, { display: 'inline-block', priority: 'important', color: 'red', sameNode: true, sameChild: true, events: 1, removed: true });
    assert.equal(result.duplicateRejected, true);
    assert.equal(result.idempotent, 'flex');
  });
});

test('Wikipedia mount refuses absent or ambiguous targets and leaves the original visible on construction failure', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const api = annotationLab.annotation, model = api.createProjection('正常');
      const doc = document.implementation.createHTMLDocument('Fixture');
      let absent = false, ambiguous = false, failed = false;
      try { api.mountWikipediaAnnotation(doc, model); } catch { absent = true; }
      doc.body.innerHTML = '<div id="mw-content-text"><div class="mw-parser-output">First</div><div class="mw-parser-output">Second</div></div>';
      try { api.mountWikipediaAnnotation(doc, model); } catch { ambiguous = true; }
      doc.querySelector('#mw-content-text').lastElementChild.remove();
      try { api.mountWikipediaAnnotation(doc, { ...model, source: '\uD800' }); } catch { failed = true; }
      return { absent, ambiguous, failed, style: doc.querySelector('.mw-parser-output').getAttribute('style'), views: doc.querySelectorAll('.annotation-document').length };
    });
    assert.deepEqual(result, { absent: true, ambiguous: true, failed: true, style: null, views: 0 });
  });
});

test('Wikipedia heading IDs follow exact source starts through duplicates, markup and Unicode', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '前😀\r\n== Same ==\r\n文字\r\n== Same ==\r\n文字\r\n=== A &amp; [[页|B]] ===\r\n尾';
      const host = document.createElement('div');
      host.innerHTML = '<nav><a href="#Same">First</a><a href="#Same_2">Second</a><a href="#A_%26_B">Formatted</a></nav><div id="mw-content-text"><div class="mw-parser-output"><h2 id="Same">Same</h2><h2 id="Same_2">Same</h2><h3><span class="mw-headline" id="A_&amp;_B">A &amp; B</span></h3></div></div>';
      document.body.append(host);
      const original = host.querySelector('.mw-parser-output');
      const owners = [...original.querySelectorAll('[id]')];
      const html = original.innerHTML;
      const ids = ['Same', 'Same_2', 'A_&_B'];
      const starts = [source.indexOf('== Same'), source.lastIndexOf('== Same'), source.indexOf('=== A')];
      const anchors = starts.map((at, i) => ({ unit: 'utf8-byte', start: new TextEncoder().encode(source.slice(0, at)).length, level: i === 2 ? 3 : 2, id: ids[i] }));
      const mount = annotationLab.annotation.mountWikipediaAnnotation(document, annotationLab.annotation.createProjection(source), { headingAnchors: anchors });
      const headings = [...mount.view.element.querySelectorAll('[data-heading-start]')];
      const assigned = ids.map((id, i) => ({ id, count: [...document.querySelectorAll('[id]')].filter(node => node.id === id).length, target: document.getElementById(id) === headings[i], start: Number(headings[i].dataset.headingStart), oldIdRemoved: !owners[i].hasAttribute('id') }));
      const range = document.createRange(); range.selectNodeContents(headings[2]);
      const selected = mount.view.readRange(range);
      const restored = mount.view.readRange(mount.view.restoreRange(selected.anchor));
      mount.destroy();
      const back = ids.every((id, i) => document.getElementById(id) === owners[i]);
      const htmlPreserved = original.innerHTML === html;
      host.remove();
      return { assigned, anchors, selected, restored, back, htmlPreserved };
    });
    for (const [i, item] of result.assigned.entries()) {
      assert.equal(item.count, 1);
      assert.equal(item.target, true);
      assert.equal(item.oldIdRemoved, true);
      assert.equal(item.start, result.anchors[i].start);
    }
    assert.deepEqual(result.restored, result.selected);
    assert.equal(result.selected.quote, ' A & B ');
    assert.equal(result.selected.sourceText, ' A &amp; [[页|B]] ');
    assert.equal(result.back, true);
    assert.equal(result.htmlPreserved, true);
  });
});

test('ambiguous heading metadata fails before hiding the article and unmatched headings are not guessed', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const host = document.createElement('div'); host.id = 'mw-content-text'; host.innerHTML = '<div class="mw-parser-output"><h2 id="Exact">Exact</h2></div>'; document.body.append(host);
      const original = host.firstElementChild;
      const api = annotationLab.annotation, projection = api.createProjection('== Exact ==');
      const anchor = { unit: 'utf8-byte', start: 0, level: 2, id: 'Exact' };
      let failed = false;
      try { api.mountWikipediaAnnotation(document, projection, { headingAnchors: [anchor, anchor] }); } catch { failed = true; }
      const untouched = original.style.display === '' && original.querySelector('h2').id === 'Exact' && !host.querySelector('.annotation-document');
      const mount = api.mountWikipediaAnnotation(document, projection, { headingAnchors: [{ ...anchor, start: 1 }] });
      const noGuess = !mount.view.element.querySelector('h2').id && original.querySelector('h2').id === 'Exact';
      mount.destroy(); host.remove();
      return { failed, untouched, noGuess };
    });
    assert.deepEqual(result, { failed: true, untouched: true, noGuess: true });
  });
});

test('one newline creates a line break and two create a paragraph gap without block-specific margins', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '{{NoteTA\n|G1=unit\n}}\n{{Good article}}\n{{redirect|Earth}}\n\n{{Infobox\n|name=地球\n}}\n后文';
      const view = annotationLab.render(source);
      const blocks = [...view.element.children];
      const note = blocks[0], middle = blocks[1], info = blocks[2], last = blocks[3];
      const templates = [...middle.querySelectorAll('[data-template]')];
      const labels = templates.map(node => node.getBoundingClientRect());
      const rects = blocks.map(node => node.getBoundingClientRect());
      const range = document.createRange(); range.selectNodeContents(middle);
      const selected = view.readRange(range);
      const serialized = document.createElement('div');
      serialized.innerHTML = annotationLab.annotation.renderToHtml(view.projection);
      return {
        beforeGap: rects[1].top - rects[0].bottom,
        betweenLineTops: labels[1].top - labels[0].top,
        lineHeight: parseFloat(getComputedStyle(middle).lineHeight),
        paragraphGap: rects[2].top - rects[1].bottom,
        expectedGap: parseFloat(getComputedStyle(info).marginTop),
        afterGap: rects[3].top - rects[2].bottom,
        noteMargin: getComputedStyle(note).marginBottom, lastMargin: getComputedStyle(last).marginTop,
        selected, restored: view.readRange(view.restoreRange(selected.anchor)),
        source: view.projection.source, expectedSource: source,
        serializedGap: serialized.querySelector('[data-break-before="paragraph"]')?.textContent,
      };
    });
    assert.ok(Math.abs(result.beforeGap) < 1);
    assert.ok(Math.abs(result.afterGap) < 1);
    assert.ok(Math.abs(result.betweenLineTops - result.lineHeight) < 1);
    assert.equal(result.noteMargin, '0px'); assert.equal(result.lastMargin, '0px');
    assert.ok(result.expectedGap > 0);
    assert.ok(Math.abs(result.paragraphGap - result.expectedGap) < 1);
    assert.equal(result.selected.quote, '{{Good article}}\n{{redirect|Earth}}');
    assert.equal(result.selected.sourceText, result.selected.quote);
    assert.deepEqual(result.restored, result.selected);
    assert.equal(result.source, result.expectedSource);
    assert.equal(result.serializedGap, '{{Infobox\n|name=地球\n}}');
  });
});

test('plain-text single and double line breaks preserve CRLF anchors and distinct visual spacing', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '第一行😀\r\n第二行\r\n\r\n新段落';
      const view = annotationLab.render(source);
      const paragraphs = [...view.element.querySelectorAll('p')];
      const run = view.projection.runs.find(run => run.text === '第二行');
      const node = view.element.querySelector(`[data-source-run="${run.id}"]`).firstChild;
      const range = document.createRange(); range.selectNodeContents(node);
      const selected = view.readRange(range);
      const first = paragraphs[0].querySelector('[data-source-run]').getBoundingClientRect();
      const second = range.getBoundingClientRect();
      const encoder = new TextEncoder();
      const at = source.indexOf('第二行');
      return {
        lines: second.top - first.top, lineHeight: parseFloat(getComputedStyle(paragraphs[0]).lineHeight),
        paragraphGap: paragraphs[1].getBoundingClientRect().top - paragraphs[0].getBoundingClientRect().bottom,
        selected, expected: { unit: 'utf8-byte', start: encoder.encode(source.slice(0, at)).length, end: encoder.encode(source.slice(0, at + 3)).length },
        quote: view.projection.text, restored: view.readRange(view.restoreRange(selected.anchor)),
      };
    });
    assert.ok(Math.abs(result.lines - result.lineHeight) < 1);
    assert.ok(result.paragraphGap > 0);
    assert.deepEqual(result.selected.anchor, result.expected);
    assert.deepEqual(result.restored, result.selected);
    assert.equal(result.quote, '第一行😀\n第二行\n\n新段落');
  });
});

test('source ranges survive remounting, entities, emoji and CRLF', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '甲😀\r\n乙&amp;丙\r\n\r\n<math>x</math>';
      let view = annotationLab.render(source);
      const entity = view.projection.runs.find(run => run.text === '&');
      const node = view.element.querySelector(`[data-source-run="${entity.id}"]`).firstChild;
      const range = document.createRange(); range.selectNodeContents(node);
      const first = view.readRange(range);
      view = annotationLab.render(source);
      return { source: view.projection.source, first, restored: view.readRange(view.restoreRange(first.anchor)) };
    });
    assert.equal(result.first.sourceText, '&amp;');
    assert.equal(result.source, '甲😀\r\n乙&amp;丙\r\n\r\n<math>x</math>');
    assert.deepEqual(result.restored, result.first);
  });
});

test('inline code and formatted template text stay in the paragraph and restore native selections', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = "前<code>literal()</code>{{例|'''重点'''与[[页面|标签]]|<nowiki>[[原样]]</nowiki>}}<math>x</math>后";
      const view = annotationLab.render(source);
      const range = document.createRange();
      range.setStart(view.element.querySelector('strong span').firstChild, 0);
      range.setEnd(view.element.querySelector('a span').firstChild, 2);
      const read = view.readRange(range);
      const code = view.element.querySelector('code');
      const serialized = document.createElement('div');
      serialized.innerHTML = annotationLab.annotation.renderToHtml(view.projection);
      return {
        read, restored: view.readRange(view.restoreRange(read.anchor)),
        blocks: view.element.children.length, paragraph: view.element.firstElementChild.tagName,
        codeDisplay: getComputedStyle(code).display, preCount: view.element.querySelectorAll('pre').length,
        text: view.element.textContent, serializedText: serialized.textContent,
      };
    });
    assert.equal(result.blocks, 1);
    assert.equal(result.paragraph, 'P');
    assert.equal(result.codeDisplay, 'inline');
    assert.equal(result.preCount, 0);
    assert.equal(result.text, '前literal(){{例|重点与标签|[[原样]]}}<math>x</math>后');
    assert.equal(result.serializedText, result.text);
    assert.equal(result.read.quote, '重点与标签');
    assert.equal(result.read.sourceText, "重点'''与[[页面|标签");
    assert.deepEqual(result.restored, result.read);
  });
});

test('link-template labels preserve native selection, destinations and serialized HTML', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = "前{{tsl|en|Foreign|目标|'''相同'''}}与{{le|相同|Foreign|相同}}后";
      const view = annotationLab.render(source);
      const links = [...view.element.querySelectorAll('a')];
      const selections = links.map(link => {
        const range = document.createRange(); range.selectNodeContents(link);
        const selected = view.readRange(range);
        return { href: link.dataset.targetUrl, directHref: link.hasAttribute('href'), selected, restored: view.readRange(view.restoreRange(selected.anchor)) };
      });
      const encoder = new TextEncoder();
      const last = source.lastIndexOf('相同');
      const expectedLast = { unit: 'utf8-byte', start: encoder.encode(source.slice(0, last)).length, end: encoder.encode(source.slice(0, last + 2)).length };
      const holder = document.createElement('div'); holder.innerHTML = annotationLab.annotation.renderToHtml(view.projection);
      // A template used inside a wikilink must not create nested anchors.
      const nested = annotationLab.render('[[目标|{{tsl|en|Foreign|目标|标签}}]]');
      return { selections, expectedLast, quote: view.projection.text, domText: view.element.textContent, serializedText: holder.textContent, nestedAnchors: nested.element.querySelectorAll('a a').length };
    });
    assert.equal(result.quote, '前相同与相同后');
    assert.equal(result.domText, result.quote);
    assert.equal(result.serializedText, result.quote);
    assert.equal(result.nestedAnchors, 0);
    assert.deepEqual(result.selections.map(item => item.href), ['https://en.wikipedia.org/wiki/Foreign', 'https://zh.wikipedia.org/wiki/%E7%9B%B8%E5%90%8C']);
    assert.deepEqual(result.selections[1].selected.anchor, result.expectedLast);
    assert.notEqual(result.selections[0].selected.anchor.start, result.selections[1].selected.anchor.start);
    for (const item of result.selections) {
      assert.equal(item.directHref, true);
      assert.equal(item.selected.quote, '相同');
      assert.equal(item.selected.sourceText, '相同');
      assert.deepEqual(item.restored, item.selected);
    }
  });
});

test('modified link clicks open the destination while ordinary clicks select the source', async () => {
  await inPage(async page => {
    await page.evaluate(() => {
      annotationLab.render('[[頁面|標籤]] {{tsl|en|Water|水}}');
      window.openedLinks = [];
      window.open = (...args) => { openedLinks.push(args); return null; };
    });
    const links = page.locator('#view a');
    await links.first().click();
    const selected = await page.evaluate(() => annotationLab.view.selection);
    for (const modifier of ['metaKey', 'ctrlKey']) await links.nth(1).dispatchEvent('click', { [modifier]: true });
    assert.deepEqual(await page.evaluate(() => openedLinks), Array(2).fill(['https://en.wikipedia.org/wiki/Water', '_blank', 'noopener']));
    assert.deepEqual(await page.evaluate(() => annotationLab.view.selection), selected);
    assert.equal(await links.nth(1).getAttribute('href'), 'https://en.wikipedia.org/wiki/Water');
  });
});

test('link source popups never navigate and their text cannot become an annotation', async () => {
  await inPage(async page => {
    const snippets = ['[[页面|标签]]', '{{tsl|en|Water|水}}', '[https://example.org 外链]'];
    await page.evaluate(source => annotationLab.render(source), '前' + snippets.join('与') + '后');
    const links = page.locator('#view [data-inspect="link"]');
    const popup = page.locator('#view [data-annotation-popup]');
    const url = page.url();
    for (const [index, snippet] of snippets.entries()) {
      await links.nth(index).hover();
      assert.equal(await popup.locator('pre').textContent(), snippet);
      assert.equal(await popup.isVisible(), true);
      await popup.hover();
      assert.equal(await popup.isVisible(), true, 'The popup must stay open while its source is inspected.');
      await links.nth(index).click();
      assert.equal(page.url(), url);
      const selected = await page.evaluate(() => {
        const view = annotationLab.view;
        const selected = view.readRange(getSelection().getRangeAt(0));
        return { selected, restored: view.readRange(view.restoreRange(selected.anchor)) };
      });
      assert.equal(selected.selected.sourceText, snippet);
      assert.deepEqual(selected.restored, selected.selected);
    }
    const result = await page.evaluate(() => {
      const view = annotationLab.view;
      const popup = view.element.querySelector('[data-annotation-popup]');
      const range = document.createRange(); range.selectNodeContents(popup.querySelector('pre'));
      const popupSelection = view.readRange(range);
      range.selectNodeContents(view.element);
      const all = view.readRange(range);
      return { popupSelection, all, selectable: getComputedStyle(popup).userSelect, directLinks: view.element.querySelectorAll('a[href]').length, popupText: popup.textContent, cursor: getComputedStyle(view.element.querySelector('a')).cursor };
    });
    assert.equal(result.popupSelection, null);
    assert.equal(result.selectable, 'text');
    assert.equal(result.directLinks, 3);
    assert.equal(result.cursor, 'text');
    assert.equal(result.popupText, '連結原始碼' + snippets[2]);
    assert.equal(result.all.quote, '前标签与水与外链后');
    assert.equal(result.all.sourceText, '前' + snippets.join('与') + '后');
    await page.keyboard.press('Escape');
    assert.equal(await popup.isVisible(), false);
    await links.first().focus();
    assert.equal(await popup.isVisible(), true);
    assert.equal(await popup.locator('pre').textContent(), snippets[0]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    assert.equal(await popup.isVisible(), true);
    assert.equal(page.url(), url);
    const restored = await page.evaluate(() => {
      const selected = annotationLab.view.readRange(getSelection().getRangeAt(0));
      const view = annotationLab.render('前[[页面|标签]]与{{tsl|en|Water|水}}与[https://example.org 外链]后');
      return view.readRange(view.restoreRange(selected.anchor));
    });
    assert.equal(restored.sourceText, snippets[0]);
  });
});

test('dragging part of a link keeps fine-grained text selection instead of selecting the whole invocation', async () => {
  await inPage(async page => {
    await page.evaluate(() => annotationLab.render('前[[目标页面|一段可以局部选取的链接文字]]后'));
    const bounds = await page.evaluate(() => {
      const node = annotationLab.view.element.querySelector('a [data-source-run]').firstChild;
      const from = node.data.indexOf('局部选取');
      const first = document.createRange(); first.setStart(node, from); first.setEnd(node, from + 1);
      const last = document.createRange(); last.setStart(node, from + 3); last.setEnd(node, from + 4);
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
      return { x1: a.left + 1, x2: b.right - 1, y: a.top + a.height / 2 };
    });
    await page.mouse.move(bounds.x1, bounds.y); await page.mouse.down();
    await page.mouse.move(bounds.x2, bounds.y, { steps: 8 }); await page.mouse.up();
    const selected = await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0)));
    assert.equal(selected.quote, '局部选取');
    assert.equal(selected.sourceText, '局部选取');
  });
});

test('reference popups expose original code while markers restore the complete reference span', async () => {
  await inPage(async page => {
    const refs = ['<ref>匿名内容</ref>', '<ref name="named">命名内容</ref>', '<ref name="named"/>'];
    await page.evaluate(refs => annotationLab.render(`前${refs[0]}。<references>${refs[1]}</references>\n\n{{reflist|refs=${refs[2]}}}`), refs);
    const markers = page.locator('#view [data-inspect="reference"]');
    assert.deepEqual(await markers.allTextContents(), ['[1]', '[named]', '[named]']);
    for (const [index, source] of refs.entries()) {
      await markers.nth(index).hover();
      assert.equal(await page.locator('[data-annotation-popup] pre').textContent(), source);
      await markers.nth(index).click();
      const selected = await page.evaluate(() => {
        const view = annotationLab.view;
        const selected = view.readRange(getSelection().getRangeAt(0));
        return { selected, restored: view.readRange(view.restoreRange(selected.anchor)) };
      });
      assert.equal(selected.selected.sourceText, source);
      assert.deepEqual(selected.restored, selected.selected);
    }
    await markers.first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0)).sourceText), refs[0]);
    const result = await page.evaluate(() => {
      const view = annotationLab.view;
      const marker = view.element.querySelector('[data-inspect="reference"]');
      const range = document.createRange(); range.selectNodeContents(marker);
      const selected = view.readRange(range);
      return { selected, restored: view.readRange(view.restoreRange(selected.anchor)) };
    });
    assert.equal(result.selected.quote, '[1]');
    assert.equal(result.selected.sourceText, refs[0]);
    assert.deepEqual(result.restored, result.selected);
  });
});

test('line breaks between adjacent references collapse visually without changing source or intervening prose', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '{{reflist|refs=<ref name=a>A</ref>\n\n<ref name=b>B</ref>\nBetween refs\n<ref name=c>C</ref>}}';
      const view = annotationLab.render(source);
      const refs = [...view.element.querySelectorAll('[data-inspect="reference"]')];
      const gap = refs[0].nextElementSibling;
      const prose = refs[1].nextElementSibling;
      const range = document.createRange(); range.selectNodeContents(refs[1]);
      const selected = view.readRange(range);
      const encoder = new TextEncoder();
      const start = source.indexOf('<ref name=b>');
      const end = start + '<ref name=b>B</ref>'.length;
      const holder = document.createElement('div'); holder.innerHTML = annotationLab.annotation.renderToHtml(view.projection);
      return {
        source: view.projection.source, expectedSource: source,
        sameLine: Math.abs(refs[0].getBoundingClientRect().top - refs[1].getBoundingClientRect().top) < 1,
        gapText: gap.textContent, gapDisplay: getComputedStyle(gap).display, gapHeight: gap.getBoundingClientRect().height,
        prose: prose.textContent, proseCompacted: prose.hasAttribute('data-reference-gap'),
        selected, expected: { unit: 'utf8-byte', start: encoder.encode(source.slice(0, start)).length, end: encoder.encode(source.slice(0, end)).length },
        restored: view.readRange(view.restoreRange(selected.anchor)), serializedGap: holder.querySelector('[data-reference-gap]')?.textContent,
      };
    });
    assert.equal(result.source, result.expectedSource);
    assert.equal(result.sameLine, true);
    assert.equal(result.gapText, '\n\n');
    assert.equal(result.gapDisplay, 'inline-block');
    assert.equal(result.gapHeight, 0);
    assert.equal(result.prose, '\nBetween refs\n');
    assert.equal(result.proseCompacted, false);
    assert.equal(result.serializedGap, result.gapText);
    assert.deepEqual(result.selected.anchor, result.expected);
    assert.deepEqual(result.restored, result.selected);
  });
});

test('r template groups share reference popups, full-selection behavior and source restoration', async () => {
  await inPage(async page => {
    const templates = ['{{r|黄龙篇}}', '{{r|大众标准化|谢富来|page2=5–12}}'];
    await page.evaluate(templates => annotationLab.render(`文字😀${templates[0]}${templates[1]}<ref name=原有>定义</ref>尾`), templates);
    const markers = page.locator('#view [data-inspect="reference"]');
    assert.deepEqual(await markers.allTextContents(), ['[黄龙篇]', '[大众标准化][谢富来]:5–12', '[原有]']);
    for (let index = 0; index < templates.length; index++) {
      await markers.nth(index).hover();
      assert.equal(await page.locator('[data-annotation-popup] pre').textContent(), templates[index]);
      await markers.nth(index).click();
      const result = await page.evaluate(() => {
        const view = annotationLab.view;
        const selected = view.readRange(getSelection().getRangeAt(0));
        const popup = view.element.querySelector('[data-annotation-popup]');
        const range = document.createRange(); range.selectNodeContents(popup.querySelector('pre'));
        return { selected, restored: view.readRange(view.restoreRange(selected.anchor)), popupSelection: view.readRange(range), popupSelectable: getComputedStyle(popup).userSelect };
      });
      assert.equal(result.selected.sourceText, templates[index]);
      assert.deepEqual(result.restored, result.selected);
      assert.equal(result.popupSelection, null);
      assert.equal(result.popupSelectable, 'text');
    }
    await markers.first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0)).sourceText), templates[0]);
    const partial = await page.evaluate(() => {
      const view = annotationLab.view;
      const text = view.element.querySelectorAll('[data-inspect="reference"]')[1].firstChild.firstChild;
      const range = document.createRange(); range.setStart(text, 8); range.setEnd(text, 11);
      const selected = view.readRange(range);
      const source = view.projection.source;
      annotationLab.render(source);
      return { selected, restored: annotationLab.view.readRange(annotationLab.view.restoreRange(selected.anchor)) };
    });
    assert.equal(partial.selected.sourceText, templates[1]);
    assert.equal(partial.selected.adjusted, true);
    assert.equal(partial.restored.sourceText, templates[1]);
    assert.deepEqual(partial.restored.anchor, partial.selected.anchor);
  });
});

test('rp and sfn aliases use superscript source popups with complete keyboard and click selection', async () => {
  await inPage(async page => {
    const sources = ['{{r|书}}', '{{Page|8, 31}}', '{{Shortened_footnote_template|Smith|2006|p=25}}', '{{RP|at=书脊}}'];
    await page.evaluate(sources => annotationLab.render('原文' + sources.join('') + '尾'), sources);
    const markers = page.locator('#view [data-inspect="reference"]');
    assert.deepEqual(await markers.allTextContents(), ['[书]', ':8, 31', '[Smith 2006:25]', ':书脊']);
    for (let i = 0; i < sources.length; i++) {
      const trigger = markers.nth(i);
      await trigger.focus();
      await page.keyboard.press(i % 2 ? ' ' : 'Enter');
      const result = await page.evaluate(() => {
        const view = annotationLab.view;
        const selected = view.readRange(getSelection().getRangeAt(0));
        const node = document.activeElement;
        return { selected, restored: view.readRange(view.restoreRange(selected.anchor)), source: view.element.querySelector('[data-annotation-popup] pre').textContent, cursor: getComputedStyle(node).cursor, tag: node.tagName, verticalAlign: getComputedStyle(node).verticalAlign };
      });
      assert.equal(result.source, sources[i]);
      assert.equal(result.selected.sourceText, sources[i]);
      assert.deepEqual(result.restored, result.selected);
      assert.equal(result.tag, 'SUP');
      assert.equal(result.cursor, 'text');
      await page.keyboard.press('Escape');
      await trigger.click();
      assert.equal(await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0)).sourceText), sources[i]);
    }
  });
});

test('source containers and code use monospace, including parsed table contents', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = "<code>inline()</code> {{例|text='''bold'''}}\n\n{|\n| [[页|标签]] || '''重点'''<ref name=r>引用</ref>\n|}\n\n<syntaxhighlight>code\nblock</syntaxhighlight>";
      const view = annotationLab.render(source);
      const table = view.element.querySelector('[data-source-kind="table"]');
      const fonts = [...view.element.querySelectorAll('code, pre, [data-template], [data-source-kind], [data-template] strong, [data-source-kind] strong, [data-source-kind] a')].map(node => getComputedStyle(node).fontFamily);
      const range = document.createRange(); range.selectNodeContents(table.querySelector('a'));
      const selected = view.readRange(range);
      return { fonts, tableText: table.textContent, selected, restored: view.readRange(view.restoreRange(selected.anchor)) };
    });
    assert.ok(result.fonts.length >= 7);
    assert.ok(result.fonts.every(font => font.includes('monospace')));
    assert.equal(result.tableText, '{|\n| 标签 || 重点[r]\n|}');
    assert.equal(result.selected.sourceText, '标签');
    assert.deepEqual(result.restored, result.selected);
  });
});

test('semantic formatting, HTML lists and literal pre blocks render safely with exact selections', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '<small>Small</small><u>Under</u><del>Old</del><ins>New</ins>\n\n<ol start="3"><li>First</li><li value="7">Second</li></ol>\n\n<blockquote>One\n\nTwo [[页|标签]]</blockquote>\n\n<pre style="color:red; background-image:url(/bad)" onclick="window.executed=1">literal &amp;</pre>\n\n<span style="font-size:smaller">[[不解析]]</span>\n\n<div>[[不解析]]</div>\n\n----';
      const view = annotationLab.render(source);
      const range = document.createRange(); range.selectNodeContents(view.element.querySelector('blockquote a'));
      const selected = view.readRange(range);
      const pre = view.element.querySelector('pre:not([data-raw-kind])');
      const serialized = document.createElement('div'); serialized.innerHTML = annotationLab.annotation.renderToHtml(view.projection);
      return {
        selected, restored: view.readRange(view.restoreRange(selected.anchor)),
        tags: ['small', 'u', 'del', 'ins', 'blockquote', 'hr'].every(tag => !!view.element.querySelector(tag)),
        start: view.element.querySelector('ol').start, second: view.element.querySelectorAll('li')[1].value,
        preText: pre.textContent, preColor: getComputedStyle(pre).color, executable: pre.hasAttribute('onclick'), background: pre.style.backgroundImage,
        raw: [...view.element.querySelectorAll('[data-raw-kind]')].map(node => node.textContent),
        serializedText: serialized.textContent, domText: view.element.textContent,
      };
    });
    assert.equal(result.tags, true);
    assert.equal(result.start, 3); assert.equal(result.second, 7);
    assert.equal(result.preText, 'literal &');
    assert.equal(result.preColor, 'rgb(255, 0, 0)');
    assert.equal(result.executable, false); assert.equal(result.background, '');
    assert.equal(result.selected.sourceText, '标签');
    assert.deepEqual(result.restored, result.selected);
    assert.deepEqual(result.raw, ['<span style="font-size:smaller">[[不解析]]</span>', '<div>[[不解析]]</div>']);
    assert.equal(result.serializedText, result.domText);
  });
});

test('numbered and bare external links use source popups and whole-slice click selection', async () => {
  await inPage(async page => {
    const snippets = ['[https://example.org]', 'https://example.org/path', '[mailto:a@example.org Email]'];
    await page.evaluate(source => annotationLab.render(source), snippets.join(' 与 '));
    const links = page.locator('#view [data-inspect="link"]');
    assert.deepEqual(await links.allTextContents(), ['[1]', 'https://example.org/path', 'Email']);
    for (const [index, source] of snippets.entries()) {
      await links.nth(index).click();
      const result = await page.evaluate(() => {
        const view = annotationLab.view;
        const selected = view.readRange(getSelection().getRangeAt(0));
        return { selected, restored: view.readRange(view.restoreRange(selected.anchor)), popup: view.element.querySelector('[data-annotation-popup] pre').textContent };
      });
      assert.equal(result.selected.sourceText, source);
      assert.equal(result.popup, source);
      assert.deepEqual(result.restored, result.selected);
    }
  });
});

test('long source popups stay within a narrow viewport and clean up when the view is replaced', async () => {
  await inPage(async page => {
    await page.setViewportSize({ width: 390, height: 844 });
    const source = '<ref name=long>' + 'a long literal line & <script>window.executed=1</script> '.repeat(60) + '</ref>';
    await page.evaluate(source => annotationLab.render(source), source);
    await page.locator('#view [data-inspect="reference"]').click();
    const result = await page.evaluate(() => {
      const popup = annotationLab.view.element.querySelector('[data-annotation-popup]');
      const box = popup.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, scrollable: popup.scrollHeight > popup.clientHeight, scripts: popup.querySelectorAll('script').length, executed: Boolean(window.executed), overflow: document.documentElement.scrollWidth > innerWidth, source: popup.querySelector('pre').textContent };
    });
    assert.ok(result.left >= 0 && result.right <= result.width);
    assert.ok(result.top >= 0 && result.bottom <= result.height);
    assert.equal(result.scrollable, true);
    assert.equal(result.overflow, false);
    assert.equal(result.scripts, 0);
    assert.equal(result.executed, false);
    assert.equal(result.source, source);
    await page.evaluate(() => annotationLab.view.destroy());
    assert.equal(await page.locator('[data-annotation-popup]').count(), 0);
    await page.locator('#view [data-inspect="reference"]').focus();
    assert.equal(await page.locator('[data-annotation-popup]').count(), 0);
    await page.evaluate(() => annotationLab.render('新的视图'));
    assert.equal(await page.locator('[data-annotation-popup]').count(), 0);
  });
});

test('file invocations inside templates reuse images with independently selectable source code', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '{{例\n|first=[[File:A.png|thumb|甲]]\n|second={{内|[[File:A.png|thumb|乙]]}}\n|literal=<nowiki>[[File:A.png]]</nowiki>\n}}';
      const view = annotationLab.render(source, '<a href="/wiki/File:A.png"><img src="/fixture.png"></a>');
      const imageCodes = [...view.element.querySelectorAll('[data-inspect="image"]')].map(code => {
        const range = document.createRange(); range.selectNodeContents(code);
        const selected = view.readRange(range);
        const restored = view.readRange(view.restoreRange(selected.anchor));
        return { selected, restored };
      });
      const holder = document.createElement('div'); holder.innerHTML = annotationLab.annotation.renderToHtml(view.projection);
      return { imageCodes, imageCount: view.element.querySelectorAll('[data-inspect="image"]').length, inlineImages: view.element.querySelectorAll('img').length, text: view.element.textContent, serializedText: holder.textContent, invalidNesting: !!view.element.querySelector('p pre, span pre') };
    });
    assert.equal(result.imageCount, 2);
    assert.equal(result.inlineImages, 0);
    assert.equal(result.invalidNesting, false);
    assert.equal(result.text, result.serializedText);
    assert.deepEqual(result.imageCodes.map(code => code.selected.sourceText), ['[[File:A.png|thumb|甲]]', '[[File:A.png|thumb|乙]]']);
    for (const code of result.imageCodes) {
      assert.deepEqual(code.restored, code.selected);
    }
    for (let index = 0; index < 2; index++) {
      await page.locator('[data-inspect="image"]').nth(index).hover();
      assert.equal(await page.locator('[data-annotation-popup] img').count(), 1);
      await page.keyboard.press('Escape');
    }
  });
});

test('formatted file captions preserve selection and give nested links and references their own popups', async () => {
  await inPage(async page => {
    const source = "前[[File:A.png|thumb|alt=[[Raw|alt]]|说明 '''强调''' [[页面|标签]]<ref name=r>{{cite|x=a|y=b}}</ref>|right]]后";
    await page.evaluate(source => annotationLab.render(source, '<a href="/wiki/File:A.png"><img src="/fixture.png" width="80"></a>'), source);
    const caption = page.locator('[data-file-caption]');
    assert.equal(await caption.textContent(), '说明 强调 标签[r]');
    const selected = await page.evaluate(() => {
      const view = annotationLab.view;
      const range = document.createRange();
      range.setStart(view.element.querySelector('[data-file-caption] strong span').firstChild, 0);
      range.setEnd(view.element.querySelector('[data-file-caption] a span').firstChild, 2);
      const selected = view.readRange(range);
      return { selected, restored: view.readRange(view.restoreRange(selected.anchor)) };
    });
    assert.equal(selected.selected.quote, '强调 标签');
    assert.equal(selected.selected.sourceText, "强调''' [[页面|标签");
    assert.deepEqual(selected.restored, selected.selected);
    await caption.locator('[data-inspect="link"]').click();
    assert.equal(await page.locator('[data-annotation-popup] pre').textContent(), '[[页面|标签]]');
    assert.equal(await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0)).sourceText), '[[页面|标签]]');
    await page.keyboard.press('Escape');
    await caption.locator('[data-inspect="reference"]').click();
    assert.equal(await page.locator('[data-annotation-popup] pre').textContent(), '<ref name=r>{{cite|x=a|y=b}}</ref>');
    assert.equal(await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0)).sourceText), '<ref name=r>{{cite|x=a|y=b}}</ref>');
    await page.keyboard.press('Escape');
    await page.locator('[data-inspect="image"] > [data-source-run]').first().click();
    assert.equal(await page.locator('[data-annotation-popup] img').count(), 1);
    assert.equal(await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0)).sourceText), source.slice(1, -1));
    const remounted = await page.evaluate(({ source, anchor }) => {
      const view = annotationLab.render(source);
      return view.readRange(view.restoreRange(anchor));
    }, { source, anchor: selected.selected.anchor });
    assert.deepEqual(remounted, selected.selected);
  });
});

test('both conversion-branch files have preview triggers with or without supplied images', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '-{|zh-hans:[[File:A.svg|thumb|甲[[页|标签]]]];zh-hant:[[File:B.svg|thumb|乙[[頁|標籤]]]]}-';
      const first = '<a href="/wiki/File:A.svg"><img src="/fixture.png?a"></a>';
      let view = annotationLab.render(source, first);
      const one = { files: view.element.querySelectorAll('[data-raw-kind="file"]').length, previews: view.element.querySelectorAll('[data-inspect="image"]').length, text: view.projection.text };
      const secondCaption = view.element.querySelectorAll('[data-file-caption]')[1];
      const range = document.createRange(); range.selectNodeContents(secondCaption.querySelector('a'));
      const selected = view.readRange(range);
      view = annotationLab.render(source, first + '<a href="/wiki/File:B.svg"><img src="/fixture.png?b"></a>');
      return { one, previews: view.element.querySelectorAll('[data-inspect="image"]').length, text: view.projection.text, selected, restored: view.readRange(view.restoreRange(selected.anchor)) };
    });
    assert.equal(result.one.files, 2); assert.equal(result.one.previews, 2);
    assert.equal(result.previews, 2);
    assert.equal(result.one.text, result.text);
    assert.equal(result.selected.sourceText, '標籤');
    assert.deepEqual(result.restored, result.selected);
  });
});

test('serializing and reparsing the HTML preserves raw CRLF without executing source markup', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '<script>window.executed=1</script>\r\n\r\n{|\r\n|甲\r\n|}';
      const model = annotationLab.annotation.createProjection(source);
      const html = annotationLab.annotation.renderToHtml(model);
      const holder = document.createElement('div'); holder.innerHTML = html; document.body.append(holder);
      return { raw: holder.querySelector('[data-source-kind="table"]').textContent, scriptCount: holder.querySelectorAll('script').length, executed: Boolean(window.executed) };
    });
    assert.equal(result.raw, '{|\r\n|甲\r\n|}');
    assert.equal(result.scriptCount, 0);
    assert.equal(result.executed, false);
  });
});

test('file source stays inline and the popup image is excluded from annotation coordinates', async () => {
  await inPage(async page => {
    const requests = [];
    page.on('request', request => { if (request.url().includes('image-hover-test')) requests.push(request.url()); });
    const before = await page.evaluate(() => {
      const source = '前[[File:Example image.png|thumb|来源说明]]后';
      const html = '<figure><a href="/wiki/File:Example_image.png"><img src="/fixture.png?image-hover-test" width="80" height="40" class="cached-image" alt="Existing description" onload="window.executed=1"></a><figcaption>Unrelated caption</figcaption></figure>';
      const view = annotationLab.render(source, html);
      const code = view.element.querySelector('[data-inspect="image"]');
      return { text: view.projection.text, domText: view.element.textContent, tag: code.tagName, parent: code.parentElement.tagName, display: getComputedStyle(code).display, decoration: getComputedStyle(code).textDecorationStyle, images: view.element.querySelectorAll('img').length, frames: view.element.querySelectorAll('figure,pre').length };
    });
    assert.equal(before.text, '前[[File:Example image.png|thumb|来源说明]]后');
    assert.equal(before.domText, before.text);
    assert.equal(before.tag, 'CODE'); assert.equal(before.parent, 'P');
    assert.equal(before.display, 'inline'); assert.equal(before.decoration, 'dotted');
    assert.equal(before.images, 0); assert.equal(before.frames, 0);
    assert.equal(requests.length, 0);
    await page.locator('[data-inspect="image"]').hover();
    await page.waitForFunction(() => document.querySelector('[data-annotation-popup] img')?.complete);
    const result = await page.evaluate(() => {
      const view = annotationLab.view;
      const image = view.element.querySelector('[data-annotation-popup] img');
      const wrapper = view.element.querySelector('[data-annotation-image]');
      const range = document.createRange(); range.selectNode(wrapper);
      const imageSelection = view.readRange(range);
      range.selectNode(image);
      const innerImageSelection = view.readRange(range);
      range.selectNodeContents(wrapper);
      const imageContentsSelection = view.readRange(range);
      const code = view.element.querySelector('[data-raw-kind="file"]');
      range.selectNodeContents(code);
      const selection = view.readRange(range);
      return {
        count: view.element.querySelectorAll('img').length, src: image.getAttribute('src'), width: image.getAttribute('width'), className: image.className,
        handlers: image.hasAttribute('onload'), rawFiles: view.element.querySelectorAll('[data-raw-kind="file"]').length,
        captionCopied: view.element.textContent.includes('Unrelated caption'), selection,
        imageSelection, innerImageSelection, imageContentsSelection,
        selectable: getComputedStyle(wrapper).userSelect, draggable: image.draggable,
        restored: view.readRange(view.restoreRange(selection.anchor)), modelSource: view.projection.source,
      };
    });
    assert.equal(result.count, 1);
    assert.equal(result.src, server.url + '/fixture.png?image-hover-test');
    assert.equal(result.width, '80');
    assert.equal(result.className, 'cached-image');
    assert.equal(result.handlers, false);
    assert.equal(result.rawFiles, 1);
    assert.equal(result.captionCopied, false);
    assert.equal(result.imageSelection, null);
    assert.equal(result.innerImageSelection, null);
    assert.equal(result.imageContentsSelection, null);
    assert.equal(result.selectable, 'text');
    assert.equal(result.draggable, true);
    assert.equal(result.selection.sourceText, '[[File:Example image.png|thumb|来源说明]]');
    assert.equal(result.selection.quote, '[[File:Example image.png|thumb|来源说明]]');
    assert.deepEqual(result.restored, result.selection);
    assert.equal(requests.length, 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-annotation-popup]').isVisible(), false);
  });
});

test('missing, ambiguous and unsafe supplied images retain source and receive lookup triggers', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '[[File:A.png|thumb]]';
      const candidates = [
        '<a href="/wiki/File:B.png"><img src="/fixture.png"></a>',
        '<a href="/wiki/File:A.png"><img src="/fixture.png" width="20"><img src="/fixture.png" width="80"></a>',
        '<a href="/wiki/File:A.png"><img src="javascript:alert(1)"></a>',
        '<a href="/wiki/File:A.png"><img resource="./File:B.png" src="/fixture.png"></a>',
        '<a href="/wiki/File:A.png"><img src="https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/B.png/250px-B.png"></a>',
        '<img src="/unidentified.png">',
      ];
      return candidates.map(html => {
        const view = annotationLab.render(source, html);
        return { images: view.element.querySelectorAll('[data-inspect="image"]').length, raw: view.element.querySelector('[data-raw-kind="file"]')?.textContent };
      });
    });
    for (const item of result) { assert.equal(item.images, 1); assert.equal(item.raw, '[[File:A.png|thumb]]'); }
  });
});

test('missing image popups lazily query 250px thumbnails and cache filename aliases across occurrences', async () => {
  await inPage(async page => {
    const requests = [];
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    await page.route('https://zh.wikipedia.org/w/api.php?*', async route => {
      requests.push(new URL(route.request().url()));
      await ready;
      await route.fulfill({ json: { query: {
        normalized: [{ from: 'File:a image.svg', to: 'File:A image.svg' }],
        redirects: [{ from: 'File:A image.svg', to: 'File:Final.svg' }],
        pages: [{ title: 'File:Final.svg', missing: true, imagerepository: 'shared', imageinfo: [{ thumburl: 'https://thumb.wikimedia.org/250px-test.png', thumbwidth: 250, thumbheight: 134 }] }],
      } }, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.route('https://thumb.wikimedia.org/250px-test.png', async route => route.fulfill({ response: await page.request.get(server.url + '/fixture.png') }));
    await page.evaluate(() => annotationLab.render('前[[File:a_image.svg|thumb|甲]]后\n[[File:a image.svg|乙]]'));
    assert.equal(requests.length, 0);
    assert.equal(await page.locator('[data-annotation-popup]').count(), 0);
    const request = page.waitForRequest('https://zh.wikipedia.org/w/api.php?*');
    await page.locator('[data-inspect="image"]').first().focus();
    await request;
    assert.equal(await page.locator('[data-annotation-popup]').isVisible(), true);
    assert.equal(await page.locator('[data-annotation-image]').textContent(), '正在載入圖片…');
    await page.locator('[data-inspect="image"]').last().focus();
    release();
    await page.waitForFunction(() => document.querySelector('[data-annotation-popup] img')?.naturalWidth > 0);
    const image = page.locator('[data-annotation-popup] img');
    assert.equal(await image.getAttribute('width'), '250');
    assert.equal(await image.getAttribute('height'), '134');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('iiurlwidth'), '250');
    assert.equal(requests[0].searchParams.get('titles'), 'File:a image.svg');
    assert.equal(requests[0].searchParams.get('origin'), '*');
    await page.keyboard.press('Enter');
    const selected = await page.evaluate(() => {
      const view = annotationLab.view;
      const selected = view.readRange(getSelection().getRangeAt(0));
      const range = document.createRange(); range.selectNode(view.element.querySelector('[data-annotation-popup] img'));
      return { selected, restored: view.readRange(view.restoreRange(selected.anchor)), imageSelection: view.readRange(range) };
    });
    assert.equal(selected.selected.sourceText, '[[File:a image.svg|乙]]');
    assert.deepEqual(selected.restored, selected.selected);
    assert.equal(selected.imageSelection, null);
    await page.locator('[data-inspect="image"]').first().focus();
    await page.waitForFunction(() => document.querySelector('[data-annotation-popup] img')?.getAttribute('alt') === 'a_image.svg');
    assert.equal(requests.length, 1);
  });
});

test('nearby thumbnail lookups are batched and a late result cannot overwrite a link popup', async () => {
  await inPage(async page => {
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    const requests = [];
    await page.route('https://zh.wikipedia.org/w/api.php?*', async route => {
      requests.push(new URL(route.request().url()));
      await ready;
      await route.fulfill({ json: { query: { pages: ['A.svg', 'B.svg'].map(name => ({ title: 'File:' + name, imageinfo: [{ thumburl: 'https://thumb.wikimedia.org/' + name + '.png', thumbwidth: 250, thumbheight: 80 }] })) } }, headers: { 'access-control-allow-origin': '*' } });
    });
    const lookup = page.waitForResponse('https://zh.wikipedia.org/w/api.php?*');
    await page.evaluate(() => {
      const view = annotationLab.render('[[File:A.svg|甲]][[File:B.svg|乙]][[Page|页]]');
      for (const trigger of view.element.querySelectorAll('[data-inspect]')) trigger.focus();
    });
    release();
    await (await lookup).finished();
    // Reopening B uses the completed batch, while leaving A unused.
    assert.equal(await page.locator('[data-annotation-popup] pre').textContent(), '[[Page|页]]');
    assert.equal(await page.locator('[data-annotation-popup] img').count(), 0);
    await page.route('https://thumb.wikimedia.org/B.svg.png', async route => route.fulfill({ response: await page.request.get(server.url + '/fixture.png') }));
    await page.locator('[data-inspect="image"]').last().focus();
    await page.waitForFunction(() => document.querySelector('[data-annotation-popup] img')?.naturalWidth > 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('titles'), 'File:A.svg|File:B.svg');
    await page.evaluate(() => annotationLab.view.destroy());
    assert.equal(await page.locator('[data-annotation-popup]').count(), 0);
  });
});

test('unavailable thumbnails keep an accessible popup and never mount unsafe URLs', async () => {
  await inPage(async page => {
    let requests = 0;
    await page.route('https://zh.wikipedia.org/w/api.php?*', async route => {
      requests++;
      const title = new URL(route.request().url()).searchParams.get('titles');
      if (title === 'File:Error.svg') { await route.fulfill({ status: 503, body: 'Unavailable', headers: { 'access-control-allow-origin': '*' } }); return; }
      await route.fulfill({ json: { query: { pages: [{ title, ...(title === 'File:Unsafe.svg' ? { imageinfo: [{ thumburl: 'javascript:alert(1)', thumbwidth: 250, thumbheight: 60 }] } : {}) }] } }, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.evaluate(() => annotationLab.render('[[File:Missing.svg]][[File:Unsafe.svg]][[File:Error.svg]]'));
    for (let index = 0; index < 3; index++) {
      const trigger = page.locator('[data-inspect="image"]').nth(index);
      await trigger.focus();
      await page.waitForFunction(() => document.querySelector('[data-annotation-image]')?.textContent === '無法載入圖片預覽。');
      assert.equal(await page.locator('[data-annotation-popup]').isVisible(), true);
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('[data-annotation-popup] img').count(), 0);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => annotationLab.view.readRange(getSelection().getRangeAt(0)).sourceText), `[[File:${['Missing', 'Unsafe', 'Error'][index]}.svg]]`);
    }
    assert.equal(requests, 3);
  });
});

test('destroying a view cancels a pending thumbnail lookup and prevents popup resurrection', async () => {
  await inPage(async page => {
    await page.route('https://zh.wikipedia.org/w/api.php?*', () => {});
    await page.evaluate(() => annotationLab.render('[[File:Pending.svg]]'));
    const request = page.waitForRequest('https://zh.wikipedia.org/w/api.php?*');
    await page.locator('[data-inspect="image"]').focus();
    const started = await request;
    const failed = page.waitForEvent('requestfailed', event => event === started);
    await page.evaluate(() => annotationLab.view.destroy());
    await failed;
    assert.equal(await page.locator('[data-annotation-popup]').count(), 0);
    await page.locator('[data-inspect="image"]').click();
    assert.equal(await page.locator('[data-annotation-popup]').count(), 0);
  });
});

test('a narrow code annotation restores unchanged when an image becomes available', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '[[File:A.png|thumb|caption]]';
      let view = annotationLab.render(source);
      const start = view.projection.text.indexOf('caption');
      const selection = annotationLab.annotation.selectionFromView(view.projection, start, start + 7);
      view = annotationLab.render(source, '<a href="/wiki/File:A.png"><img src="/fixture.png"></a>');
      return { imageCount: view.element.querySelectorAll('[data-inspect="image"]').length, selection, restored: view.readRange(view.restoreRange(selection.anchor)) };
    });
    assert.equal(result.imageCount, 1);
    assert.equal(result.restored.quote, 'caption');
    assert.deepEqual(result.restored, result.selection);
  });
});

test('image availability does not change the projection, quotes or cross-block anchors', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '前文。\n\n[[File:A.png|thumb|caption]]\n\n后文。';
      const model = annotationLab.annotation.createProjection(source);
      const view = annotationLab.annotation.createAnnotationView(document, model, { referenceHtml: '<a href="/wiki/File:A.png"><img src="/fixture.png"></a>', referenceBaseUrl: location.origin + '/' });
      document.querySelector('#view').replaceChildren(view.element);
      const range = document.createRange(); range.selectNodeContents(view.element);
      const selection = view.readRange(range);
      return { sameModel: view.projection === model, text: model.text, selection, restored: view.readRange(view.restoreRange(selection.anchor)) };
    });
    assert.equal(result.sameModel, true);
    assert.equal(result.selection.quote, result.text);
    assert.equal(result.selection.sourceText, '前文。\n\n[[File:A.png|thumb|caption]]\n\n后文。');
    assert.deepEqual(result.restored, result.selection);
  });
});

test('interacting with an image popup preserves the selected source text', async () => {
  await inPage(async page => {
    await page.evaluate(() => {
      const view = annotationLab.render('[[File:A.png|caption]]', '<a href="/wiki/File:A.png"><img src="/fixture.png" width="80" height="40"></a>');
      const node = view.element.querySelector('[data-file-caption] [data-source-run]').firstChild;
      const range = document.createRange(); range.selectNodeContents(node);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.waitForFunction(() => document.querySelector('#quote').textContent === 'caption');
    await page.locator('[data-inspect="image"]').hover();
    await page.locator('[data-annotation-popup] img').evaluate(image => image.addEventListener('contextmenu', event => {
      window.imageContextMenu = { target: event.target.tagName, prevented: event.defaultPrevented };
      event.preventDefault(); // Observe the native image target without opening the OS menu in tests.
    }, { once: true }));
    await page.locator('[data-annotation-popup] img').click({ button: 'right' });
    assert.deepEqual(await page.evaluate(() => window.imageContextMenu), { target: 'IMG', prevented: false });
    await page.locator('[data-annotation-image]').click();
    assert.equal(await page.locator('#quote').textContent(), 'caption');
    assert.equal(await page.locator('#restore').isDisabled(), false);
  });
});

test('repeated identical image candidates are reusable and missing DOM nodes cannot receive restored ranges', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const html = '<a href="/wiki/File:A.png"><img src="/fixture.png" width="20"></a>';
      const view = annotationLab.render('[[File:A.png]]', html + html);
      const run = view.projection.runs[0];
      const selected = annotationLab.annotation.selectionFromView(view.projection, run.viewFrom, run.viewTo);
      const before = view.restoreRange(selected.anchor) !== null;
      view.element.replaceChildren();
      return { before, after: view.restoreRange(selected.anchor) === null };
    });
    assert.equal(result.before, true);
    assert.equal(result.after, true);
  });
});

test('source images match encoded/localized file names without requiring Parsoid attributes', async () => {
  await inPage(async page => {
    await page.evaluate(() => annotationLab.render('[[文件:測試 圖.png]]', '<a href="/wiki/File:%E6%B8%AC%E8%A9%A6_%E5%9C%96.png"><img src="/fixture.png" srcset="/fixture.png 1x, /fixture.png?large 2x"></a>'));
    await page.locator('[data-inspect="image"]').hover();
    const result = await page.evaluate(() => {
      const view = annotationLab.view;
      const image = view.element.querySelector('img');
      return { count: view.element.querySelectorAll('img').length, srcset: image?.getAttribute('srcset') };
    });
    assert.equal(result.count, 1);
    assert.equal(result.srcset, `${server.url}/fixture.png 1x, ${server.url}/fixture.png?large 2x`);
  });
});

test('supplied tables and scripts have no reuse path', async () => {
  await inPage(async page => {
    const result = await page.evaluate(() => {
      const source = '{|\n| original\n|}\n\n<math>x</math>';
      const view = annotationLab.render(source, '<table><tr><td>Rendered table</td></tr></table><script>window.executed=1</script><iframe src="/bad"></iframe>');
      return { raw: [...view.element.querySelectorAll('[data-source-kind="table"], [data-raw-kind]')].map(n => n.textContent), tables: view.element.querySelectorAll('table').length, scripts: view.element.querySelectorAll('script,iframe').length, executed: Boolean(window.executed) };
    });
    assert.deepEqual(result.raw, ['{|\n| original\n|}', '<math>x</math>']);
    assert.equal(result.tables, 0); assert.equal(result.scripts, 0); assert.equal(result.executed, false);
  });
});

test('real mouse dragging inside a long paragraph selects a sentence without rewriting the DOM', async () => {
  await inPage(async page => {
    const expected = '第二句可以單獨批註。';
    await page.evaluate(() => annotationLab.render('第一句是背景。第二句可以單獨批註。第三句保留在同一段落。'));
    const bounds = await page.evaluate(target => {
      const node = annotationLab.view.element.querySelector('p span').firstChild;
      const from = node.data.indexOf(target);
      const start = document.createRange(); start.setStart(node, from); start.setEnd(node, from + 1);
      const end = document.createRange(); end.setStart(node, from + target.length - 1); end.setEnd(node, from + target.length);
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect();
      window.originalRun = node;
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    }, expected);
    await page.mouse.move(bounds.x1, bounds.y1); await page.mouse.down();
    await page.mouse.move(bounds.x2, bounds.y2, { steps: 8 }); await page.mouse.up();
    const result = await page.evaluate(() => ({ selection: annotationLab.view.readRange(getSelection().getRangeAt(0)), stable: originalRun.isConnected && originalRun === annotationLab.view.element.querySelector('p span').firstChild }));
    assert.equal(result.selection.quote, expected);
    assert.equal(result.selection.sourceText, expected);
    assert.equal(result.stable, true);
  });
});
