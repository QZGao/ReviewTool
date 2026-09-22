import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { articles } from './articles.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const routes = new Map([
  ['/', ['tests/annotation/demo.html', 'text/html; charset=utf-8']],
  ['/annotation.mjs', ['.cache/annotation-rnd/index.mjs', 'text/javascript; charset=utf-8']],
  ['/annotation.mjs.map', ['.cache/annotation-rnd/index.mjs.map', 'application/json']],
  ['/style.css', ['src/annotation/style.css', 'text/css; charset=utf-8']],
]);
for (const article of articles) routes.set(`/articles/${article.key}.json`, [`.cache/annotation-articles/${article.key}.json`, 'application/json; charset=utf-8']);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');

export async function startServer(port = 0) {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/fixture.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(image); return; }
    const route = routes.get(pathname);
    if (!route) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const content = await readFile(path.join(root, route[0]));
      response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }); response.end(content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(pathname.startsWith('/articles/') ? 'Run npm run prepare:annotation-articles first.' : 'Run the annotation test build first.');
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
