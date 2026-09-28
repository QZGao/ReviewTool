import { createAnnotationView } from './render';
import { bindHeadingAnchors } from './heading-anchors';
import type { Projection, WikipediaViewOptions } from './types';

const mounted = new WeakSet<HTMLElement>();

/** Reuse the left sticky container and move the original widgets, retaining restoration points. */
function relocatePinnedControls(doc: Document, right: HTMLElement | null): () => void {
  const left = doc.querySelector<HTMLElement>('.vector-column-start');
  const controls = right ? [...right.querySelectorAll<HTMLElement>(':scope > .vector-sticky-pinned-container')] : [];
  if (!left || !controls.length) return () => {};
  const existing = left.querySelector<HTMLElement>(':scope > .vector-sticky-pinned-container');
  const stack = existing ?? doc.createElement('div');
  if (!existing) { stack.className = 'vector-sticky-pinned-container'; left.append(stack); }
  const hadClass = stack.classList.contains('annotation-left-pinned');
  stack.classList.add('annotation-left-pinned');
  const positions = controls.map(element => {
    const placeholder = doc.createComment('ReviewTool pinned panel');
    const parent = element.parentNode;
    const children = [...element.childNodes];
    element.before(placeholder);
    stack.append(...children);
    element.remove();
    return { element, placeholder, parent, children };
  });
  return () => {
    for (const { element, placeholder, parent, children } of positions) {
      element.append(...children);
      if (placeholder.parentNode) placeholder.replaceWith(element); else parent?.appendChild(element);
    }
    if (!hadClass) stack.classList.remove('annotation-left-pinned');
    if (!existing) stack.remove();
  };
}

/** Preserve the Wikipedia article DOM while presenting the source projection as its sibling. */
export function mountWikipediaAnnotation(doc: Document, projection: Projection, options: WikipediaViewOptions = {}) {
  const matches = doc.querySelectorAll<HTMLElement>('#mw-content-text > .mw-parser-output');
  if (matches.length !== 1) throw new Error('Expected one article parser-output element under #mw-content-text.');
  const original = matches[0];
  if (mounted.has(original)) throw new Error('Annotation View is already mounted on this article.');
  const display = original.style.getPropertyValue('display');
  const priority = original.style.getPropertyPriority('display');
  const hadStyle = original.hasAttribute('style');
  const mobileColumn = options.comments && doc.querySelector('.skin-minerva') ? doc.createElement('div') : null;
  if (mobileColumn) { mobileColumn.className = 'annotation-mobile-comments-host'; doc.body.append(mobileColumn); }
  const column = options.comments ? mobileColumn ?? doc.querySelector<HTMLElement>('div.vector-column-end.no-font-mode-scale') : null;
  if (options.comments && !column) throw new Error('Expected the Vector right column for annotation comments.');
  let view: ReturnType<typeof createAnnotationView>;
  try { view = createAnnotationView(doc, projection, { referenceHtml: original.outerHTML, referenceBaseUrl: 'https://zh.wikipedia.org/wiki/', ...options, ...(column ? { commentContainer: column } : {}) }); }
  catch (error) { mobileColumn?.remove(); throw error; }
  let headings: ReturnType<typeof bindHeadingAnchors>;
  try { headings = bindHeadingAnchors(original, view.element, options.headingAnchors ?? []); }
  catch (error) { view.destroy(); mobileColumn?.remove(); throw error; }
  const restorePinnedControls = relocatePinnedControls(doc, column);
  original.after(view.element);
  original.style.setProperty('display', 'none', 'important');
  mounted.add(original);
  headings.mounted();
  let closed = false;
  return {
    original,
    view,
    destroy() {
      if (closed) return;
      closed = true;
      view.destroy(); view.element.remove();
      mobileColumn?.remove();
      restorePinnedControls();
      if (display) original.style.setProperty('display', display, priority);
      else original.style.removeProperty('display');
      if (!hadStyle && !original.style.length) original.removeAttribute('style');
      headings.restore();
      mounted.delete(original);
    },
  };
}
