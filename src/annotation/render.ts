import { selectionFromSource, selectionFromView } from './mapping';
import { referenceImages } from './reference-html';
import { sourcePopups } from './source-popups';
import { trackSelection } from './selection-state';
import { createHighlighting } from './highlights';
import { popupLayout } from './popup-layout';
import { headingSourceStart } from './heading-anchors';
import { SourceIndex } from './source-index';
import type { ElementNode, Projection, RenderedView, RenderOptions, TextRun, ViewNode } from './types';

export function createAnnotationView(doc: Document, projection: Projection, options: RenderOptions = {}): RenderedView {
  const root = doc.createElement('article');
  root.className = 'annotation-document';
  root.setAttribute('aria-label', 'Annotation reading view');
  const nodes = new Map<TextRun, Text>();
  const records = new WeakMap<Node, TextRun>();
  const images = referenceImages(doc, projection, options);
  const inspections = new WeakMap<HTMLElement, ElementNode>();
  const previews = new WeakMap<HTMLElement, HTMLImageElement>();
  const wholeLinks = new Map<string, HTMLElement>();
  const sourceIndex = new SourceIndex(projection.source);
  const emit = (model: ViewNode): Node | null => {
    if (model.kind === 'hidden') return null;
    if (model.kind === 'text') {
      const span = doc.createElement('span'); span.dataset.sourceRun = model.id;
      if (model.referenceGap) span.dataset.referenceGap = '';
      if (model.lineBreak) span.dataset.lineBreak = '';
      const text = doc.createTextNode(model.text); span.append(text);
      nodes.set(model, text); records.set(text, model);
      return span;
    }
    const element = doc.createElement(model.tag);
    const headingStart = headingSourceStart(model);
    if (headingStart !== undefined) element.dataset.headingStart = String(sourceIndex.toByte(headingStart));
    for (const [name, value] of Object.entries(model.attributes ?? {})) element.setAttribute(name, value);
    if (model.href) element.dataset.targetUrl = model.href;
    if (model.rawKind) { element.dataset.rawKind = model.rawKind; element.setAttribute('aria-label', `Raw wikitext: ${model.rawKind}`); }
    if (model.template) element.dataset.template = '';
    if (model.lineBreak) element.dataset.lineBreak = '';
    if (model.sourceKind) element.dataset.sourceKind = model.sourceKind;
    if (model.flowBreak) element.dataset.breakBefore = model.flowBreak;
    if (model.fileCaption) element.dataset.fileCaption = '';
    const image = images.get(model);
    if (image) previews.set(element, image);
    if (model.inspection) {
      element.dataset.inspect = model.inspection.kind;
      element.setAttribute('role', 'button'); element.tabIndex = 0;
      element.setAttribute('aria-expanded', 'false');
      inspections.set(element, model);
      if (model.inspection.kind === 'link') {
        wholeLinks.set(`${sourceIndex.toByte(model.inspection.from)}:${sourceIndex.toByte(model.inspection.to)}`, element);
      }
    }
    for (const child of model.children) { const rendered = emit(child); if (rendered) element.appendChild(rendered); }
    return element;
  };
  for (const block of projection.blocks) {
    const rendered = emit(block);
    if (rendered) root.appendChild(rendered);
  }
  const selectTrigger = (element: HTMLElement) => {
    const range = doc.createRange(); range.selectNode(element);
    const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    selectionState.capture();
  };
  let highlighting: ReturnType<typeof createHighlighting> | null = null;
  const layout = popupLayout(doc);
  const popups = sourcePopups(doc, root, projection.source, inspections, previews, selectTrigger, layout);

  function descendant(node: Node, side: 'first' | 'last'): TextRun | null {
    const own = records.get(node); if (own) return own;
    const children = Array.from(node.childNodes);
    if (side === 'last') children.reverse();
    for (const child of children) { const result = descendant(child, side); if (result) return result; }
    return null;
  }

  function point(node: Node, offset: number, side: 'start' | 'end'): number | null {
    if (!root.contains(node) && node !== root) return null;
    const el = node.nodeType === 1 ? node as Element : node.parentElement;
    if (el?.closest('[data-annotation-image], [data-annotation-popup], [data-annotation-ui]')) return null;
    const own = records.get(node);
    if (own) return offset >= 0 && offset <= own.text.length ? own.viewFrom + offset : null;
    if (offset < 0 || offset > node.childNodes.length) return null;
    const next = Array.from(node.childNodes).slice(offset).map(n => descendant(n, 'first')).find(Boolean);
    const previous = Array.from(node.childNodes).slice(0, offset).reverse().map(n => descendant(n, 'last')).find(Boolean);
    return side === 'start' ? next?.viewFrom ?? previous?.viewTo ?? null : previous?.viewTo ?? next?.viewFrom ?? null;
  }

  const view: RenderedView = {
    element: root,
    projection,
    get selection() { return selectionState.current; },
    get highlighting() { return highlighting; },
    clearSelection() { selectionState.clear(); },
    destroy() { highlighting?.destroy(); popups.destroy(); selectionState.destroy(); },
    readRange(range) {
      if (range.collapsed) return null;
      const from = point(range.startContainer, range.startOffset, 'start');
      const to = point(range.endContainer, range.endOffset, 'end');
      if (from === null || to === null || from >= to) return null;
      const selected = selectionFromView(projection, from, to);
      // An element selection (click/keyboard) includes hidden link syntax; text drags retain fine-grained mapping.
      if (selected && range.startContainer === range.endContainer && range.endOffset === range.startOffset + 1) {
        const target = range.startContainer.childNodes[range.startOffset];
        const inspection = target?.nodeType === 1 ? inspections.get(target as HTMLElement)?.inspection : undefined;
        if (inspection?.kind === 'link') {
          return { ...selected, anchor: { unit: 'utf8-byte', start: sourceIndex.toByte(inspection.from), end: sourceIndex.toByte(inspection.to) }, sourceText: projection.source.slice(inspection.from, inspection.to), adjusted: false };
        }
      }
      return selected;
    },
    restoreRange(anchor) {
      if (anchor.unit === 'utf8-byte') {
        const link = wholeLinks.get(`${anchor.start}:${anchor.end}`);
        if (link && root.contains(link)) { const range = doc.createRange(); range.selectNode(link); return range; }
      }
      const selected = selectionFromSource(projection, anchor);
      if (!selected) return null;
      // Restoration must not silently expand a source boundary inside an atomic entity.
      if (selected.anchor.start !== anchor.start || selected.anchor.end !== anchor.end) return null;
      const first = projection.runs.find(r => r.viewFrom <= selected.viewFrom && r.viewTo > selected.viewFrom);
      const last = [...projection.runs].reverse().find(r => r.viewFrom < selected.viewTo && r.viewTo >= selected.viewTo);
      if (!first || !last) return null;
      const startNode = nodes.get(first), endNode = nodes.get(last);
      if (!startNode || !endNode || !root.contains(startNode) || !root.contains(endNode)) return null;
      const range = doc.createRange();
      range.setStart(startNode, selected.viewFrom - first.viewFrom);
      range.setEnd(endNode, selected.viewTo - last.viewFrom);
      return range;
    },
  };
  const selectionState = trackSelection(doc, root, range => view.readRange(range), anchor => view.restoreRange(anchor), selection => {
    if (!selection) highlighting?.selectionChanged(null);
    options.onSelectionChange?.(selection);
  }, selection => highlighting?.selectionChanged(selection));
  if (options.highlighting) {
    try { highlighting = createHighlighting(doc, view, options.highlighting, layout); }
    catch (error) { popups.destroy(); selectionState.destroy(); throw error; }
  }
  return view;
}
