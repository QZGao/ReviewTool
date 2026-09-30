import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

test('annotation entry redirects legacy skins and preserves revision, comment, language and fragment', async () => {
  const bundle = await build({ stdin: { contents: "export * from './src/annotation/view-url.ts'", resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'api', write: false });
  const scope = { URL }; vm.runInNewContext(bundle.outputFiles[0].text, scope);
  for (const skin of ['vector', 'monobook', 'timeless', 'modern', 'vector-2022', 'minerva']) {
    const input = 'https://zh.wikipedia.org/wiki/A?uselang=zh-tw&reviewtool_annotation_comment_id=id#Section';
    const url = scope.api.annotationViewUrl(input, 123, skin);
    assert.equal(url.searchParams.get('useskin'), ['vector-2022', 'minerva'].includes(skin) ? null : 'vector-2022');
    assert.equal(url.searchParams.get('oldid'), '123');
    assert.equal(url.searchParams.get('reviewtool_annotation_comment_id'), 'id');
    assert.equal(url.searchParams.get('uselang'), 'zh-tw'); assert.equal(url.hash, '#Section');
  }
  const link = scope.api.annotationCommentUrl('https://zh.wikipedia.org/wiki/A?uselang=zh-tw#Section', 'comment-id', 123);
  assert.equal(link.searchParams.get('oldid'), '123');
  assert.equal(link.searchParams.get('reviewtool_annotation_view'), '1');
  assert.equal(link.searchParams.get('reviewtool_annotation_comment_id'), 'comment-id');
  assert.equal(link.hash, '');
});

test('only comment links for the current wiki revision are handled in place', async () => {
  const bundle = await build({ stdin: { contents: "export * from './src/annotation/view-url.ts'", resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'api', write: false });
  const scope = { URL }; vm.runInNewContext(bundle.outputFiles[0].text, scope);
  const current = 'https://zh.wikipedia.org/w/index.php?title=孫中山&oldid=123&reviewtool_annotation_view=1';
  const comment = 'reviewtool_annotation_comment_id=target';
  for (const href of [
    `/w/index.php?oldid=123&${comment}`, `/wiki/孫中山?oldid=123&${comment}`,
    `https://zh.wikipedia.org/zh-cn/孙中山?${comment}&oldid=123&useskin=minerva`,
    `?oldid=123&${comment}&action=view`,
  ]) assert.equal(scope.api.samePageCommentId(href, current), 'target', href);
  for (const href of [
    `/w/index.php?oldid=456&${comment}`, `/wiki/Other?${comment}`,
    `https://en.wikipedia.org/w/index.php?oldid=123&${comment}`, `https://example.org/?oldid=123&${comment}`,
    `/w/api.php?oldid=123&${comment}`, `?oldid=123&${comment}&action=edit`,
    `?oldid=123&${comment}&diff=prev`, '?oldid=123', '?oldid=123&reviewtool_annotation_comment_id=',
    `?oldid=123&oldid=456&${comment}`, `?oldid=123&${comment}&reviewtool_annotation_comment_id=other`,
    'javascript:alert(1)',
  ]) assert.equal(scope.api.samePageCommentId(href, current), null, href);
});
