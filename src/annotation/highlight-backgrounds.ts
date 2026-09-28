import { fragmentRects, textRanges } from './range-rects';
import type { HighlightAnnotation } from './types';

interface Marker { annotation: HighlightAnnotation; range: Range }
interface Bounds { left: number; right: number; top: number; bottom: number }

/** Cached backgrounds sit above element backgrounds and below the original source-text spans. */
export function highlightBackgrounds(doc: Document, root: HTMLElement) {
  const win = doc.defaultView;
  if (!win) throw new Error('Highlight backgrounds require a browser window.');
  const events = new AbortController(), options = { signal: events.signal };
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('annotation-highlight-backgrounds'); svg.dataset.annotationUi = '';
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('preserveAspectRatio', 'none'); root.append(svg);
  const groups = new Map<string, SVGGElement>();
  let markers: readonly Marker[] = [], emphasized: string | null = null, frame = 0;
  const redraw = () => {
    frame = 0;
    if (events.signal.aborted || !root.isConnected) return;
    const origin = root.getBoundingClientRect();
    if (!origin.width || !origin.height) return;
    const clips = new Map<Element, Bounds>();
    const clip = (element: Element | null): Bounds => {
      if (!element || element === root) return { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
      const cached = clips.get(element); if (cached) return cached;
      const bounds = { ...clip(element.parentElement) }, style = win.getComputedStyle(element);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const box = element.getBoundingClientRect();
        const scaleX = element instanceof win.HTMLElement && element.offsetWidth ? box.width / element.offsetWidth : 1;
        const scaleY = element instanceof win.HTMLElement && element.offsetHeight ? box.height / element.offsetHeight : 1;
        if (style.overflowX !== 'visible') {
          const left = box.left + element.clientLeft * scaleX;
          bounds.left = Math.max(bounds.left, left); bounds.right = Math.min(bounds.right, left + element.clientWidth * scaleX);
        }
        if (style.overflowY !== 'visible') {
          const top = box.top + element.clientTop * scaleY;
          bounds.top = Math.max(bounds.top, top); bounds.bottom = Math.min(bounds.bottom, top + element.clientHeight * scaleY);
        }
      }
      clips.set(element, bounds); return bounds;
    };
    // Read every rectangle before changing SVG nodes, avoiding interleaved reads and writes.
    const rectangles = markers.map(marker => ({ id: marker.annotation.id, boxes: textRanges(marker.range, doc).flatMap(range => {
      const parent = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
      const bounds = clip(parent);
      return fragmentRects(range).map(box => {
        const left = Math.max(box.left, bounds.left), right = Math.min(box.right, bounds.right);
        const top = Math.max(box.top, bounds.top), bottom = Math.min(box.bottom, bounds.bottom);
        return { x: left - origin.left, y: top - origin.top, width: right - left, height: bottom - top, rx: marker.annotation.anchor.target === 'block' ? 4 : 0 };
      }).filter(box => box.width > 0 && box.height > 0);
    }) }));
    svg.setAttribute('viewBox', `0 0 ${origin.width} ${origin.height}`);
    for (const { id, boxes } of rectangles) {
      const group = groups.get(id); if (!group) continue;
      group.replaceChildren(...boxes.map(box => {
        const rect = doc.createElementNS(svg.namespaceURI, 'rect');
        for (const [name, value] of Object.entries(box)) rect.setAttribute(name, String(value));
        return rect;
      }));
    }
  };
  const schedule = () => { if (!frame && !events.signal.aborted) frame = win.requestAnimationFrame(redraw); };
  const observer = new win.ResizeObserver(schedule); observer.observe(root);
  win.addEventListener('resize', schedule, options);
  doc.addEventListener('scroll', event => {
    if (event.target instanceof win.Element && root.contains(event.target) && !event.target.closest('[data-annotation-ui], [data-annotation-popup]')) schedule();
  }, { ...options, capture: true, passive: true });
  void doc.fonts.ready.then(schedule); doc.fonts.addEventListener('loadingdone', schedule, options);
  return {
    replace(next: readonly Marker[]) {
      markers = next;
      const ids = new Set(next.map(marker => marker.annotation.id));
      for (const [id, group] of groups) if (!ids.has(id)) { group.remove(); groups.delete(id); }
      for (const marker of next) {
        const { id, color } = marker.annotation;
        let group = groups.get(id);
        if (!group) { group = doc.createElementNS(svg.namespaceURI, 'g') as SVGGElement; group.dataset.annotationMarker = id; groups.set(id, group); }
        group.dataset.color = color; group.toggleAttribute('data-engaged', id === emphasized);
        svg.append(group); // DOM paint order preserves the existing highlight overlap order.
      }
      schedule();
    },
    emphasize(this: void, id: string | null) {
      if (id === emphasized) return;
      if (emphasized) groups.get(emphasized)?.removeAttribute('data-engaged');
      emphasized = id;
      if (id) groups.get(id)?.setAttribute('data-engaged', '');
      svg.toggleAttribute('data-engaged', id !== null);
    },
    destroy() { events.abort(); observer.disconnect(); win.cancelAnimationFrame(frame); svg.remove(); groups.clear(); },
  };
}
