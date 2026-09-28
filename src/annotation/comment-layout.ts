import { textRects } from './range-rects';
import type { RenderedView, SourceAnchor } from './types';
import type { PopupLayout } from './popup-layout';

export interface CommentCard { element: HTMLElement; anchor: SourceAnchor; revision: number }

/** Join adjacent fragments on a line without outlining whitespace between lines or blocks. */
function outlineRects(rects: readonly DOMRect[]): DOMRect[] {
  const merged: DOMRect[] = [];
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    let next = new DOMRect(rect.x, rect.y, rect.width, rect.height);
    for (let i = 0; i < merged.length; i++) {
      const other = merged[i];
      const overlap = Math.min(next.bottom, other.bottom) - Math.max(next.top, other.top);
      if (overlap < Math.min(next.height, other.height) / 2 || next.left > other.right + 1 || other.left > next.right + 1) continue;
      const left = Math.min(next.left, other.left), top = Math.min(next.top, other.top);
      next = new DOMRect(left, top, Math.max(next.right, other.right) - left, Math.max(next.bottom, other.bottom) - top);
      merged.splice(i, 1); i = -1;
    }
    merged.push(next);
  }
  return merged;
}

/** Align cards to source lines, pushing later cards down only when they would overlap. */
export function commentLayout(doc: Document, view: RenderedView, column: HTMLElement, container: HTMLElement, cards: () => readonly CommentCard[], popups: PopupLayout) {
  const win = doc.defaultView;
  if (!win) throw new Error('Comment layout requires a browser window.');
  const controller = new AbortController();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('annotation-comment-connectors'); svg.setAttribute('aria-hidden', 'true');
  const outline = doc.createElementNS(svg.namespaceURI, 'g') as SVGGElement;
  outline.classList.add('annotation-comment-highlight-outline'); svg.append(outline);
  doc.body.append(svg);
  let frame = 0;
  let active: string | null = null, floatingAnchor: DOMRect | null = null;
  let compact = false;
  let engaged: HTMLElement | null = null, outlineKey = '', sourceBoxKey = '', sourceVersion = 0;
  const paths = new Map<HTMLElement, SVGPathElement>();
  const ranges = new Map<HTMLElement, { key: string; range: Range | null; version: number; rects: DOMRect[]; blockTop: number | null }>();
  const naturalSizes = new Map<HTMLElement, { width: number; revision: number; height: number }>();
  const attribute = (element: Element, name: string, value: string) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  const appearance = (target: Element, card: HTMLElement) => {
    attribute(target, 'data-color', card.dataset.color ?? '');
    target.toggleAttribute('data-all-resolved', card.hasAttribute('data-all-resolved'));
  };
  const updateOutline = () => {
    if (!engaged || engaged.hidden || container.hidden) {
      if (outlineKey) { outline.replaceChildren(); delete outline.dataset.annotationId; outlineKey = ''; }
      return;
    }
    const geometry = ranges.get(engaged);
    if (!geometry || geometry.version !== sourceVersion) { schedule(); return; }
    appearance(outline, engaged);
    attribute(outline, 'transform', `translate(${-win.scrollX} ${-win.scrollY})`);
    const key = `${engaged.dataset.annotationId}:${geometry.key}:${sourceVersion}`;
    if (key === outlineKey) return;
    outlineKey = key;
    const rects = outlineRects(geometry.rects).map(box => {
      const rect = doc.createElementNS(svg.namespaceURI, 'rect');
      rect.setAttribute('x', String(box.left - .5)); rect.setAttribute('y', String(box.top - .5));
      rect.setAttribute('width', String(box.width + 1)); rect.setAttribute('height', String(box.height + 1));
      if (geometry.range?.commonAncestorContainer.nodeType === 1 && (geometry.range.commonAncestorContainer as Element).matches('[data-block-target]')) rect.setAttribute('rx', '4');
      return rect;
    });
    attribute(outline, 'data-annotation-id', engaged.dataset.annotationId ?? ''); outline.replaceChildren(...rects);
  };
  const engage = (next: HTMLElement | null) => {
    if (next === engaged) return;
    if (engaged) { engaged.removeAttribute('data-engaged'); paths.get(engaged)?.removeAttribute('data-engaged'); }
    engaged = next;
    if (engaged) { engaged.setAttribute('data-engaged', ''); paths.get(engaged)?.setAttribute('data-engaged', ''); }
    container.toggleAttribute('data-engaged', Boolean(engaged)); svg.toggleAttribute('data-engaged', Boolean(engaged));
    view.highlighting?.emphasize(engaged?.dataset.annotationId ?? null);
    updateOutline();
  };
  const measurement = doc.createElement('div');
  measurement.className = 'annotation-comment-measure'; measurement.inert = true; measurement.setAttribute('aria-hidden', 'true'); container.append(measurement);
  const naturalHeight = (card: CommentCard) => {
    const width = card.element.getBoundingClientRect().width, previous = naturalSizes.get(card.element);
    if (previous?.width === width && previous.revision === card.revision) return previous.height;
    // Measure an inert copy so neither hover nor the live text selection is disturbed.
    const copy = card.element.cloneNode(true) as HTMLElement;
    copy.classList.add('annotation-comment-measuring'); copy.style.position = 'static'; copy.style.width = `${width}px`;
    measurement.replaceChildren(copy);
    const height = copy.getBoundingClientRect().height;
    measurement.replaceChildren(); naturalSizes.set(card.element, { width, revision: card.revision, height });
    return height;
  };
  const layout = () => {
    frame = 0;
    if (controller.signal.aborted || !container.isConnected) return;
    const article = view.element.getBoundingClientRect(), host = column.getBoundingClientRect();
    const boxKey = `${article.left + win.scrollX}:${article.top + win.scrollY}:${article.width}:${article.height}`;
    if (boxKey !== sourceBoxKey) { sourceBoxKey = boxKey; sourceVersion++; }
    const all = cards();
    const nextCompact = host.left < article.right - 1 || host.width < 140;
    if (nextCompact !== compact) { active = null; floatingAnchor = null; }
    compact = nextCompact;
    attribute(container, 'data-layout', compact ? 'floating' : 'margin');
    if (!compact) { container.style.maxHeight = ''; container.style.maxWidth = ''; container.style.left = ''; container.style.top = ''; }
    for (const card of all) {
      const hidden = compact && card.element.dataset.annotationId !== active;
      if (card.element.hidden !== hidden) card.element.hidden = hidden;
    }
    const current = all.find(card => card.element.dataset.annotationId === active);
    const hidden = all.length === 0 || (compact && !current);
    if (container.hidden !== hidden) container.hidden = hidden;
    const origin = container.getBoundingClientRect();
    const entries = all.map(card => {
      const key = `${card.anchor.start}:${card.anchor.end}:${card.anchor.target ?? 'text'}`;
      let geometry = ranges.get(card.element);
      if (!geometry || geometry.key !== key) {
        geometry = { key, range: view.restoreRange(card.anchor), version: -1, rects: [], blockTop: null };
        ranges.set(card.element, geometry);
      }
      if (geometry.version !== sourceVersion) {
        const range = geometry.range;
        geometry.rects = range ? textRects(range, doc).map(rect => new DOMRect(rect.x + win.scrollX, rect.y + win.scrollY, rect.width, rect.height)) : [];
        const block = card.anchor.target === 'block' ? range?.startContainer.parentElement : null;
        geometry.blockTop = block ? block.getBoundingClientRect().top + win.scrollY : null;
        geometry.version = sourceVersion;
      }
      const rects = geometry.rects;
      const first = rects.find(rect => rect.width > 0 && rect.height > 0);
      const line = first && { top: first.top - win.scrollY, bottom: first.bottom - win.scrollY, right: Math.max(...rects.filter(rect => Math.abs(rect.top - first.top) < 2).map(rect => rect.right)) - win.scrollX };
      return { ...card, line, blockTop: geometry.blockTop, idealTop: Math.max(0, (line?.top ?? article.top) - origin.top), naturalHeight: compact ? 0 : naturalHeight(card) };
    }).sort((a, b) => (a.line?.top ?? 0) - (b.line?.top ?? 0) || a.anchor.start - b.anchor.start);
    const crowded = new Set<HTMLElement>();
    if (!compact) {
      let group: typeof entries = [], end = -Infinity;
      const finish = () => { if (group.length > 1) for (const entry of group) crowded.add(entry.element); };
      // Use full text without hover controls to keep crowding stable during expansion.
      for (const entry of entries) {
        if (entry.idealTop >= end + 12) { finish(); group = []; end = -Infinity; }
        group.push(entry); end = Math.max(end, entry.idealTop + entry.naturalHeight);
      }
      finish();
    }
    for (const entry of entries) entry.element.toggleAttribute('data-crowded', crowded.has(entry.element));
    engage(!container.hidden ? entries.find(entry => !entry.element.hidden && entry.element.matches(':hover'))?.element ?? null : null);
    // Read all card sizes before writing positions so each card does not force another layout.
    const measured = entries.map(entry => ({ ...entry, box: entry.element.getBoundingClientRect() }));
    let bottom = 0;
    const routes: { y: number; start: number; middle: number; low: number; high: number; lane: number }[] = [];
    for (const [order, entry] of measured.entries()) {
      const { element, line, box } = entry;
      const top = Math.max(bottom, entry.idealTop);
      if (compact) {
        if (element.style.top) element.style.top = '';
        if (element.style.order !== String(order)) element.style.order = String(order);
      } else {
        const value = `${top}px`; if (element.style.top !== value) element.style.top = value;
        bottom = top + box.height + 12;
      }
      let path = paths.get(element);
      if (!path) { path = doc.createElementNS(svg.namespaceURI, 'path') as SVGPathElement; path.dataset.annotationId = element.dataset.annotationId; paths.set(element, path); svg.append(path); }
      path.toggleAttribute('data-engaged', element === engaged); appearance(path, element);
      if (compact || !line) { attribute(path, 'd', ''); continue; }
      const block = entry.blockTop !== null;
      const baseY = entry.blockTop !== null ? entry.blockTop - win.scrollY - 3 : line.bottom + 2, y2 = origin.top + top + Math.min(20, box.height / 2);
      const route = { y: baseY, start: line.right + 2, middle: (article.right + box.left) / 2, low: Math.min(baseY, y2), high: Math.max(baseY, y2), lane: 0 };
      const used = new Set(routes.filter(other =>
        (Math.abs(other.y - route.y) < 3 && Math.max(other.start, route.start) < Math.min(other.middle, route.middle))
        || (Math.abs(other.middle - route.middle) < 3 && Math.min(other.high, route.high) > Math.max(other.low, route.low) + 1)
      ).map(other => other.lane));
      route.lane = [0, 1, 2].find(lane => !used.has(lane)) ?? 0;
      routes.push(route);
      const y1 = baseY + route.lane * 3, middle = Math.max(line.right + 4, route.middle - route.lane * 3);
      const startY = block ? (line.top + line.bottom) / 2 : line.bottom;
      const lead = block ? `M ${line.right} ${startY} H ${line.right + 2} V ${y1}` : `M ${line.right} ${startY} L ${line.right + 2} ${y1}`;
      attribute(path, 'd', `${lead} H ${middle} C ${middle + 8} ${y1}, ${middle - 8} ${y2}, ${box.left - 1} ${y2}`);
    }
    const minHeight = compact ? '' : `${bottom}px`;
    if (container.style.minHeight !== minHeight) container.style.minHeight = minHeight;
    const anchor = floatingAnchor;
    if (compact && current && anchor) popups.show('comment', container, () => anchor);
    else { popups.hide('comment'); container.style.maxHeight = ''; container.style.maxWidth = ''; container.style.left = ''; container.style.top = ''; }
    for (const [element, path] of paths) if (!container.contains(element)) { path.remove(); paths.delete(element); }
    updateOutline();
  };
  const schedule = () => { if (!frame && !controller.signal.aborted) frame = win.requestAnimationFrame(layout); };
  const invalidateSource = () => { sourceVersion++; schedule(); };
  const observer = new win.ResizeObserver(entries => { if (entries.some(entry => entry.target === view.element)) sourceVersion++; schedule(); });
  observer.observe(view.element); observer.observe(column); observer.observe(container);
  const hoveredCard = (target: EventTarget | null) => {
    const element = (target as Element | null)?.closest?.<HTMLElement>('.annotation-comment-thread');
    return element && container.contains(element) ? element : null;
  };
  container.addEventListener('pointerover', event => engage(hoveredCard(event.target)), { signal: controller.signal });
  container.addEventListener('pointerout', event => engage(hoveredCard(event.relatedTarget)), { signal: controller.signal });
  doc.addEventListener('scroll', event => {
    if (event.target instanceof win.Node && view.element.contains(event.target)) invalidateSource(); else schedule();
  }, { capture: true, passive: true, signal: controller.signal });
  win.addEventListener('resize', invalidateSource, { signal: controller.signal });
  const fontsChanged = () => { naturalSizes.clear(); invalidateSource(); };
  void doc.fonts.ready.then(fontsChanged);
  doc.fonts.addEventListener('loadingdone', fontsChanged, { signal: controller.signal });
  return {
    get compact() { return compact; },
    get active() { return active; },
    activate(id: string, anchor: DOMRect) { const changed = id !== active || anchor !== floatingAnchor; active = id; floatingAnchor = anchor; if (compact && changed) schedule(); },
    close() { active = null; schedule(); },
    schedule,
    observe(element: HTMLElement) { observer.observe(element); schedule(); },
    unobserve(element: HTMLElement) { if (engaged === element) engage(null); observer.unobserve(element); paths.get(element)?.remove(); paths.delete(element); ranges.delete(element); naturalSizes.delete(element); schedule(); },
    destroy() { controller.abort(); observer.disconnect(); win.cancelAnimationFrame(frame); engage(null); popups.hide('comment'); svg.remove(); measurement.remove(); paths.clear(); ranges.clear(); naturalSizes.clear(); },
  };
}
