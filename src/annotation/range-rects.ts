/** Source-text fragments exclude annotation controls between selected blocks. */
export function textRanges(range: Range, doc: Document): Range[] {
  const ancestor = range.commonAncestorContainer;
  if (ancestor.nodeType === 1 && (ancestor as Element).matches('[data-block-target]')) return [range];
  if (ancestor.nodeType === 3) return [range];
  const walker = doc.createTreeWalker(ancestor, 4 /* SHOW_TEXT */);
  const ranges: Range[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest('[data-block-target]')) continue;
    if (range.comparePoint(node, 0) === 1) break;
    if (!node.length || range.comparePoint(node, node.length) === -1 || !range.intersectsNode(node)) continue;
    const part = doc.createRange();
    part.setStart(node, node === range.startContainer ? range.startOffset : 0);
    part.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
    if (!part.collapsed) ranges.push(part);
  }
  return ranges;
}

/** A block annotation targets the control's whole box, including padding around its glyph. */
export function fragmentRects(range: Range): DOMRect[] {
  const ancestor = range.commonAncestorContainer;
  if (ancestor.nodeType === 1 && (ancestor as Element).matches('[data-block-target]')) return [(ancestor as Element).getBoundingClientRect()];
  return Array.from(range.getClientRects());
}

/** Text fragments avoid paragraph whitespace; block annotations use their complete control box. */
export function textRects(range: Range, doc: Document): DOMRect[] {
  return textRanges(range, doc).flatMap(fragmentRects).filter(rect => rect.width > 0 && rect.height > 0);
}
