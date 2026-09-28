import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { articles } from './articles.mjs';

const directory = fileURLToPath(new URL('../../.cache/annotation-pages/', import.meta.url));
await mkdir(path.join(directory, 'assets'), { recursive: true });
const refresh = process.argv.includes('--refresh');
const headers = { 'User-Agent': 'ReviewTool-annotation-RnD/0.1 (https://github.com/QZGao/ReviewTool)' };
const manifestPath = path.join(directory, 'assets.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}'));
const pending = new Map();

async function download(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response;
}

async function asset(value, base) {
  if (/^(?:data:|#)/i.test(value)) return value;
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol)) return value;
  const fragment = url.hash; url.hash = '';
  const key = url.href;
  if (!pending.has(key)) pending.set(key, (async () => {
    const id = createHash('sha256').update(key).digest('hex');
    const file = path.join(directory, 'assets', id);
    if (!refresh && manifest[id]?.url === key && existsSync(file)) return `/wiki-assets/${id}`;
    const response = await download(key);
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const body = contentType.includes('text/css') ? await localCss(await response.text(), key) : Buffer.from(await response.arrayBuffer());
    await writeFile(file, body);
    manifest[id] = { url: key, contentType };
    console.log(`  Cached ${contentType.split(';')[0]} asset (${Buffer.byteLength(body)} bytes)`);
    return `/wiki-assets/${id}`;
  })());
  return (await pending.get(key)) + fragment;
}

async function localCss(css, base) {
  const matches = [...css.matchAll(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^)\\])*?))\s*\)/g)];
  for (const match of matches.reverse()) {
    const value = (match[1] ?? match[2] ?? match[3]).trim();
    if (!value || value.startsWith('data:') || value.startsWith('#')) continue;
    const replacement = `url("${await asset(value, base)}")`;
    css = css.slice(0, match.index) + replacement + css.slice(match.index + match[0].length);
  }
  return css;
}

const channel = process.env.ANNOTATION_BROWSER_CHANNEL ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  for (const [index, article] of articles.entries()) {
    console.log(`[${index + 1}/${articles.length}] Preparing Wikipedia page: ${article.title} @ ${article.revisionId}`);
    const sourceUrl = 'https://zh.wikipedia.org/w/index.php?' + new URLSearchParams({ title: article.title, oldid: String(article.revisionId), useskin: 'vector-2022', variant: 'zh' });
    const originalPath = path.join(directory, article.key + '.original.html');
    let html = refresh ? '' : await readFile(originalPath, 'utf8').catch(() => '');
    if (Number(/"wgRevisionId"\s*:\s*(\d+)/.exec(html)?.[1]) !== article.revisionId) {
      html = await (await download(sourceUrl)).text();
      if (Number(/"wgRevisionId"\s*:\s*(\d+)/.exec(html)?.[1]) !== article.revisionId) throw new Error('Downloaded page revision does not match the fixture.');
      await writeFile(originalPath, html);
    }
    // Parse inertly: upstream scripts are retained in the original download, never executed here.
    const prepared = await page.evaluate(({ html, sourceUrl, article }) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const articleRoots = doc.querySelectorAll('#mw-content-text > .mw-parser-output');
      if (articleRoots.length !== 1) throw new Error('Expected one direct article parser-output root.');
      const original = articleRoots[0];
      const resources = [];
      doc.querySelectorAll('script, base, link[rel="preconnect"], link[rel="dns-prefetch"], link[rel="preload"]').forEach(node => node.remove());
      for (const element of doc.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
          if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
        }
        for (const attribute of ['href', 'src', 'poster', 'action']) {
          const value = element.getAttribute(attribute);
          if (value && !value.startsWith('#') && !value.startsWith('data:')) element.setAttribute(attribute, new URL(value, sourceUrl).href);
        }
        const srcset = element.getAttribute('srcset');
        if (srcset && !srcset.includes('data:')) element.setAttribute('srcset', srcset.split(',').map(candidate => {
          const [url, ...descriptor] = candidate.trim().split(/\s+/);
          return [new URL(url, sourceUrl).href, ...descriptor].join(' ');
        }).join(', '));
      }
      const capture = (element, attribute, kind = 'asset') => {
        const value = attribute === 'textContent' ? element.textContent : element.getAttribute(attribute);
        if (!value) return;
        const token = `REVIEWTOOL_SNAPSHOT_ASSET_${resources.length}__`;
        resources.push({ token, value, kind });
        if (attribute === 'textContent') element.textContent = token;
        else element.setAttribute(attribute, token);
      };
      doc.querySelectorAll('link[rel="stylesheet"], link[rel="icon"]').forEach(element => capture(element, 'href'));
      doc.querySelectorAll('style').forEach(element => capture(element, 'textContent', 'css'));
      doc.querySelectorAll('[style]').forEach(element => { if (element.getAttribute('style').includes('url(')) capture(element, 'style', 'css-attribute'); });
      for (const img of doc.querySelectorAll('img')) {
        // Cache the skin/logo/indicator assets; article media retain their original URLs.
        if (!original.contains(img)) {
          capture(img, 'src'); capture(img, 'srcset', 'srcset');
        }
      }
      doc.documentElement.dataset.reviewtoolArticle = article.key;
      doc.documentElement.dataset.reviewtoolRevision = String(article.revisionId);
      const stylesheet = doc.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/style.css'; doc.head.append(stylesheet);
      const controls = doc.createElement('link'); controls.rel = 'stylesheet'; controls.href = '/wikipedia-demo.css'; doc.head.append(controls);
      const script = doc.createElement('script'); script.type = 'module'; script.src = '/wikipedia-demo.mjs'; doc.body.append(script);
      return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, resources, parserOutputs: doc.querySelectorAll('.mw-parser-output').length };
    }, { html, sourceUrl, article });
    for (const resource of prepared.resources) {
      let replacement;
      if (resource.kind.startsWith('css')) replacement = await localCss(resource.value, sourceUrl);
      else if (resource.kind === 'srcset') replacement = (await Promise.all(resource.value.split(',').map(async candidate => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        return [await asset(url, sourceUrl), ...descriptor].join(' ');
      }))).join(', ');
      else replacement = await asset(resource.value, sourceUrl);
      if (resource.kind !== 'css') replacement = replacement.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      prepared.html = prepared.html.replace(resource.token, () => replacement);
    }
    await writeFile(path.join(directory, article.key + '.html'), prepared.html);
    await writeFile(path.join(directory, article.key + '.json'), JSON.stringify({ ...article, sourceUrl, skin: 'vector-2022', runtime: 'html-and-styles', parserOutputs: prepared.parserOutputs }));
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`  Saved full page (${Buffer.byteLength(prepared.html)} bytes; ${prepared.parserOutputs} parser-output elements)`);
  }
} finally { await browser.close(); }
