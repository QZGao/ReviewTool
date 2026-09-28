import { decodeHTMLStrict } from 'entities';
import { templateFields } from './template-fields';
import type { SourceExtent } from './types';

// Verified shortcuts in Chinese Wikipedia's Internal link helper documentation.
const shortcuts = new Set(['le', 'lj', 'ld', 'lk', 'lvi', 'ly']);
const languageCode = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i;
function trimmed(source: string, from: number, to: number): SourceExtent {
  while (from < to && /\s/.test(source[from])) from++;
  while (to > from && /\s/.test(source[to - 1])) to--;
  return { from, to };
}

/** Local link and source-backed display parameter. Unknown forms keep ordinary template presentation. */
export function templateLink(source: string, from: number, to: number, baseUrl: string): { href: string; label: SourceExtent } | null {
  if (source.startsWith('{{{', from)) return null;
  const parts = templateFields(source, from + 2, to - 2);
  if (!parts || parts.length < 2) return null;
  const name = source.slice(parts[0].from, parts[0].to).trim().replace(/_/g, ' ').replace(/^(?:template|模板):\s*/i, '').toLowerCase();
  const translink = name === 'tsl' || name === 'translink';
  const language = name.startsWith('link-') ? name.slice(5) : '';
  const helper = shortcuts.has(name) || (languageCode.test(language) && !['wd'].includes(language));
  if (!translink && !helper) return null;
  const allowed = translink ? new Set(['1', '2', '3', '4', 'nocat']) : new Set(['1', '2', '3', 'd', 'nocat']);
  const args = new Map<string, SourceExtent>();
  let positional = 1;
  for (const field of parts.slice(1)) {
    const key = field.equals === undefined ? String(positional++) : source.slice(field.from, field.equals).trim();
    if (!allowed.has(key)) return null;
    args.set(key, trimmed(source, field.equals === undefined ? field.from : field.equals + 1, field.to));
  }
  const nonempty = (value: SourceExtent | undefined): SourceExtent | undefined => value && value.from < value.to ? value : undefined;
  const value = (key: string): SourceExtent | undefined => nonempty(args.get(key));
  const code = value('1');
  if (translink) {
    if (!code || !languageCode.test(source.slice(code.from, code.to)) || !value('2')) return null;
  }
  const target = translink ? value('2') : args.has('1') ? value('1') : value('2');
  const label = (translink ? value('4') ?? value('3') : args.has('d') ? value('d') : value('3')) ?? target;
  if (!target || !label) return null;
  const title = decodeHTMLStrict(source.slice(target.from, target.to)).replace(/^:/, '');
  // Dynamic/invalid targets cannot be resolved without template execution.
  if (!title.trim() || /^[.]{1,2}$/.test(title) || /[\u0000-\u001f\u007f<>\[\]{}|]/.test(title)) return null;
  const [page, ...fragment] = title.split('#');
  if (!page.trim() || /^[.]{1,2}$/.test(page)) return null;
  const destination = translink && code ? `https://${source.slice(code.from, code.to).toLowerCase()}.wikipedia.org/wiki/` : baseUrl;
  const href = new URL(encodeURIComponent(page.replace(/ /g, '_')), destination);
  if (fragment.length) href.hash = fragment.join('#').replace(/ /g, '_');
  return { href: href.href, label };
}
