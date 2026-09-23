import type { AnnotationComment, HighlightAction, HighlightAnnotation, HighlightOptions, SourceAnchor } from './types';

function utcTimestamp(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error('Comment posting time must be a UTC ISO timestamp.');
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  const date = new Date(canonical);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) throw new Error('Invalid comment posting time.');
  return canonical;
}

function freezeComment(comment: AnnotationComment, ids: Set<string>): AnnotationComment {
  if (!comment || typeof comment.id !== 'string' || !comment.id.trim() || ids.has(comment.id)
    || typeof comment.author !== 'string' || !comment.author.trim()
    || typeof comment.text !== 'string' || !comment.text.trim() || !Array.isArray(comment.replies)) throw new Error('Invalid or duplicate comment.');
  ids.add(comment.id);
  return Object.freeze({ id: comment.id, text: comment.text, author: comment.author, createdAt: utcTimestamp(comment.createdAt), replies: Object.freeze(comment.replies.map((reply: AnnotationComment) => freezeComment(reply, ids))) });
}

/** Immutable local snapshots and explicit actions shared by markers and their comment threads. */
export function annotationState(config: HighlightOptions, validate: (anchor: SourceAnchor) => boolean) {
  let snapshot: readonly HighlightAnnotation[] = Object.freeze<HighlightAnnotation[]>([]);
  let closed = false;
  const listeners = new Set<(annotations: readonly HighlightAnnotation[], action?: HighlightAction) => void>();
  const replace = (annotations: readonly HighlightAnnotation[], action?: HighlightAction) => {
    if (closed) return;
    const ids = new Set<string>(), commentIds = new Set<string>();
    const next = annotations.map(annotation => {
      if (typeof annotation.id !== 'string' || !annotation.id.trim() || ids.has(annotation.id)
        || !['red', 'yellow', 'green', 'blue'].includes(annotation.color)) throw new Error('Invalid or duplicate highlight ID/color.');
      if (!validate(annotation.anchor)) throw new Error('Highlight anchor cannot be restored in this source revision.');
      ids.add(annotation.id);
      const comment = annotation.comment ? freezeComment(annotation.comment, commentIds) : undefined;
      return Object.freeze({ id: annotation.id, anchor: Object.freeze({ ...annotation.anchor }), color: annotation.color, ...(comment ? { comment } : {}) });
    });
    const committed = Object.freeze(next);
    snapshot = committed;
    const publishedAction = action && Object.freeze(action.type === 'add-highlight'
      ? { ...action, highlight: committed.find(annotation => annotation.id === action.highlight.id) ?? action.highlight }
      : action.type === 'add-comment' ? { ...action, comment: freezeComment(action.comment, new Set<string>()) } : { ...action });
    for (const listener of listeners) listener(committed, publishedAction);
    if (publishedAction) config.onChange?.(committed, publishedAction);
  };
  replace(config.initial ?? []);
  return {
    get annotations() { return snapshot; },
    replace: (annotations: readonly HighlightAnnotation[]) => replace(annotations),
    subscribe(this: void, listener: (annotations: readonly HighlightAnnotation[], action?: HighlightAction) => void) {
      if (!closed) listeners.add(listener); return () => { listeners.delete(listener); };
    },
    destroy() { closed = true; listeners.clear(); snapshot = Object.freeze<HighlightAnnotation[]>([]); },
    dispatch(this: void, action: HighlightAction) {
      if (closed) return;
      if (action.type === 'add-highlight') { replace([...snapshot, action.highlight], action); return; }
      const annotation = snapshot.find(annotation => annotation.id === action.id);
      if (!annotation) throw new Error('Annotation no longer exists.');
      if (action.type === 'delete-highlight' || (action.type === 'resolve-comment' && annotation.comment?.id === action.commentId)) {
        replace(snapshot.filter(item => item !== annotation), action); return;
      }
      let updated: HighlightAnnotation = annotation;
      if (action.type === 'recolor-highlight') updated = { ...annotation, color: action.color };
      else if (action.type === 'add-comment' && !action.parentId) {
        if (annotation.comment) throw new Error('Annotation already has a comment.');
        updated = { ...annotation, comment: action.comment };
      } else {
        let found = false;
        const visit = (comment: AnnotationComment): AnnotationComment | null => {
          const id = action.type === 'add-comment' ? action.parentId : action.commentId;
          if (comment.id === id) {
            found = true;
            if (action.type === 'resolve-comment') return null;
            if (action.type === 'edit-comment') return { ...comment, text: action.text };
            if (action.type === 'add-comment') return { ...comment, replies: [...comment.replies, action.comment] };
          }
          return { ...comment, replies: comment.replies.map(visit).filter((reply): reply is AnnotationComment => reply !== null) };
        };
        const comment = annotation.comment && visit(annotation.comment);
        if (!found || !comment) throw new Error('Comment no longer exists.');
        updated = { ...annotation, comment };
      }
      replace(snapshot.map(item => item === annotation ? updated : item), action);
    },
  };
}
