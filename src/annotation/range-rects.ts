/** Text-only rectangles avoid treating the whitespace between blocks as highlighted text. */
export function textRects(range: Range, doc: Document): DOMRect[] {
  const ancestor = range.commonAncestorContainer;
  if (ancestor.nodeType === 1 && (ancestor as Element).matches('[data-block-target]')) return Array.from(range.getClientRects());
  if (ancestor.nodeType === 3) return Array.from(range.getClientRects());
  const walker = doc.createTreeWalker(ancestor, 4 /* SHOW_TEXT */);
  const rects: DOMRect[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest('[data-block-target]')) continue;
    if (range.comparePoint(node, 0) === 1) break;
    if (!node.length || range.comparePoint(node, node.length) === -1 || !range.intersectsNode(node)) continue;
    const part = doc.createRange();
    part.setStart(node, node === range.startContainer ? range.startOffset : 0);
    part.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
    if (!part.collapsed) rects.push(...Array.from(part.getClientRects()));
  }
  return rects.filter(rect => rect.width > 0 && rect.height > 0);
}
