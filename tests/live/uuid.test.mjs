import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
let api;
before(async () => {
  const file = path.resolve(`.cache/compact-uuid-${process.pid}.mjs`);
  await build({ stdin: { contents: ['uuid', 'view-url', 'record-document', 'live-storage', 'export', 'projection'].map(name => `export * from './src/annotation/${name}';`).join('\n'), resolveDir: process.cwd() }, outfile: file, bundle: true, format: 'esm', platform: 'node' });
  api = await import(pathToFileURL(file));
});
const h = '550e8400-e29b-41d4-a716-446655440000', c = '550e8400-e29b-41d4-a716-446655440001', r = '550e8400-e29b-41d4-a716-446655440002';
const generation = '550e8400-e29b-41d4-a716-446655440003';
const time = '2026-09-26T00:00:00.000Z', actor = { name: 'Alice' }, identity = { wiki: 'zhwiki', pageId: 1, revisionId: 2 };
const valid = anchor => anchor.unit === 'utf8-byte' && anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= 12;
const short = id => Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url');
const message = (id, replies = []) => ({ id, author: actor.name, createdAt: time, text: `UUID in prose: ${h}`, replies });
const initial = () => [{ id: h, author: actor.name, createdAt: time, color: 'yellow', anchor: { unit: 'utf8-byte', start: 0, end: 6 }, threads: [message(c, [message(r)])] }];
const seed = () => api.AnnotationDocument.seed(generation, initial(), valid);
const page = text => ({ text, revision: 1, parentId: 0, timestamp: time, tags: [], summary: '/* ReviewTool */' });
const decode = text => api.decodePage(page(text), identity, valid);
const encode = document => api.encodePage(identity, { baseline: 37 }, document);
const legacy = document => JSON.stringify({ format: 'reviewtool.annotation-records/1', document: { ...identity, offsetUnit: 'utf8-byte' }, generation: document.generation, baseline: 37, records: document.toJSON() });

test('UUID byte encoding matches an independent Base64url encoder and preserves all 128 bits', () => {
  const values = [h, '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'];
  for (let n = 0; n < 100; n++) {
    const hex = randomBytes(16).toString('hex');
    values.push(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  }
  assert.equal(api.compactUuid(h), 'VQ6EAOKbQdSnFkRmVUQAAA');
  for (const value of values) {
    assert.equal(api.compactUuid(value), short(value));
    assert.equal(api.compactUuid(value).length, 22);
    assert.equal(api.expandUuid(short(value)), value);
  }
  assert.equal(api.expandUuid(api.compactUuid(h.toUpperCase())), h);
  for (const bad of ['', h.slice(1), h + '0', h.replace('5', 'x')]) assert.throws(() => api.compactUuid(bad));
  for (const bad of ['A'.repeat(21), 'A'.repeat(23), short(h) + '==', 'A'.repeat(21) + 'B', '/'.repeat(22)]) assert.throws(() => api.expandUuid(bad));
});

test('stored identifiers, references and change keys compact while every canonical record and user field round-trips', () => {
  const document = seed();
  document.dispatch({ type: 'edit-comment', id: h, commentId: c, text: `Saved ${h}`, editedAt: time }, actor);
  document.dispatch({ type: 'recolor-highlight', id: h, color: 'blue', editedAt: time }, actor);
  document.dispatch({ type: 'set-thread-resolution', id: h, commentId: c, resolved: true, at: time }, actor);
  document.dispatch({ type: 'resolve-comment', id: h, commentId: c, at: time }, actor);
  document.dispatch({ type: 'delete-highlight', id: h, at: time }, actor);
  const text = encode(document), raw = JSON.parse(text), restored = decode(text), fromOld = decode(legacy(document));
  try {
    assert.equal(raw.format, 'reviewtool.annotation-records/2'); assert.equal(raw.generation, short(generation));
    assert.equal(raw.records['c/' + short(c)].highlight, 'h/' + short(h));
    assert.equal(raw.records['c/' + short(r)].parent, 'c/' + short(c));
    assert.equal(raw.records['c/' + short(c)].body.text, `UUID in prose: ${h}`);
    assert.equal(raw.records['c/' + short(c)].author, 'Alice');
    assert.ok(Object.values(raw.records).every(record => record.stamp[1].length === 22));
    assert.equal(text.split('\n').filter(line => /^    "/.test(line)).length, Object.keys(document.toJSON()).length);
    for (const stored of [restored, fromOld]) {
      assert.equal(stored.generation, generation); assert.equal(stored.baseline, 37);
      assert.deepEqual(stored.document.toJSON(), document.toJSON());
      assert.deepEqual(stored.annotations, document.snapshot());
      assert.equal(encode(stored.document), text);
    }
  } finally { document.destroy(); restored.document.destroy(); fromOld.document.destroy(); }
});

test('replica tie-breaks and publication receipts survive encoding even when lexical orders are reversed', () => {
  const low = '00000000-0000-4000-8000-000000000001', high = 'd0000000-0000-4000-8000-000000000001';
  assert.ok(low < high); assert.ok(short(low) > short(high));
  const initial = seed(), a = initial.clone(low), b = initial.clone(high);
  const ua = a.dispatch({ type: 'edit-comment', id: h, commentId: c, text: 'Low replica', editedAt: time }, actor);
  const ub = b.dispatch({ type: 'edit-comment', id: h, commentId: c, text: 'High replica', editedAt: time }, actor);
  const wireA = decode(encode(a)).document, wireB = decode(encode(b)).document;
  wireA.merge({ generation, records: wireB.toJSON() }); wireB.merge(ua);
  assert.deepEqual(wireA.snapshot(), wireB.snapshot());
  assert.equal(wireA.snapshot()[0].threads[0].text, 'High replica');
  assert.equal(wireA.contains(ua), true); assert.equal(wireA.contains(ub), true);
  for (const doc of [initial, a, b, wireA, wireB]) doc.destroy();
});

test('decoding rejects malformed encodings, duplicate identities, stamp aliases and mismatched change keys', () => {
  const document = seed(); document.dispatch({ type: 'edit-comment', id: h, commentId: c, text: 'edit', editedAt: time }, actor);
  const wire = JSON.parse(encode(document)), ck = 'c/' + short(c), hk = 'h/' + short(h);
  const invalid = [
    raw => { raw.generation = 'A'.repeat(21) + 'B'; },
    raw => { raw.records['h/' + h] = structuredClone(raw.records[hk]); },
    raw => { raw.records[ck].parent = 'c/' + short(r); },
    raw => { raw.records[ck].stamp = [raw.records[hk].stamp[0], api.expandUuid(raw.records[hk].stamp[1])]; },
    raw => { raw.records[ck].stamp[1] = 'A'.repeat(21) + 'B'; },
    raw => { const key = Object.keys(raw.records).find(key => key.includes('/body/')); raw.records[key + 'x'] = raw.records[key]; delete raw.records[key]; },
  ];
  for (const mutate of invalid) { const raw = structuredClone(wire); mutate(raw); assert.throws(() => decode(JSON.stringify(raw)), api.MalformedData); }
  assert.throws(() => decode(JSON.stringify({ ...wire, format: 'reviewtool.annotation-records/999' })), api.IncompatibleData);
  document.destroy();
});

test('opaque older identifiers cannot alias compact UUIDs, including literal escapes and prototype-like names', () => {
  const ids = [short(h), 'A'.repeat(21) + 'B', '~literal', '~~literal', '__proto__', 'root'];
  const annotations = ids.map(id => ({ ...initial()[0], id, threads: [] }));
  const document = api.AnnotationDocument.seed(short(h), annotations, valid), restored = decode(encode(document));
  assert.deepEqual(restored.annotations, document.snapshot()); assert.equal(restored.generation, short(h));
  for (const id of ids) assert.equal(api.decodeId(api.encodeId(id)), id);
  document.destroy(); restored.document.destroy();
});

test('old and short comment URLs resolve to the same canonical ID; newly copied links contain 22 characters', () => {
  const href = 'https://zh.wikipedia.org/w/index.php?oldid=2&reviewtool_annotation_view=1';
  const url = api.annotationCommentUrl(href + '#Heading', c, 2);
  assert.equal(url.hash, ''); assert.equal(url.searchParams.get(api.commentParameter), short(c));
  for (const value of [c, c.toUpperCase(), short(c)]) {
    assert.equal(api.commentIdFromUrl(value), c);
    url.searchParams.set(api.commentParameter, value);
    assert.equal(api.samePageCommentId(url.href, href), c);
  }
  assert.equal(api.commentIdFromUrl('A'.repeat(21) + 'B'), null);
});

test('download serialization compacts identifiers while the export projection used by imports stays canonical', () => {
  const projection = api.createProjection('文字文字');
  const payload = api.buildAnnotationExport(identity, 'Test', projection, initial()), before = structuredClone(payload);
  const wire = JSON.parse(api.serializeAnnotationExport(payload));
  assert.deepEqual(payload, before);
  assert.equal(payload.highlights[0].id, h); assert.equal(payload.groups[0].annotations[0].id, c);
  assert.equal(wire.format, 'reviewtool.annotation-export/2'); assert.equal(wire.highlights[0].id, short(h));
  assert.equal(wire.groups[0].annotations[0].id, short(c));
  const reply = wire.groups[0].annotations[1];
  assert.equal(reply.highlightId, short(h)); assert.equal(reply.rootId, short(c)); assert.equal(reply.parentId, short(c));
  assert.equal(reply.opinion, `UUID in prose: ${h}`);
});
