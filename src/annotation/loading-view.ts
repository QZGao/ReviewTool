/** Replace the reading surface immediately, preserving its exact inline display state. */
export function showAnnotationLoading(doc: Document, label: string): () => void {
  const original = doc.querySelector<HTMLElement>('#mw-content-text > .mw-parser-output');
  if (!original) return () => {};
  const display = original.style.getPropertyValue('display'), priority = original.style.getPropertyPriority('display');
  const hadStyle = original.hasAttribute('style');
  const loading = doc.createElement('div'); loading.className = 'annotation-loading';
  const text = doc.createElement('p'); text.textContent = label;
  const track = doc.createElement('div'); track.className = 'annotation-loading-track';
  track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', label);
  loading.append(text, track); original.after(loading);
  original.style.setProperty('display', 'none', 'important');
  let restored = false;
  return () => {
    if (restored) return;
    restored = true; loading.remove();
    if (display) original.style.setProperty('display', display, priority);
    else original.style.removeProperty('display');
    if (!hadStyle && !original.style.length) original.removeAttribute('style');
  };
}
