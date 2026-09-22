import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { articles } from './articles.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const routes = new Map([
  ['/lab', ['tests/annotation/demo.html', 'text/html; charset=utf-8']],
  ['/annotation.mjs', ['.cache/annotation-rnd/index.mjs', 'text/javascript; charset=utf-8']],
  ['/annotation.mjs.map', ['.cache/annotation-rnd/index.mjs.map', 'application/json']],
  ['/style.css', ['src/annotation/style.css', 'text/css; charset=utf-8']],
  ['/wikipedia-demo.mjs', ['tests/annotation/wikipedia-demo.mjs', 'text/javascript; charset=utf-8']],
  ['/wikipedia-demo.css', ['tests/annotation/wikipedia-demo.css', 'text/css; charset=utf-8']],
]);
for (const article of articles) routes.set(`/articles/${article.key}.json`, [`.cache/annotation-articles/${article.key}.json`, 'application/json; charset=utf-8']);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');

export async function startServer(port = 0) {
  const assets = JSON.parse(await readFile(path.join(root, '.cache/annotation-pages/assets.json'), 'utf8').catch(() => '{}'));
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/articles.json') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(articles)); return; }
    if (pathname === '/fixture.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(image); return; }
    let route = routes.get(pathname);
    const assetId = /^\/wiki-assets\/([a-f0-9]{64})$/.exec(pathname)?.[1];
    if (assetId && assets[assetId]) route = [`.cache/annotation-pages/assets/${assetId}`, assets[assetId].contentType];
    if (pathname === '/') {
      const article = articles.find(article => article.key === (url.searchParams.get('article') ?? 'sun-yat-sen'));
      if (!article) { response.writeHead(404); response.end('Unknown article fixture.'); return; }
      route = [`.cache/annotation-pages/${article.key}.html`, 'text/html; charset=utf-8'];
    }
    if (!route) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const content = await readFile(path.join(root, route[0]));
      const headers = { 'Content-Type': route[1], 'Cache-Control': 'no-store' };
      if (pathname === '/') headers['Content-Security-Policy'] = "script-src 'self'; object-src 'none'; base-uri 'none'";
      response.writeHead(200, headers); response.end(content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(pathname === '/' ? 'Run npm run prepare:annotation-pages first.' : pathname.startsWith('/articles/') ? 'Run npm run prepare:annotation-articles first.' : 'Run the annotation test build first.');
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.env.PORT ?? 4178));
  console.log(`Annotation visual-model lab: ${url}`);
}
