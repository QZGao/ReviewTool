import { bracketExtent, opaqueAt, readLine, readTag, tagExtent } from './opaque';
import type { ElementNode, Tag, ViewNode } from './types';

type InlineParser = (from: number, to: number) => { nodes: ViewNode[]; end: number };
const element = (tag: Tag, children: ViewNode[] = []): ElementNode => ({ kind: 'element', tag, children });
const hidden = (from: number, to: number): ViewNode => ({ kind: 'hidden', from, to });
const listType = (marker: string): 'ul' | 'ol' | 'dl' => marker === '*' ? 'ul' : marker === '#' ? 'ol' : 'dl';
const itemType = (marker: string): 'li' | 'dt' | 'dd' => marker === ';' ? 'dt' : marker === ':' ? 'dd' : 'li';

function definitionSeparator(source: string, from: number, to: number): number {
  for (let cursor = from; cursor < to;) {
    const opaque = opaqueAt(source, cursor);
    const tag = source[cursor] === '<' ? readTag(source, cursor) : null;
    const skip = opaque?.end ?? (source.startsWith('[[', cursor) ? bracketExtent(source, cursor)
      : tag ? tagExtent(source, cursor, tag) : cursor);
    if (skip > cursor) { cursor = skip; continue; }
    if (/^\[(?:https?|ftp):\/\//i.test(source.slice(cursor, to))) {
      const close = source.indexOf(']', cursor + 1);
      cursor = close < 0 ? to : close + 1; continue;
    }
    const url = /^(?:https?|ftp):\/\/[^\s<>\[\]{}|]+/i.exec(source.slice(cursor, to));
    if (url) { cursor += url[0].length; continue; }
    if (source[cursor] === ':') return cursor;
    cursor++;
  }
  return -1;
}

/** Build source-ordered lists, including implicit containing items and definition terms. */
export function parseLists(source: string, from: number, parseInline: InlineParser, fallback: (from: number, to: number) => ElementNode): { nodes: ViewNode[]; end: number } {
  const nodes: ViewNode[] = [];
  const levels: { list: ElementNode; item: ElementNode }[] = [];
  let previous = '';
  let cursor = from;
  while (cursor < source.length) {
    const line = readLine(source, cursor);
    const marker = /^([*#;:]+)[ \t]*/.exec(line.value);
    if (!marker) break;
    const path = marker[1];
    const normalized = path.replace(/;/g, ':');
    let shared = normalized === previous ? path.length : 0;
    if (!shared) while (shared < path.length && path[shared] === previous[shared]) shared++;
    if (path.length > 24) { nodes.push(fallback(cursor, line.end)); return { nodes, end: line.end }; }

    let contentFrom = cursor + marker[0].length;
    let contentEnd = line.end;
    while (contentEnd > contentFrom && /[ \t]/.test(source[contentEnd - 1])) contentEnd--;
    const terms = new Map<number, { nodes: ViewNode[]; end: number; colon: number; after: number }>();
    let failedEnd = 0;
    // A newly opened semicolon level can consume a term before its nested list is opened.
    for (let depth = shared === path.length ? path.length - 1 : shared; depth < path.length; depth++) {
      if (path[depth] !== ';') continue;
      const colon = definitionSeparator(source, contentFrom, contentEnd);
      if (colon < 0) continue;
      let termEnd = colon;
      while (termEnd > contentFrom && /[ \t]/.test(source[termEnd - 1])) termEnd--;
      const parsed = parseInline(contentFrom, termEnd);
      if (parsed.end !== termEnd) { failedEnd = Math.max(line.end, parsed.end); break; }
      let after = colon + 1;
      while (after < contentEnd && /[ \t]/.test(source[after])) after++;
      terms.set(depth, { nodes: parsed.nodes, end: termEnd, colon, after });
      contentFrom = after;
    }
    const tail = failedEnd ? null : parseInline(contentFrom, contentEnd);
    if (!tail || tail.end !== contentEnd) {
      const end = Math.max(line.end, failedEnd, tail?.end ?? 0);
      nodes.push(fallback(cursor, end)); return { nodes, end };
    }

    levels.length = shared;
    let prefixPending = true;
    const prefix = (row: ElementNode) => {
      if (prefixPending) { row.children.push(hidden(cursor, cursor + marker[0].length)); prefixPending = false; }
    };
    const splitTerm = (depth: number) => {
      const term = terms.get(depth);
      if (!term) return;
      const level = levels[depth];
      prefix(level.item);
      level.item.children.push(...term.nodes, hidden(term.end, term.colon));
      const definition = element('dd', [hidden(term.colon, term.after)]);
      level.list.children.push(definition);
      level.item = definition;
    };
    if (shared === path.length) {
      const level = levels[shared - 1];
      level.item = element(itemType(path[path.length - 1]));
      level.list.children.push(level.item);
      splitTerm(shared - 1);
    } else {
      // A description sublist following a term belongs to a dd, not inside the term's bold text.
      if (shared && path[shared - 1] === ':' && levels[shared - 1].item.tag === 'dt') {
        const level = levels[shared - 1];
        level.item = element('dd'); level.list.children.push(level.item);
      }
      for (let depth = shared; depth < path.length; depth++) {
        const list = element(listType(path[depth]));
        if (depth) levels[depth - 1].item.children.push(list);
        else nodes.push(list);
        const item = element(itemType(path[depth]));
        list.children.push(item); levels.push({ list, item });
        splitTerm(depth);
      }
    }
    const row = levels[levels.length - 1].item;
    prefix(row);
    row.children.push(...tail.nodes, hidden(contentEnd, line.after));
    previous = normalized;
    cursor = line.after;
  }
  return { nodes, end: cursor };
}
