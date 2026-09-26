import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export async function launch({ dryRun = false, headless = false, profile } = {}) {
  const result = spawnSync(process.execPath, ['build.mjs', '--extension', ...(dryRun ? ['--dry-run'] : [])], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Extension build failed.');
  const mode = dryRun ? 'dry-run' : 'normal';
  const directory = path.join(root, '.cache/reviewtool-extension', mode);
  const userDataDir = profile ?? path.join(root, '.cache/reviewtool-chrome', mode);
  await mkdir(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome', headless, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--window-size=1440,1000'], viewport: null,
  });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: directory });
    if (dryRun) {
      // Defense in depth for this testing profile, including requests outside ReviewTool.
      await context.route('https://**.wikipedia.org/**', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname !== '/w/api.php') return ['GET', 'HEAD'].includes(request.method()) ? route.continue() : route.abort('blockedbyclient');
        const params = new URLSearchParams(request.postData() ?? '');
        const actions = [...params.getAll('action'), ...url.searchParams.getAll('action')];
        const readOnly = (actions.length ? actions : ['query']).every(action => ['query', 'parse', 'compare', 'paraminfo', 'help', 'expandtemplates', 'opensearch'].includes(action));
        const contentType = request.headers()['content-type'] ?? '';
        if (!readOnly || (request.method() !== 'GET' && contentType && !contentType.startsWith('application/x-www-form-urlencoded'))) {
          console.error(`[ReviewTool dry run] Blocked remote API action: ${actions.join(',')}`); return route.abort('blockedbyclient');
        }
        return route.continue();
      });
    }
    return { context, extensionId: id, directory, mode };
  } catch (error) { await context.close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dryRun = args.includes('--dry-run');
  const urlAt = args.indexOf('--url');
  const url = urlAt >= 0 ? args[urlAt + 1] : 'https://zh.wikipedia.org/wiki/孫中山?reviewtool_annotation_view=1';
  if (!url || new URL(url).origin !== 'https://zh.wikipedia.org') throw new Error('Use a Chinese Wikipedia HTTPS URL.');
  const { context, mode, directory } = await launch({ dryRun });
  console.log(`ReviewTool ${mode}: ${directory}\nNormal mode uses the real API; dry-run edits are stored in this profile's IndexedDB. Close Chrome to stop. Rebuild/relaunch to update the injected code.`);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const stop = () => { void context.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await new Promise(resolve => context.once('close', resolve));
}
