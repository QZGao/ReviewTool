import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

let server, browser;
before(async () => {
  server = await startServer();
  browser = await chromium.launch({ headless: true, ...(existsSync('/Applications/Google Chrome.app') ? { channel: 'chrome' } : {}) });
});
after(async () => { await browser?.close(); await server?.close(); });

async function inPage(source, callback, renderOptions = {}, beforeRender) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
  try {
    await page.goto(server.url + '/lab');
    await page.waitForFunction(() => Boolean(window.annotationLab));
    await beforeRender?.(page);
    await page.evaluate(({ source, renderOptions }) => {
      const { annotation } = annotationLab;
      annotationLab.view.destroy();
      document.body.innerHTML = '<p id="outside">Outside selectable text</p><main id="test-content" style="margin:80px auto;max-width:600px"></main>';
      window.markerActions = [];
      window.markerSnapshots = [];
      window.markerView = annotation.createAnnotationView(document, annotation.createProjection(source), {
        referenceBaseUrl: location.origin + '/', commentAuthor: 'Example', ...renderOptions,
        highlighting: { onChange: (snapshot, action) => { markerSnapshots.push(snapshot); markerActions.push(action); } },
      });
      document.getElementById('test-content').append(markerView.element);
      window.originalRuns = [...markerView.element.querySelectorAll('[data-source-run]')].map(element => element.firstChild);
      window.markerAnchor = (from, to) => ({ unit: 'utf8-byte', start: new TextEncoder().encode(source.slice(0, from)).length, end: new TextEncoder().encode(source.slice(0, to)).length });
    }, { source, renderOptions });
    await callback(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
const toolbar = page => page.locator('[data-annotation-toolbar]');
const choose = (page, color) => toolbar(page).getByRole('button', { name: `${({ Red: '紅色', Yellow: '黃色', Green: '綠色', Blue: '藍色' })[color]}高亮`, exact: true }).click();

test('heading and paragraph symbols are distinct persistent targets that highlight only the symbol', async () => {
  const source = '== 標題 ==\n段落[[頁面|連結]]。\n\n* 項目一\n* 項目二';
  await inPage(source, async page => {
    const heading = page.locator('.annotation-document h2'), paragraph = page.locator('.annotation-document p').first();
    await heading.hover(); await heading.getByRole('button', { name: '批註整個標題' }).click();
    assert.equal(await page.evaluate(() => markerView.selection.sourceText), '== 標題 ==');
    const selected = await heading.locator('[data-block-target]').evaluate(el => {
      const style = getComputedStyle(el), box = el.getBoundingClientRect();
      return { width: box.width, height: box.height, background: style.backgroundColor, border: style.boxShadow };
    });
    assert.ok(selected.width >= 24 && selected.height >= 24);
    assert.notEqual(selected.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(selected.border, 'none');
    await choose(page, 'Yellow');
    await paragraph.hover(); await paragraph.getByRole('button', { name: '批註整個段落或區塊' }).click();
    assert.equal(await page.evaluate(() => markerView.selection.quote), '段落連結。');
    await choose(page, 'Blue');
    assert.deepEqual(await page.evaluate(() => markerView.highlighting.annotations.map(annotation => ({ target: annotation.anchor.target, painted: markerView.restoreRange(annotation.anchor).toString() }))), [{ target: 'block', painted: '#' }, { target: 'block', painted: '¶' }]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations.every(annotation => {
      const symbol = markerView.restoreRange(annotation.anchor).commonAncestorContainer;
      const box = symbol.getBoundingClientRect(), glyphRange = document.createRange(); glyphRange.selectNodeContents(symbol);
      const glyph = glyphRange.getBoundingClientRect();
      const painted = [...document.querySelectorAll('.annotation-highlight-backgrounds > g')].find(group => group.dataset.annotationMarker === annotation.id).firstElementChild;
      const rect = painted.getBoundingClientRect();
      return box.width >= 24 && box.height >= 24 && box.width > glyph.width
        && Math.abs(rect.left - box.left) < 1 && Math.abs(rect.top - box.top) < 1
        && Math.abs(rect.width - box.width) < 1 && Math.abs(rect.height - box.height) < 1 && painted.getAttribute('rx') === '4';
    })), true, 'both symbols paint their padded boxes rather than their glyphs');
    await page.mouse.move(0, 0);
    assert.equal(await paragraph.locator('[data-block-target]').evaluate(element => getComputedStyle(element).opacity), '1');
    const paddedCorner = await paragraph.locator('[data-block-target]').boundingBox();
    await page.mouse.move(paddedCorner.x + 3, paddedCorner.y + 3); await toolbar(page).waitFor({ state: 'visible' });
    assert.equal(await toolbar(page).getAttribute('aria-label'), '更改高亮顏色');
    await choose(page, 'Red');
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations.length), 2);
    const from = source.indexOf('段落'), to = source.indexOf('。') + 1;
    await select(page, from, to); await choose(page, 'Green');
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations.length), 3, 'the same extent may have separate text and block highlights');
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations[2].anchor.target), undefined);
    assert.equal(await page.evaluate(() => originalRuns.every(node => markerView.element.contains(node))), true);
    await page.evaluate(() => {
      const saved = markerView.highlighting.annotations, projection = markerView.projection;
      markerView.destroy(); markerView.element.remove();
      window.markerView = annotationLab.annotation.createAnnotationView(document, projection, { highlighting: { initial: saved }, commentAuthor: 'Example' });
      document.querySelector('#test-content').append(markerView.element);
    });
    assert.deepEqual(await page.evaluate(() => markerView.highlighting.annotations.slice(0, 2).map(annotation => markerView.restoreRange(annotation.anchor).toString())), ['#', '¶']);
  });
});
test('block symbols remain reachable beside scrolling code', async () => {
  await inPage(' ' + 'wide code '.repeat(60), async page => {
    const code = page.locator('.annotation-document pre').first();
    await code.evaluate(element => { element.style.whiteSpace = 'pre'; element.style.width = '160px'; });
    await code.hover();
    const symbol = page.locator('.annotation-block-target').first();
    assert.equal(await symbol.evaluate(element => {
      const box = element.getBoundingClientRect();
      return box.width >= 24 && box.height >= 24 && document.elementFromPoint(box.left + 3, box.top + 3) === element;
    }), true, 'the target is not clipped by the code scroller');
    await symbol.click(); await choose(page, 'Blue');
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations[0].anchor.target), 'block');
  });
});

async function separatePopups(page) {
  await toolbar(page).waitFor({ state: 'visible' });
  await page.locator('[data-annotation-popup]').waitFor({ state: 'visible' });
  const bar = await toolbar(page).boundingBox(), source = await page.locator('[data-annotation-popup]').boundingBox();
  const viewport = page.viewportSize();
  for (const box of [bar, source]) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'popup stays inside viewport');
  }
  assert.ok(bar.y + bar.height + 7 <= source.y || source.y + source.height + 7 <= bar.y
    || bar.x + bar.width + 7 <= source.x || source.x + source.width + 7 <= bar.x, 'popups have a gap and do not collide');
  return { bar, source };
}
async function select(page, from, to) {
  await page.evaluate(({ from, to }) => {
    const range = markerView.restoreRange(markerAnchor(from, to));
    if (!range) throw new Error('Test range cannot be restored.');
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }, { from, to });
  await toolbar(page).waitFor({ state: 'visible' });
}
async function hover(page, index = 0, offset = 0) {
  const point = await page.evaluate(({ index, offset }) => {
    const annotation = markerView.highlighting.annotations[index];
    const range = markerView.restoreRange(annotation.anchor);
    if (range.startContainer.nodeType === 3 && offset) {
      range.setStart(range.startContainer, range.startOffset + offset);
      range.setEnd(range.startContainer, range.startOffset + 1);
    }
    const rect = [...range.getClientRects()].find(rect => rect.width > 0);
    return { x: rect.left + Math.min(4, rect.width / 2), y: rect.top + rect.height / 2 };
  }, { index, offset });
  await page.mouse.move(5, 5); await page.mouse.move(point.x, point.y);
  await toolbar(page).waitFor({ state: 'visible' });
}

async function assertPaintedTextColors(page, screenshot, markers, description) {
  // Highlight currentColor resolves at painting time; its computed value alone
  // can report a parent's color rather than the color used for the glyphs.
  const painted = await page.evaluate(async ({ png, markers }) => {
    const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return markers.map(marker => {
      const rgb = marker.originalColor.match(/\d+/g).slice(0, 3).map(Number), box = marker.rect;
      // Exclude the underline so a surviving underline cannot mask recolored glyphs.
      const { data } = context.getImageData(Math.floor(box.x), Math.floor(box.y), Math.ceil(box.width), Math.max(1, Math.ceil(box.height) - 4));
      let matching = 0;
      for (let i = 0; i < data.length; i += 4) if (rgb.every((channel, index) => data[i + index] === channel)) matching++;
      return { text: marker.text, matching };
    });
  }, { png: screenshot.toString('base64'), markers });
  for (const marker of painted) assert.ok(marker.matching > 3, `${description}: ${marker.text} retains its painted text color`);
}

test('native drag opens the color bar; all four colors retain exact UTF-8 source anchors and text nodes', async () => {
  await inPage('甲🌏 red yellow green blue。', async page => {
    for (const color of ['Red', 'Yellow', 'Green', 'Blue']) {
      const bounds = await page.locator('[data-source-run]').first().evaluate((element, word) => {
        const text = element.firstChild, start = text.data.indexOf(word.toLowerCase());
        const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + word.length);
        const box = range.getBoundingClientRect();
        return { x: box.left, y: box.top + box.height / 2, right: box.right, start, end: start + word.length };
      }, color);
      await page.mouse.move(bounds.x + .5, bounds.y); await page.mouse.down();
      await page.mouse.move(bounds.right - .5, bounds.y, { steps: 8 }); await page.mouse.up();
      await toolbar(page).waitFor({ state: 'visible' });
      assert.equal(await toolbar(page).getAttribute('aria-label'), '高亮所選文字');
      assert.equal(await toolbar(page).getByRole('button', { name: '刪除高亮' }).isVisible(), false);
      await choose(page, color);
      const actual = await page.evaluate(({ start, end }) => ({
        saved: markerView.highlighting.annotations.at(-1), expected: markerAnchor(start, end), selection: markerView.selection,
        unchanged: originalRuns.every((node, index) => node === markerView.element.querySelectorAll('[data-source-run]')[index].firstChild),
      }), bounds);
      assert.deepEqual(actual.saved.anchor, actual.expected); assert.equal(actual.saved.color, color.toLowerCase());
      assert.equal(actual.selection, null); assert.equal(actual.unchanged, true);
    }
    assert.deepEqual(await page.evaluate(() => markerActions.map(action => action.type)), Array(4).fill('add-highlight'));
    assert.equal(await page.evaluate(() => markerSnapshots.every(snapshot => Object.isFrozen(snapshot) && snapshot.every(item => Object.isFrozen(item) && Object.isFrozen(item.anchor)))), true);
  });
});

test('hover permits recoloring and deletion, including crossing the gap to the bar', async () => {
  await inPage('Alpha Beta Gamma', async page => {
    await page.clock.setFixedTime('2026-09-24T08:00:00Z');
    await select(page, 0, 5); await choose(page, 'Red');
    const original = await page.evaluate(() => markerView.highlighting.annotations[0]);
    assert.equal(original.createdAt, '2026-09-24T08:00:00.000Z');
    assert.equal(original.editedAt, undefined); assert.equal(original.editedBy, undefined);
    await hover(page);
    assert.equal(await toolbar(page).getAttribute('aria-label'), '更改高亮顏色');
    assert.equal(await toolbar(page).getByRole('button', { name: '紅色高亮' }).getAttribute('aria-pressed'), 'true');
    const button = await toolbar(page).getByRole('button', { name: '綠色高亮' }).boundingBox();
    await page.mouse.move(button.x + 10, button.y + 10, { steps: 8 });
    await page.waitForTimeout(240);
    await page.clock.setFixedTime('2026-09-24T08:05:00Z');
    await choose(page, 'Green');
    const recolored = await page.evaluate(() => markerView.highlighting.annotations[0]);
    assert.deepEqual(recolored, { ...original, color: 'green', editedAt: '2026-09-24T08:05:00.000Z', editedBy: 'Example' });
    await page.clock.setFixedTime('2026-09-24T08:10:00Z');
    await hover(page); await choose(page, 'Green');
    assert.deepEqual(await page.evaluate(() => markerView.highlighting.annotations[0]), recolored, 'choosing the same color is not an edit');
    await hover(page);
    await toolbar(page).getByRole('button', { name: '刪除高亮' }).click();
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations[0].deleted.by), 'Example');
    assert.deepEqual(await page.evaluate(() => markerActions.map(action => action.type)), ['add-highlight', 'recolor-highlight', 'delete-highlight']);
    assert.equal(await page.locator('[data-annotation-marker]').count(), 0);
  });
});

test('legacy highlight dates stay unknown and malformed highlight metadata cannot replace a valid snapshot', async () => {
  await inPage('Alpha Beta Gamma', async page => {
    await page.evaluate(() => markerView.highlighting.replace([{ id: 'legacy', anchor: markerAnchor(0, 5), color: 'red', author: 'Original' }]));
    await page.clock.setFixedTime('2026-09-24T09:00:00Z');
    await hover(page); await choose(page, 'Blue');
    const stored = await page.evaluate(() => markerView.highlighting.annotations[0]);
    assert.equal(stored.createdAt, undefined); assert.equal(stored.author, 'Original');
    assert.equal(stored.editedAt, '2026-09-24T09:00:00.000Z'); assert.equal(stored.editedBy, 'Example');
    const rejected = await page.evaluate(() => {
      const state = markerView.highlighting, original = state.annotations;
      const replacements = [
        { createdAt: '2026-09-24T09:00:00' }, { createdAt: '2026-02-30T09:00:00Z' },
        { editedAt: 'invalid' }, { editedBy: ' ' }, { editedBy: undefined }, { editedAt: undefined },
      ];
      return replacements.map(patch => {
        try { state.replace([{ ...original[0], ...patch }]); return false; }
        catch { return state.annotations === original; }
      });
    });
    assert.deepEqual(rejected, Array(6).fill(true));
    assert.equal(await page.evaluate(() => {
      const state = markerView.highlighting, original = state.annotations;
      try { state.dispatch({ type: 'add-highlight', highlight: { id: 'missing-time', anchor: markerAnchor(6, 10), color: 'green' } }); return false; }
      catch { return state.annotations === original; }
    }), true, 'a newly added highlight must include its creation time');
  });
});

test('cross-format and multiline markers preserve source slices; overlap hover edits the topmost marker', async () => {
  const source = "前🌏'''strong''' and [[Page|label]] end\n\nnext paragraph";
  await inPage(source, async page => {
    await select(page, 0, source.length); await choose(page, 'Yellow');
    const first = await page.evaluate(() => markerView.highlighting.annotations[0]);
    await select(page, 0, source.length); await choose(page, 'Blue');
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations.length), 1, 'same source anchor edits existing marker');
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations[0].id), first.id);
    await select(page, 0, 3); await choose(page, 'Red');
    await hover(page, 1);
    assert.equal(await toolbar(page).getByRole('button', { name: '紅色高亮' }).getAttribute('aria-pressed'), 'true');
    const paintOrder = await page.evaluate(() => [...markerView.element.querySelectorAll('[data-annotation-marker]')].map(group => group.dataset.annotationMarker));
    assert.deepEqual(paintOrder, await page.evaluate(() => markerView.highlighting.annotations.map(annotation => annotation.id)));
    await toolbar(page).getByRole('button', { name: '刪除高亮' }).click();
    await hover(page, 0);
    assert.equal(await toolbar(page).getByRole('button', { name: '藍色高亮' }).getAttribute('aria-pressed'), 'true');
    const restored = await page.evaluate(() => markerView.readRange(markerView.restoreRange(markerView.highlighting.annotations[0].anchor)));
    assert.equal(restored.sourceText, source);
  });
});

test('cached highlight backgrounds respect scrolling code clips and remain below the original text', async () => {
  const source = ' ' + 'Long code fragment '.repeat(35);
  await inPage(source, async page => {
    await page.locator('.annotation-document pre').evaluate(element => { element.style.cssText = 'width:140px;white-space:pre;overflow:auto'; });
    await select(page, 1, source.length); await choose(page, 'Green');
    const check = async () => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const measured = await page.evaluate(() => {
        const pre = markerView.element.querySelector('pre'), box = pre.getBoundingClientRect();
        const rectangles = [...markerView.element.querySelectorAll('.annotation-highlight-backgrounds rect')].map(rect => rect.getBoundingClientRect());
        return { count: rectangles.length, clipped: rectangles.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1),
          sourceLayer: getComputedStyle(pre.querySelector('[data-source-run]')).zIndex,
          highlightLayer: getComputedStyle(markerView.element.querySelector('.annotation-highlight-backgrounds')).zIndex,
        };
      });
      assert.ok(measured.count > 0); assert.equal(measured.clipped, true);
      assert.ok(Number(measured.sourceLayer) > Number(measured.highlightLayer));
    };
    await check();
    await page.locator('.annotation-document pre').evaluate(element => { element.scrollLeft = 150; }); await check();
    await page.setViewportSize({ width: 800, height: 700 }); await check();
  });
});

test('whole links and atomic references show source tooltips together with highlight controls', async () => {
  await inPage('[[Page|label]] <ref name="Book">book source</ref> [[Other|other]]', async page => {
    await page.locator('[data-inspect="link"]').first().click();
    await choose(page, 'Blue');
    assert.equal(await page.evaluate(() => markerView.readRange(markerView.restoreRange(markerView.highlighting.annotations[0].anchor)).sourceText), '[[Page|label]]');
    await hover(page);
    const pair = await separatePopups(page);
    const trigger = await page.locator('[data-inspect="link"]').first().boundingBox();
    assert.ok(pair.bar.y + pair.bar.height <= trigger.y && pair.source.y >= trigger.y + trigger.height, 'color bar above and source tooltip below');
    await page.keyboard.press('Escape');
    await page.locator('[data-inspect="reference"]').click();
    await separatePopups(page);
    await choose(page, 'Green');
    assert.equal(await page.evaluate(() => markerView.readRange(markerView.restoreRange(markerView.highlighting.annotations[1].anchor)).sourceText), '<ref name="Book">book source</ref>');
    await page.locator('[data-inspect="link"]').last().hover();
    await page.locator('[data-annotation-popup]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-annotation-popup] pre').textContent(), '[[Other|other]]');
  });
});

test('outside selections retain the article anchor; toolbar supports keyboard choice and stays inside a narrow viewport', async () => {
  await inPage('Select this text for a marker.', async page => {
    await page.setViewportSize({ width: 390, height: 650 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await select(page, 0, 16);
    const anchor = await page.evaluate(() => markerView.selection.anchor);
    const box = await toolbar(page).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 650);
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => markerView.highlighting.annotations[0].color), 'yellow');
    assert.deepEqual(await page.evaluate(() => markerView.highlighting.annotations[0].anchor), anchor);
    await select(page, 17, 20);
    const pending = await page.evaluate(() => markerView.selection.anchor);
    await page.locator('#outside').click({ clickCount: 3 });
    assert.deepEqual(await page.evaluate(() => markerView.selection.anchor), pending);
    assert.equal(await toolbar(page).isVisible(), false);
    assert.match(await page.evaluate(() => getSelection().toString()), /Outside/);
  });
});

test('snapshot replacement is transactional and destroying one view preserves another view’s markers', async () => {
  await inPage('甲🌏 first second', async page => {
    await select(page, 0, 3); await choose(page, 'Red');
    const result = await page.evaluate(() => {
      const initial = markerView.highlighting.annotations;
      let rejected = 0;
      for (const bad of [
        [...initial, initial[0]],
        [{ ...initial[0], anchor: { unit: 'utf8-byte', start: 4, end: 5 } }],
        [{ ...initial[0], color: 'purple' }],
      ]) {
        try { markerView.highlighting.replace(bad); } catch { rejected++; }
        if (markerView.highlighting.annotations !== initial) throw new Error('Invalid replacement mutated state');
      }
      const second = annotationLab.annotation.createAnnotationView(document, markerView.projection, { highlighting: { initial } });
      document.getElementById('test-content').append(second.element);
      const count = () => document.querySelectorAll('[data-annotation-marker]').length;
      const both = count();
      markerView.destroy(); markerView.destroy();
      const one = count(), secondUnchanged = second.highlighting.annotations[0].id === initial[0].id;
      second.destroy(); const none = count();
      return { rejected, both, one, none, secondUnchanged, actions: markerActions.length };
    });
    assert.deepEqual(result, { rejected: 3, both: 2, one: 1, none: 0, secondUnchanged: true, actions: 1 });
  });
});

test('reselecting after dismissal reopens the bar; selecting popup text preserves the pending article range', async () => {
  await inPage('Selected words and [[Page|label]]', async page => {
    await select(page, 0, 8);
    const original = await page.evaluate(() => markerView.selection.anchor);
    await page.keyboard.press('Escape');
    await select(page, 0, 8);
    await page.locator('[data-inspect="link"]').focus();
    await page.locator('[data-annotation-popup]').waitFor({ state: 'visible' });
    await separatePopups(page);
    await page.locator('[data-annotation-popup] pre').click({ clickCount: 3 });
    assert.match(await page.evaluate(() => getSelection().toString()), /\[\[Page\|label\]\]/);
    assert.deepEqual(await page.evaluate(() => markerView.selection.anchor), original);
    await separatePopups(page);
    await page.keyboard.press('Escape');
    await select(page, 0, 8); await choose(page, 'Blue');
    assert.deepEqual(await page.evaluate(() => markerView.highlighting.annotations[0].anchor), original);
  });
});

test('a tooltip can open after the selection bar and remain usable with its pending selection', async () => {
  await inPage('Selected text and [[Page|label]]', async page => {
    await select(page, 0, 8);
    const original = await page.evaluate(() => markerView.selection.anchor);
    await page.locator('[data-inspect="link"]').hover();
    await separatePopups(page);
    await page.locator('[data-annotation-popup]').hover();
    await page.waitForTimeout(220);
    await separatePopups(page);
    await choose(page, 'Yellow');
    assert.deepEqual(await page.evaluate(() => markerView.highlighting.annotations[0].anchor), original);
  });
});

test('tall source tooltips avoid the color bar at viewport edges and can scroll independently', async () => {
  const source = '<ref name="Book">' + 'Long reference source\n'.repeat(50) + '</ref>';
  await inPage(source, async page => {
    for (const width of [960, 390]) {
      await page.setViewportSize({ width, height: 600 });
      for (const y of [16, 280, 552]) {
        await page.keyboard.press('Escape');
        await page.evaluate(({ width, y }) => {
          document.getElementById('test-content').style.cssText = `position:fixed;left:20px;top:${y}px;width:${width - 40}px;margin:0`;
          markerView.clearSelection();
        }, { width, y });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator('[data-inspect="reference"]').click();
        await separatePopups(page);
        const anchor = await page.evaluate(() => markerView.selection.anchor);
        await page.locator('[data-annotation-popup]').evaluate(popup => { popup.focus(); popup.scrollTop = 100; });
        await page.waitForTimeout(200);
        await separatePopups(page);
        assert.ok(await page.locator('[data-annotation-popup]').evaluate(popup => popup.scrollTop > 0));
        assert.deepEqual(await page.evaluate(() => markerView.selection.anchor), anchor);
      }
    }
  });
});

test('an image tooltip reflows around an open color bar after its image loads', async () => {
  let release;
  const loaded = new Promise(resolve => { release = resolve; });
  try {
    await inPage('Selected text [[File:A.png]]', async page => {
      await page.setViewportSize({ width: 390, height: 440 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await select(page, 0, 8);
      await page.locator('[data-inspect="image"]').hover();
      await separatePopups(page);
      assert.equal(await page.locator('[data-annotation-popup] img').evaluate(image => image.complete), false);
      release();
      await page.waitForFunction(() => document.querySelector('[data-annotation-popup] img')?.naturalWidth > 0);
      await separatePopups(page);
      assert.equal(await page.locator('[data-annotation-popup]').evaluate(popup => popup.scrollHeight > popup.clientHeight), true);
    }, { referenceHtml: '<a href="/wiki/File:A.png"><img src="/fixture.png?delayed" width="250"></a>' }, async page => {
      await page.route('**/fixture.png?delayed', async route => {
        await loaded;
        await route.fulfill({ response: await page.request.get(server.url + '/fixture.png') });
      });
    });
  } finally { release(); }
});

test('dragging through an existing marker creates a new range; paragraph whitespace does not open marker controls', async () => {
  await inPage('Alpha Beta Gamma\n\nSecond paragraph', async page => {
    await select(page, 0, 5); await choose(page, 'Red');
    const points = await page.locator('[data-source-run]').first().evaluate(element => {
      const text = element.firstChild;
      const first = document.createRange(); first.setStart(text, 2); first.setEnd(text, 3);
      const last = document.createRange(); last.setStart(text, 9); last.setEnd(text, 10);
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
      return { x1: a.left + .5, x2: b.right - .5, y: a.top + a.height / 2 };
    });
    await page.mouse.move(points.x1, points.y); await page.mouse.down();
    await page.mouse.move(points.x2, points.y, { steps: 10 }); await page.mouse.up();
    await choose(page, 'Blue');
    assert.deepEqual(await page.evaluate(() => markerView.highlighting.annotations.map(item => item.anchor)), [
      { unit: 'utf8-byte', start: 0, end: 5 }, { unit: 'utf8-byte', start: 2, end: 10 },
    ]);
    await select(page, 0, 33); await choose(page, 'Green');
    const gap = await page.locator('.annotation-document p').evaluateAll(paragraphs => {
      const a = paragraphs[0].getBoundingClientRect(), b = paragraphs[1].getBoundingClientRect();
      return { x: a.left + 20, y: (a.bottom + b.top) / 2 };
    });
    await page.mouse.move(gap.x, gap.y); await page.waitForTimeout(240);
    assert.equal(await toolbar(page).isVisible(), false);
  });
});

test('Wikipedia markers and selections preserve text colors in light/dark modes and survive view toggles', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
  try {
    await page.goto(server.url + '/?article=sun-yat-sen#求學');
    await page.waitForFunction(() => Boolean(window.annotationPageLab));
    await page.evaluate(() => {
      const heading = document.getElementById('求學'); heading.scrollIntoView();
      const range = document.createRange(); range.selectNodeContents(heading);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await choose(page, 'Blue');
    for (const [text, color] of [['1879年5月21日', 'Red'], ['希望改造中國', 'Yellow'], ['英語', 'Green']]) {
      await page.evaluate(text => {
        const view = annotationPageLab.view;
        const from = view.projection.source.indexOf(text, view.projection.source.indexOf('==== 求學 ===='));
        if (from < 0) throw new Error('Real-article highlight sample missing: ' + text);
        const anchor = { unit: 'utf8-byte', start: new TextEncoder().encode(view.projection.source.slice(0, from)).length, end: new TextEncoder().encode(view.projection.source.slice(0, from + text.length)).length };
        const range = view.restoreRange(anchor);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      }, text);
      await choose(page, color);
    }
    const original = await page.evaluate(() => annotationPageLab.view.highlighting.annotations);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Escape');
      await page.evaluate(theme => annotationPageLab.setTheme(theme), theme);
      const point = await page.locator('#求學').boundingBox();
      await page.mouse.move(point.x + 8, point.y + 10);
      await toolbar(page).waitFor({ state: 'visible' });
      const markers = await page.evaluate(() => {
        const view = annotationPageLab.view;
        return view.highlighting.annotations.map(annotation => {
          const range = view.restoreRange(annotation.anchor), node = range.startContainer;
          const element = node.nodeType === 3 ? node.parentElement : node;
          const group = [...view.element.querySelectorAll('[data-annotation-marker]')].find(group => group.dataset.annotationMarker === annotation.id);
          const original = getComputedStyle(element), marked = getComputedStyle(group);
          const background = marked.fill.replace('rgb(', 'rgba(').replace(')', `, ${marked.opacity})`);
          const box = range.getBoundingClientRect();
          return { text: range.toString(), originalColor: original.color, background, link: Boolean(element.closest('a')), rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
        });
      });
      assert.equal(markers.length, 4);
      assert.ok(markers.some(marker => marker.link), 'include native Wikipedia link colors');
      for (const marker of markers) {
        assert.match(marker.background, /^rgba\(.+, 0\.5\)$/, `${theme}: translucent marker background`);
      }
      const screenshot = await page.screenshot({ path: `.cache/annotation-rnd/highlights-${theme}.png` });
      await assertPaintedTextColors(page, screenshot, markers, theme + ' markers');
      await page.keyboard.press('Escape');

      const selectedSamples = markers.filter(marker => ['1879年5月21日', '英語'].includes(marker.text));
      assert.equal(selectedSamples.length, 2);
      await page.evaluate(() => {
        const link = [...annotationPageLab.view.element.querySelectorAll('a')].find(link => link.textContent === '英語');
        const range = document.createRange(); range.selectNodeContents(link.closest('p'));
        getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await page.waitForFunction(() => annotationPageLab.view.selection?.quote.includes('1879年5月21日'));
      await page.keyboard.press('Escape');
      await assertPaintedTextColors(page, await page.screenshot(), selectedSamples, theme + ' native selection');
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.waitForFunction(() => getSelection().rangeCount === 0 && annotationPageLab.view.selection);
      await assertPaintedTextColors(page, await page.screenshot(), selectedSamples, theme + ' retained selection');
      await page.evaluate(() => annotationPageLab.view.clearSelection());
    }
    await page.evaluate(() => { annotationPageLab.setEnabled(false); annotationPageLab.setEnabled(true); });
    assert.deepEqual(await page.evaluate(() => annotationPageLab.view.highlighting.annotations), original);
  } finally { await page.close(); }
});
