import { createProjection } from './projection';
import type { ViewNode } from './types';
import { samePageCommentId } from './view-url';

/** Reuse the bounded wikitext parser; comments do not participate in article-source mapping. */
export function renderCommentMarkup(doc: Document, source: string, commentPageUrl = doc.location.href): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const emit = (node: ViewNode): Node | null => {
    if (node.kind === 'hidden') return null;
    if (node.kind === 'text') return doc.createTextNode(node.text);
    const element = doc.createElement(node.tag);
    if (node.flowBreak) element.dataset.breakBefore = node.flowBreak;
    if (node.href) {
      const commentId = samePageCommentId(node.href, commentPageUrl);
      element.setAttribute('href', node.href); element.setAttribute('target', commentId ? '_self' : '_blank'); element.setAttribute('rel', 'noopener noreferrer');
      if (commentId) element.dataset.commentLink = commentId;
    }
    for (const [name, value] of Object.entries(node.attributes ?? {})) element.setAttribute(name, value);
    for (const child of node.children) { const rendered = emit(child); if (rendered) element.append(rendered); }
    return element;
  };
  for (const node of createProjection(source, { mode: 'comment' }).blocks) { const rendered = emit(node); if (rendered) fragment.append(rendered); }
  return fragment;
}
