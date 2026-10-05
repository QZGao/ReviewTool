import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let api;
before(async () => {
  const outfile = path.resolve('.cache/notification-test.mjs');
  await build({ stdin: { contents: ['activity', 'activity-tracker', 'visits', 'subscription-check', 'record-document', 'sync', 'live-storage'].map(name => `export * from './src/annotation/${name}.ts';`).join('\n'), resolveDir: process.cwd() }, outfile, bundle: true, format: 'esm', platform: 'node' });
  api = await import(pathToFileURL(outfile));
});
class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  key(index) { return [...this.values.keys()][index] ?? null; }
}
const at = '2026-10-06T00:00:00.000Z';
const marker = { id: 'highlight', color: 'yellow', author: 'Alice', createdAt: at, anchor: { unit: 'utf8-byte', start: 0, end: 6 } };
const comment = (id, author) => ({ id, author, text: id, createdAt: at, replies: [] });
const doc = () => api.AnnotationDocument.seed('g', [marker], () => true);
const published = (doc, revision) => ({ records: doc.toJSON(), generation: doc.generation, revision });
const add = (doc, id, author = 'Bob', parentId) => doc.dispatch({ type: 'add-comment', id: 'highlight', comment: comment(id, author), ...(parentId ? { parentId } : {}) }, { name: author });
const setup = (overrides = {}) => {
  const storage = new MemoryStorage(), visits = api.annotationVisits(storage, 'normal/zhwiki'), shown = [], errors = [];
  const tracker = api.activityTracker({ visits, pageName: 'Test', oldid: 2, viewer: 'Alice', show: group => shown.push(group), read: async () => { throw new Error('No historical read expected'); }, error: error => errors.push(error), ...overrides });
  return { storage, visits, shown, errors, tracker };
};

test('a first visit establishes a quiet baseline, then each remote action gets its own notification', async () => {
  const model = doc(); add(model, 'old');
  const { tracker, visits, shown, errors } = setup();
  await tracker.receive(published(model, 100));
  assert.equal(shown.length, 0); assert.equal(visits.get(2).viewedRevision, 100);
  add(model, 'new'); add(model, 'reply', 'Carol', 'new'); add(model, 'own', 'Alice');
  await tracker.receive(published(model, 200));
  assert.deepEqual(shown.map(group => group.actions.map(action => action.commentId)), [['new'], ['reply']]);
  await tracker.receive(published(model, 200));
  assert.equal(shown.length, 2); assert.equal(visits.get(2).viewedRevision, 200); assert.deepEqual(errors, []);
});

test('catch-up groups new descendants under their new ancestor; replies to old comments stay flat', async () => {
  const model = doc(); add(model, 'old'); const previous = published(model, 100);
  add(model, 'new'); add(model, 'child', 'Carol', 'new'); add(model, 'grandchild', 'Dan', 'child');
  add(model, 'old-reply', 'Ed', 'old'); add(model, 'sibling', 'Fay', 'old');
  const { tracker, visits, shown } = setup({ read: async id => { assert.equal(id, 100); return previous; } });
  visits.viewed('Test', 2, 100);
  await tracker.receive(published(model, 200));
  assert.deepEqual(shown.map(group => [group.target.commentId, group.actions.map(action => action.author)]), [
    ['new', ['Bob', 'Carol', 'Dan']], ['old-reply', ['Ed']], ['sibling', ['Fay']],
  ]);
  assert.equal(visits.get(2).viewedRevision, 200);
});

test('a newly viewed empty page reports its first remotely created annotations', async () => {
  const { tracker, visits, shown } = setup(); visits.viewed('Test', 2, 0);
  const model = doc(); add(model, 'first');
  await tracker.receive(published(model, 200));
  assert.equal(shown.length, 1); assert.equal(shown[0].target.commentId, 'first');
});

test('all action types retain actor, source and navigation target, including deletions', () => {
  const model = doc(); add(model, 'root'); const before = published(model, 1);
  model.dispatch({ type: 'edit-comment', id: marker.id, commentId: 'root', text: 'changed', editedAt: at }, { name: 'Bob' });
  model.dispatch({ type: 'recolor-highlight', id: marker.id, color: 'blue', editedAt: at }, { name: 'Bob' });
  model.dispatch({ type: 'set-thread-resolution', id: marker.id, commentId: 'root', resolved: true, at }, { name: 'Carol' });
  model.dispatch({ type: 'set-thread-resolution', id: marker.id, commentId: 'root', resolved: false, at }, { name: 'Carol' });
  model.dispatch({ type: 'resolve-comment', id: marker.id, commentId: 'root', at }, { name: 'Bob' });
  model.dispatch({ type: 'delete-highlight', id: marker.id, at, reason: 'test' }, { name: 'Mod', groups: ['sysop'] });
  const actions = api.annotationActivity(before, published(model, 2), 'Alice');
  assert.deepEqual(actions.map(action => action.record.kind), ['body', 'appearance', 'resolution', 'resolution', 'resolve', 'delete']);
  assert.ok(actions.every(action => action.highlightId === marker.id && action.anchor.end === 6));
  assert.deepEqual(actions.filter(action => action.commentId).map(action => action.commentId), ['root', 'root', 'root', 'root']);
});

test('own actions normalize username spaces and generation resets do not replay seeded history', () => {
  const model = doc(), before = published(model, 1); add(model, 'own', 'Example_User');
  assert.equal(api.annotationActivity(before, published(model, 2), 'Example User').length, 0);
  assert.equal(api.annotationActivity(before, { ...published(model, 2), generation: 'reset' }, '').length, 0);
});

test('serialized catch-up cannot be overtaken by a newer incoming revision', async () => {
  const model = doc(), old = published(model, 100); add(model, 'new'); const second = published(model, 200); add(model, 'later');
  let release; const pending = new Promise(resolve => { release = resolve; });
  const { tracker, visits, shown } = setup({ read: () => pending }); visits.viewed('Test', 2, 100);
  const first = tracker.receive(second), next = tracker.receive(published(model, 300));
  release(old); await Promise.all([first, next]);
  assert.deepEqual(shown.map(group => group.target.commentId), ['new', 'later']); assert.equal(visits.get(2).viewedRevision, 300);
});

test('unavailable old revisions report the gap without fabricating actions; closing cancels late catch-up', async () => {
  const model = doc(), fixture = setup(); fixture.visits.viewed('Test', 2, 99);
  await fixture.tracker.receive(published(model, 100));
  assert.equal(fixture.errors.length, 1); assert.equal(fixture.shown.length, 0); assert.equal(fixture.visits.get(2).viewedRevision, 100);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const stopped = setup({ read: () => pending }); stopped.visits.viewed('Test', 2, 99);
  const run = stopped.tracker.receive(published(model, 100)); stopped.tracker.destroy(); release(published(model, 99)); await run;
  assert.equal(stopped.visits.get(2).viewedRevision, 99); assert.equal(stopped.shown.length, 0);
});

test('subscription toggles preserve viewed revisions and other tabs cannot regress their baseline', () => {
  const storage = new MemoryStorage(), a = api.annotationVisits(storage, 'normal/zhwiki'), b = api.annotationVisits(storage, 'normal/zhwiki');
  a.viewed('Test', 2, 100); b.subscribe('Other', 3, true); a.subscribe('Test', 2, true); b.viewed('Renamed', 2, 200); a.viewed('Renamed', 2, 150);
  assert.deepEqual(a.get(2), { pageName: 'Renamed', oldid: 2, subscribed: true, viewedRevision: 200 });
  a.subscribe('Renamed', 2, false); assert.equal(a.get(2).viewedRevision, 200); assert.deepEqual(a.subscriptions().map(item => item.oldid), [3]);
  assert.equal(api.annotationVisits(storage, 'dry-run/zhwiki').subscriptions().length, 0);
});

test('background checks batch heads, count paginated metadata, and do not download content or change visits', async () => {
  const { visits, storage } = setup(); visits.viewed('Test', 2, 100); visits.subscribe('Test', 2, true); visits.viewed('Other', 3, 300); visits.subscribe('Other', 3, true);
  const before = [...storage.values], calls = [], shown = [], errors = [];
  await api.checkSubscriptions(async params => {
    calls.push(params); assert.equal(params.rvprop, 'ids'); assert.equal(params.rvslots, undefined);
    if (!params.rvlimit) return { query: { pages: [{ title: api.dataPageTitle(2), revisions: [{ revid: 900, parentid: 800 }] }, { title: api.dataPageTitle(3), revisions: [{ revid: 300, parentid: 0 }] }] } };
    if (!params.rvcontinue) return { query: { pages: [{ revisions: [{ revid: 900, parentid: 800 }] }] }, continue: { rvcontinue: 'next' } };
    return { query: { pages: [{ revisions: [{ revid: 800, parentid: 100 }, { revid: 100, parentid: 0 }] }] } };
  }, visits.subscriptions(), (visit, count) => shown.push([visit.oldid, count]), error => errors.push(error));
  assert.deepEqual(shown, [[2, 2]]); assert.equal(calls.length, 3); assert.equal(calls[0].titles, [2, 3].map(api.dataPageTitle).join('|'));
  assert.deepEqual([...storage.values], before); assert.deepEqual(errors, []);
});

test('background checks ignore missing pages and uninitialized baselines and handle request failures', async () => {
  const shown = [], errors = [], subscriptions = [2, 3, 4].map(oldid => ({ oldid, pageName: 'Test', subscribed: true, ...(oldid === 3 ? {} : { viewedRevision: 100 }) }));
  await api.checkSubscriptions(async params => {
    if (params.rvlimit) throw new Error('offline');
    return { query: { pages: [{ title: api.dataPageTitle(2), missing: true }, ...[3, 4].map(id => ({ title: api.dataPageTitle(id), revisions: [{ revid: 200, parentid: 100 }] }))] } };
  }, subscriptions, (...args) => shown.push(args), error => errors.push(error));
  assert.equal(shown.length, 0); assert.equal(errors.length, 1);
});

test('sync publication hook sees committed records after the UI, never optimistic local edits', async () => {
  const model = doc(), identity = { wiki: 'zhwiki', pageId: 1, revisionId: 2 };
  const encode = doc => api.encodePage(identity, { baseline: 0 }, doc);
  const pages = [{ revision: 100, parentId: 0, timestamp: at, summary: '/* ReviewTool */', tags: [], text: encode(model) }];
  const journal = new Map(), order = [];
  const sync = api.annotationSync({ identity, actor: { name: 'Alice' }, canWrite: true, validate: () => true, status() {},
    changed: () => order.push('UI'), published: value => order.push(value),
    journal: { load: async () => [...journal.values()], put: async value => journal.set(value.id, value), remove: async id => journal.delete(id) },
    source: { head: async () => pages.at(-1), read: async id => pages.find(page => page.revision === id), history: async () => [pages.at(-1)], write: async text => pages.push({ ...pages.at(-1), revision: 200, parentId: 100, text }) },
  });
  try {
    await sync.start(); order.length = 0;
    sync.add({ type: 'add-comment', id: marker.id, comment: comment('own', 'Alice') });
    assert.ok(order.every(item => item === 'UI')); assert.equal(sync.published.records['c/own'], undefined);
    await sync.sync();
    const index = order.findIndex(item => typeof item === 'object'); assert.equal(order[index - 1], 'UI'); assert.equal(order[index].revision, 200); assert.ok(order[index].records['c/own']);
  } finally { sync.destroy(); }
});
