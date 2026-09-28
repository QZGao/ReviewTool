/** Conservative boundaries for source we deliberately do not visually interpret. */
export interface OpaqueExtent { end: number; reason: string }
export interface HtmlTag { name: string; end: number; closing: boolean; selfClosing: boolean; raw: string }
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export function readLine(source: string, from: number): { end: number; after: number; value: string } {
  let end = from;
  while (end < source.length && !/[\r\n]/.test(source[end])) end++;
  const after = end + (source.startsWith('\r\n', end) ? 2 : end < source.length ? 1 : 0);
  return { end, after, value: source.slice(from, end) };
}

export function readTag(source: string, from: number): HtmlTag | null {
  const match = /^<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/?\s*>/i.exec(source.slice(from));
  if (!match) return null;
  const raw = match[0];
  const name = match[1].toLowerCase();
  return { name, end: from + raw.length, closing: raw.startsWith('</'), selfClosing: /\/\s*>$/.test(raw) || voidTags.has(name), raw };
}

export function tagExtent(source: string, from: number, tag: HtmlTag): number {
  if (tag.selfClosing || tag.closing) return tag.end;
  let depth = 1;
  let cursor = tag.end;
  while (cursor < source.length) {
    const next = source.indexOf('<', cursor);
    if (next < 0) break;
    if (source.startsWith('<!--', next)) {
      const end = source.indexOf('-->', next + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    const candidate = readTag(source, next);
    if (!candidate) { cursor = next + 1; continue; }
    if (candidate.name !== tag.name && !candidate.closing && ['nowiki', 'pre', 'syntaxhighlight', 'source', 'math'].includes(candidate.name)) {
      cursor = tagExtent(source, next, candidate); continue;
    }
    if (candidate.name === tag.name) {
      if (candidate.closing) depth--;
      else if (!candidate.selfClosing) depth++;
      if (!depth) return candidate.end;
    }
    cursor = candidate.end;
  }
  // An unclosed construct stays source-visible through the remaining document.
  return source.length;
}

/** Find the end of an internal link, skipping protected and nested source. */
export function bracketExtent(source: string, from: number): number {
  let depth = 1;
  let i = from + 2;
  while (i < source.length) {
    const opaque = opaqueAt(source, i);
    if (opaque) { i = opaque.end; continue; }
    if (source[i] === '<') {
      const tag = readTag(source, i);
      if (tag && !tag.closing) { i = tagExtent(source, i, tag); continue; }
    }
    if (source.startsWith('[[', i)) { depth++; i += 2; }
    else if (source.startsWith(']]', i)) { i += 2; if (!--depth) return i; }
    else i++;
  }
  return source.length;
}

function bracesExtent(source: string, from: number): OpaqueExtent {
  const stack: number[] = [];
  let cursor = from;
  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      cursor = end < 0 ? source.length : end + 3;
    } else if (source[cursor] === '<') {
      const tag = readTag(source, cursor);
      if (tag && !tag.closing && ['nowiki', 'pre', 'syntaxhighlight', 'source', 'math'].includes(tag.name)) {
        cursor = tagExtent(source, cursor, tag);
      } else cursor++;
    } else if (source.startsWith('{{', cursor)) {
      const size = source.startsWith('{{{', cursor) ? 3 : 2;
      stack.push(size); cursor += size;
    } else if (stack.length && source.startsWith('}'.repeat(stack[stack.length - 1]), cursor)) {
      cursor += stack[stack.length - 1];
      stack.pop();
      if (!stack.length) return { end: cursor, reason: 'template' };
    } else cursor++;
  }
  return { end: source.length, reason: 'unclosed-template' };
}

export function opaqueAt(source: string, from: number): OpaqueExtent | null {
  if (source.startsWith('<!--', from)) {
    const end = source.indexOf('-->', from + 4);
    return { end: end < 0 ? source.length : end + 3, reason: 'comment' };
  }
  if (source.startsWith('{{', from)) return bracesExtent(source, from);
  if (source.startsWith('-{', from)) {
    let depth = 1;
    let cursor = from + 2;
    while (cursor < source.length && depth) {
      if (source.startsWith('<!--', cursor)) {
        const close = source.indexOf('-->', cursor + 4);
        cursor = close < 0 ? source.length : close + 3;
        continue;
      }
      if (source[cursor] === '<') {
        const tag = readTag(source, cursor);
        if (tag && !tag.closing) { cursor = tagExtent(source, cursor, tag); continue; }
      }
      if (source.startsWith('{{', cursor)) { cursor = bracesExtent(source, cursor).end; continue; }
      if (source.startsWith('-{', cursor)) { depth++; cursor += 2; }
      else if (source.startsWith('}-', cursor)) { depth--; cursor += 2; }
      else cursor++;
    }
    return { end: cursor, reason: depth ? 'unclosed-language-conversion' : 'language-conversion' };
  }
  if (source.startsWith('{|', from)) {
    let depth = 1;
    let cursor = from + 2;
    while (cursor < source.length) {
      if (source.startsWith('-{', cursor)) {
        const conversion = opaqueAt(source, cursor);
        if (conversion) { cursor = conversion.end; continue; }
      }
      if (source.startsWith('<!--', cursor)) {
        const close = source.indexOf('-->', cursor + 4);
        cursor = close < 0 ? source.length : close + 3;
        continue;
      }
      if (source.startsWith('{{', cursor)) { cursor = bracesExtent(source, cursor).end; continue; }
      if (source[cursor] === '<') {
        const tag = readTag(source, cursor);
        if (tag && !tag.closing) { cursor = tagExtent(source, cursor, tag); continue; }
      }
      if (source.startsWith('{|', cursor)) { depth++; cursor += 2; }
      else if (source.startsWith('|}', cursor)) {
        cursor += 2;
        if (!--depth) return { end: cursor, reason: 'table' };
      } else cursor++;
    }
    return { end: source.length, reason: 'unclosed-table' };
  }
  return null;
}
