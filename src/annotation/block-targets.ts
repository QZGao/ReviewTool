import { SourceIndex } from './source-index';
import type { ElementNode, Projection, SourceAnchor, SourceExtent, ViewNode } from './types';

const blocks = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'ul', 'ol', 'dl', 'li', 'dt', 'dd', 'div', 'hr']);
const cached = new WeakMap<Projection, ReadonlyMap<ElementNode, Readonly<SourceAnchor>>>();
function extent(node: ViewNode): SourceExtent | null {
  if (node.kind !== 'element') return node;
  const first = node.children.map(extent).find(Boolean), last = [...node.children].reverse().map(extent).find(Boolean);
  return first && last ? { from: first.from, to: last.to } : null;
}

/** Source-defined block identities; nested containers with the same extent share one target. */
export function blockTargets(projection: Projection): ReadonlyMap<ElementNode, Readonly<SourceAnchor>> {
  const existing = cached.get(projection); if (existing) return existing;
  const targets = new Map<ElementNode, Readonly<SourceAnchor>>(), seen = new Set<string>(), index = new SourceIndex(projection.source);
  const visit = (node: ViewNode) => {
    if (node.kind !== 'element') return;
    const source = blocks.has(node.tag) ? extent(node) : null;
    if (source && source.from < source.to) {
      const key = `${source.from}:${source.to}`;
      if (!seen.has(key)) { seen.add(key); targets.set(node, Object.freeze({ unit: 'utf8-byte', start: index.toByte(source.from), end: index.toByte(source.to), target: 'block' })); }
    }
    node.children.forEach(visit);
  };
  projection.blocks.forEach(visit); cached.set(projection, targets); return targets;
}
