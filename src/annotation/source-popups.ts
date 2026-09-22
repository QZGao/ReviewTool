import type { ElementNode } from './types';
import { imagePreviews } from './image-preview';

let nextPopup = 0;

/** One interactive source popup per mounted view; its contents are excluded from annotation mapping. */
export function sourcePopups(doc: Document, root: HTMLElement, source: string, entries: WeakMap<HTMLElement, ElementNode>, images: WeakMap<HTMLElement, HTMLImageElement>, selectTrigger: (element: HTMLElement) => void): () => void {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const thumbnail = imagePreviews(controller.signal);
  const popup = doc.createElement('div');
  popup.className = 'annotation-source-popup';
  popup.dataset.annotationPopup = '';
  popup.id = `annotation-source-popup-${++nextPopup}`;
  popup.setAttribute('role', 'dialog');
  popup.tabIndex = -1;
  popup.hidden = true;
  const heading = doc.createElement('div'); heading.className = 'annotation-popup-heading';
  heading.id = popup.id + '-heading';
  popup.setAttribute('aria-labelledby', heading.id);
  const code = doc.createElement('pre');
  const preview = doc.createElement('div'); preview.className = 'annotation-popup-image';
  preview.dataset.annotationImage = ''; preview.hidden = true;
  popup.append(heading, code, preview);
  let active: HTMLElement | null = null;
  let down: { x: number; y: number } | null = null;
  let dragged = false;
  let restoringFocus = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const hide = (restoreFocus = false) => {
    const previous = active;
    const popupFocused = popup.contains(doc.activeElement);
    cancel(); popup.hidden = true;
    active?.setAttribute('aria-expanded', 'false');
    active?.removeAttribute('aria-describedby');
    active = null;
    if (restoreFocus && popupFocused && previous) {
      restoringFocus = true; previous.focus({ preventScroll: true }); restoringFocus = false;
    }
  };
  const trigger = (target: EventTarget | null): HTMLElement | null => {
    const element = (target as Element | null)?.closest?.<HTMLElement>('[data-inspect]') ?? null;
    return element && root.contains(element) && entries.has(element) ? element : null;
  };
  const inside = (target: EventTarget | null, element: HTMLElement | null): boolean => Boolean(target && 'nodeType' in target && element?.contains(target as Node));
  const position = () => {
    if (!active || popup.hidden) return;
    const viewport = doc.documentElement;
    popup.style.maxWidth = `${Math.max(0, viewport.clientWidth - 24)}px`;
    popup.style.maxHeight = `${Math.max(0, Math.min(360, viewport.clientHeight - 24))}px`;
    const anchor = active.getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.left, viewport.clientWidth - box.width - 12));
    const below = anchor.bottom + 8;
    const above = anchor.top - box.height - 8;
    const top = above >= 12 ? above : Math.min(below, Math.max(12, viewport.clientHeight - box.height - 12));
    popup.style.left = `${left}px`; popup.style.top = `${top}px`;
  };
  const displayImage = (image: HTMLImageElement) => {
    preview.replaceChildren(image);
    if (image.complete && image.naturalWidth === 0) preview.textContent = 'Image preview unavailable.';
    position();
  };
  const show = (element: HTMLElement) => {
    const model = entries.get(element);
    if (!model?.inspection) return;
    hide(); active = element;
    const image = images.get(element);
    const isImage = model.inspection.kind === 'image';
    heading.textContent = isImage ? 'Image preview' : model.inspection.kind === 'link' ? 'Link source' : 'Reference source';
    code.hidden = isImage;
    code.textContent = isImage ? '' : source.slice(model.inspection.from, model.inspection.to);
    preview.hidden = !isImage;
    preview.textContent = isImage ? 'Loading image…' : '';
    if (!popup.isConnected) root.append(popup);
    popup.hidden = false;
    element.setAttribute('aria-expanded', 'true');
    element.setAttribute('aria-describedby', popup.id);
    position();
    if (image) displayImage(image);
    else if (isImage) {
      void thumbnail(model.fileName ?? '').then(result => {
        if (controller.signal.aborted || active !== element || popup.hidden) return;
        let loaded: HTMLImageElement | null = null;
        if (result) {
          loaded = doc.createElement('img');
          loaded.src = result.url; loaded.width = result.width; loaded.height = result.height;
          loaded.alt = model.fileName ?? '';
          images.set(element, loaded);
        }
        if (loaded) displayImage(loaded);
        else { preview.textContent = 'Image preview unavailable.'; position(); }
      });
    }
  };
  const later = () => {
    cancel();
    timer = setTimeout(() => {
      if (doc.activeElement !== active && !inside(doc.activeElement, popup)) hide();
    }, 140);
  };
  root.addEventListener('pointerover', event => {
    if (event.buttons) return;
    if (inside(doc.activeElement, popup)) { cancel(); return; }
    const element = trigger(event.target);
    if (element && element !== active) show(element);
    else if (element || inside(event.target, popup)) cancel();
  }, options);
  root.addEventListener('pointerout', event => {
    if (inside(event.relatedTarget, active) || inside(event.relatedTarget, popup)) return;
    if (trigger(event.target) || inside(event.target, popup)) later();
  }, options);
  root.addEventListener('focusin', event => { const element = trigger(event.target); if (element && !restoringFocus) show(element); }, options);
  root.addEventListener('focusout', event => {
    if (inside(event.relatedTarget, popup)) return;
    if (trigger(event.target) || (inside(event.target, popup) && event.relatedTarget && event.relatedTarget !== active)) hide();
  }, options);
  root.addEventListener('click', event => {
    const element = trigger(event.target);
    if (element) {
      event.preventDefault();
      if (event.detail > 0 && dragged) return;
      show(element);
      selectTrigger(element);
    }
  }, options);
  root.addEventListener('pointerdown', event => { down = { x: event.clientX, y: event.clientY }; dragged = false; }, options);
  root.addEventListener('pointermove', event => {
    if (down && event.buttons && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) dragged = true;
  }, options);
  root.addEventListener('keydown', event => {
    const element = trigger(event.target);
    if (element === active && !popup.hidden && event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault(); popup.focus({ preventScroll: true }); return;
    }
    if (element && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); show(element);
      selectTrigger(element);
    }
  }, options);
  popup.addEventListener('load', position, { ...options, capture: true });
  popup.addEventListener('error', event => {
    if (inside(event.target, preview)) { preview.textContent = 'Image preview unavailable.'; position(); }
  }, { ...options, capture: true });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') hide(true); }, options);
  doc.addEventListener('pointerdown', event => {
    if (!inside(event.target, active) && !inside(event.target, popup)) hide();
  }, options);
  doc.addEventListener('scroll', event => { if (!inside(event.target, popup)) hide(); }, { ...options, capture: true });
  doc.defaultView?.addEventListener('resize', () => hide(), options);
  return () => { hide(); controller.abort(); popup.remove(); };
}
