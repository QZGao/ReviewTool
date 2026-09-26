import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { root } from './launch.mjs';
let api;
before(async () => {
  const file = path.join(root, '.cache/records-storage-test.mjs');
  await build({ stdin: { contents: ['record-document', 'record-json', 'live-storage', 'sync', 'wiki-source'].map(name => `export * from './src/annotation/${name}.ts';`).join('\n'), resolveDir: root }, outfile: file, bundle: true, format: 'esm', platform: 'node' });
  api = await import(pathToFileURL(file));
});
const identity = { wiki: 'zhwiki', pageId: 123, revisionId: 456 }, actor = { name: 'Alice' };
const time = '2026-09-26T00:00:00.000Z';
const marker = { id: 'highlight', color: 'yellow', anchor: { unit: 'utf8-byte', start: 0, end: 6 }, author: 'Alice', createdAt: time };
const message = (id, author = 'Alice') => ({ id, text: id, author, createdAt: time, replies: [] });
const rootComment = message('root');
const valid = anchor => anchor?.unit === 'utf8-byte' && anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= 100;
const seed = (annotations = [{ ...marker, threads: [rootComment] }]) => api.AnnotationDocument.seed('shared', annotations, valid);
const shell = { baseline: 0, prefix: '{{ReviewTool annotation data page}}\n<syntaxhighlight lang="json">\n', suffix: '\n</syntaxhighlight>\n' };
const encoded = doc => api.encodePage(identity, shell, doc);
function memoryJournal() { const records = new Map(); return { records, load: async () => [...records.values()].map(value => structuredClone(value)), put: async value => { records.set(value.id, structuredClone(value)); }, remove: async id => { records.delete(id); } }; }
function wiki(initial) {
  let serial = 0, pages = [], writes = [], failAfterWrite = false;
  const commit = (text, summary = '/* ReviewTool */', tags = []) => { const page = { revision: ++serial, parentId: pages.at(-1)?.revision ?? 0, timestamp: time, tags, summary, text }; pages.push(page); return page; };
  if (initial !== undefined) commit(initial);
  const source = {
    head: async () => pages.at(-1) ?? null,
    read: async id => { const page = pages.find(page => page.revision === id); if (!page) throw new Error('missing history'); return page; },
    history: async (head, stop) => { const at = pages.findIndex(page => page.revision === head), end = stop === undefined ? -1 : pages.findIndex(page => page.revision === stop); if (stop !== undefined && end < 0) throw new Error('history gap'); return pages.slice(end + 1, at + 1).reverse(); },
    write: async (text, base, reason) => { if ((base?.revision ?? 0) !== (pages.at(-1)?.revision ?? 0)) throw new Error(base ? 'editconflict' : 'articleexists'); commit(text, '/* ReviewTool */' + (reason ? ' ' + reason : '')); writes.push({ text, reason }); if (failAfterWrite) { failAfterWrite = false; throw new Error('connection lost'); } },
  };
  return { source, commit, pages, writes, loseAcknowledgement() { failAfterWrite = true; } };
}
async function client(server, name = 'Alice', journal = memoryJournal(), groups = []) {
  let snapshots = [], statuses = [];
  const sync = api.annotationSync({ identity, actor: { name, groups }, source: server.source, journal, validate: valid, canWrite: true, changed: value => snapshots.push(value), status: (text, error) => statuses.push({ text, error }) });
  await sync.start(); return { sync, journal, snapshots, statuses };
}
function snapshot(server) { const stored = api.decodePage(server.pages.at(-1), identity, valid); const value = stored.document.snapshot(); stored.document.destroy(); return value; }
function mutate(text, change) { const match = /<syntaxhighlight lang="json">\n([\s\S]*?)\n<\/syntaxhighlight>/.exec(text); const value = JSON.parse(match[1]); change(value); return text.replace(match[1], JSON.stringify(value)); }

test('independent roots and replies converge under reverse/duplicate update delivery', () => {
  const initial = seed(), a = initial.clone(), b = initial.clone();
  const ua = a.dispatch({ type: 'add-comment', id: marker.id, comment: message('Alice root') }, actor, 'op-a');
  const ub = b.dispatch({ type: 'add-comment', id: marker.id, parentId: 'root', comment: message('Bob reply', 'Bob') }, { name: 'Bob' }, 'op-b');
  a.merge(ub); a.merge(ub); b.merge(ua);
  assert.deepEqual(a.snapshot(), b.snapshot()); assert.equal(a.snapshot()[0].threads.length, 2); assert.equal(a.snapshot()[0].threads.find(root => root.id === 'root').replies[0].id, 'Bob reply');
  const c = initial.clone(); c.merge(ub); c.merge(ua); assert.deepEqual(c.snapshot(), a.snapshot());
  for (const doc of [initial, a, b, c]) doc.destroy();
});

test('competing text and color changes converge with the winning edit metadata intact', () => {
  const initial = seed(), a = initial.clone(), b = initial.clone();
  const ua = a.dispatch({ type: 'edit-comment', id: marker.id, commentId: 'root', text: 'Alice edit', editedAt: time }, actor, 'edit-a');
  const later = '2026-09-26T00:00:01.000Z';
  const ub = b.dispatch({ type: 'edit-comment', id: marker.id, commentId: 'root', text: 'Moderator edit', editedAt: later, reason: 'Correction' }, { name: 'Bob', groups: ['sysop'] }, 'edit-b');
  a.merge(ub); b.merge(ua); assert.deepEqual(a.snapshot(), b.snapshot());
  const comment = a.snapshot()[0].threads[0]; assert.equal(comment.editedBy, comment.text === 'Alice edit' ? 'Alice' : 'Bob'); assert.equal(comment.editedAt, comment.editedBy === 'Alice' ? time : later);
  const ca = a.dispatch({ type: 'recolor-highlight', id: marker.id, color: 'red', editedAt: time }, actor, 'color-a');
  const cb = b.dispatch({ type: 'recolor-highlight', id: marker.id, color: 'green', editedAt: later }, { name: 'Bob' }, 'color-b');
  a.merge(cb); b.merge(ca); assert.deepEqual(a.snapshot(), b.snapshot()); assert.equal(a.snapshot()[0].editedBy, a.snapshot()[0].color === 'red' ? 'Alice' : 'Bob');
  for (const doc of [initial, a, b]) doc.destroy();
});

test('resolution retains late replies and permissions belong to each root author', () => {
  const initial = seed([{ ...marker, threads: [rootComment, message('second', 'Bob')] }]), a = initial.clone(), b = initial.clone();
  assert.throws(() => a.dispatch({ type: 'resolve-comment', id: marker.id, commentId: 'second', at: time }, actor, 'bad'), /author/);
  assert.throws(() => a.dispatch({ type: 'delete-highlight', id: marker.id, at: time }, actor, 'bad-delete'), /author/);
  const ua = a.dispatch({ type: 'resolve-comment', id: marker.id, commentId: 'root', at: time }, actor, 'resolve');
  const ub = b.dispatch({ type: 'add-comment', id: marker.id, parentId: 'root', comment: message('late', 'Bob') }, { name: 'Bob' }, 'late');
  a.merge(ub); b.merge(ua); assert.deepEqual(a.snapshot(), b.snapshot());
  const [first, second] = a.snapshot()[0].threads; assert.equal(first.resolved.by, 'Alice'); assert.equal(first.replies[0].id, 'late'); assert.equal(second.resolved, undefined);
  for (const doc of [initial, a, b]) doc.destroy();
});

test('two clients publish concurrently, receive remote roots, and recognize lost acknowledgements', async () => {
  const doc = seed(), server = wiki(encoded(doc)), a = await client(server), b = await client(server, 'Bob'); doc.destroy();
  try {
    a.sync.add({ type: 'add-comment', id: marker.id, comment: message('a') });
    b.sync.add({ type: 'add-comment', id: marker.id, comment: message('b', 'Bob') });
    await Promise.all([a.sync.sync(), b.sync.sync()]); await Promise.all([a.sync.sync(), b.sync.sync()]);
    assert.equal(snapshot(server)[0].threads.length, 3); assert.deepEqual(a.sync.annotations, b.sync.annotations); assert.equal(a.sync.dirty || b.sync.dirty, false);
    server.loseAcknowledgement(); a.sync.add({ type: 'add-comment', id: marker.id, parentId: 'root', comment: message('once') }); await a.sync.sync(); assert.equal(a.sync.dirty, true);
    await a.sync.sync(); assert.equal(a.sync.dirty, false); assert.equal(snapshot(server)[0].threads[0].replies.length, 1);
    const writes = server.writes.length; await b.sync.sync(); await a.sync.sync(); assert.equal(server.writes.length, writes, 'polls never echo remote changes');
  } finally { a.sync.destroy(); b.sync.destroy(); }
});

test('fresh record baselines preserve IDs and unknown dates and support concurrent initial page creation', async () => {
  const imported = api.AnnotationDocument.seed('shared', [{ id: 'old', color: 'blue', anchor: marker.anchor, comment: rootComment }], valid);
  assert.equal(imported.snapshot()[0].createdAt, undefined); assert.equal(imported.snapshot()[0].threads[0].id, 'root'); imported.destroy();
  const server = wiki(), [a, b] = await Promise.all([client(server), client(server, 'Bob')]);
  try {
    a.sync.add({ type: 'add-highlight', highlight: marker });
    b.sync.add({ type: 'add-highlight', highlight: { ...marker, id: 'bob-highlight', author: 'Bob' } });
    await Promise.all([a.sync.sync(), b.sync.sync()]); assert.equal(snapshot(server).length, 2);
  } finally { a.sync.destroy(); b.sync.destroy(); }
});

test('reasoned moderation has its own publication and own actions need no reason', async () => {
  const doc = seed(), server = wiki(encoded(doc)); doc.destroy(); const c = await client(server, 'Mod', memoryJournal(), ['sysop']);
  try {
    assert.throws(() => c.sync.add({ type: 'edit-comment', id: marker.id, commentId: 'root', text: 'change', editedAt: time }), /reason/);
    c.sync.add({ type: 'add-comment', id: marker.id, comment: message('my root', 'Mod') });
    c.sync.add({ type: 'edit-comment', id: marker.id, commentId: 'root', text: 'change', editedAt: time, reason: 'Correct quote' });
    c.sync.add({ type: 'resolve-comment', id: marker.id, commentId: 'my root', at: time });
    await c.sync.sync(); assert.deepEqual(server.writes.map(item => item.reason), [undefined, 'Correct quote', undefined]);
    assert.equal(snapshot(server)[0].threads.find(item => item.id === 'root').editedBy, 'Mod');
  } finally { c.sync.destroy(); }
});

test('manual snapshot changes reset the generation and retain old pending work without resurrection', async () => {
  const doc = seed(), server = wiki(encoded(doc)); doc.destroy(); const c = await client(server);
  try {
    c.sync.add({ type: 'edit-comment', id: marker.id, commentId: 'root', text: 'Local pending edit', editedAt: time });
    server.commit(mutate(server.pages.at(-1).text, value => { delete value.records['c/root']; }), 'Manual removal');
    await c.sync.sync(); assert.equal(snapshot(server)[0].threads, undefined); assert.equal(c.sync.retained.length, 1); assert.equal(c.sync.retained[0].action.text, 'Local pending edit');
    const writes = server.writes.length; await c.sync.sync(); assert.equal(server.writes.length, writes); assert.equal(c.sync.dirty, true);
    await c.sync.discardRetained(); assert.equal(c.sync.dirty, false);
  } finally { c.sync.destroy(); }
});

test('malformed manual content is repaired from the latest valid manual revision, not stale local data', async () => {
  const doc = seed(), server = wiki(encoded(doc)); doc.destroy(); const c = await client(server);
  try {
    const corrected = mutate(server.pages.at(-1).text, value => { value.records['c/root'].body.text = 'Valid manual correction'; });
    server.commit(corrected, 'Manual correction'); server.commit('broken JSON', 'Accidental damage');
    await c.sync.sync(); assert.equal(snapshot(server)[0].threads[0].text, 'Valid manual correction');
    assert.equal(server.writes.length, 1);
  } finally { c.sync.destroy(); }
});

test('concurrent repair adopts the winning recovery document and unsupported schemas are never overwritten', async () => {
  const doc = seed(), server = wiki(encoded(doc)); doc.destroy(); const a = await client(server), b = await client(server, 'Bob');
  try {
    server.commit('broken', 'Manual damage'); await Promise.all([a.sync.sync(), b.sync.sync()]); assert.equal(server.writes.length, 1); assert.equal(snapshot(server)[0].threads[0].text, 'root');
    server.commit(mutate(server.pages.at(-1).text, value => { value.format = 'reviewtool.annotation-records/999'; }), 'New tool format'); const writes = server.writes.length;
    await a.sync.sync(); assert.equal(server.writes.length, writes); assert.match(a.statuses.at(-1).text, /Unsupported/);
  } finally { a.sync.destroy(); b.sync.destroy(); }
});

test('pending submissions survive reload and cannot be claimed by another actor', async () => {
  const doc = seed(), server = wiki(encoded(doc)); doc.destroy(); const journal = memoryJournal(), first = await client(server, 'Alice', journal);
  first.sync.add({ type: 'add-comment', id: marker.id, comment: message('reload') }); await new Promise(resolve => setTimeout(resolve, 0)); first.sync.destroy();
  const other = await client(server, 'Bob', journal); assert.equal(snapshot(server)[0].threads.length, 1); other.sync.destroy();
  const reloaded = await client(server, 'Alice', journal);
  try { assert.equal(snapshot(server)[0].threads.length, 2); assert.equal(reloaded.sync.dirty, false); } finally { reloaded.sync.destroy(); }
});

test('tag availability is checked once and summary fallback stays recognizable after activation', async () => {
  for (const active of [false, true]) {
    const calls = []; let reject = active;
    const source = api.wikiSource(async (params, write) => {
      calls.push(params);
      if (!write) return { query: { tags: [{ name: 'ReviewTool', ...(active ? { active: true } : {}), source: ['manual'] }] } };
      if (reject) { reject = false; throw new Error('badtags'); }
      return { edit: { result: 'Success' } };
    }, 'Talk:Page/ReviewTool/456');
    await source.write('data', null); await source.write('data2', { revision: 12 }, 'Moderator reason');
    assert.equal(calls.filter(call => call.list === 'tags').length, 1);
    assert.equal(calls.at(-1).summary, '/* ReviewTool */ Moderator reason'); assert.equal(calls.at(-1).baserevid, 12); assert.equal(calls.at(-1).basetimestamp, undefined);
  }
  for (const summary of ['/* ReviewTool */', '/* ReviewTool */ Reason']) assert.equal(api.recognizedEdit({ tags: [], summary }), true);
  assert.equal(api.recognizedEdit({ tags: ['ReviewTool'], summary: 'Other' }), true);
  assert.equal(api.recognizedEdit({ tags: [], summary: 'Mention /* ReviewTool */ later' }), false);
});

test('intervening manual edits are noticed even when the head is tagged, and formatting-only edits are preserved', async () => {
  const doc = seed(), server = wiki(encoded(doc)); doc.destroy(); const c = await client(server);
  try {
    server.commit(server.pages.at(-1).text + '\n<!-- manual notice -->', 'Manual formatting');
    await c.sync.sync(); assert.equal(server.writes.length, 0);
    c.sync.add({ type: 'recolor-highlight', id: marker.id, color: 'green', editedAt: time }); await c.sync.sync(); assert.ok(server.pages.at(-1).text.endsWith('<!-- manual notice -->'));
    const before = server.pages.at(-1).text;
    server.commit(mutate(before, value => { value.records['c/root'].body.text = 'Manual correction between polls'; }), 'Manual edit');
    server.commit(before, '/* ReviewTool */');
    await c.sync.sync(); assert.equal(snapshot(server)[0].threads[0].text, 'Manual correction between polls');
  } finally { c.sync.destroy(); }
});

test('repair rereads a new valid head instead of overwriting an intervening correction', async () => {
  const doc = seed(), initial = encoded(doc), server = wiki(initial); doc.destroy(); const c = await client(server);
  const originalWrite = server.source.write; let raced = false;
  try {
    server.commit('broken', 'Manual damage');
    server.source.write = async (...args) => {
      if (!raced) { raced = true; server.commit(mutate(initial, value => { value.records['c/root'].body.text = 'Newer manual fix'; }), 'Fixed manually'); }
      return originalWrite(...args);
    };
    await c.sync.sync(); assert.equal(snapshot(server)[0].threads[0].text, 'Newer manual fix');
  } finally { c.sync.destroy(); }
});

test('same-account tabs merge independent publications without suppressing self-conflicts', async () => {
  const doc = seed(), server = wiki(encoded(doc)); doc.destroy(); const a = await client(server), b = await client(server);
  try {
    a.sync.add({ type: 'add-comment', id: marker.id, comment: message('tab one') }); b.sync.add({ type: 'add-comment', id: marker.id, comment: message('tab two') });
    await Promise.all([a.sync.sync(), b.sync.sync()]); await Promise.all([a.sync.sync(), b.sync.sync()]);
    assert.deepEqual(a.sync.annotations, b.sync.annotations); assert.equal(snapshot(server)[0].threads.length, 3);
  } finally { a.sync.destroy(); b.sync.destroy(); }
});

test('missing required fields are repaired, while a valid foreign document identity is protected', async () => {
  const doc = seed(), initial = encoded(doc); doc.destroy();
  for (const change of [value => { delete value.format; }, value => { value.records = null; }]) {
    const server = wiki(initial), c = await client(server);
    try { server.commit(mutate(initial, change), 'Malformed manual edit'); await c.sync.sync(); assert.equal(server.writes.length, 1); assert.equal(snapshot(server)[0].id, marker.id); }
    finally { c.sync.destroy(); }
  }
  const server = wiki(initial), c = await client(server);
  try { server.commit(mutate(initial, value => { value.document.pageId = 999; }), 'Different document'); await c.sync.sync(); assert.equal(server.writes.length, 0); assert.match(c.statuses.at(-1).text, /another wiki/); }
  finally { c.sync.destroy(); }
});

test('closing a view during a read prevents subsequent publication', async () => {
  const doc = seed(), server = wiki(encoded(doc)); doc.destroy(); const c = await client(server);
  let release; const original = server.source.head;
  server.source.head = async () => { await new Promise(resolve => { release = resolve; }); return original(); };
  c.sync.add({ type: 'add-comment', id: marker.id, comment: message('pending during close') });
  const saving = c.sync.sync();
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  c.sync.destroy(); release(); await saving; assert.equal(server.writes.length, 0); assert.equal(c.journal.records.size, 1);
});

test('already-published journal entries and no-op actions clear without another write', async () => {
  const doc=seed(), action={type:'edit-comment',id:marker.id,commentId:'root',text:'Accepted earlier',editedAt:time};
  const update=doc.dispatch(action,actor), server=wiki(encoded(doc)), journal=memoryJournal();
  await journal.put({id:'cached-ack',sequence:1,generation:doc.generation,baseline:0,update,action,actor});
  journal.checkpoint=async value=>value??{generation:doc.generation,baseline:0,base:doc.toJSON(),local:doc.toJSON(),revision:server.pages[0],prefix:shell.prefix,suffix:shell.suffix};
  const c=await client(server,'Alice',journal);
  try { assert.equal(c.sync.dirty,false);assert.equal(server.writes.length,0);c.sync.add({type:'recolor-highlight',id:marker.id,color:'yellow',editedAt:time});await c.sync.sync();assert.equal(server.writes.length,0);assert.equal(c.sync.dirty,false); }
  finally {c.sync.destroy();doc.destroy();}
});


test('a server-side text merge of stale independent submissions is validated and acknowledged', async () => {
  const doc=seed([{...marker,threads:[rootComment]},{...marker,id:'other',threads:[message('other-root')]}]);
  const server=wiki(encoded(doc));doc.destroy();const a=await client(server),b=await client(server);
  let merged=0;const write=server.source.write;
  server.source.write=async(text,base,reason)=>{
    const current=server.pages.at(-1);
    if(base?.revision===current.revision)return write(text,base,reason);
    const ancestor=server.pages.find(page=>page.revision===base?.revision);
    if(!ancestor)throw new Error('editconflict');
    const directory=await mkdtemp(path.resolve('.cache/native-record-merge-'));
    const files=['ours','base','theirs'].map(name=>path.join(directory,name));
    await Promise.all([text,ancestor.text,current.text].map((value,i)=>writeFile(files[i],value)));
    const result=spawnSync('/usr/bin/diff3',['-m',...files],{encoding:'utf8'});
    if(result.status!==0||server.pages.at(-1).revision!==current.revision)throw new Error('editconflict');
    merged++;return write(result.stdout,current,reason);
  };
  try {
    a.sync.add({type:'edit-comment',id:marker.id,commentId:'root',text:'Independent A',editedAt:time});
    b.sync.add({type:'edit-comment',id:'other',commentId:'other-root',text:'Independent B',editedAt:time});
    await Promise.all([a.sync.sync(),b.sync.sync()]);await a.sync.sync();
    assert.equal(merged,1);assert.equal(a.sync.dirty||b.sync.dirty,false);assert.deepEqual(a.sync.annotations,b.sync.annotations);
    assert.deepEqual(snapshot(server).flatMap(h=>h.threads.map(c=>c.text)),['Independent A','Independent B']);
  } finally {a.sync.destroy();b.sync.destroy();}
});
