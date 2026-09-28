import type { ElementNode, Projection, RenderOptions, ViewNode } from './types';

function safeUrl(value: string, base: string): string | null {
  try { const url = new URL(value, base); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

const normalizeName = (name: string) => name.replace(/_/g, ' ').trim();

function fileIdentity(value: string): string | null {
  try {
    const match = /(?:^|[/.])(?:File|Image|文件|檔案|档案|图像|圖像):([^?#]+)/i.exec(decodeURIComponent(value));
    return match ? normalizeName(match[1]) : null;
  } catch { return null; }
}

function uploadIdentity(url: string): string | null {
  const parsed = new URL(url);
  if (!['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(parsed.hostname)) return null;
  const parts = parsed.pathname.split('/');
  const name = parts[parts.length - (parts.includes('thumb') ? 2 : 1)];
  try { return name ? normalizeName(decodeURIComponent(name)) : null; }
  catch { return null; }
}

/** Copy an existing img, retaining ordinary presentation attributes, never executable attributes. */
function copyImage(original: HTMLImageElement, base: string): HTMLImageElement | null {
  const src = original.getAttribute('src');
  const url = src ? safeUrl(src, base) : null;
  if (!url) return null;
  const copy = original.cloneNode(false) as HTMLImageElement;
  const allowed = new Set(['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'class', 'loading', 'decoding', 'referrerpolicy']);
  for (const attribute of Array.from(copy.attributes)) if (!allowed.has(attribute.name)) copy.removeAttribute(attribute.name);
  copy.src = url;
  const srcset = copy.getAttribute('srcset');
  if (srcset) {
    const candidates = srcset.split(',').map(candidate => {
      const match = /^(\S+)(?:\s+(\d+(?:\.\d+)?[wx]))?$/.exec(candidate.trim());
      const resolved = match ? safeUrl(match[1], base) : null;
      return resolved ? `${resolved}${match?.[2] ? ` ${match[2]}` : ''}` : null;
    });
    if (candidates.every(Boolean)) copy.setAttribute('srcset', candidates.join(', '));
    else copy.removeAttribute('srcset');
  }
  return copy;
}

/** Filename identity only. No table bindings, text matching, or Parsoid source metadata. */
export function referenceImages(doc: Document, projection: Projection, options: RenderOptions): Map<ElementNode, HTMLImageElement> {
  const images = new Map<ElementNode, HTMLImageElement>();
  if (!options.referenceHtml) return images;
  const base = options.referenceBaseUrl ?? 'https://zh.wikipedia.org/wiki/';
  if (!safeUrl(base, base)) throw new TypeError('referenceBaseUrl must be HTTP(S).');
  const template = doc.createElement('template');
  template.innerHTML = options.referenceHtml;
  const files = new Map<string, Map<string, HTMLImageElement>>();
  for (const original of Array.from(template.content.querySelectorAll('img'))) {
    const copy = copyImage(original, base);
    if (!copy) continue;
    const names = new Set([
      fileIdentity(original.closest('a')?.getAttribute('href') ?? ''),
      fileIdentity(original.getAttribute('resource') ?? ''),
      uploadIdentity(copy.src),
    ].filter((name): name is string => name !== null));
    // A custom image link may point to a different file page. Conflicting identities are ambiguous.
    if (names.size !== 1) continue;
    const name = [...names][0];
    const candidates = files.get(name) ?? new Map<string, HTMLImageElement>();
    const signature = ['src', 'srcset', 'sizes', 'width', 'height', 'alt'].map(attr => copy.getAttribute(attr) ?? '').join('\n');
    candidates.set(signature, copy);
    files.set(name, candidates);
  }
  const visit = (node: ViewNode): void => {
    if (node.kind !== 'element') return;
    if (node.fileName) {
      const candidates = files.get(normalizeName(node.fileName));
      if (candidates?.size === 1) images.set(node, [...candidates.values()][0].cloneNode(false) as HTMLImageElement);
    }
    node.children.forEach(visit);
  };
  projection.blocks.forEach(visit);
  return images;
}
