import type { ElementNode, ViewNode, WikipediaHeadingAnchor } from './types';

/** The first source leaf includes the heading's opening syntax, even when it is hidden. */
export function headingSourceStart(node: ElementNode): number | undefined {
  if (!/^h[1-6]$/.test(node.tag)) return undefined;
  let first: ViewNode | undefined = node;
  while (first?.kind === 'element') first = first.children[0];
  return first?.from;
}

/** Move verified heading IDs between the hidden original and the active source view. */
export function bindHeadingAnchors(original: HTMLElement, view: HTMLElement, anchors: readonly WikipediaHeadingAnchor[]) {
  const doc = original.ownerDocument;
  const headings = new Map(Array.from(view.querySelectorAll<HTMLElement>('[data-heading-start]')).map(node => [Number(node.dataset.headingStart), node]));
  const owners = new Map<string, HTMLElement[]>();
  for (const node of Array.from(doc.querySelectorAll<HTMLElement>('[id]'))) {
    const list = owners.get(node.id) ?? []; list.push(node); owners.set(node.id, list);
  }
  const bindings: { id: string; original: HTMLElement; heading: HTMLElement }[] = [];
  const usedIds = new Set<string>(), usedStarts = new Set<number>();
  for (const anchor of anchors) {
    if (anchor.unit !== 'utf8-byte' || !Number.isInteger(anchor.start) || anchor.start < 0 || !anchor.id || !Number.isInteger(anchor.level) || anchor.level < 1 || anchor.level > 6) throw new Error('Invalid heading anchor metadata.');
    if (usedIds.has(anchor.id) || usedStarts.has(anchor.start)) throw new Error('Ambiguous heading anchor metadata.');
    usedIds.add(anchor.id); usedStarts.add(anchor.start);
    const heading = headings.get(anchor.start);
    const candidates = owners.get(anchor.id) ?? [];
    // Only transfer an existing section anchor with an exact source start and heading level.
    if (!heading || heading.tagName !== `H${anchor.level}` || candidates.length !== 1) continue;
    const owner = candidates[0];
    if (!original.contains(owner) || owner.closest('h1,h2,h3,h4,h5,h6')?.tagName !== heading.tagName) continue;
    bindings.push({ id: anchor.id, original: owner, heading });
  }
  for (const binding of bindings) {
    binding.original.removeAttribute('id'); binding.heading.id = binding.id;
  }

  let frame: number | undefined;
  const revealHash = (restoring: boolean) => {
    const win = doc.defaultView;
    if (!win?.location.hash) return;
    let id: string;
    try { id = decodeURIComponent(win.location.hash.slice(1)); } catch { return; }
    const binding = bindings.find(binding => binding.id === id);
    if (!binding) return;
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      const target = restoring ? binding.original : binding.heading;
      if (target.isConnected && doc.getElementById(id) === target) target.scrollIntoView({ block: 'start' });
    });
  };
  return {
    mounted() { revealHash(false); },
    restore() {
      if (frame !== undefined) doc.defaultView?.cancelAnimationFrame(frame);
      for (const binding of bindings) {
        binding.heading.removeAttribute('id'); binding.original.id = binding.id;
      }
      revealHash(true);
    },
  };
}
