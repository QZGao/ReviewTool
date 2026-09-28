import { decodeHTMLStrict } from 'entities';
import { bracketExtent, opaqueAt, readLine as line, readTag, tagExtent } from './opaque';
import { parseLists } from './lists';
import { htmlFormat, isBlockTag } from './html-format';
import { externalLinkAt } from './external-links';
import { templateLink } from './template-links';
import { referenceTemplate } from './reference-template';
import { fileCaption } from './file-caption';
import type { ElementNode, ProjectionOptions, Tag, TextRun, ViewNode } from './types';

const fileNamespace = /^(?:file|image|文件|檔案|档案|图像|圖像):/i;
const categoryNamespace = /^(?:category|分类|分類):/i;

export function text(source: string, from: number, to: number, replacement?: string): TextRun {
  return { kind: 'text', from, to, text: replacement ?? source.slice(from, to), mapping: replacement === undefined ? 'identity' : 'atomic', id: '', viewFrom: 0, viewTo: 0 };
}
const hidden = (from: number, to: number): ViewNode => ({ kind: 'hidden', from, to });
const element = (tag: Tag, children: ViewNode[]): ElementNode => ({ kind: 'element', tag, children });
const isBlock = (node: ViewNode): boolean => node.kind === 'element' && isBlockTag(node.tag);
const hasBlock = (nodes: ViewNode[]): boolean => nodes.some(n => isBlock(n) || (n.kind === 'element' && hasBlock(n.children)));
const hasLink = (nodes: ViewNode[]): boolean => nodes.some(n => n.kind === 'element' && (n.tag === 'a' || hasLink(n.children)));
const blockKinds = new Set(['table', 'unclosed-table', 'source-block', 'complex-list-item', 'complex-heading', 'pre', 'syntaxhighlight', 'source', 'gallery', 'div', 'blockquote', 'script']);
const tableTags = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption']);

function lastLeaf(nodes: ViewNode[]): ViewNode | undefined {
  let node = nodes[nodes.length - 1];
  while (node?.kind === 'element') node = node.children[node.children.length - 1];
  return node;
}

function referenceName(tag: string): string | undefined {
  const attributes = /\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.replace(/\/?\s*>$/, '').matchAll(attributes)) {
    if (match[1].toLowerCase() === 'name') return decodeHTMLStrict(match[2] ?? match[3] ?? match[4]).trim() || undefined;
  }
  return undefined;
}

export function raw(source: string, from: number, to: number, reason: string): ElementNode {
  const content = text(source, from, to);
  const block = reason !== 'file' && (blockKinds.has(reason) || /[\r\n]/.test(content.text));
  return { kind: 'element', tag: block ? 'pre' : 'code', rawKind: reason, children: block ? [element('code', [content])] : [content] };
}

/** A bounded presentation parser. Unsupported constructs keep their original source. */
function inline(source: string, from: number, end: number, baseUrl: string, depth = 0, allowLists = true): { nodes: ViewNode[]; end: number } {
  if (depth > 24) return { nodes: [raw(source, from, end, 'nesting-limit')], end };
  const nodes: ViewNode[] = [];
  let i = from;
  let literal = i;
  const flush = () => { if (literal < i) nodes.push(text(source, literal, i)); };
  while (i < end) {
    let emitted: ViewNode[] | null = null;
    let next = i;
    const opaque = opaqueAt(source, i);
    const external = opaque ? null : externalLinkAt(source, i, baseUrl);
    if (allowLists && (i === 0 || /[\r\n]/.test(source[i - 1])) && /[*#;:]/.test(source[i])) {
      const parsed = parseLists(source.slice(0, end), i,
        (from, to) => inline(source, from, to, baseUrl, depth + 1),
        (from, to) => raw(source, from, to, 'complex-list-item'));
      emitted = parsed.nodes;
      next = parsed.end;
      // A source container needs the list's final newline before its next parameter or closing delimiter.
      const length = source.slice(0, next).endsWith('\r\n') ? 2 : /[\r\n]/.test(source[next - 1]) ? 1 : 0;
      const last = lastLeaf(emitted);
      if (length && last?.kind === 'hidden' && last.to === next && last.from <= next - length) {
        last.to -= length;
        emitted.push(text(source, next - length, next));
      }
    } else if (opaque) {
      next = opaque.end;
      if (opaque.reason === 'template') {
        const reference = referenceTemplate(source, i, next);
        if (reference) {
          const ref = element('sup', [text(source, i, next, reference)]);
          ref.inspection = { kind: 'reference', from: i, to: next };
          emitted = [ref];
        }
        const known = reference ? null : templateLink(source, i, next, baseUrl);
        if (known) {
          const label = inline(source, known.label.from, known.label.to, baseUrl, depth + 1);
          if (label.end === known.label.to && !hasBlock(label.nodes) && !hasLink(label.nodes)) {
            const link = element('a', label.nodes);
            link.href = known.href;
            link.inspection = { kind: 'link', from: i, to: next };
            emitted = [hidden(i, known.label.from), link, hidden(known.label.to, next)];
          }
        }
        if (!emitted) {
          const size = source.startsWith('{{{', i) ? 3 : 2;
          const contentEnd = next - size;
          const content = inline(source, i + size, contentEnd, baseUrl, depth + 1);
          if (content.end !== contentEnd) emitted = [raw(source, i, next, 'complex-template')];
          else {
            const block = hasBlock(content.nodes) || /[\r\n]/.test(source.slice(i, next));
            const node = element(block ? 'div' : 'span', [text(source, i, i + size), ...content.nodes, text(source, contentEnd, next)]);
            node.template = true;
            emitted = [node];
          }
        }
      } else if (opaque.reason === 'language-conversion') {
        // Keep flags/variant labels literal; a branch separator at line start is not a definition-list marker.
        const content = inline(source, i + 2, next - 2, baseUrl, depth + 1, false);
        if (content.end !== next - 2) emitted = [raw(source, i, next, 'complex-language-conversion')];
        else {
          const block = hasBlock(content.nodes) || /[\r\n]/.test(source.slice(i, next));
          const conversion = element(block ? 'div' : 'span', [text(source, i, i + 2), ...content.nodes, text(source, next - 2, next)]);
          conversion.sourceKind = 'conversion';
          emitted = [conversion];
        }
      } else if (opaque.reason === 'table') {
        const content = inline(source, i + 2, next - 2, baseUrl, depth + 1);
        if (content.end !== next - 2) emitted = [raw(source, i, next, 'complex-table')];
        else {
          const table = element('div', [text(source, i, i + 2), ...content.nodes, text(source, next - 2, next)]);
          table.sourceKind = 'table';
          emitted = [table];
        }
      } else emitted = [raw(source, i, next, opaque.reason)];
    } else if (source.startsWith('[[', i)) {
      next = bracketExtent(source, i);
      const closed = source.slice(next - 2, next) === ']]';
      const innerEnd = closed ? next - 2 : next;
      const inside = source.slice(i + 2, innerEnd);
      const pipe = inside.indexOf('|');
      const target = (pipe < 0 ? inside : inside.slice(0, pipe));
      if (!closed || /[\r\n\[\]{}<>]/.test(target) || !target.trim() || (pipe >= 0 && !inside.slice(pipe + 1))) {
        emitted = [raw(source, i, next, 'unsupported-link')];
      } else if (fileNamespace.test(target) || categoryNamespace.test(target)) {
        const node = raw(source, i, next, fileNamespace.test(target) ? 'file' : 'category');
        if (fileNamespace.test(target)) {
          node.fileName = target.slice(target.indexOf(':') + 1).trim();
          node.inspection = { kind: 'image', from: i, to: next };
          const caption = pipe < 0 ? null : fileCaption(source, i + 3 + pipe, innerEnd);
          if (caption && caption.from < caption.to) {
            const content = inline(source, caption.from, caption.to, baseUrl, depth + 1);
            if (content.end === caption.to && !hasBlock(content.nodes)) {
              const description = element('span', content.nodes);
              description.fileCaption = true;
              node.children = [text(source, i, caption.from), description, text(source, caption.to, next)];
            }
          }
        }
        emitted = [node];
      } else {
        const labelFrom = pipe < 0 ? i + 2 : i + 3 + pipe;
        const label = inline(source, labelFrom, innerEnd, baseUrl, depth + 1);
        if (hasBlock(label.nodes) || hasLink(label.nodes) || label.end !== innerEnd) emitted = [raw(source, i, next, 'complex-link')];
        else {
          const link = element('a', label.nodes);
          link.href = new URL(encodeURIComponent(target.trim().replace(/^:/, '').replace(/ /g, '_')), baseUrl).href;
          link.inspection = { kind: 'link', from: i, to: next };
          emitted = [hidden(i, labelFrom), link, hidden(innerEnd, next)];
        }
      }
    } else if (external) {
      next = external.end;
      const link = element('a', []);
      link.href = external.href;
      link.inspection = { kind: 'link', from: i, to: next };
      if (external.numbered) {
        link.children = [text(source, i, next, '')];
        link.externalNumber = true;
        emitted = [link];
      } else if (!external.bracketed) {
        link.children = literalWithEntities(source, external.urlFrom, external.urlTo);
        emitted = [link];
      } else {
        const label = inline(source, external.labelFrom, external.labelTo, baseUrl, depth + 1);
        if (hasBlock(label.nodes) || hasLink(label.nodes) || label.end !== external.labelTo) emitted = [raw(source, i, next, 'complex-link')];
        else {
          link.children = label.nodes;
          emitted = [hidden(i, external.labelFrom), link, hidden(external.labelTo, next)];
        }
      }
    } else if (source.startsWith("''", i)) {
      let count = 2;
      while (source[i + count] === "'") count++;
      const marker = "'".repeat(count);
      const close = [2, 3, 5].includes(count) ? source.indexOf(marker, i + count) : -1;
      if (close < 0 || close >= end) { next = end; emitted = [raw(source, i, next, 'unclosed-emphasis')]; }
      else {
        next = close + count;
        const content = inline(source, i + count, close, baseUrl, depth + 1);
        if (hasBlock(content.nodes) || content.end !== close) emitted = [raw(source, i, next, 'complex-emphasis')];
        else {
          const styled = count === 2 ? element('em', content.nodes) : element('strong', count === 5 ? [element('em', content.nodes)] : content.nodes);
          emitted = [hidden(i, i + count), styled, hidden(close, next)];
        }
      }
    } else if (source[i] === '<') {
      const tag = readTag(source, i);
      if (tag) {
        next = tagExtent(source, i, tag);
        const closingStart = source.lastIndexOf('</', next - 1);
        const closing = closingStart >= tag.end ? readTag(source, closingStart) : null;
        const paired = !tag.closing && !tag.selfClosing && closing?.name === tag.name && closing.closing && closing.end === next;
        const format = htmlFormat(tag);
        if (tag.name === 'br' && /^<br\s*\/?\s*>$/i.test(tag.raw)) {
          const lineBreak = element('span', [text(source, i, next, '\n')]);
          lineBreak.lineBreak = true;
          emitted = [lineBreak];
        } else if (tag.name === 'ref' && !tag.closing && (tag.selfClosing || paired)) {
          const ref = element('sup', [text(source, i, next, '')]);
          const name = referenceName(tag.raw);
          ref.inspection = { kind: 'reference', from: i, to: next, ...(name ? { name } : {}) };
          emitted = [ref];
        } else if (paired && (tag.name === 'references' || tableTags.has(tag.name))) {
          const content = inline(source, tag.end, closingStart, baseUrl, depth + 1);
          if (content.end !== closingStart) emitted = [raw(source, i, next, tag.name)];
          else {
            const block = tag.name === 'table' || hasBlock(content.nodes) || /[\r\n]/.test(source.slice(i, next));
            const container = element(block ? 'div' : 'span', [text(source, i, tag.end), ...content.nodes, text(source, closingStart, next)]);
            container.sourceKind = tag.name === 'references' ? 'references' : tag.name === 'table' ? 'table' : 'markup';
            emitted = [container];
          }
        } else if (tag.name === 'nowiki' && tag.selfClosing && !tag.closing) {
          emitted = [hidden(i, next)];
        } else if (paired && tag.name === 'nowiki') {
          emitted = [hidden(i, tag.end), ...literalWithEntities(source, tag.end, closingStart), hidden(closingStart, next)];
        } else if (tag.name === 'hr' && tag.selfClosing && !tag.closing) {
          emitted = [element('hr', [hidden(i, next)])];
        } else if (paired && format) {
          let contents: ViewNode[];
          if (format.tag === 'pre') contents = literalWithEntities(source, tag.end, closingStart);
          else if (format.tag === 'blockquote') {
            contents = parseSource(source.slice(tag.end, closingStart), { wikiBaseUrl: baseUrl }, depth + 1);
            shiftSource(contents, tag.end);
          } else {
            const parsed = inline(source, tag.end, closingStart, baseUrl, depth + 1);
            const allowsBlocks = ['ul', 'ol', 'li', 'dl', 'dt', 'dd'].includes(format.tag);
            if (parsed.end !== closingStart || (!allowsBlocks && hasBlock(parsed.nodes))) {
              emitted = [raw(source, i, next, 'complex-html-content')]; contents = [];
            } else contents = parsed.nodes;
            if (['ul', 'ol', 'dl'].includes(format.tag)) contents = contents.map(node => node.kind === 'text' && !node.text.trim() ? hidden(node.from, node.to) : node);
          }
          if (!emitted) {
            const node = element(format.tag, [hidden(i, tag.end), ...contents, hidden(closingStart, next)]);
            node.attributes = format.attributes;
            emitted = [node];
          }
        } else emitted = [raw(source, i, next, tag.name)];
      }
    } else if (source[i] === '&') {
      const match = /^&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/.exec(source.slice(i, end));
      if (match) {
        const decoded = decodeHTMLStrict(match[0]);
        if (decoded !== match[0]) { next = i + match[0].length; emitted = [text(source, i, next, decoded)]; }
      }
    }
    if (emitted) {
      flush(); nodes.push(...emitted); i = next; literal = i;
    } else i++;
  }
  flush();
  return { nodes, end: i };
}

function literalWithEntities(source: string, from: number, to: number): ViewNode[] {
  const nodes: ViewNode[] = [];
  const re = /&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g;
  let cursor = from;
  for (const match of source.slice(from, to).matchAll(re)) {
    const start = from + match.index;
    const decoded = decodeHTMLStrict(match[0]);
    if (decoded === match[0]) continue;
    if (cursor < start) nodes.push(text(source, cursor, start));
    cursor = start + match[0].length;
    nodes.push(text(source, start, cursor, decoded));
  }
  if (cursor < to) nodes.push(text(source, cursor, to));
  return nodes;
}

function shiftSource(nodes: ViewNode[], offset: number): void {
  for (const node of nodes) {
    if (node.kind === 'element') {
      if (node.inspection) { node.inspection.from += offset; node.inspection.to += offset; }
      shiftSource(node.children, offset);
    } else { node.from += offset; node.to += offset; }
  }
}

function sourceBounds(node: ViewNode): { from: number; to: number } | null {
  if (node.kind !== 'element') return node;
  const extents = node.children.map(sourceBounds).filter((extent): extent is { from: number; to: number } => extent !== null);
  return extents.length ? { from: extents[0].from, to: extents[extents.length - 1].to } : null;
}

/** Block margins follow source blank lines, not the kind of construct being displayed. */
function setFlowBreaks(source: string, blocks: ViewNode[]): void {
  let previousEnd: number | undefined;
  for (const block of blocks) {
    if (block.kind !== 'element') continue;
    const extent = sourceBounds(block);
    if (!extent) continue;
    if (previousEnd !== undefined) {
      const count = source.slice(previousEnd, extent.from).match(/\r\n|\r|\n/g)?.length ?? 0;
      block.flowBreak = count >= 2 ? 'paragraph' : 'line';
    }
    previousEnd = extent.to;
    while (previousEnd > extent.from && /[ \t\r\n]/.test(source[previousEnd - 1])) previousEnd--;
  }
}

export function parseSource(source: string, options: ProjectionOptions = {}, depth = 0): ViewNode[] {
  if (depth > 24) return [raw(source, 0, source.length, 'nesting-limit')];
  const base = new URL(options.wikiBaseUrl ?? 'https://zh.wikipedia.org/wiki/');
  if (!['http:', 'https:'].includes(base.protocol) || !base.pathname.endsWith('/')) throw new TypeError('wikiBaseUrl must be an HTTP(S) directory URL.');
  const blocks: ViewNode[] = [];
  let paragraph: ViewNode[] = [];
  let i = 0;
  const flush = () => {
    // The next block already starts a new line; do not also render a trailing newline inside this paragraph.
    const last = paragraph[paragraph.length - 1];
    const ending = last?.kind === 'text' && last.lineBreak ? last : null;
    if (ending) paragraph.pop();
    if (paragraph.length) { blocks.push(element('p', paragraph)); paragraph = []; }
    if (ending) blocks.push(hidden(ending.from, ending.to));
  };
  const append = (nodes: ViewNode[]) => {
    for (const node of nodes) {
      if (isBlock(node)) { flush(); blocks.push(node); }
      else paragraph.push(node);
    }
  };
  while (i < source.length) {
    const current = line(source, i);
    if (!current.value.trim()) {
      flush(); blocks.push(hidden(i, current.after)); i = current.after; continue;
    }
    const atLineStart = i === 0 || /[\r\n]/.test(source[i - 1]);
    const heading = atLineStart ? /^(={1,6})(?![=])(.*?)(\1)[ \t]*$/.exec(current.value) : null;
    const list = atLineStart ? /^([*#;:]+)[ \t]*/.exec(current.value) : null;
    const rule = atLineStart ? /^-{4,}/.exec(current.value) : null;
    if (rule) {
      flush(); blocks.push(element('hr', [hidden(i, i + rule[0].length)]));
      i += rule[0].length;
    } else if (heading && heading[2].trim()) {
      flush();
      const from = i + heading[1].length;
      const to = from + heading[2].length;
      const parsed = inline(source, from, to, base.href, depth);
      if (hasBlock(parsed.nodes) || parsed.end !== to) blocks.push(raw(source, i, current.end, 'complex-heading'));
      else blocks.push(element(`h${heading[1].length}` as Tag, [hidden(i, from), ...parsed.nodes, hidden(to, current.end)]));
      if (current.after > current.end) blocks.push(hidden(current.end, current.after));
      i = current.after;
    } else if (list) {
      flush();
      const parsed = parseLists(source, i,
        (from, to) => inline(source, from, to, base.href, depth),
        (from, to) => raw(source, from, to, 'complex-list-item'));
      blocks.push(...parsed.nodes);
      i = parsed.end;
    } else if (atLineStart && current.value.startsWith(' ')) {
      flush();
      const contents: ViewNode[] = [];
      while (i < source.length && source[i] === ' ') {
        const item = line(source, i);
        const parsed = inline(source, i + 1, item.end, base.href, depth);
        if (hasBlock(parsed.nodes) || parsed.end !== item.end) {
          if (contents.length) blocks.push(element('pre', contents.splice(0)));
          const end = Math.max(item.end, parsed.end);
          blocks.push(raw(source, i, end, 'complex-preformatted')); i = end; break;
        }
        contents.push(hidden(i, i + 1), ...parsed.nodes);
        if (item.after > item.end) contents.push(text(source, item.end, item.after));
        i = item.after;
      }
      if (contents.length) blocks.push(element('pre', contents));
    } else if (atLineStart && (/^[\t]/.test(current.value) || /^[*#;:]/.test(current.value))) {
      flush(); blocks.push(raw(source, i, current.end, 'source-block'));
      if (current.after > current.end) blocks.push(hidden(current.end, current.after));
      i = current.after;
    } else {
      const parsed = inline(source, i, current.end, base.href, depth);
      append(parsed.nodes);
      i = parsed.end;
      const rest = line(source, i);
      if (rest.end === i && rest.after > i) {
        const next = line(source, rest.after).value;
        if (!next.trim() || /^[=*#;:\s]/.test(next) || /^-{4,}/.test(next) || next.startsWith('{|') || /^<(?:blockquote|pre|p|ul|ol|dl)\b/i.test(next)) {
          flush(); blocks.push(hidden(i, rest.after));
        } else if (paragraph.length) {
          const ending = text(source, i, rest.after, '\n'); ending.lineBreak = true;
          paragraph.push(ending);
        } else blocks.push(hidden(i, rest.after));
        i = rest.after;
      }
    }
  }
  flush();
  setFlowBreaks(source, blocks);
  return blocks;
}
