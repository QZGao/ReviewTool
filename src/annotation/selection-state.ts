/// <reference lib="dom.iterable" />
import type { MappedSelection, SourceAnchor } from './types';

const highlightName = 'reviewtool-annotation-selection';

/** Retain this view's selection independently of the document's native selection. */
export function trackSelection(doc: Document, root: HTMLElement, readRange: (range: Range) => MappedSelection | null, restoreRange: (anchor: SourceAnchor) => Range | null, onChange?: (selection: MappedSelection | null) => void, onCapture?: (selection: MappedSelection) => void) {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const win = doc.defaultView;
  const registry = win?.CSS?.highlights;
  let selected: MappedSelection | null = null;
  let painted: Range | null = null;
  let gesture: 'content' | 'outside' | null = null;
  let canClear = true;

  const inContent = (node: Node | null): boolean => {
    if (!node || !root.contains(node)) return false;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    return element?.closest('.annotation-document') === root && !element.closest('[data-annotation-popup], [data-annotation-image], [data-annotation-ui]');
  };
  const targetInContent = (target: EventTarget | null): boolean => Boolean(target && 'nodeType' in target && inContent(target as Node));
  const paint = () => {
    if (!registry || !win?.Highlight) return;
    let highlight = registry.get(highlightName);
    if (painted) highlight?.delete(painted);
    painted = selected && gesture !== 'content' ? restoreRange(selected.anchor) : null;
    if (painted) {
      if (!highlight) highlight = new win.Highlight();
      highlight.priority = 2147483647;
      highlight.add(painted); registry.set(highlightName, highlight);
    } else if (highlight?.size === 0) registry.delete(highlightName);
  };
  const commit = (next: MappedSelection | null) => {
    if (selected?.anchor.start === next?.anchor.start && selected?.anchor.end === next?.anchor.end && selected?.adjusted === next?.adjusted) return;
    selected = next ? Object.freeze({ ...next, anchor: Object.freeze({ ...next.anchor }) }) : null;
    paint(); onChange?.(selected);
  };
  const capture = () => {
    if (controller.signal.aborted || !root.isConnected || gesture) return;
    const native = doc.getSelection();
    if (!native || native.rangeCount !== 1) return;
    const range = native.getRangeAt(0);
    const next = readRange(range);
    if (next) { commit(next); onCapture?.(next); }
    else if (range.collapsed && canClear && inContent(range.startContainer)) commit(null);
  };
  doc.addEventListener('selectionchange', capture, options);
  doc.addEventListener('pointerdown', event => {
    canClear = targetInContent(event.target);
    gesture = canClear ? 'content' : 'outside';
    // Start a fresh mouse range after programmatic restoration; retain native Shift-click extension.
    const native = doc.getSelection();
    if (canClear && event.pointerType === 'mouse' && event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey
      && native?.rangeCount === 1 && readRange(native.getRangeAt(0))) native.removeAllRanges();
    paint();
  }, options);
  doc.addEventListener('pointerup', () => {
    const contentGesture = gesture === 'content';
    gesture = null;
    if (contentGesture) capture();
    paint();
  }, options);
  doc.addEventListener('pointercancel', () => { gesture = null; paint(); }, options);
  doc.addEventListener('keydown', event => {
    // Native text selection can leave focus on body; editable controls have their own selection.
    canClear = targetInContent(event.target) || (event.target === doc.body && inContent(doc.getSelection()?.anchorNode ?? null));
  }, options);
  win?.addEventListener('blur', () => { gesture = null; paint(); }, options);

  return {
    get current() { return selected; },
    capture,
    clear() {
      if (controller.signal.aborted) return;
      commit(null);
      const native = doc.getSelection();
      if (native?.rangeCount === 1 && readRange(native.getRangeAt(0))) native.removeAllRanges();
    },
    destroy() {
      controller.abort(); selected = null; gesture = null; paint();
    },
  };
}
