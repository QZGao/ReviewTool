import { decodeHTMLStrict } from 'entities';
import type { HtmlTag } from './opaque';
import type { Tag } from './types';

const tags: Record<string, Tag> = {
  b: 'strong', strong: 'strong', i: 'em', em: 'em', sup: 'sup', sub: 'sub', code: 'code',
  u: 'u', s: 's', strike: 's', del: 'del', ins: 'ins', small: 'small', big: 'big', mark: 'mark',
  abbr: 'abbr', bdi: 'bdi', bdo: 'bdo', cite: 'cite', dfn: 'dfn', kbd: 'kbd',
  q: 'q', ruby: 'ruby', rt: 'rt', rp: 'rp', samp: 'samp', time: 'time', var: 'var', tt: 'code',
  blockquote: 'blockquote', p: 'p', pre: 'pre',
  ul: 'ul', ol: 'ol', li: 'li', dl: 'dl', dt: 'dt', dd: 'dd',
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
};
const blockTags = new Set<Tag>(['p', 'pre', 'div', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
export const isBlockTag = (tag: Tag): boolean => blockTags.has(tag);

const styleValues: Record<string, RegExp> = {
  color: /^(?:[a-z]+|#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i,
  'background-color': /^(?:[a-z]+|#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/i,
  'font-size': /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger|\d+(?:\.\d+)?(?:px|em|rem|%))$/i,
  'font-weight': /^(?:normal|bold|bolder|lighter|[1-9]00)$/i,
  'font-style': /^(?:normal|italic|oblique)$/i,
  'text-decoration': /^(?:(?:none|underline|overline|line-through)\s*)+$/i,
  'text-align': /^(?:left|right|center|justify|start|end)$/i,
  'vertical-align': /^(?:baseline|sub|super|top|text-top|middle|bottom|text-bottom)$/i,
  'white-space': /^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/i,
};

/** Only local text presentation; source HTML never provides event handlers or resource URLs. */
export function htmlFormat(tag: HtmlTag): { tag: Tag; attributes: Record<string, string> } | null {
  const name = tags[tag.name];
  if (!name) return null;
  const attributes: Record<string, string> = {};
  const attrs = /\s+([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.raw.replace(/\/?\s*>$/, '').matchAll(attrs)) {
    const key = match[1].toLowerCase();
    const value = decodeHTMLStrict(match[2] ?? match[3] ?? match[4] ?? '');
    if (key === 'title') attributes.title = value;
    else if (key === 'lang' && /^[a-z0-9-]+$/i.test(value)) attributes.lang = value;
    else if (key === 'dir' && /^(?:ltr|rtl|auto)$/.test(value)) attributes.dir = value;
    else if ((key === 'start' && name === 'ol') || (key === 'value' && name === 'li')) {
      if (/^-?\d+$/.test(value)) attributes[key] = value;
    } else if (key === 'type' && name === 'ol' && /^[1aAiI]$/.test(value)) attributes.type = value;
    else if (key === 'reversed' && name === 'ol') attributes.reversed = '';
    else if (key === 'style') {
      const declarations = value.split(';').flatMap(part => {
        const colon = part.indexOf(':');
        const property = part.slice(0, colon).trim().toLowerCase();
        const content = part.slice(colon + 1).trim();
        if (['pre', 'code', 'kbd', 'samp'].includes(name) && ['font-size', 'background-color'].includes(property)) return [];
        return colon >= 0 && styleValues[property]?.test(content) ? [`${property}: ${content}`] : [];
      });
      if (declarations.length) attributes.style = declarations.join('; ');
    }
  }
  return { tag: name, attributes };
}
