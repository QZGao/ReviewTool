import { createAnnotationView } from './render';
import { bindHeadingAnchors } from './heading-anchors';
import type { Projection, WikipediaViewOptions } from './types';

const mounted = new WeakSet<HTMLElement>();

/** Preserve the Wikipedia article DOM while presenting the source projection as its sibling. */
export function mountWikipediaAnnotation(doc: Document, projection: Projection, options: WikipediaViewOptions = {}) {
  const matches = doc.querySelectorAll<HTMLElement>('#mw-content-text > .mw-parser-output');
  if (matches.length !== 1) throw new Error('Expected one article parser-output element under #mw-content-text.');
  const original = matches[0];
  if (mounted.has(original)) throw new Error('Annotation View is already mounted on this article.');
  const display = original.style.getPropertyValue('display');
  const priority = original.style.getPropertyPriority('display');
  const hadStyle = original.hasAttribute('style');
  const column = options.comments ? doc.querySelector<HTMLElement>('div.vector-column-end.no-font-mode-scale') : null;
  if (options.comments && !column) throw new Error('Expected the Vector right column for annotation comments.');
  const view = createAnnotationView(doc, projection, { referenceHtml: original.outerHTML, referenceBaseUrl: 'https://zh.wikipedia.org/wiki/', ...options, ...(column ? { commentContainer: column } : {}) });
  let headings: ReturnType<typeof bindHeadingAnchors>;
  try { headings = bindHeadingAnchors(original, view.element, options.headingAnchors ?? []); }
  catch (error) { view.destroy(); throw error; }
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
      if (display) original.style.setProperty('display', display, priority);
      else original.style.removeProperty('display');
      if (!hadStyle && !original.style.length) original.removeAttribute('style');
      headings.restore();
      mounted.delete(original);
    },
  };
}
