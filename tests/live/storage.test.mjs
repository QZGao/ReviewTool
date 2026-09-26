import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { root } from './launch.mjs';

let storage;
before(async () => {
  const file = path.join(root, '.cache/live-storage-test.mjs');
  await build({ entryPoints: [path.join(root, 'src/annotation/live-storage.ts')], outfile: file, bundle: true, format: 'esm', platform: 'node' });
  storage = await import(pathToFileURL(file));
});
const identity = { wiki: 'zhwiki', pageId: 123, revisionId: 456 };
const marker = { id: 'a', anchor: { unit: 'utf8-byte', start: 0, end: 4 }, color: 'blue', createdAt: '2026-09-23T00:00:00.000Z' };
const comment = { id: 'message', text: 'Original', author: 'Example', createdAt: '2026-09-23T00:00:00.000Z', replies: [] };
const editedAt = '2026-09-24T00:00:00.000Z';

test('moderator groups can edit/remove other users’ content only with a valid reason; regular edits require authorship', () => {
  const thread = { ...marker, comment }, before = [thread];
  const edit = { type: 'edit-comment', id: marker.id, commentId: comment.id, text: 'Corrected', editedAt, reason: 'Remove personal information' };
  const resolve = { type: 'resolve-comment', id: marker.id, commentId: comment.id, reason: 'Discussion completed' };
  const remove = { type: 'delete-highlight', id: marker.id, reason: 'Duplicate thread' };
  for (const group of ['patroller', 'sysop', 'bureaucrat']) {
    const actor = { name: 'Moderator', groups: [group] };
    const edited = storage.replay(before, [{ action: edit, before }], () => true, actor);
    assert.equal(edited[0].comment.text, 'Corrected'); assert.equal(edited[0].comment.author, 'Example');
    assert.equal(edited[0].comment.createdAt, comment.createdAt); assert.equal(edited[0].comment.editedAt, editedAt); assert.equal(edited[0].comment.editedBy, 'Moderator');
    assert.deepEqual(storage.replay(edited, [{ action: edit, before }], () => true, actor), edited);
    for (const action of [resolve, remove]) assert.deepEqual(storage.replay(before, [{ action, before }], () => true, actor), []);
    for (const action of [edit, resolve, remove]) {
      for (const reason of [undefined, '  ', '😀'.repeat(501)]) {
        assert.throws(() => storage.replay(before, [{ action: { ...action, reason }, before }], () => true, actor), /reason/);
      }
      const ownResult = storage.replay(before, [{ action: { ...action, reason: undefined }, before }], () => true, { ...actor, name: 'Example' });
      assert.equal(action.type === 'edit-comment' ? ownResult[0].comment.text : ownResult.length, action.type === 'edit-comment' ? 'Corrected' : 0);
    }
    assert.throws(() => storage.replay(before, [{ action: { ...resolve, commentId: 'reply' }, before }], () => true, actor), /Only the first/);
  }
  for (const actor of [{ name: 'Other' }, { name: 'Other', groups: ['autopatrolled', 'rollbacker'] }, {}]) {
    assert.throws(() => storage.replay(before, [{ action: edit, before }], () => true, actor), /Only the comment author/);
  }
  assert.equal(storage.replay(before, [{ action: { ...edit, reason: undefined }, before }], () => true, { name: 'Example' })[0].comment.editedAt, editedAt);
});

test('moderators can resolve their own root without a reason, including saves/retries, but fresh foreign ownership still requires one', async () => {
  const thread = { ...marker, author: 'Different highlight creator', comment };
  const action = { type: 'resolve-comment', id: marker.id, commentId: comment.id };
  const pending = [{ action, before: [thread] }];
  for (const group of ['patroller', 'sysop', 'bureaucrat']) {
    const actor = { name: 'Example', groups: [group] };
    assert.deepEqual(storage.replay([thread], pending, () => true, actor), []);
    assert.deepEqual(storage.replay([], pending, () => true, actor), [], 'a successful submission remains retryable without a reason');
    assert.throws(() => storage.replay([{ ...thread, comment: { ...comment, author: 'Other' } }], pending, () => true, actor), /reason/);
    let written, summary;
    const queue = storage.saveQueue({ identity, actor, validate: () => true,
      read: async () => ({ text: storage.encodeData(identity, [thread]), revision: 1 }),
      write: async (text, base, editSummary) => { written = storage.decodeData(text, identity); summary = editSummary; },
      saved: () => {}, status: () => {},
    });
    queue.add(action, [thread]); await queue.flush();
    assert.equal(queue.dirty, false); assert.deepEqual(written, []);
    assert.equal(summary, 'ReviewTool: update revision annotations'); queue.destroy();
  }
});

test('reasoned actions get individual wiki edits and retain their exact summaries and edit times on conflict retry', async () => {
  const thread = { ...marker, comment }, bare = { ...marker, id: 'bare', author: 'Other' };
  const edited = { ...thread, comment: { ...comment, text: 'Corrected', editedAt, editedBy: 'Moderator' } };
  let page = { text: storage.encodeData(identity, [thread]), revision: 1 }, conflict = true, saved;
  const attempts = [], writes = [];
  const queue = storage.saveQueue({ identity, actor: { name: 'Moderator', groups: ['sysop'] }, validate: () => true, read: async () => page,
    write: async (text, base, summary) => {
      attempts.push(summary);
      if (summary === 'Correct inaccurate quotation' && conflict) { conflict = false; throw new Error('editconflict'); }
      assert.equal(base.revision, page.revision);
      page = { text, revision: page.revision + 1 }; writes.push({ summary, data: storage.decodeData(text, identity) });
    }, saved: annotations => { saved = annotations; }, status: () => {},
  });
  queue.add({ type: 'add-highlight', highlight: bare }, [thread]);
  queue.add({ type: 'edit-comment', id: marker.id, commentId: comment.id, text: 'Corrected', editedAt, reason: 'Correct inaccurate quotation' }, [thread, bare]);
  queue.add({ type: 'resolve-comment', id: marker.id, commentId: comment.id, reason: 'Question answered' }, [edited, bare]);
  queue.add({ type: 'delete-highlight', id: bare.id, reason: 'Stray marker' }, [bare]);
  await queue.flush();
  assert.equal(queue.dirty, false); assert.deepEqual(saved, []);
  assert.deepEqual(writes.map(write => write.summary), ['ReviewTool: update revision annotations', 'Correct inaccurate quotation', 'Question answered', 'Stray marker']);
  assert.deepEqual(attempts, ['ReviewTool: update revision annotations', 'Correct inaccurate quotation', 'Correct inaccurate quotation', 'Question answered', 'Stray marker']);
  assert.equal(writes[0].data[0].comment.editedAt, undefined);
  assert.equal(writes[1].data[0].comment.editedAt, editedAt);
  assert.deepEqual(writes[2].data, [bare]);
  queue.destroy();
});

test('own edits and highlight/thread deletions use ordinary saves even for moderators', async () => {
  for (const group of ['patroller', 'sysop', 'bureaucrat']) {
    const actor = { name: 'Example', groups: [group] };
    const ownBare = { ...marker, author: 'Example' }, ownThread = { ...ownBare, comment };
    const edit = { type: 'edit-comment', id: marker.id, commentId: comment.id, text: 'My revision', editedAt };
    const remove = { type: 'delete-highlight', id: marker.id };
    for (const [initial, action] of [[ownThread, edit], [ownBare, remove], [ownThread, remove]]) {
      let written, summary;
      const queue = storage.saveQueue({ identity, actor, validate: () => true,
        read: async () => ({ text: storage.encodeData(identity, [initial]), revision: 1 }),
        write: async (text, base, editSummary) => { written = storage.decodeData(text, identity); summary = editSummary; },
        saved: () => {}, status: () => {},
      });
      queue.add(action, [initial]); await queue.flush();
      assert.equal(queue.dirty, false); assert.equal(summary, 'ReviewTool: update revision annotations');
      assert.equal(action.type === 'edit-comment' ? written[0].comment.text : written.length, action.type === 'edit-comment' ? 'My revision' : 0);
      queue.destroy();
    }
    const ownReply = { ...comment, id: 'my-reply' };
    const foreignThread = { ...ownBare, comment: { ...comment, author: 'Other', replies: [ownReply] } };
    assert.equal(storage.replay([foreignThread], [{ action: { ...edit, commentId: 'my-reply' }, before: [foreignThread] }], () => true, actor)[0].comment.replies[0].text, 'My revision');
    assert.throws(() => storage.replay([foreignThread], [{ action: remove, before: [foreignThread] }], () => true, actor), /reason/, 'own highlight does not confer ownership of someone else’s thread');
    const foreignBare = { ...ownBare, author: 'Other' };
    assert.throws(() => storage.replay([foreignBare], [{ action: remove, before: [ownBare] }], () => true, actor), /reason/);
    assert.throws(() => storage.replay([foreignBare], [{ action: remove, before: [foreignBare] }], () => true, { name: 'Example' }), /Only the highlight creator/);
  }
});

test('storage envelope safely round-trips comment text and rejects malformed or mismatched pages', () => {
  const data = [{ ...marker, author: 'Highlight creator', comment: { ...comment, text: '</syntaxhighlight>{{unsafe}}' } }];
  const encoded = storage.encodeData(identity, data);
  assert.ok(encoded.startsWith('{{ReviewTool annotation data page}}\n<syntaxhighlight lang="json">'));
  assert.equal(encoded.match(/<\/syntaxhighlight>/g).length, 1);
  assert.deepEqual(storage.decodeData(encoded, identity), data);
  assert.throws(() => storage.decodeData(encoded, { ...identity, revisionId: 999 }));
  assert.throws(() => storage.decodeData('corrupt', identity));
});

test('highlight authors survive replay and retries independently of comment authors', () => {
  const highlight = { ...marker, author: 'Highlight creator' };
  const creation = { action: { type: 'add-highlight', highlight }, before: [] };
  const result = storage.replay([], [creation, { action: { type: 'add-comment', id: marker.id, comment }, before: [highlight] }], () => true, { name: 'Example' });
  assert.equal(result[0].author, 'Highlight creator'); assert.equal(result[0].comment.author, 'Example');
  assert.deepEqual(storage.replay(result, [creation], () => true), result);
  assert.throws(() => storage.replay([{ ...result[0], author: 'Someone else' }], [creation], () => true), /Another edit/);
  const recolored = storage.replay(result, [{ action: { type: 'recolor-highlight', id: marker.id, color: 'red', editedAt }, before: result }], () => true, { name: 'Example' });
  assert.equal(recolored[0].author, 'Highlight creator');
  assert.deepEqual(storage.decodeData(storage.encodeData(identity, recolored), identity), recolored);
});

test('highlight timestamps and editor survive saves/retries without changing comment metadata or inventing legacy dates', async () => {
  const created = { ...marker, author: 'Creator' };
  const firstComment = { action: { type: 'add-comment', id: marker.id, comment }, before: [created] };
  const withComment = storage.replay([created], [firstComment], () => true, { name: 'Example' });
  assert.equal(withComment[0].createdAt, created.createdAt); assert.equal(withComment[0].editedAt, undefined);
  const editedComment = storage.replay(withComment, [{ action: { type: 'edit-comment', id: marker.id, commentId: comment.id, text: 'Comment edit', editedAt }, before: withComment }], () => true, { name: 'Example' });
  assert.equal(editedComment[0].editedAt, undefined); assert.equal(editedComment[0].editedBy, undefined);
  const action = { type: 'recolor-highlight', id: marker.id, color: 'red', editedAt };
  const pending = [{ action, before: editedComment }], actor = { name: 'Painter' };
  const colored = storage.replay(editedComment, pending, () => true, actor);
  assert.equal(colored[0].author, 'Creator'); assert.equal(colored[0].createdAt, created.createdAt);
  assert.equal(colored[0].editedAt, editedAt); assert.equal(colored[0].editedBy, 'Painter');
  assert.deepEqual(colored[0].comment, editedComment[0].comment);
  assert.deepEqual(storage.replay(colored, pending, () => true, actor), colored);
  assert.deepEqual(storage.decodeData(storage.encodeData(identity, colored), identity), colored);
  assert.throws(() => storage.replay(editedComment, pending, () => true), /current user/);
  const intervening = { ...editedComment[0], editedAt: '2026-09-24T01:00:00.000Z', editedBy: 'Another painter' };
  assert.throws(() => storage.replay([intervening], pending, () => true, actor), /Another edit/);
  const alreadySameColor = { ...intervening, color: 'red' };
  assert.deepEqual(storage.replay([alreadySameColor], pending, () => true, actor), [alreadySameColor], 'an already-matching color keeps the actual editor/time');
  const { createdAt, ...legacy } = created;
  const legacyEdited = storage.replay([legacy], [{ action, before: [legacy] }], () => true, actor);
  assert.equal(legacyEdited[0].createdAt, undefined); assert.equal(legacyEdited[0].editedAt, editedAt);
  assert.throws(() => storage.replay([], [{ action: { type: 'add-highlight', highlight: legacy }, before: [] }], () => true, actor), /creation time/);
  assert.throws(() => storage.replay([created], [{ action: { type: 'add-highlight', highlight: { ...created, createdAt: editedAt } }, before: [] }], () => true, actor), /Another edit/);

  const attempts = []; let committed;
  const queue = storage.saveQueue({ identity, actor, validate: () => true,
    read: async () => ({ text: storage.encodeData(identity, editedComment), revision: 1 }),
    write: async text => { attempts.push(storage.decodeData(text, identity)); if (attempts.length === 1) throw new Error('editconflict'); },
    saved: data => { committed = data; }, status: () => {},
  });
  queue.add(action, editedComment); await queue.flush();
  assert.equal(queue.dirty, false); assert.deepEqual(attempts, [colored, colored]); assert.deepEqual(committed, colored);
  queue.destroy();
});

test('replay preserves independent remote additions, recognizes successful retries, and rejects conflicting edits', () => {
  const remote = { ...marker, id: 'remote' };
  const batch = [{ action: { type: 'add-highlight', highlight: marker }, before: [] }, { action: { type: 'add-comment', id: 'a', comment }, before: [marker] }];
  const result = storage.replay([remote], batch, () => true);
  assert.deepEqual(result, [remote, { ...marker, comment }]);
  assert.deepEqual(storage.replay(result, batch, () => true), result);
  const edit = { action: { type: 'edit-comment', id: 'a', commentId: 'message', text: 'Local edit', editedAt: '2026-09-24T00:00:00.000Z' }, before: [{ ...marker, comment }] };
  assert.throws(() => storage.replay([{ ...marker, comment: { ...comment, text: 'Remote edit' } }], [edit], () => true, { name: 'Example' }), /Another edit/);
  const resolution = { action: { type: 'resolve-comment', id: 'a', commentId: 'message' }, before: [{ ...marker, comment }] };
  assert.deepEqual(storage.replay([], [resolution], () => true, { name: 'Example' }), []);
  assert.throws(() => storage.replay([{ ...marker, comment: { ...comment, replies: [{ ...comment, id: 'reply' }] } }], [resolution], () => true, { name: 'Example' }));
});

test('thread removal checks the root author against fresh data and rejects reply resolution, including retries', async () => {
  const thread = { ...marker, comment: { ...comment, replies: [{ ...comment, id: 'reply', author: 'Other' }] } };
  const resolution = { action: { type: 'resolve-comment', id: marker.id, commentId: comment.id }, before: [thread] };
  assert.deepEqual(storage.replay([thread], [resolution], () => true, { name: 'Example' }), []);
  for (const author of ['Other', undefined]) {
    assert.throws(() => storage.replay([thread], [resolution], () => true, { name: author }), /Only the author/);
    assert.throws(() => storage.replay([], [resolution], () => true, { name: author }), /Only the author/);
    assert.throws(() => storage.replay([thread], [{ ...resolution, action: { type: 'delete-highlight', id: marker.id } }], () => true, { name: author }), /Only the author/);
  }
  const reply = { ...resolution, action: { ...resolution.action, commentId: 'reply' } };
  assert.throws(() => storage.replay([thread], [reply], () => true, { name: 'Example' }), /Only the first comment/);
  assert.throws(() => storage.replay([], [reply], () => true, { name: 'Other' }), /Only the first comment/);
  const changedOwner = { ...thread, comment: { ...thread.comment, author: 'Other' } };
  assert.throws(() => storage.replay([changedOwner], [resolution], () => true, { name: 'Example' }), /Only the author/);
  let writes = 0, status;
  const queue = storage.saveQueue({ identity, actor: { name: 'Example' }, validate: () => true,
    read: async () => ({ text: storage.encodeData(identity, [changedOwner]), revision: 2 }),
    write: async () => { writes++; }, saved: () => {}, status: message => { status = message; },
  });
  queue.add(resolution.action, resolution.before); await queue.flush();
  assert.equal(writes, 0); assert.equal(queue.dirty, true); assert.match(status, /Only the author/);
  queue.destroy();
});

test('the save queue retries CAS conflicts, bundles actions, and retains changes after a failed save', async () => {
  let page = null, writes = 0, saved;
  const queue = storage.saveQueue({ identity, actor: { name: 'Example' }, validate: () => true, read: async () => page,
    write: async text => { if (++writes === 1) { page = { text: storage.encodeData(identity, [{ ...marker, id: 'remote' }]), revision: 1 }; throw new Error('editconflict'); } page = { text, revision: 2 }; },
    saved: annotations => { saved = annotations; }, status: () => {},
  });
  queue.add({ type: 'add-highlight', highlight: marker }, []);
  queue.add({ type: 'add-comment', id: 'a', comment }, [marker]);
  await queue.flush();
  assert.equal(queue.dirty, false); assert.equal(writes, 2); assert.equal(saved.length, 2);
  queue.destroy();
  let failing = true;
  const retry = storage.saveQueue({ identity, actor: { name: 'Example' }, validate: () => true, read: async () => null, write: async () => { if (failing) throw new Error('offline'); }, saved: () => {}, status: () => {} });
  retry.add({ type: 'add-highlight', highlight: marker }, []); await retry.flush(); assert.equal(retry.dirty, true);
  failing = false; await retry.flush(); assert.equal(retry.dirty, false); retry.destroy();
});
