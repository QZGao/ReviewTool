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

async function inPage(callback, real = false, fixtureSource = source, contextOptions = {}, commentUserGroups = []) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...contextOptions }); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
  try {
    await page.goto(server.url + (real ? '/?article=sun-yat-sen#求學' : '/lab'));
    await page.waitForFunction(real ? () => Boolean(window.annotationPageLab) : () => Boolean(window.annotationLab));
    if (!real) await page.evaluate(({ source, commentUserGroups }) => {
      const api = annotationLab.annotation; annotationLab.view.destroy();
      document.body.innerHTML = '<div id="comment-fixture"><div id="mw-content-text"><div class="mw-parser-output">Original article</div></div><div class="vector-column-end no-font-mode-scale"></div></div>';
      const style = document.createElement('style'); style.textContent = '#comment-fixture {display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:30px;margin:80px 30px} @media(max-width:800px){#comment-fixture{display:block;margin:80px 16px}}'; document.head.append(style);
      window.commentEvents = [];
      window.reasonRequests = [];
      const requestModerationReason = (action, signal) => new Promise(resolve => {
        reasonRequests.push(action);
        window.pendingReason = reason => { window.pendingReason = null; resolve(reason); };
        signal.addEventListener('abort', () => { if (window.pendingReason) window.pendingReason(null); }, { once: true });
      });
      window.commentMount = api.mountWikipediaAnnotation(document, api.createProjection(source), { comments: true, commentAuthor: 'Example', commentUserGroups, requestModerationReason, highlighting: { onChange: (annotations, action) => commentEvents.push({ annotations, action }) } });
      window.commentView = commentMount.view;
    }, { source: fixtureSource, commentUserGroups });
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
  await page.locator('[data-annotation-toolbar]').getByRole('button', { name: `${({ Red: '紅色', Yellow: '黃色', Green: '綠色', Blue: '藍色' })[color]}高亮`, exact: true }).click();
  const id = await page.evaluate(() => commentView.highlighting.annotations.at(-1).id);
  const thread = page.locator(`[data-annotation-id="${id}"].annotation-comment-thread`);
  await thread.getByRole('button', { name: '新增評論…' }).waitFor({ state: 'visible' });
  return thread;
}
async function send(thread, text, label = '送出') {
  const placeholder = thread.getByRole('button', { name: /^(新增評論|另寫評論)…$/ });
  if (!await thread.getByRole('textbox').count()) { await thread.hover(); await placeholder.click(); }
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
    assert.equal(await thread.locator('.annotation-highlight-attribution').textContent(), '高亮：Example');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].author), 'Example');
    assert.equal(await thread.getByRole('textbox').count(), 0);
    assert.equal(await thread.getByRole('button', { name: '送出' }).count(), 0);
    assert.equal(await thread.evaluate(element => element.contains(document.activeElement)), false);
    assert.deepEqual(await page.evaluate(() => commentView.comments.drafts), []);
    const initial = await thread.evaluate(element => ({ top: element.getBoundingClientRect().top, sourceTop: commentView.restoreRange(commentView.highlighting.annotations[0].anchor).getClientRects()[0].top }));
    assert.ok(Math.abs(initial.top - initial.sourceTop) <= 1);
    await thread.getByRole('button', { name: '新增評論…' }).click(); await frames(page);
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
    assert.equal(await thread.getByRole('button', { name: '送出' }).isDisabled(), true);
    await thread.getByRole('button', { name: '放棄草稿' }).click();
    assert.equal(await thread.getByRole('button', { name: '新增評論…' }).isVisible(), true);
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations.length), 1);
  });
});

test('highlight attribution follows the original root author, preserves creation identity, and leaves legacy data unattributed', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage');
    await send(thread, 'My own thread');
    assert.equal(await thread.locator('.annotation-highlight-attribution').count(), 0);
    await page.evaluate(() => {
      const state = commentView.highlighting, annotation = state.annotations[0];
      state.replace([{ ...annotation, comment: { ...annotation.threads?.[0], author: 'Other', editedBy: 'Example', editedAt: '2026-09-24T00:00:00Z' } }]);
    });
    assert.equal(await thread.locator('.annotation-highlight-attribution').textContent(), '高亮：Example');
    assert.equal(await thread.locator('.annotation-comment-author').textContent(), 'Other（由 Example 編輯）');
    await page.evaluate(() => {
      const state = commentView.highlighting, annotation = state.annotations[0];
      state.replace([{ ...annotation, comment: { ...annotation.threads?.[0], author: 'Example', editedBy: 'Moderator' } }]);
    });
    assert.equal(await thread.locator('.annotation-highlight-attribution').count(), 0, 'latest editor does not change the thread author comparison');
    await page.evaluate(() => {
      const state = commentView.highlighting;
      state.replace([{ ...state.annotations[0], author: 'Another creator' }]);
      state.dispatch({ type: 'recolor-highlight', id: state.annotations[0].id, color: 'blue', editedAt: new Date().toISOString() });
    });
    assert.equal(await thread.locator('.annotation-highlight-attribution').textContent(), '高亮：Another creator', 'attribution updates even when the comment is unchanged');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].author), 'Another creator');
    assert.equal(await page.evaluate(() => {
      const state = commentView.highlighting, previous = state.annotations;
      try { state.replace([{ ...previous[0], author: '   ' }]); return false; }
      catch { return state.annotations === previous; }
    }), true);
    await page.evaluate(() => {
      const { author, threads, ...legacy } = commentView.highlighting.annotations[0];
      commentView.highlighting.replace([legacy]);
    });
    assert.equal(await thread.locator('.annotation-highlight-attribution').count(), 0);
    await send(thread, 'The first comment on an old highlight');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].author), undefined);
    assert.equal(await thread.locator('.annotation-highlight-attribution').count(), 0, 'a first comment never retroactively attributes an old highlight');
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
    await page.evaluate(() => commentView.highlighting.dispatch({ type: 'add-highlight', highlight: { ...makeComment('neighbor', 'linked words', 'Neighbor'), createdAt: new Date().toISOString() } }));
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

test('comments support nested replies and editing, but only the first comment can resolve the whole thread', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage'); await send(thread, 'Root comment');
    const root = await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].id);
    await act(page, root, '回覆'); await send(thread, 'First reply');
    const reply = await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].replies[0].id);
    await act(page, reply, '回覆'); await send(thread, 'Nested reply');
    await act(page, root, '回覆'); await send(thread, 'Sibling reply');
    const indent = await thread.locator('.annotation-comment-replies').first().evaluate(element => ({ width: getComputedStyle(element).borderLeftWidth, left: element.getBoundingClientRect().left, parent: element.parentElement.getBoundingClientRect().left }));
    assert.equal(indent.width, '1px'); assert.ok(indent.left > indent.parent);
    await act(page, root, '編輯'); await thread.getByRole('textbox').fill('Discard this'); await thread.getByRole('button', { name: '取消' }).click();
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].text), 'Root comment');
    await act(page, root, '編輯'); await send(thread, 'Edited root', '儲存修改');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].replies.length), 2);
    assert.equal(await thread.getByRole('button', { name: '結束討論', exact: true, includeHidden: true }).count(), 1);
    assert.equal(await body(page, reply).getByRole('button', { name: '結束討論', exact: true, includeHidden: true }).count(), 0);
    assert.equal(await page.evaluate(reply => {
      const state = commentView.highlighting, before = state.annotations, events = commentEvents.length;
      try { state.dispatch({ type: 'resolve-comment', id: before[0].id, commentId: reply }); return false; }
      catch (error) { return error.message === 'Only the first comment can resolve a thread.' && state.annotations === before && commentEvents.length === events; }
    }, reply), true, 'reply resolution is rejected transactionally even when called directly');
    await act(page, root, '結束討論');
    assert.equal(await thread.count(), 0); assert.equal(await page.evaluate(() => commentView.highlighting.annotations.filter(item => !item.deleted && !(item.threads?.length && item.threads.every(root => root.resolved))).length), 0);
    assert.equal(await page.evaluate(() => [...CSS.highlights.keys()].some(key => key.startsWith('reviewtool-marker-'))), false);
    assert.equal(await page.locator('.annotation-comment-connectors path').count(), 0);
  });
});

test('only the first comment author can remove a thread, including through the highlight toolbar', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage');
    await page.evaluate(() => {
      const state = commentView.highlighting;
      state.replace([{ ...state.annotations[0], comment: {
        id: 'other-root', text: 'Started by someone else', author: 'Other', createdAt: '2026-01-01T00:30:00.000Z',
        replies: [{ id: 'my-reply', text: 'My participation', author: 'Example', createdAt: '2026-01-01T00:31:00.000Z', replies: [] }],
      } }]);
    });
    await thread.hover();
    assert.equal(await thread.getByRole('button', { name: '結束討論', exact: true, includeHidden: true }).count(), 0);
    assert.equal(await body(page, 'other-root').getByRole('button', { name: '編輯', exact: true, includeHidden: true }).count(), 0);
    assert.equal(await body(page, 'my-reply').getByRole('button', { name: '編輯', exact: true, includeHidden: true }).count(), 1);
    assert.equal(await body(page, 'other-root').getByRole('button', { name: '回覆', exact: true, includeHidden: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => {
      const state = commentView.highlighting, before = state.annotations, events = commentEvents.length;
      return [
        { type: 'resolve-comment', id: before[0].id, commentId: 'other-root' },
        { type: 'resolve-comment', id: before[0].id, commentId: 'my-reply' },
        { type: 'delete-highlight', id: before[0].id },
        { type: 'edit-comment', id: before[0].id, commentId: 'other-root', text: 'Unauthorized edit', editedAt: new Date().toISOString() },
      ].map(action => {
        try { state.dispatch(action); return false; }
        catch { return state.annotations === before && commentEvents.length === events; }
      });
    }), [true, true, true, true]);
    await page.evaluate(() => {
      const range = commentView.restoreRange(commentView.highlighting.annotations[0].anchor);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.locator('[data-annotation-toolbar]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-delete-highlight]').isVisible(), false);
    assert.equal(await page.locator('[data-annotation-toolbar]').getByRole('button', { name: '綠色高亮', exact: true }).isVisible(), true);
  });
});

test('moderators resolve their own threads without a prompt, using root authorship rather than highlight ownership', async () => {
  for (const group of ['patroller', 'sysop', 'bureaucrat']) {
    await inPage(async page => {
      const thread = await mark(page, 'First passage'); await send(thread, 'My thread');
      const root = await page.evaluate(() => {
        const state = commentView.highlighting, annotation = state.annotations[0];
        state.replace([{ ...annotation, author: 'Other highlight creator', comment: { ...annotation.threads?.[0], editedBy: 'Other moderator', editedAt: '2026-09-24T00:00:00Z' } }]);
        return annotation.threads?.[0].id;
      });
      await act(page, root, '結束討論'); await thread.waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => reasonRequests), []);
      assert.equal(await page.evaluate(() => commentEvents.at(-1).action.reason), undefined);
      assert.equal(await page.evaluate(() => commentView.highlighting.annotations.filter(item => !item.deleted && !(item.threads?.length && item.threads.every(root => root.resolved))).length), 0);
    }, false, source, {}, [group]);
  }
});

test('moderator reasons precede editing/removal, survive the draft, and record the actual editor', async () => {
  for (const group of ['patroller', 'sysop', 'bureaucrat']) {
    await inPage(async page => {
      const answer = async reason => {
        await page.waitForFunction(() => typeof pendingReason === 'function');
        await page.evaluate(reason => pendingReason(reason), reason);
      };
      const thread = await mark(page, 'First passage');
      await page.evaluate(() => {
        const annotation = commentView.highlighting.annotations[0];
        window.moderatedThread = { ...annotation, comment: {
          id: 'moderated-root', text: 'Other author’s comment', author: 'Other', createdAt: '2026-01-01T00:30:00.000Z',
          replies: [{ id: 'own-reply', text: 'My reply', author: 'Example', createdAt: '2026-01-02T00:30:00.000Z', replies: [] }],
        } };
        commentView.highlighting.replace([moderatedThread]);
      });
      assert.equal(await thread.getByRole('button', { name: '結束討論', exact: true, includeHidden: true }).count(), 1);
      assert.equal(await body(page, 'own-reply').getByRole('button', { name: '結束討論', exact: true, includeHidden: true }).count(), 0);
      await act(page, 'moderated-root', '編輯');
      assert.equal(await thread.getByRole('textbox').count(), 0, 'reason is requested before the editor exists');
      await answer(null);
      assert.equal(await thread.getByRole('textbox').count(), 0);
      assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].text), 'Other author’s comment');
      await act(page, 'moderated-root', '編輯'); await answer('Correct the quotation');
      await thread.getByRole('textbox').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => commentView.comments.drafts[0].reason), 'Correct the quotation');
      await page.clock.setFixedTime('2026-09-24T01:02:03Z');
      const promptsBeforeSave = await page.evaluate(() => reasonRequests.length);
      await send(thread, 'Corrected quotation', '儲存修改');
      assert.equal(await page.evaluate(() => reasonRequests.length), promptsBeforeSave, 'Save does not ask again');
      const saved = await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0]);
      assert.equal(saved.author, 'Other'); assert.equal(saved.editedBy, 'Example'); assert.equal(saved.editedAt, '2026-09-24T01:02:03.000Z');
      assert.equal(await body(page, 'moderated-root').locator('.annotation-comment-author').textContent(), 'Other（由 Example 編輯）');
      assert.match(await body(page, 'moderated-root').locator('time').textContent(), /（已編輯）$/);
      const requestsBeforeOwnEdit = await page.evaluate(() => reasonRequests.length);
      await act(page, 'own-reply', '編輯');
      await send(thread, 'My clarified reply', '儲存修改');
      assert.equal(await page.evaluate(() => reasonRequests.length), requestsBeforeOwnEdit);
      assert.equal(await body(page, 'own-reply').locator('.annotation-comment-author').textContent(), 'Example');
      await act(page, 'moderated-root', '結束討論'); await answer(null);
      assert.equal(await thread.count(), 1);
      await act(page, 'moderated-root', '結束討論'); await answer('Discussion concluded');
      await thread.waitFor({ state: 'detached' });
      await page.evaluate(() => {
        commentView.highlighting.replace([moderatedThread]);
        const range = commentView.restoreRange(moderatedThread.anchor);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      const remove = page.locator('[data-annotation-toolbar]').getByRole('button', { name: '刪除高亮', exact: true });
      await remove.click(); await answer(null);
      assert.equal(await thread.count(), 1);
      await remove.click(); await answer('Duplicate thread');
      await thread.waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => commentEvents.filter(event => event.action.reason).map(event => event.action.reason)),
        ['Correct the quotation', 'Discussion concluded', 'Duplicate thread']);
    }, false, source, {}, [group]);
  }
});

test('moderators edit their own comments and delete their own highlights/threads without prompts, including restored drafts', async () => {
  for (const group of ['patroller', 'sysop', 'bureaucrat']) {
    await inPage(async page => {
      const remove = async thread => {
        await page.evaluate(() => {
          const range = commentView.restoreRange(commentView.highlighting.annotations.filter(item => !item.deleted)[0].anchor);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        });
        await page.locator('[data-annotation-toolbar]').getByRole('button', { name: '刪除高亮', exact: true }).click();
        await thread.waitFor({ state: 'detached' });
      };
      await remove(await mark(page, 'First passage'));
      const thread = await mark(page, 'First passage'); await send(thread, 'My comment');
      const root = await page.evaluate(() => commentView.highlighting.annotations.filter(item => !item.deleted)[0].threads?.[0].id);
      await act(page, root, '編輯'); await thread.getByRole('textbox').fill('My restored edit');
      await page.evaluate(group => {
        const api = annotationLab.annotation, source = commentView.projection.source;
        const annotations = commentView.highlighting.annotations, drafts = commentView.comments.drafts;
        commentMount.destroy();
        window.commentMount = api.mountWikipediaAnnotation(document, api.createProjection(source), {
          comments: true, commentAuthor: 'Example', commentUserGroups: [group], commentDrafts: drafts,
          requestModerationReason: async action => { reasonRequests.push(action); return null; },
          highlighting: { initial: annotations, onChange: (annotations, action) => commentEvents.push({ annotations, action }) },
        });
        window.commentView = commentMount.view;
      }, group);
      assert.equal(await thread.getByRole('textbox').inputValue(), 'My restored edit');
      await send(thread, 'My restored edit', '儲存修改');
      assert.equal(await page.evaluate(() => commentView.highlighting.annotations.filter(item => !item.deleted)[0].threads?.[0].text), 'My restored edit');
      await remove(thread);
      assert.deepEqual(await page.evaluate(() => reasonRequests), []);
      assert.equal(await page.evaluate(() => commentEvents.some(event => event.action.reason)), false);
    }, false, source, {}, [group]);
  }
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
    const root = await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].id);
    await act(page, root, '編輯'); await page.mouse.move(0, 0);
    assert.equal(await thread.getByRole('button', { name: '儲存修改' }).evaluate(element => getComputedStyle(element.parentElement).opacity), '1');
    const selection = await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('.annotation-comment-thread'));
      return commentView.readRange(range);
    });
    assert.equal(selection, null);
    await thread.getByRole('button', { name: '取消' }).click();
    const initial = await page.evaluate(() => commentView.highlighting.annotations);
    await page.evaluate(() => { const state = commentView.highlighting; state.dispatch({ type: 'recolor-highlight', id: state.annotations[0].id, color: 'Blue'.toLowerCase(), editedAt: new Date().toISOString() }); });
    assert.equal(await thread.getAttribute('data-color'), 'blue');
    assert.deepEqual(await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0]), initial[0].threads?.[0]);
  });
});

test('editing uses Save changes/Cancel and a gray disabled button until the saved text changes', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage'); await send(thread, 'Original');
    const root = await page.evaluate(() => {
      const annotation = commentView.highlighting.annotations[0];
      // A textarea normalizes line endings; opening imported CRLF text is not an edit.
      commentView.highlighting.dispatch({ type: 'edit-comment', id: annotation.id, commentId: annotation.threads?.[0].id, text: 'Original\r\nsecond line', editedAt: new Date().toISOString() });
      return annotation.threads?.[0].id;
    });
    await act(page, root, '編輯');
    const input = thread.getByRole('textbox'), save = thread.getByRole('button', { name: '儲存修改', exact: true }), cancel = thread.getByRole('button', { name: '取消', exact: true });
    assert.equal(await input.inputValue(), 'Original\nsecond line');
    assert.equal(await save.isDisabled(), true);
    assert.equal(await thread.getByRole('button', { name: '送出', exact: true }).count(), 0);
    assert.equal(await thread.getByRole('button', { name: '放棄草稿', exact: true }).count(), 0);
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
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].text), 'Original\r\nsecond line');
    await act(page, root, '編輯'); await send(thread, 'Saved change', '儲存修改');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].text), 'Saved change');
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
    const content = thread.locator('.annotation-comment-content');
    await content.hover(); await frames(page);
    const beforeWheel = await content.evaluate(element => element.scrollTop);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(start => {
      const element = document.querySelector('.annotation-comment-content');
      return element.scrollTop >= Math.min(start + 300, element.scrollHeight - element.clientHeight) - 1;
    }, beforeWheel);
    await frames(page);
    assert.equal(await panel.isVisible(), true, 'scrolling long content keeps the floating card open');
    const readingPosition = () => thread.locator('.annotation-comment-text').first().evaluate(element => element.getBoundingClientRect().top - element.closest('.annotation-comment-content').getBoundingClientRect().top);
    const beforeUpdate = await readingPosition();
    await page.evaluate(() => {
      const state = commentView.highlighting, annotation = state.annotations[0];
      state.replace([{ ...annotation, comment: { ...annotation.threads?.[0], replies: [{ id: 'incoming-reply', text: 'An incoming reply', author: 'Other', createdAt: '2026-09-24T00:00:00Z', replies: [] }] } }]);
    });
    await frames(page);
    assert.ok(Math.abs(await readingPosition() - beforeUpdate) <= 1, 'a thread update preserves the visible text position');
    await panel.hover(); await page.waitForTimeout(230); assert.equal(await panel.isVisible(), true);
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(0, 0); await page.waitForTimeout(230); assert.equal(await panel.isVisible(), false);
    await page.evaluate(() => commentView.highlighting.dispatch({ type: 'add-highlight', highlight: { id: 'narrow-new', createdAt: new Date().toISOString(), anchor: { unit: 'utf8-byte', start: 0, end: 13 }, color: 'red' } }));
    await frames(page); assert.equal(await panel.isVisible(), false, 'new narrow-screen threads wait for highlight hover');
    await page.locator('.annotation-document [data-source-run]').first().hover();
    await panel.getByRole('button', { name: '新增評論…' }).waitFor({ state: 'visible' });
    assert.equal(await panel.getByRole('textbox').count(), 0);
    await panel.getByRole('button', { name: '新增評論…' }).click();
    await panel.getByRole('textbox', { name: '評論內容' }).waitFor({ state: 'visible' });
    assert.equal(await panel.getByRole('button', { name: '送出' }).isVisible(), true);
  });
});

test('real Wikipedia comments survive view toggles, preserve the sidebar, and clean up completely', async () => {
  await inPage(async page => {
    const thread = await mark(page, '1879年5月21日', 'Red'); await send(thread, 'Check the date and source.');
    const saved = await page.evaluate(() => commentView.highlighting.annotations);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => annotationPageLab.setTheme(theme), theme); await frames(page);
      await page.screenshot({ path: `.cache/annotation-rnd/comments-${theme}.png` });
      await act(page, saved[0].threads?.[0].id, '編輯');
      assert.equal(await thread.getByRole('button', { name: '儲存修改' }).isDisabled(), true);
      const colors = await thread.locator('.annotation-comment-editor-actions button').evaluateAll(buttons => buttons.map(button => getComputedStyle(button).color));
      assert.notEqual(colors[0], colors[1], `${theme}: disabled save has a distinct gray color`);
      await page.screenshot({ path: `.cache/annotation-rnd/comment-edit-${theme}.png` });
      await thread.getByRole('button', { name: '取消' }).click();
    }
    await page.evaluate(() => annotationPageLab.setEnabled(false));
    assert.equal(await page.locator('.annotation-comments, .annotation-comment-connectors').count(), 0);
    assert.ok(await page.locator('div.vector-column-end.no-font-mode-scale > .vector-sticky-pinned-container').count() > 0);
    await page.evaluate(() => { annotationPageLab.setEnabled(true); window.commentView = annotationPageLab.view; });
    assert.deepEqual(await page.evaluate(() => commentView.highlighting.annotations), saved);
    assert.equal(await page.locator('.annotation-comment-text').textContent(), 'Check the date and source.');
    await act(page, saved[0].threads?.[0].id, '編輯');
    await page.locator('.annotation-comments textarea').fill('Unsent revision');
    await page.evaluate(() => { annotationPageLab.setEnabled(false); annotationPageLab.setEnabled(true); window.commentView = annotationPageLab.view; });
    assert.equal(await page.locator('.annotation-comments textarea').inputValue(), 'Unsent revision');
    assert.equal(await page.locator('.annotation-comments').getByRole('button', { name: '儲存修改' }).isEnabled(), true);
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
      const state = commentView.highlighting, original = state.annotations, root = original[0].threads?.[0];
      const incoming = { id: 'test-reply', text: '回覆', author: 'Example', createdAt: '2026-01-01T00:30:00.000Z', replies: [] };
      state.dispatch({ type: 'add-comment', id: original[0].id, parentId: root.id, comment: incoming });
      incoming.text = 'Mutated outside';
      const action = commentEvents.at(-1).action, committed = state.annotations;
      let rejected = 0;
      for (const run of [
        () => state.dispatch({ type: 'edit-comment', id: original[0].id, commentId: root.id, text: '  ', editedAt: new Date().toISOString() }),
        () => state.dispatch({ type: 'add-comment', id: original[0].id, parentId: 'missing', comment: { id: 'another', text: 'Text', author: 'Example', createdAt: '2026-01-01T00:30:00.000Z', replies: [] } }),
        () => state.replace([{ ...committed[0], comment: { ...root, replies: [root] } }]),
        () => state.replace([{ ...committed[0], comment: { ...root, author: '' } }]),
        () => state.replace([{ ...committed[0], comment: { ...root, createdAt: '2026-01-01T00:30:00' } }]),
        () => state.replace([{ ...committed[0], comment: { ...root, createdAt: '2026-02-30T00:30:00Z' } }]),
        () => state.replace([{ ...committed[0], comment: { ...root, editedAt: '2026-01-01T00:30:00' } }]),
        () => state.dispatch({ type: 'edit-comment', id: original[0].id, commentId: root.id, text: 'Invalid date', editedAt: '2026-02-30T00:30:00Z' }),
      ]) { try { run(); } catch { rejected++; } }
      return { rejected, unchanged: state.annotations === committed, original: original[0].threads?.[0].text,
        reply: committed[0].threads?.[0].replies[0].text, action: action.comment.text,
        frozen: Object.isFrozen(committed[0].threads?.[0].replies) && Object.isFrozen(committed[0].threads?.[0].replies[0]) && Object.isFrozen(action.comment) };
    });
    assert.deepEqual(result, { rejected: 8, unchanged: true, original: 'Original', reply: '回覆', action: '回覆', frozen: true });
  });
});

test('editing preserves the original author/posting time and displays the latest UTC edit time with an edited suffix', async () => {
  await inPage(async page => {
    await page.clock.setFixedTime('2026-01-01T00:30:00Z');
    const thread = await mark(page, 'First passage');
    await thread.getByRole('button', { name: '新增評論…' }).click();
    assert.equal(await thread.locator('.annotation-comment-author').textContent(), 'Example');
    assert.equal(await thread.locator('time').count(), 0, 'an unsent draft has no posting date');
    await page.clock.setFixedTime('2026-01-01T00:45:00Z');
    await send(thread, 'Root comment');
    let saved = await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0]);
    assert.equal(saved.author, 'Example'); assert.equal(saved.createdAt, '2026-01-01T00:45:00.000Z');
    const root = saved.id;
    await page.clock.setFixedTime('2026-01-02T01:15:00Z');
    await act(page, root, '回覆');
    assert.equal(await thread.locator('.annotation-comment-editor time').count(), 0);
    await send(thread, 'Reply comment');
    saved = await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0]);
    assert.equal(saved.replies[0].author, 'Example'); assert.equal(saved.replies[0].createdAt, '2026-01-02T01:15:00.000Z');
    assert.equal(saved.createdAt, '2026-01-01T00:45:00.000Z');
    await page.clock.setFixedTime('2026-02-03T04:00:00Z');
    await act(page, root, '編輯');
    assert.equal(await thread.locator('.annotation-comment-editor .annotation-comment-author').textContent(), 'Example');
    assert.equal(await thread.locator('.annotation-comment-editor time').getAttribute('datetime'), '2026-01-01T00:45:00.000Z');
    await send(thread, 'Edited root', '儲存修改');
    saved = await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0]);
    assert.equal(saved.author, 'Example'); assert.equal(saved.createdAt, '2026-01-01T00:45:00.000Z');
    assert.equal(saved.editedAt, '2026-02-03T04:00:00.000Z');
    assert.equal(await body(page, root).locator('time').getAttribute('datetime'), saved.editedAt);
    assert.match(await body(page, root).locator('time').textContent(), /（已編輯）$/);
    assert.equal(saved.replies[0].createdAt, '2026-01-02T01:15:00.000Z');
    assert.equal(saved.replies[0].editedAt, undefined);
    await page.clock.setFixedTime('2026-02-04T04:00:00Z');
    await act(page, root, '編輯');
    assert.equal(await thread.getByRole('button', { name: '儲存修改', exact: true }).isDisabled(), true);
    await thread.getByRole('textbox').fill('Canceled edit'); await thread.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].editedAt), saved.editedAt);
    await act(page, root, '編輯'); await send(thread, 'Edited again', '儲存修改');
    assert.equal(await body(page, root).locator('time').getAttribute('datetime'), '2026-02-04T04:00:00.000Z');
    assert.deepEqual(await thread.locator('.annotation-comment-author').allTextContents(), ['Example', 'Example']);
  });
});

test('stored UTC dates display in the system timezone across date boundaries and daylight saving', async () => {
  for (const scenario of [
    { zone: 'Asia/Taipei', winter: '2026年1月1日 上午8:30', summer: '2026年7月1日 上午8:30' },
    { zone: 'America/Los_Angeles', winter: '2025年12月31日 下午4:30', summer: '2026年6月30日 下午5:30' },
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
        assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads?.[0].createdAt), utc.replace('Z', '.000Z'));
        await page.evaluate(editedAt => {
          const annotation = commentView.highlighting.annotations[0];
          commentView.highlighting.replace([{ ...annotation, comment: { ...annotation.threads?.[0], createdAt: '2020-01-01T00:00:00Z', editedAt } }]);
        }, utc);
        assert.equal((await date.textContent()).replace(/\s+/g, ' '), expected + '（已編輯）');
        assert.equal(await date.getAttribute('datetime'), utc.replace('Z', '.000Z'));
      }
    }, false, source, { timezoneId: scenario.zone, locale: 'en-US' });
  }
});

test('multiple root discussions keep separate owners and resolving one preserves the other', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage'); await send(thread, 'My discussion');
    const id = await page.evaluate(() => {
      const state = commentView.highlighting, annotation = state.annotations[0];
      state.replace([{ ...annotation, threads: [...annotation.threads, { id: 'other-root', text: 'A separate discussion', author: 'Other', createdAt: '2026-09-26T00:00:00.000Z', replies: [] }] }]);
      return annotation.threads[0].id;
    });
    assert.equal(await body(page, 'other-root').getByRole('button', { name: '結束討論', exact: true, includeHidden: true }).count(), 0);
    await act(page, id, '結束討論');
    assert.equal(await thread.count(), 1); assert.equal(await thread.locator('.annotation-comment-text').textContent(), 'A separate discussion');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads[0].resolved.by), 'Example');
    await send(thread, 'Another top-level comment');
    assert.equal(await page.evaluate(() => commentView.highlighting.annotations[0].threads.length), 3);
    assert.equal(await thread.locator('.annotation-comment-text').count(), 2);
  });
});

test('remote updates preserve an active draft, caret, focus and article selection', async () => {
  await inPage(async page => {
    const thread = await mark(page, 'First passage'); await send(thread, 'Original root');
    await thread.hover();
    await thread.getByRole('button', { name: '另寫評論…' }).click();
    await thread.getByRole('textbox').fill('My unsent draft');
    await thread.getByRole('textbox').evaluate(input => input.setSelectionRange(3, 9, 'backward'));
    const before = await page.evaluate(() => commentView.selection);
    await page.evaluate(() => {
      const state = commentView.highlighting, annotation = state.annotations[0];
      state.replace([{ ...annotation, threads: [...annotation.threads, { id: 'remote-root', text: 'Arrived during typing', author: 'Other', createdAt: '2026-09-26T00:00:00.000Z', replies: [] }] }]);
    });
    assert.deepEqual(await thread.getByRole('textbox').evaluate(input => ({ text: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, focused: document.activeElement === input })), { text: 'My unsent draft', start: 3, end: 9, direction: 'backward', focused: true });
    assert.deepEqual(await page.evaluate(() => commentView.selection), before);
    assert.equal(await thread.locator('.annotation-comment-text').count(), 2);
  });
});
