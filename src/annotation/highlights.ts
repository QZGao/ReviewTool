import { annotationMessages, type AnnotationMessages } from './i18n';
import type { HighlightAnnotation, HighlightColor, HighlightOptions, MappedSelection, ModerationReasonPrompt, RenderedView } from './types';
import type { PopupLayout } from './popup-layout';
import { annotationState, annotationVisible } from './annotation-state';
import { canRemoveAnnotation, requestActionReason, type AnnotationActor } from './permissions';
import { textRects } from './range-rects';

const colors: readonly HighlightColor[] = ['red', 'yellow', 'green', 'blue'];
interface Marker { annotation: HighlightAnnotation; range: Range; name: string; rects?: DOMRect[] }
type Active = { kind: 'selection'; selection: MappedSelection } | { kind: 'marker'; id: string };

/** Owns only transient UI and CSS highlights; source DOM text nodes never change. */
export function createHighlighting(doc: Document, view: RenderedView, config: HighlightOptions, popupLayout: PopupLayout, actor: AnnotationActor = {}, promptReason?: ModerationReasonPrompt, messages: AnnotationMessages = annotationMessages()) {
  const win = doc.defaultView;
  if (!win?.Highlight || !win.CSS?.highlights) throw new Error('This browser does not support text highlights.');
  const registry = win.CSS.highlights;
  const root = view.element;
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const prefix = 'reviewtool-marker-' + win.crypto.randomUUID();
  const style = doc.createElement('style');
  const hoverListeners = new Set<(id: string, anchor: DOMRect) => void>();
  let serial = 0;
  let markers: Marker[] = [];
  let emphasized: string | null = null;
  const updateStyles = () => {
    style.textContent = markers.map(marker => {
      const color = `var(--annotation-marker-${marker.annotation.color})`;
      const fill = emphasized && marker.annotation.id !== emphasized ? `color-mix(in srgb, ${color} 35%, transparent)` : color;
      return `.annotation-document ::highlight(${marker.name}) { background-color: ${fill}; }\n.annotation-document .annotation-block-target::highlight(${marker.name}) { background-color: ${marker.annotation.anchor.target === 'block' ? fill : 'transparent'}; }`;
    }).join('\n');
  };
  const state = annotationState(config, anchor => { const range = view.restoreRange(anchor); return Boolean(range && !range.collapsed); }, actor);
  let active: Active | null = null;
  let reasonPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let down: { x: number; y: number } | null = null;
  let dragged = false;
  let frame = 0;
  let layout = '';
  const bar = doc.createElement('div');
  bar.className = 'annotation-highlight-bar';
  bar.dataset.annotationUi = '';
  bar.dataset.annotationToolbar = '';
  bar.setAttribute('role', 'toolbar');
  bar.hidden = true;

  const icon = (path: string) => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const line = doc.createElementNS(svg.namespaceURI, 'path'); line.setAttribute('d', path); svg.append(line);
    return svg;
  };
  const buttons = colors.map(color => {
    const button = doc.createElement('button'); button.type = 'button'; button.dataset.color = color;
    const label = messages[color];
    button.setAttribute('aria-label', label); button.title = label;
    button.append(icon('M5 12l4 4L19 6'));
    bar.append(button); return button;
  });
  const separator = doc.createElement('span'); separator.className = 'annotation-highlight-divider'; separator.setAttribute('aria-hidden', 'true');
  const remove = doc.createElement('button'); remove.type = 'button'; remove.dataset.deleteHighlight = '';
  remove.setAttribute('aria-label', messages.deleteHighlight); remove.title = messages.deleteHighlight;
  remove.append(icon('M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6'));
  bar.append(separator, remove);

  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const cancelFrame = () => { win.cancelAnimationFrame(frame); frame = 0; };
  const hide = () => { cancel(); cancelFrame(); active = null; bar.hidden = true; popupLayout.hide('highlight'); };
  const invalidate = () => { for (const marker of markers) delete marker.rects; };
  const insideBar = (target: EventTarget | null) => Boolean(target && 'nodeType' in target && bar.contains(target as Node));
  const contentTarget = (target: EventTarget | null) => {
    const element = (target as Element | null)?.closest?.('.annotation-document');
    return element === root && !(target as Element).closest('[data-annotation-ui]:not([data-block-target]), [data-annotation-popup]');
  };
  const hit = (x: number, y: number): { marker: Marker; rect: DOMRect } | null => {
    const box = root.getBoundingClientRect();
    const nextLayout = `${box.x}:${box.y}:${box.width}:${box.height}`;
    if (layout !== nextLayout) { layout = nextLayout; invalidate(); }
    for (let i = markers.length - 1; i >= 0; i--) {
      const marker = markers[i];
      if (!marker.rects) {
        const bounds = marker.range.getBoundingClientRect();
        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) continue;
      }
      marker.rects ??= textRects(marker.range, doc);
      const rect = marker.rects.find(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      if (rect) return { marker, rect };
    }
    return null;
  };
  const show = (next: Active, anchor: DOMRect) => {
    cancel(); cancelFrame(); active = next;
    if (!bar.isConnected) root.append(bar);
    bar.hidden = false;
    const editing = next.kind === 'marker';
    bar.setAttribute('aria-label', editing ? messages.editHighlight : messages.highlightSelection);
    const annotation = editing ? markers.find(marker => marker.annotation.id === next.id)?.annotation : undefined;
    const color = annotation?.color;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === color)));
    separator.hidden = remove.hidden = !annotation || !canRemoveAnnotation(annotation, actor);
    popupLayout.show('highlight', bar, () => anchor);
    if (next.kind === 'marker') for (const listener of hoverListeners) listener(next.id, anchor);
  };
  const later = () => {
    if (timer !== undefined || active?.kind !== 'marker') return;
    timer = setTimeout(() => { timer = undefined; if (!popupLayout.contains(doc.activeElement)) hide(); }, 180);
  };
  const paint = (annotations: readonly HighlightAnnotation[]) => {
    if (controller.signal.aborted) return;
    const visible = annotations.filter(annotationVisible);
    if (visible.length === markers.length && visible.every((annotation, index) => { const previous = markers[index].annotation; return annotation.id === previous.id && annotation.color === previous.color && annotation.anchor.start === previous.anchor.start && annotation.anchor.end === previous.anchor.end && annotation.anchor.target === previous.anchor.target; })) {
      markers.forEach((marker, index) => { marker.annotation = visible[index]; }); return;
    }
    const prepared = visible.map(annotation => {
      const range = view.restoreRange(annotation.anchor);
      if (!range) throw new Error('Highlight source is no longer available in the reading view.');
      return { annotation, range, name: `${prefix}-${++serial}` };
    });
    hide();
    for (const marker of markers) registry.delete(marker.name);
    markers = prepared;
    for (const symbol of root.querySelectorAll('[data-block-target]')) symbol.removeAttribute('data-highlighted');
    for (const marker of markers) if (marker.annotation.anchor.target === 'block') (marker.range.startContainer as HTMLElement).setAttribute('data-highlighted', '');
    updateStyles();
    if (!style.isConnected) doc.head.append(style);
    markers.forEach((marker, index) => {
      const highlight = new win.Highlight(marker.range); highlight.priority = index;
      registry.set(marker.name, highlight);
    });
  };
  const selectionChanged = (selection: MappedSelection | null) => {
    if (!selection) { if (active?.kind === 'selection') hide(); return; }
    const range = view.restoreRange(selection.anchor);
    if (!range) return;
    const rects = textRects(range, doc);
    const rect = rects.filter(rect => rect.bottom > 0 && rect.top < doc.documentElement.clientHeight).pop();
    if (!rect) return;
    const existing = [...markers].reverse().find(marker => marker.annotation.anchor.start === selection.anchor.start && marker.annotation.anchor.end === selection.anchor.end && marker.annotation.anchor.target === selection.anchor.target);
    show(existing ? { kind: 'marker', id: existing.annotation.id } : { kind: 'selection', selection }, rect);
  };
  const returnFocus = () => {
    if (!insideBar(doc.activeElement)) return;
    // A dismissed toolbar must not strand keyboard focus in a hidden button.
    root.tabIndex = -1; root.focus({ preventScroll: true });
  };
  paint(state.annotations);
  const stopState = state.subscribe(paint);
  const activateButton = async (event: MouseEvent) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || !active || reasonPending) return;
    const color = button.dataset.color as HighlightColor | undefined;
    const current = active;
    if (current.kind === 'marker' && button === remove) {
      const annotation = state.annotations.find(annotation => annotation.id === current.id);
      if (!annotation) return;
      reasonPending = true;
      try {
        const reason = await requestActionReason({ type: 'delete-highlight' }, actor, promptReason, controller.signal, annotation);
        if (reason === null || controller.signal.aborted || !state.annotations.some(annotation => annotation.id === current.id)) return;
        returnFocus();
        state.dispatch({ type: 'delete-highlight', id: current.id, ...(reason ? { reason } : {}) });
        view.clearSelection(); hide(); return;
      } finally { reasonPending = false; }
    }
    returnFocus();
    if (current.kind === 'selection' && color) {
      const author = actor.name?.trim();
      const highlight = Object.freeze({ id: win.crypto.randomUUID(), anchor: Object.freeze({ ...current.selection.anchor }), color, createdAt: new Date().toISOString(), ...(author ? { author } : {}) });
      state.dispatch({ type: 'add-highlight', highlight });
    } else if (current.kind === 'marker' && color) {
      state.dispatch({ type: 'recolor-highlight', id: current.id, color, editedAt: new Date().toISOString() });
    }
    view.clearSelection(); hide();
  };
  bar.addEventListener('click', event => { void activateButton(event); }, options);
  bar.addEventListener('keydown', event => {
    const controls = [...buttons, ...(!remove.hidden ? [remove] : [])];
    const index = controls.indexOf(doc.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowRight' ? (index + 1) % controls.length : event.key === 'ArrowLeft' ? (index + controls.length - 1) % controls.length : event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); controls[next].focus(); }
  }, options);
  doc.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (bar.hidden) return;
    if (event.key === 'Escape') { returnFocus(); hide(); }
    else if (event.key === 'Tab' && !event.shiftKey && !insideBar(doc.activeElement)
      && (doc.activeElement === root || doc.activeElement === doc.body || contentTarget(doc.activeElement))) {
      event.preventDefault(); buttons[0].focus();
    }
  }, options);
  doc.addEventListener('pointerdown', event => {
    down = { x: event.clientX, y: event.clientY }; dragged = false;
    if (!popupLayout.contains(event.target)) hide();
  }, options);
  doc.addEventListener('pointermove', event => {
    if (event.buttons) {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) dragged = true;
      return;
    }
    if (popupLayout.contains(event.target)) { cancel(); cancelFrame(); return; }
    if (active?.kind === 'selection' || popupLayout.contains(doc.activeElement)) return;
    if (frame) win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      const match = contentTarget(event.target) ? hit(event.clientX, event.clientY) : null;
      if (match) show({ kind: 'marker', id: match.marker.annotation.id }, match.rect);
      else later();
    });
  }, options);
  root.addEventListener('click', event => {
    if ((event.metaKey || event.ctrlKey) && (event.target as Element).closest('a[data-target-url]')) return;
    if (!event.detail || dragged || !contentTarget(event.target)) return;
    const match = hit(event.clientX, event.clientY);
    if (match) {
      event.preventDefault(); event.stopImmediatePropagation();
      show({ kind: 'marker', id: match.marker.annotation.id }, match.rect);
    }
  }, { ...options, capture: true });
  bar.addEventListener('focusout', event => { if (!popupLayout.contains(event.relatedTarget)) later(); }, options);
  const moved = () => { hide(); invalidate(); };
  doc.addEventListener('scroll', event => { if (!popupLayout.contains(event.target)) moved(); }, { ...options, capture: true });
  win.addEventListener('resize', moved, options);
  const observer = new win.ResizeObserver(invalidate);
  observer.observe(root);

  return {
    get annotations() { return state.annotations; },
    emphasize(id: string | null) { if (id !== emphasized) { emphasized = id; updateStyles(); } },
    replace: state.replace,
    dispatch: state.dispatch,
    subscribe: state.subscribe,
    onHover(listener: (id: string, anchor: DOMRect) => void) { hoverListeners.add(listener); return () => { hoverListeners.delete(listener); }; },
    selectionChanged,
    destroy() {
      hide(); stopState(); state.destroy(); controller.abort(); observer.disconnect(); win.cancelAnimationFrame(frame);
      for (const marker of markers) registry.delete(marker.name);
      markers = []; hoverListeners.clear(); style.remove(); bar.remove();
    },
  };
}
