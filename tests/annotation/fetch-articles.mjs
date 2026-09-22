import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { articles } from './articles.mjs';

const directory = fileURLToPath(new URL('../../.cache/annotation-articles/', import.meta.url));
const headers = { 'User-Agent': 'ReviewTool-annotation-RnD/0.1 (https://github.com/QZGao/ReviewTool)' };
await mkdir(directory, { recursive: true });
async function getJson(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response.json();
}
for (const [index, article] of articles.entries()) {
  const file = path.join(directory, article.key + '.json');
  if (!process.argv.includes('--refresh')) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.revisionId === article.revisionId && typeof saved.wikitext === 'string' && typeof saved.renderedHtml === 'string') {
        console.log(`[${index + 1}/${articles.length}] Cached ${article.title}, revision ${article.revisionId}`);
        continue;
      }
    } catch { /* fetch missing fixture */ }
  }
  console.log(`[${index + 1}/${articles.length}] Reading ${article.title}, revision ${article.revisionId}`);
  const source = await getJson(`https://zh.wikipedia.org/w/rest.php/v1/revision/${article.revisionId}`);
  const params = new URLSearchParams({ action: 'parse', oldid: String(article.revisionId), prop: 'text|revid|displaytitle', format: 'json', formatversion: '2', variant: 'zh' });
  const htmlRequestUrl = `https://zh.wikipedia.org/w/api.php?${params}`;
  const rendered = await getJson(htmlRequestUrl);
  if (source.id !== article.revisionId || rendered.parse?.revid !== article.revisionId || typeof source.source !== 'string' || typeof rendered.parse?.text !== 'string') {
    throw new Error(`Missing or mismatched source/HTML revision for ${article.title}.`);
  }
  const fixture = {
    ...article,
    wikitext: source.source,
    renderedHtml: rendered.parse.text,
    referenceBaseUrl: 'https://zh.wikipedia.org/wiki/',
    sourceUrl: `https://zh.wikipedia.org/w/index.php?${new URLSearchParams({ title: article.title, oldid: String(article.revisionId) })}`,
    license: source.license,
    htmlRequestUrl,
  };
  await writeFile(file, JSON.stringify(fixture));
  console.log(`Saved ${Buffer.byteLength(fixture.wikitext)} source bytes and ${Buffer.byteLength(fixture.renderedHtml)} HTML bytes.`);
}
