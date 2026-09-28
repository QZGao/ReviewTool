interface Thumbnail { url: string; width: number; height: number }
interface ImageInfoResponse {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages?: { title: string; imageinfo?: { thumburl?: string; thumbwidth?: number; thumbheight?: number }[] }[];
  };
}

/** Lazy, per-view thumbnail cache. Nearby requests share a batch; no article-wide prefetch. */
export function imagePreviews(signal: AbortSignal): (fileName: string) => Promise<Thumbnail | null> {
  const cache = new Map<string, Promise<Thumbnail | null>>();
  const pending = new Map<string, (value: Thumbnail | null) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const request = async (batch: [string, (value: Thumbnail | null) => void][]) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10000);
    const thumbnails = new Map<string, Thumbnail>();
    try {
      const url = new URL('https://zh.wikipedia.org/w/api.php');
      url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', origin: '*',
        prop: 'imageinfo', iiprop: 'url', iiurlwidth: '250', redirects: '1', titles: batch.map(([title]) => title).join('|') }).toString();
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Thumbnail lookup failed.');
      const data = await response.json() as ImageInfoResponse;
      const aliases = new Map([...(data.query?.normalized ?? []), ...(data.query?.redirects ?? [])].map(item => [item.from, item.to]));
      const pages = new Map((data.query?.pages ?? []).map(page => [page.title, page]));
      for (const [title] of batch) {
        let resolved = title;
        const seen = new Set<string>();
        while (aliases.has(resolved) && !seen.has(resolved)) { seen.add(resolved); resolved = aliases.get(resolved)!; }
        // Commons files can have missing:true on the local wiki and still carry valid imageinfo.
        const info = pages.get(resolved)?.imageinfo?.[0];
        if (!info?.thumburl || !info.thumbwidth || !info.thumbheight) continue;
        const imageUrl = new URL(info.thumburl);
        if (imageUrl.protocol !== 'https:' || !Number.isFinite(info.thumbwidth) || !Number.isFinite(info.thumbheight) || info.thumbwidth <= 0 || info.thumbheight <= 0) continue;
        thumbnails.set(title, { url: imageUrl.href, width: Math.min(250, info.thumbwidth), height: Math.round(info.thumbheight * Math.min(250, info.thumbwidth) / info.thumbwidth) });
      }
    } catch { /* The popup reports an unavailable preview; source remains selectable. */ }
    finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      for (const [title, resolve] of batch) resolve(signal.aborted ? null : thumbnails.get(title) ?? null);
    }
  };

  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    for (const resolve of pending.values()) resolve(null);
    pending.clear(); cache.clear();
  }, { once: true });

  return fileName => {
    const name = fileName.replace(/_/g, ' ').trim();
    if (signal.aborted || !name || /[|\x00-\x1f]/.test(name)) return Promise.resolve(null);
    const title = `File:${name}`;
    const existing = cache.get(title);
    if (existing !== undefined) return existing;
    const promise = new Promise<Thumbnail | null>(resolve => pending.set(title, resolve));
    cache.set(title, promise);
    if (timer === undefined) timer = setTimeout(() => {
      timer = undefined;
      const batch = [...pending]; pending.clear();
      for (let index = 0; index < batch.length; index += 50) void request(batch.slice(index, index + 50));
    }, 40);
    return promise;
  };
}
