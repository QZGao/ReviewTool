import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { recordTestApi } from './record-test-api.mjs';
let api;
before(async () => { api = await recordTestApi(); });
const time = '2026-09-26T00:00:00.000Z', actor = { name: 'Alice' };
const identity = { wiki: 'zhwiki', pageId: 123, revisionId: 456 }, frame = { baseline: 0, prefix: '{{ReviewTool annotation data page}}\n<syntaxhighlight lang="json">\n', suffix: '\n</syntaxhighlight>\n' };
const valid = anchor => anchor?.unit === 'utf8-byte' && anchor.start >= 0 && anchor.start < anchor.end && anchor.end <= 100;
const comment = id => ({ id, text: `Original ${id}`, author: 'Alice', createdAt: time, replies: [] });
const initial = () => [
  { id: 'a', color: 'blue', anchor: { unit: 'utf8-byte', start: 0, end: 6 }, author: 'Alice', threads: [comment('one')] },
  { id: 'b', color: 'green', anchor: { unit: 'utf8-byte', start: 6, end: 12 }, author: 'Alice', createdAt: time, threads: [comment('two')] },
];
const seed = () => api.AnnotationDocument.seed('generation', initial(), valid);
const page = text => ({ text, revision: 1, parentId: 0, summary: '/* ReviewTool */', tags: [], timestamp: time });

test('one record per line preserves the entire snapshot without a materialized mirror', () => {
  const document = seed(), text = api.encodePage(identity, frame, document);
  const raw = api.parseRecordJson(text.match(/<syntaxhighlight lang="json">\n([\s\S]*?)\n<\/syntaxhighlight>/)[1]);
  assert.equal(raw.format, api.recordFormat); assert.equal(raw.yjs, undefined); assert.equal(raw.annotations, undefined);
  assert.equal(text.split('\n').filter(line => /^    "/.test(line)).length, 4);
  const result = api.decodePage(page(text), identity, valid);
  assert.deepEqual(result.annotations, initial()); assert.equal(result.annotations[0].createdAt, undefined);
  const sorted = Object.fromEntries(Object.entries(raw.records).reverse().map(([key,record]) => [key,Object.fromEntries(Object.entries(record).reverse())]));
  const reordered = new api.AnnotationDocument(raw.generation, valid, sorted);
  assert.equal(api.encodePage(identity, frame, reordered), text);
  document.destroy(); result.document.destroy(); reordered.destroy();
});

test('any user can mark and unmark a root resolved, concurrent changes converge, and closure stays independent', () => {
  const document = seed(), bob = { name: 'Bob' }, a = document.clone('a'), b = document.clone('b');
  const action = resolved => ({ type: 'set-thread-resolution', id: 'a', commentId: 'one', resolved, at: time });
  const marked = a.dispatch(action(true), bob), unmarked = b.dispatch(action(false), actor);
  a.merge(unmarked); b.merge(marked);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.snapshot()[0].threads[0].resolution.resolved, false);
  a.dispatch(action(true), bob);
  const restored = api.decodePage(page(api.encodePage(identity, frame, a)), identity, valid).document;
  assert.equal(restored.snapshot()[0].threads[0].resolution.by, 'Bob');
  assert.equal(restored.snapshot()[0].threads[0].resolved, undefined);
  assert.throws(() => a.dispatch({ type: 'resolve-comment', id: 'a', commentId: 'one', at: time }, bob), /author/);
  a.dispatch({ type: 'resolve-comment', id: 'a', commentId: 'one', at: time }, actor);
  assert.equal(a.snapshot()[0].threads[0].resolved.by, 'Alice');
  assert.equal(a.snapshot()[0].threads[0].resolution.resolved, true);
  for (const doc of [document, a, b, restored]) doc.destroy();
});

test('block targets retain their kind through record storage and can coexist with text highlights at the same source interval', () => {
  const highlights = initial();
  highlights.push({ ...highlights[0], id: 'block', threads: [], anchor: { ...highlights[0].anchor, target: 'block' } });
  const document = api.AnnotationDocument.seed('block-generation', highlights, valid);
  const restored = api.decodePage(page(api.encodePage(identity, frame, document)), identity, valid).document;
  assert.equal(restored.snapshot().find(h => h.id === 'block').anchor.target, 'block');
  assert.equal(restored.snapshot().find(h => h.id === 'a').anchor.target, undefined);
  document.destroy(); restored.destroy();
});

test('JSON parser rejects duplicate escaped/nested keys before any state is accepted', () => {
  for (const bad of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":[{"b":1,"b":2}]}']) assert.throws(() => api.parseRecordJson(bad), /Duplicate/);
  const good = '{"a":[{},[],true,null,-1.5e2,"quote\\\"slash\\\\"],"b":{"a":1}}';
  assert.deepEqual(api.parseRecordJson(good), JSON.parse(good));
  const document = seed(), text = api.encodePage(identity, frame, document), entry = text.split('\n').find(line=>line.startsWith('    "c/one"'));
  assert.throws(() => api.decodePage(page(text.replace(entry,entry+'\n'+entry)),identity,valid), api.MalformedData);
  document.destroy();
});

test('invalid records, losing values and references are rejected transactionally', () => {
  const document = seed(); document.dispatch({type:'recolor-highlight',id:'a',color:'red',editedAt:time},actor);
  const accepted = document.snapshot(), records = document.toJSON();
  const invalid = [
    r=>{r['h/a'].appearance.color='invalid';}, r=>{r['h/a'].appearance.color=['blue'];},
    r=>{r['c/one'].parent='c/missing';}, r=>{r['c/two'].parent='c/one';}, r=>{r['c/one'].parent='c/one';},
    r=>{r['c/one'].stamp=[...r['h/a'].stamp];}, r=>{r['c/one'].stamp=[r['h/a'].stamp[0],'other'];},
    r=>{r['c/one'].kind=['comment'];}, r=>{r['c/one'].stamp[0]=Number.MAX_SAFE_INTEGER+1;},
    r=>{r['c/one'].body.extra='surprise';}, r=>{r['c/one'].createdAt='2026-02-30T00:00:00.000Z';},
    r=>{r['h/a'].source=[0,1000];}, r=>{r['h/a'].source=[0,1.5];},
  ];
  for (const mutate of invalid) { const copy=structuredClone(records); mutate(copy); assert.throws(()=>new api.AnnotationDocument('generation',valid,copy)); }
  const changed=structuredClone(records);changed['c/one'].body.text='Mutated identity';
  assert.throws(()=>document.merge({generation:'generation',records:changed}),/Immutable/);
  assert.deepEqual(document.snapshot(),accepted); assert.ok(Object.isFrozen(records['c/one'].body)); document.destroy();
});

test('fixed replica tie-breaks, causal edits, and exact update receipts are deterministic', () => {
  const document=seed(), a=document.clone('replica-a'), b=document.clone('replica-b');
  const ua=a.dispatch({type:'edit-comment',id:'a',commentId:'one',text:'A',editedAt:time},actor);
  const ub=b.dispatch({type:'edit-comment',id:'a',commentId:'one',text:'B',editedAt:time},actor);
  assert.equal(Object.values(ua.records)[0].stamp[0],Object.values(ub.records)[0].stamp[0]);
  a.merge(ub);b.merge(ua);assert.deepEqual(a.toJSON(),b.toJSON());assert.equal(a.snapshot()[0].threads[0].text,'B');
  const later=a.dispatch({type:'edit-comment',id:'a',commentId:'one',text:'Later',editedAt:time},actor);b.merge(later);
  assert.equal(b.snapshot()[0].threads[0].text,'Later');assert.equal(b.contains(ua),true);assert.equal(b.contains(ub),true);
  const corrupted=structuredClone(ua);Object.values(corrupted.records)[0].text='Wrong receipt';assert.equal(b.contains(corrupted),false);
  assert.throws(()=>b.merge({...ua,generation:'other'}),/generation/);
  for(const item of [document,a,b])item.destroy();
});

test('deterministic randomized delivery of independent operations converges with duplicates', () => {
  const document=seed(), writers=Array.from({length:4},(_,i)=>document.clone('replica-'+i)), updates=[];
  for(let i=0;i<64;i++){
    const client=writers[i%4];
    updates.push(i%3===0 ? client.dispatch({type:'add-comment',id:'a',parentId:'one',comment:comment('reply-'+i)},actor)
      : client.dispatch({type:'edit-comment',id:'a',commentId:'one',text:'edit-'+i,editedAt:time},actor));
  }
  const reference=document.clone();updates.forEach(update=>reference.merge(update));
  let random=12345;
  for(let attempt=0;attempt<20;attempt++){
    const shuffled=[...updates,...updates.filter((_,i)=>i%5===0)];
    for(let i=shuffled.length-1;i>0;i--){random=(Math.imul(random,1664525)+1013904223)>>>0;const j=random%(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
    const peer=document.clone();shuffled.forEach(update=>peer.merge(update));
    assert.deepEqual(peer.snapshot(),reference.snapshot());assert.equal(api.encodePage(identity,frame,peer),api.encodePage(identity,frame,reference));peer.destroy();
  }
  for(const item of [document,reference,...writers])item.destroy();
});

test('actual text-merged independent edits decode to the application union', async () => {
  const document=seed(), a=document.clone('A'), b=document.clone('B');
  const ua=a.dispatch({type:'edit-comment',id:'a',commentId:'one',text:'Left',editedAt:time},actor);
  const ub=b.dispatch({type:'edit-comment',id:'b',commentId:'two',text:'Right',editedAt:time},actor);
  const directory=await mkdtemp(path.resolve('.cache/record-merge-')), files={};
  for(const [name,value] of [['base',document],['left',a],['right',b]]){files[name]=path.join(directory,name);await writeFile(files[name],api.encodePage(identity,frame,value));}
  const result=spawnSync('/usr/bin/diff3',['-m',files.left,files.base,files.right],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
  const merged=api.decodePage(page(result.stdout),identity,valid);document.merge(ua);document.merge(ub);
  assert.deepEqual(merged.document.toJSON(),document.toJSON());
  for(const item of [document,a,b,merged.document])item.destroy();
});

test('runtime rejects unpublished legacy formats; the standalone converter preserves old data', async () => {
  const old={schemaVersion:2,...identity,annotations:initial(),yjs:'not needed by one-time converter'};
  const directory=await mkdtemp(path.resolve('.cache/record-conversion-')), input=path.join(directory,'old.json'), output=path.join(directory,'new.wikitext');
  await writeFile(input,JSON.stringify(old));
  assert.throws(()=>api.decodePage(page(frame.prefix+JSON.stringify(old)+frame.suffix),identity,valid),api.IncompatibleData);
  const converted=spawnSync(process.execPath,['tests/live/convert-records.mjs',input,output,'46'],{encoding:'utf8'});
  assert.equal(converted.status,0,converted.stderr);const result=api.decodePage(page(await readFile(output,'utf8')),identity,valid);
  assert.equal(result.baseline,46);assert.deepEqual(result.annotations,initial());result.document.destroy();
});
