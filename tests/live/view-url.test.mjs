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
