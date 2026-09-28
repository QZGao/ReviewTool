import { createApi, mode } from './mediawiki';

declare global { interface Window { __reviewToolDev?: { mode: string; createApi: typeof createApi } } }

async function boot() {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (typeof mw !== 'undefined' && mw.loader && typeof $ !== 'undefined') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (typeof mw === 'undefined') throw new Error('MediaWiki did not initialize.');
  await mw.loader.using(['mediawiki.api', 'mediawiki.util', 'mediawiki.Title']);
  if (window.__reviewToolDev) return;
  window.__reviewToolDev = { mode, createApi };
  await import('./main');
}
void boot().catch(error => console.error('[ReviewTool development extension]', error));
