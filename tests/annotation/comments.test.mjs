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
const source = 'First passage [[Page|linked words]] after.\nSecond sentence.\n\nNext paragraph for annotations.';

async function inPage(callback, real = false, fixtureSource = source, contextOptions = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...contextOptions }); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
  try {
    await page.goto(server.url + (real ? '/?article=sun-yat-sen#求學' : '/lab'));
    await page.waitForFunction(real ? () => Boolean(window.annotationPageLab) : () => Boolean(window.annotationLab));
    if (!real) await page.evaluate(source => {
      const api = annotationLab.annotation; annotationLab.view.destroy();
      document.body.innerHTML = '<div id="comment-fixture"><div id="mw-content-text"><div class="mw-parser-output">Original article</div></div><div class="vector-column-end no-font-mode-scale"></div></div>';
      const style = document.createElement('style'); style.textContent = '#comment-fixture {display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:30px;margin:80px 30px} @media(max-width:800px){#comment-fixture{display:block;margin:80px 16px}}'; document.head.append(style);
      window.commentEvents = [];
      window.commentMount = api.mountWikipediaAnnotation(document, api.createProjection(source), { comments: true, commentAuthor: 'Example', highlighting: { onChange: (annotations, action) => commentEvents.push({ annotations, action }) } });
      window.commentView = commentMount.view;
    }, fixtureSource);
    else await page.evaluate(() => { window.commentView = annotationPageLab.view; });
    await callback(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function mark(page, text, color = 'Yellow') {
  await page.evaluate(text => {
    const view = commentView, source = view.projection.source, start = source.indexOf(text);
    if (start < 0) throw new Error('Missing selected text');
    const encoder = new TextEncoder(), range = view.restoreRange({ unit: 'utf8-byte', start: encoder.encode(source.slice(0, start)).length, end: encoder.encode(source.slice(0, start + text.length)).length });
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }, text);
  await page.locator('[data-annotation-toolbar]').getByRole('button', { name: `${color} highlight`, exact: true }).click();
  const id = await page.evaluate(() => commentView.highlighting.annotations.at(-1).id);
  const thread = page.locator(`[data-annotation-id="${id}"].annotation-comment-thread`);
  await thread.getByRole('button', { name: 'Add a comment…' }).waitFor({ state: 'visible' });
  return thread;
}
async function send(thread, text, label = 'Send') {
  const placeholder = thread.getByRole('button', { name: 'Add a comment…' });
  if (await placeholder.count()) await placeholder.click();
  await thread.getByRole('textbox').fill(text);
  await thread.getByRole('button', { name: label, exact: true }).click();
  await thread.getByRole('textbox').waitFor({ state: 'hidden' });
}
const body = (page, id) => page.locator(`[data-comment-id="${id}"] > .annotation-comment-body`);
async function act(page, id, action) {
  const target = body(page, id); await target.hover(); await target.getByRole('button', { name: action, exact: true }).click();
}
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

test('a new highlight shows an aligned Add a comment placeholder and opens its editor only when requested', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage', 'Red'); await frames(page);
    assert.equal(await thread.getByRole('textbox').count(), 0);
    assert.equal(await thread.getByRole('button', { name: 'Send' }).count(), 0);
    assert.equal(await thread.evaluate(element => element.contains(document.activeElement)), false);
    assert.deepEqual(await page.evaluate(() => commentView.comments.drafts), []);
    const initial = await thread.evaluate(element => ({ top: element.getBoundingClientRect().top, sourceTop: commentView.restoreRange(commentView.highlighting.annotations[0].anchor).getClientRects()[0].top }));
    assert.ok(Math.abs(initial.top - initial.sourceTop) <= 1);
    await thread.getByRole('button', { name: 'Add a comment…' }).click(); await frames(page);
    const result = await thread.evaluate(element => {
      const annotation = commentView.highlighting.annotations[0], range = commentView.restoreRange(annotation.anchor);
      const box = element.getBoundingClientRect(), first = range.getClientRects()[0], css = getComputedStyle(element);
      const input = element.querySelector('textarea'), editor = getComputedStyle(input);
      return { inColumn: element.closest('div.vector-column-end.no-font-mode-scale') !== null, top: box.top, sourceTop: first.top,
        border: css.borderTopColor, background: css.backgroundColor, inputBorder: editor.borderTopWidth, inputBackground: editor.backgroundColor,
        focused: document.activeElement === input, connector: document.querySelector('.annotation-comment-connectors path').getAttribute('d') };
    });
    assert.equal(result.inColumn, true); assert.ok(Math.abs(result.top - result.sourceTop) <= 1);
    assert.equal(result.border, 'rgb(242, 206, 182)'); assert.equal(result.background, 'rgba(242, 206, 182, 0.5)');
    assert.equal(result.inputBorder, '0px'); assert.equal(result.inputBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(result.focused, true); assert.match(result.connector, /^M /);
    assert.equal(await thread.getByRole('button', { name: 'Send' }).isDisabled(), true);
    await thread.getByRole('button', { name: 'Discard' }).click();
    assert.equal(await thread.getByRole('button', { name: 'Add a comment…' }).isVisible(), true);
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations.length), 1);
  });
});

test('crowded cards expand on hover and collapse on leaving without overlapping or toggling on clicks', async () => {
  await inPage(async page => {
    const first = await mark(page, 'First passage'); await send(first, 'A longer comment. '.repeat(28));
    const second = await mark(page, 'linked words', 'Green'); await send(second, 'Second comment');
    const third = await mark(page, 'after.', 'Blue'); await send(third, 'Third comment');
    await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur());
    const check = async () => {
      await frames(page);
      const boxes = await page.locator('.annotation-comment-thread').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      assert.ok(boxes[1].top >= boxes[0].bottom + 11 && boxes[2].top >= boxes[1].bottom + 11); return boxes;
    };
    const before = await check();
    const text = first.locator('.annotation-comment-text');
    assert.equal(await text.evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === 'ellipsis'), true);
    const path = await page.locator('.annotation-comment-connectors path').nth(1).getAttribute('d');
    await text.hover();
    const after = await check();
    assert.ok(after[0].height > before[0].height + 100); assert.ok(after[1].top > before[1].top + 100);
    assert.notEqual(await page.locator('.annotation-comment-connectors path').nth(1).getAttribute('d'), path);
    await text.click(); await page.mouse.move(0, 0);
    const collapsed = await check(); assert.ok(Math.abs(collapsed[0].height - before[0].height) <= 1);
    await first.hover();
    const stable = await check();
    await page.waitForTimeout(160);
    assert.deepEqual(await check(), stable, 'hover does not make crowding oscillate');
  });
});

test('roomy threads stay fully visible and regain that state when a neighboring annotation is removed', async () => {
  const spacedSource = source + '\n\n' + 'Spacing paragraph.\n\n'.repeat(18) + 'Distant passage.';
  await inPage(async page => {
    await page.evaluate(() => {
      const encoder = new TextEncoder(), source = commentView.projection.source;
      window.makeComment = (id, selected, text) => {
        const start = source.indexOf(selected);
        return { id, color: 'green', anchor: { unit: 'utf8-byte', start: encoder.encode(source.slice(0, start)).length, end: encoder.encode(source.slice(0, start + selected.length)).length }, comment: { id: id + '-message', text, author: 'Example', createdAt: '2026-01-01T00:30:00.000Z', replies: [] } };
      };
      commentView.highlighting.replace([makeComment('first', 'First passage', 'Full comment text. '.repeat(15)), makeComment('distant', 'Distant passage', 'Another full comment. '.repeat(10))]);
    });
    await frames(page);
    const first = page.locator('.annotation-comment-thread[data-annotation-id="first"]'), distant = page.locator('.annotation-comment-thread[data-annotation-id="distant"]');
    const originalHeight = (await first.boundingBox()).height;
    for (const thread of [first, distant]) {
      assert.equal(await thread.getAttribute('data-crowded'), null);
      assert.equal(await thread.locator('.annotation-comment-text').evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap');
    }
    await page.evaluate(() => commentView.highlighting.dispatch({ type: 'add-highlight', highlight: makeComment('neighbor', 'linked words', 'Neighbor') }));
    await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(0, 0); await frames(page);
    assert.notEqual(await first.getAttribute('data-crowded'), null);
    assert.ok((await first.boundingBox()).height < originalHeight - 50);
    assert.equal(await distant.getAttribute('data-crowded'), null);
    await page.evaluate(() => commentView.highlighting.dispatch({ type: 'delete-highlight', id: 'neighbor' })); await frames(page);
    assert.equal(await first.getAttribute('data-crowded'), null);
    assert.ok(Math.abs((await first.boundingBox()).height - originalHeight) <= 1);
  }, false, spacedSource);
});

test('overlapping connectors use three small offsets and allow additional lines to reuse them', async () => {
  await inPage(async page => {
    await page.evaluate(() => {
      const source = commentView.projection.source, encoder = new TextEncoder();
      commentView.highlighting.replace(['First', 'passage', 'linked words', 'after.'].map((text, index) => {
        const start = source.indexOf(text);
        return { id: 'line-' + index, color: 'blue', anchor: { unit: 'utf8-byte', start: encoder.encode(source.slice(0, start)).length, end: encoder.encode(source.slice(0, start + text.length)).length }, comment: { id: 'message-' + index, text: 'Comment ' + index, author: 'Example', createdAt: '2026-01-01T00:30:00.000Z', replies: [] } };
      }));
    });
    await frames(page);
    const routes = await page.locator('.annotation-comment-connectors path').evaluateAll(paths => paths.map(path => {
      const numbers = path.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number);
      const annotation = commentView.highlighting.annotations.find(item => item.id === path.dataset.annotationId);
      const highlight = commentView.restoreRange(annotation.anchor).getClientRects()[0];
      return { x: numbers[0], attachmentY: numbers[1], y: numbers[3], middle: numbers[4], edgeX: highlight.right, edgeY: highlight.bottom };
    }));
    for (const route of routes) {
      assert.ok(Math.abs(route.x - route.edgeX) < .5 && Math.abs(route.attachmentY - route.edgeY) < .5, 'each connector starts at its highlight background');
      assert.ok(route.y > route.attachmentY, 'a short segment joins the highlight to the offset lane');
    }
    assert.equal(new Set(routes.slice(0, 3).map(route => route.y)).size, 3);
    assert.ok(Math.max(...routes.map(route => route.y)) - Math.min(...routes.map(route => route.y)) <= 8);
    assert.equal(new Set(routes.map(route => route.y)).size, 3);
    assert.equal(new Set(routes.slice(0, 3).map(route => route.middle)).size, 3);
  });
});

test('comments support nested replies, edit/discard, and resolving only the chosen subtree', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage'); await send(thread, 'Root comment');
    const root = await page.evaluate(() => commentView.highlighting.annotations[0].comment.id);
    await act(page, root, 'Reply'); await send(thread, 'First reply');
    const reply = await page.evaluate(() => commentView.highlighting.annotations[0].comment.replies[0].id);
    await act(page, reply, 'Reply'); await send(thread, 'Nested reply');
    await act(page, root, 'Reply'); await send(thread, 'Sibling reply');
    const indent = await thread.locator('.annotation-comment-replies').first().evaluate(element => ({ width: getComputedStyle(element).borderLeftWidth, left: element.getBoundingClientRect().left, parent: element.parentElement.getBoundingClientRect().left }));
    assert.equal(indent.width, '1px'); assert.ok(indent.left > indent.parent);
    await act(page, root, 'Edit'); await thread.getByRole('textbox').fill('Discard this'); await thread.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].comment.text), 'Root comment');
    await act(page, root, 'Edit'); await send(thread, 'Edited root', 'Save changes');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].comment.replies.length), 2);
    await act(page, reply, 'Resolve');
    assert.deepEqual(await page.evaluate(() => commentView.highlighting.annotations[0].comment.replies.map(reply => reply.text)), ['Sibling reply']);
    await act(page, root, 'Resolve');
    assert.equal(await thread.count(), 0); assert.equal(await page.evaluate(() => commentView.highlighting.annotations.length), 0);
    assert.equal(await page.evaluate(() => [...CSS.highlights.keys()].some(key => key.startsWith('reviewtool-marker-'))), false);
    assert.equal(await page.locator('.annotation-comment-connectors path').count(), 0);
  });
});

test('saved actions appear on hover, editor actions stay visible, and comment text remains outside source coordinates', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage'); await send(thread, '<script>alert("safe text")</script>');
    await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur());
    await frames(page);
    const resting = await thread.evaluate(element => ({ height: element.getBoundingClientRect().height, textTop: element.querySelector('.annotation-comment-text').getBoundingClientRect().top, actions: element.querySelector('.annotation-comment-actions').getBoundingClientRect().height, reply: element.querySelector('.annotation-comment-reply').getBoundingClientRect().height }));
    assert.equal(resting.actions, 0); assert.equal(resting.reply, 0);
    assert.equal(await thread.locator('.annotation-comment-actions').evaluate(element => getComputedStyle(element).opacity), '0');
    await thread.locator('.annotation-comment-body').hover();
    await frames(page);
    const hovered = await thread.evaluate(element => ({ height: element.getBoundingClientRect().height, text: element.querySelector('.annotation-comment-text').getBoundingClientRect().toJSON(), actions: element.querySelector('.annotation-comment-actions').getBoundingClientRect().toJSON(), reply: element.querySelector('.annotation-comment-reply').getBoundingClientRect().toJSON() }));
    assert.ok(hovered.text.top > resting.textTop + 10, 'actions push the text down');
    assert.ok(hovered.actions.bottom <= hovered.text.top && hovered.reply.top >= hovered.text.bottom, 'actions do not cover the text');
    assert.ok(hovered.height > resting.height + 20);
    assert.equal(await thread.locator('.annotation-comment-actions').evaluate(element => getComputedStyle(element).opacity), '1');
    assert.equal(await thread.locator('script').count(), 0);
    const root = await page.evaluate(() => commentView.highlighting.annotations[0].comment.id);
    await act(page, root, 'Edit'); await page.mouse.move(0, 0);
    assert.equal(await thread.getByRole('button', { name: 'Save changes' }).evaluate(element => getComputedStyle(element.parentElement).opacity), '1');
    const selection = await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('.annotation-comment-thread'));
      return commentView.readRange(range);
    });
    assert.equal(selection, null);
    await thread.getByRole('button', { name: 'Cancel' }).click();
    const initial = await page.evaluate(() => commentView.highlighting.annotations);
    await page.evaluate(() => { const state = commentView.highlighting; state.dispatch({ type: 'recolor-highlight', id: state.annotations[0].id, color: 'Blue'.toLowerCase() }); });
    assert.equal(await thread.getAttribute('data-color'), 'blue');
    assert.deepEqual(await page.evaluate(() => commentView.highlighting.annotations[0].comment), initial[0].comment);
  });
});

test('editing uses Save changes/Cancel and a gray disabled button until the saved text changes', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage'); await send(thread, 'Original');
    const root = await page.evaluate(() => {
      const annotation = commentView.highlighting.annotations[0];
      // A textarea normalizes line endings; opening imported CRLF text is not an edit.
      commentView.highlighting.dispatch({ type: 'edit-comment', id: annotation.id, commentId: annotation.comment.id, text: 'Original\r\nsecond line' });
      return annotation.comment.id;
    });
    await act(page, root, 'Edit');
    const input = thread.getByRole('textbox'), save = thread.getByRole('button', { name: 'Save changes', exact: true }), cancel = thread.getByRole('button', { name: 'Cancel', exact: true });
    assert.equal(await input.inputValue(), 'Original\nsecond line');
    assert.equal(await save.isDisabled(), true);
    assert.equal(await thread.getByRole('button', { name: 'Send', exact: true }).count(), 0);
    assert.equal(await thread.getByRole('button', { name: 'Discard', exact: true }).count(), 0);
    const gray = await save.evaluate(element => ({ color: getComputedStyle(element).color, opacity: Number(getComputedStyle(element).opacity) }));
    const normal = await cancel.evaluate(element => getComputedStyle(element).color);
    assert.notEqual(gray.color, normal); assert.ok(gray.opacity > 0 && gray.opacity < 1);
    const actions = await page.evaluate(() => commentEvents.length);
    await input.press('Control+Enter');
    assert.equal(await page.evaluate(() => commentEvents.length), actions, 'unchanged text emits no save action');
    await input.fill('Changed text'); assert.equal(await save.isEnabled(), true);
    assert.equal(await save.evaluate(element => getComputedStyle(element).color), normal);
    await input.fill('Original\nsecond line'); assert.equal(await save.isDisabled(), true);
    await input.fill(' \n '); assert.equal(await save.isDisabled(), true);
    await input.fill('Not saved'); await cancel.click();
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].comment.text), 'Original\r\nsecond line');
    await act(page, root, 'Edit'); await send(thread, 'Saved change', 'Save changes');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].comment.text), 'Saved change');
    assert.equal(await page.evaluate(() => commentEvents.length), actions + 1);
  });
});

test('narrow screens hide the sidebar and show a floating thread only when its highlight is hovered', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'linked words', 'Blue'); await send(thread, 'A floating comment with more context. '.repeat(30));
    await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur());
    await page.setViewportSize({ width: 390, height: 440 }); await frames(page);
    const panel = page.locator('.annotation-comments');
    assert.equal(await panel.isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('.annotation-document a').hover();
    await panel.waitFor({ state: 'visible' });
    assert.equal(await panel.getAttribute('data-layout'), 'floating');
    await thread.locator('.annotation-comment-text').hover(); await frames(page);
    const boxes = await page.locator('.annotation-comments, [data-annotation-toolbar], [data-annotation-popup]').evaluateAll(elements => elements.filter(element => !element.hidden).map(element => element.getBoundingClientRect().toJSON()));
    assert.equal(boxes.length, 3);
    for (const box of boxes) assert.ok(box.left >= 0 && box.right <= 391 && box.top >= 0 && box.bottom <= 441);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(boxes[i].bottom <= boxes[j].top || boxes[j].bottom <= boxes[i].top || boxes[i].right <= boxes[j].left || boxes[j].right <= boxes[i].left);
    await panel.hover(); await page.waitForTimeout(230); assert.equal(await panel.isVisible(), true);
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(0, 0); await page.waitForTimeout(230); assert.equal(await panel.isVisible(), false);
    await page.evaluate(() => commentView.highlighting.dispatch({ type: 'add-highlight', highlight: { id: 'narrow-new', anchor: { unit: 'utf8-byte', start: 0, end: 13 }, color: 'red' } }));
    await frames(page); assert.equal(await panel.isVisible(), false, 'new narrow-screen threads wait for highlight hover');
    await page.locator('.annotation-document [data-source-run]').first().hover();
    await panel.getByRole('button', { name: 'Add a comment…' }).waitFor({ state: 'visible' });
    assert.equal(await panel.getByRole('textbox').count(), 0);
    await panel.getByRole('button', { name: 'Add a comment…' }).click();
    await panel.getByRole('textbox', { name: 'Comment text' }).waitFor({ state: 'visible' });
    assert.equal(await panel.getByRole('button', { name: 'Send' }).isVisible(), true);
  });
});

test('real Wikipedia comments survive view toggles, preserve the sidebar, and clean up completely', async () => {
  await inPage(async page => {
    const originals = await page.locator('div.vector-column-end.no-font-mode-scale > :not(.annotation-comments)').count();
    const thread = await mark(page, '1879年5月21日', 'Red'); await send(thread, 'Check the date and source.');
    const saved = await page.evaluate(() => commentView.highlighting.annotations);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => annotationPageLab.setTheme(theme), theme); await frames(page);
      await page.screenshot({ path: `.cache/annotation-rnd/comments-${theme}.png` });
      await act(page, saved[0].comment.id, 'Edit');
      assert.equal(await thread.getByRole('button', { name: 'Save changes' }).isDisabled(), true);
      const colors = await thread.locator('.annotation-comment-editor-actions button').evaluateAll(buttons => buttons.map(button => getComputedStyle(button).color));
      assert.notEqual(colors[0], colors[1], `${theme}: disabled save has a distinct gray color`);
      await page.screenshot({ path: `.cache/annotation-rnd/comment-edit-${theme}.png` });
      await thread.getByRole('button', { name: 'Cancel' }).click();
    }
    await page.evaluate(() => annotationPageLab.setEnabled(false));
    assert.equal(await page.locator('.annotation-comments, .annotation-comment-connectors').count(), 0);
    assert.equal(await page.locator('div.vector-column-end.no-font-mode-scale > *').count(), originals);
    await page.evaluate(() => { annotationPageLab.setEnabled(true); window.commentView = annotationPageLab.view; });
    assert.deepEqual(await page.evaluate(() => commentView.highlighting.annotations), saved);
    assert.equal(await page.locator('.annotation-comment-text').textContent(), 'Check the date and source.');
    await act(page, saved[0].comment.id, 'Edit');
    await page.locator('.annotation-comments textarea').fill('Unsent revision');
    await page.evaluate(() => { annotationPageLab.setEnabled(false); annotationPageLab.setEnabled(true); window.commentView = annotationPageLab.view; });
    assert.equal(await page.locator('.annotation-comments textarea').inputValue(), 'Unsent revision');
    assert.equal(await page.locator('.annotation-comments').getByRole('button', { name: 'Save changes' }).isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => commentView.highlighting.annotations), saved, 'drafts do not become saved comments');
    await page.setViewportSize({ width: 390, height: 700 }); await frames(page);
    assert.equal(await page.locator('.annotation-comments').isVisible(), false);
    const point = await page.evaluate(() => {
      const range = commentView.restoreRange(commentView.highlighting.annotations[0].anchor);
      range.startContainer.parentElement.scrollIntoView({ block: 'center' });
      const box = range.getClientRects()[0]; return { x: box.left + 3, y: box.top + box.height / 2 };
    });
    await page.mouse.move(0, 0); await page.mouse.move(point.x, point.y);
    await page.locator('.annotation-comments').waitFor({ state: 'visible' }); await frames(page);
    const floating = await page.locator('.annotation-comments').boundingBox();
    assert.ok(floating.x >= 0 && floating.y >= 0 && floating.x + floating.width <= 391 && floating.y + floating.height <= 701);
    assert.equal(await page.locator('.annotation-comments textarea').inputValue(), 'Unsent revision');
    await page.screenshot({ path: '.cache/annotation-rnd/comments-floating.png' });
    await page.evaluate(() => annotationPageLab.setEnabled(false));
    assert.equal(await page.locator('.vector-column-end').evaluate(element => getComputedStyle(element).contain), 'paint');
  }, true);
});

test('all floating surfaces appear above Wikipedia stacking contexts, cards and page overlays', async () => {
  await inPage(async page => {
    await page.evaluate(() => {
      const source = commentView.projection.source, text = '希望改造中國', start = source.indexOf(text), encoder = new TextEncoder();
      commentView.highlighting.replace([{ id: 'layer-test', color: 'yellow',
        anchor: { unit: 'utf8-byte', start: encoder.encode(source.slice(0, start)).length, end: encoder.encode(source.slice(0, start + text.length)).length },
        comment: { id: 'layer-comment', text: 'A sidebar comment behind the reference tooltip. '.repeat(10), author: 'Example', createdAt: '2026-01-01T00:30:00.000Z', replies: [] },
      }]);
    });
    const point = await page.evaluate(() => {
      window.layerReference = [...commentView.element.querySelectorAll('[data-inspect="reference"]')].find(element => element.textContent === '[影]' && element.getBoundingClientRect().top > 0 && element.getBoundingClientRect().bottom < innerHeight);
      const box = layerReference.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    const source = page.locator('[data-annotation-popup]'), bar = page.locator('[data-annotation-toolbar]'), panel = page.locator('.annotation-comments');
    await source.waitFor({ state: 'visible' }); await frames(page);
    const overlap = await source.evaluate(popup => {
      const a = popup.getBoundingClientRect(), b = document.querySelector('.annotation-comment-thread').getBoundingClientRect();
      const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top), right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
      return { width: right - left, height: bottom - top, onTop: popup.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)) };
    });
    assert.ok(overlap.width > 0 && overlap.height > 0, 'reproduce the tooltip/sidebar overlap');
    assert.equal(overlap.onTop, true, 'the tooltip receives pointer input above the sidebar card');
    const abovePage = async locator => {
      const result = await locator.evaluate(element => {
        const box = element.getBoundingClientRect(), overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:red';
        document.body.append(overlay);
        const onTop = element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        overlay.remove();
        return { onTop, topLayer: element.matches(':popover-open'), mode: element.getAttribute('popover') };
      });
      assert.deepEqual(result, { onTop: true, topLayer: true, mode: 'manual' });
    };
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => annotationPageLab.setTheme(theme), theme);
      await abovePage(source);
      await page.screenshot({ path: `.cache/annotation-rnd/popup-stacking-fixed-${theme}.png` });
    }
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNode(layerReference);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await bar.waitFor({ state: 'visible' });
    await abovePage(bar); await abovePage(source);
    assert.equal(await page.evaluate(() => commentView.element.contains(document.querySelector('[data-annotation-popup]'))), true);
    await page.setViewportSize({ width: 390, height: 700 }); await frames(page);
    const highlight = await page.evaluate(() => {
      const range = commentView.restoreRange(commentView.highlighting.annotations[0].anchor);
      range.startContainer.parentElement.scrollIntoView({ block: 'center' });
      const box = range.getClientRects()[0]; return { x: box.left + 3, y: box.top + box.height / 2 };
    });
    await page.mouse.move(0, 0); await page.mouse.move(highlight.x, highlight.y);
    await panel.waitFor({ state: 'visible' }); await frames(page);
    assert.equal(await page.locator('.vector-column-end').evaluate(element => getComputedStyle(element).contain), 'paint');
    assert.equal(await panel.evaluate(element => Boolean(element.closest('div.vector-column-end.no-font-mode-scale'))), true);
    await abovePage(panel); await abovePage(bar);
    await page.setViewportSize({ width: 1440, height: 900 }); await frames(page);
    assert.equal(await panel.getAttribute('data-layout'), 'margin');
    assert.equal(await panel.getAttribute('popover'), null, 'desktop comments resume their ordinary sidebar role');
    await page.evaluate(() => annotationPageLab.setEnabled(false));
    assert.equal(await page.locator(':popover-open').count(), 0);
  }, true);
});

test('comment actions are immutable and invalid comment updates cannot replace a valid thread', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage'); await send(thread, 'Original');
    const result = await page.evaluate(() => {
      const state = commentView.highlighting, original = state.annotations, root = original[0].comment;
      const incoming = { id: 'test-reply', text: 'Reply', author: 'Example', createdAt: '2026-01-01T00:30:00.000Z', replies: [] };
      state.dispatch({ type: 'add-comment', id: original[0].id, parentId: root.id, comment: incoming });
      incoming.text = 'Mutated outside';
      const action = commentEvents.at(-1).action, committed = state.annotations;
      let rejected = 0;
      for (const run of [
        () => state.dispatch({ type: 'edit-comment', id: original[0].id, commentId: root.id, text: '  ' }),
        () => state.dispatch({ type: 'add-comment', id: original[0].id, parentId: 'missing', comment: { id: 'another', text: 'Text', author: 'Example', createdAt: '2026-01-01T00:30:00.000Z', replies: [] } }),
        () => state.replace([{ ...committed[0], comment: { ...root, replies: [root] } }]),
        () => state.replace([{ ...committed[0], comment: { ...root, author: '' } }]),
        () => state.replace([{ ...committed[0], comment: { ...root, createdAt: '2026-01-01T00:30:00' } }]),
        () => state.replace([{ ...committed[0], comment: { ...root, createdAt: '2026-02-30T00:30:00Z' } }]),
      ]) { try { run(); } catch { rejected++; } }
      return { rejected, unchanged: state.annotations === committed, original: original[0].comment.text,
        reply: committed[0].comment.replies[0].text, action: action.comment.text,
        frozen: Object.isFrozen(committed[0].comment.replies) && Object.isFrozen(committed[0].comment.replies[0]) && Object.isFrozen(action.comment) };
    });
    assert.deepEqual(result, { rejected: 6, unchanged: true, original: 'Original', reply: 'Reply', action: 'Reply', frozen: true });
  });
});

test('comments and replies record the author and UTC posting time on Send and preserve them when edited', async () => {
  await inPage(async page => {
    await page.clock.setFixedTime('2026-01-01T00:30:00Z');
    const thread = await mark(page, 'First passage');
    await thread.getByRole('button', { name: 'Add a comment…' }).click();
    assert.equal(await thread.locator('.annotation-comment-author').textContent(), 'Example');
    assert.equal(await thread.locator('time').count(), 0, 'an unsent draft has no posting date');
    await page.clock.setFixedTime('2026-01-01T00:45:00Z');
    await send(thread, 'Root comment');
    let saved = await page.evaluate(() => commentView.highlighting.annotations[0].comment);
    assert.equal(saved.author, 'Example'); assert.equal(saved.createdAt, '2026-01-01T00:45:00.000Z');
    const root = saved.id;
    await page.clock.setFixedTime('2026-01-02T01:15:00Z');
    await act(page, root, 'Reply');
    assert.equal(await thread.locator('.annotation-comment-editor time').count(), 0);
    await send(thread, 'Reply comment');
    saved = await page.evaluate(() => commentView.highlighting.annotations[0].comment);
    assert.equal(saved.replies[0].author, 'Example'); assert.equal(saved.replies[0].createdAt, '2026-01-02T01:15:00.000Z');
    assert.equal(saved.createdAt, '2026-01-01T00:45:00.000Z');
    await page.evaluate(() => {
      const state = commentView.highlighting;
      state.replace(state.annotations.map(annotation => ({ ...annotation, comment: { ...annotation.comment, author: 'Original author' } })));
    });
    await page.clock.setFixedTime('2026-02-03T04:00:00Z');
    await act(page, root, 'Edit');
    assert.equal(await thread.locator('.annotation-comment-editor .annotation-comment-author').textContent(), 'Original author');
    assert.equal(await thread.locator('.annotation-comment-editor time').getAttribute('datetime'), '2026-01-01T00:45:00.000Z');
    await send(thread, 'Edited root', 'Save changes');
    saved = await page.evaluate(() => commentView.highlighting.annotations[0].comment);
    assert.equal(saved.author, 'Original author'); assert.equal(saved.createdAt, '2026-01-01T00:45:00.000Z');
    assert.equal(saved.replies[0].createdAt, '2026-01-02T01:15:00.000Z');
    assert.deepEqual(await thread.locator('.annotation-comment-author').allTextContents(), ['Original author', 'Example']);
  });
});

test('stored UTC dates display in the system timezone across date boundaries and daylight saving', async () => {
  for (const scenario of [
    { zone: 'Asia/Taipei', winter: 'Jan 1, 2026, 8:30 AM', summer: 'Jul 1, 2026, 8:30 AM' },
    { zone: 'America/Los_Angeles', winter: 'Dec 31, 2025, 4:30 PM', summer: 'Jun 30, 2026, 5:30 PM' },
  ]) {
    await inPage(async page => {
      assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), scenario.zone);
      for (const [utc, expected] of [['2026-01-01T00:30:00Z', scenario.winter], ['2026-07-01T00:30:00Z', scenario.summer]]) {
        await page.evaluate(createdAt => commentView.highlighting.replace([{ id: 'timezone-test', color: 'blue', anchor: { unit: 'utf8-byte', start: 0, end: 13 },
          comment: { id: 'timezone-comment', text: 'Local time display', author: 'Example', createdAt, replies: [] },
        }]), utc);
        const date = page.locator('.annotation-comment-date');
        assert.equal((await date.textContent()).replace(/\s+/g, ' '), expected);
        assert.equal(await date.getAttribute('datetime'), utc.replace('Z', '.000Z'));
        assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].comment.createdAt), utc.replace('Z', '.000Z'));
      }
    }, false, source, { timezoneId: scenario.zone, locale: 'en-US' });
  }
});
