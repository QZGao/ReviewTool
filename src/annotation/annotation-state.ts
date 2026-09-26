import type { AnnotationComment, HighlightAction, HighlightAnnotation, HighlightOptions, SourceAnchor } from './types';
import { assertActionAllowed, type AnnotationActor } from './permissions';

function utcTimestamp(value: string, label = 'Comment posting time'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error(`${label} must be a UTC ISO timestamp.`);
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  const date = new Date(canonical);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) throw new Error(`Invalid ${label.toLowerCase()}.`);
  return canonical;
}

function freezeComment(comment: AnnotationComment, ids: Set<string>): AnnotationComment {
  if (!comment || typeof comment.id !== 'string' || !comment.id.trim() || ids.has(comment.id)
    || typeof comment.author !== 'string' || !comment.author.trim()
    || typeof comment.text !== 'string' || !comment.text.trim() || !Array.isArray(comment.replies)) throw new Error('Invalid or duplicate comment.');
  ids.add(comment.id);
  if (comment.editedBy !== undefined && (!comment.editedAt || typeof comment.editedBy !== 'string' || !comment.editedBy.trim())) throw new Error('Invalid comment editor.');
  return Object.freeze({ id: comment.id, text: comment.text, author: comment.author, createdAt: utcTimestamp(comment.createdAt),
    ...(comment.editedAt !== undefined ? { editedAt: utcTimestamp(comment.editedAt) } : {}),
    ...(comment.editedBy !== undefined ? { editedBy: comment.editedBy } : {}),
    replies: Object.freeze(comment.replies.map((reply: AnnotationComment) => freezeComment(reply, ids))) });
}

/** Immutable local snapshots and explicit actions shared by markers and their comment threads. */
export function annotationState(config: HighlightOptions, validate: (anchor: SourceAnchor) => boolean, actor: AnnotationActor = {}) {
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
      if (annotation.author !== undefined && (typeof annotation.author !== 'string' || !annotation.author.trim())) throw new Error('Invalid highlight author.');
      if ((annotation.editedAt === undefined) !== (annotation.editedBy === undefined)
        || (annotation.editedBy !== undefined && (typeof annotation.editedBy !== 'string' || !annotation.editedBy.trim()))) throw new Error('Highlight edit time and editor must be provided together.');
      ids.add(annotation.id);
      const comment = annotation.comment ? freezeComment(annotation.comment, commentIds) : undefined;
      return Object.freeze({ id: annotation.id, anchor: Object.freeze({ ...annotation.anchor }), color: annotation.color,
        ...(annotation.author !== undefined ? { author: annotation.author } : {}),
        ...(annotation.createdAt !== undefined ? { createdAt: utcTimestamp(annotation.createdAt, 'Highlight creation time') } : {}),
        ...(annotation.editedAt !== undefined && annotation.editedBy !== undefined ? { editedAt: utcTimestamp(annotation.editedAt, 'Highlight edit time'), editedBy: annotation.editedBy } : {}),
        ...(comment ? { comment } : {}) });
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
      if (action.type === 'add-highlight') {
        utcTimestamp(action.highlight.createdAt ?? '', 'Highlight creation time');
        replace([...snapshot, action.highlight], action); return;
      }
      const annotation = snapshot.find(annotation => annotation.id === action.id);
      if (!annotation) throw new Error('Annotation no longer exists.');
      assertActionAllowed(annotation, action, actor);
      if (action.type === 'delete-highlight' || action.type === 'resolve-comment') {
        replace(snapshot.filter(item => item !== annotation), action); return;
      }
      let updated: HighlightAnnotation = annotation;
      if (action.type === 'recolor-highlight') {
        if (annotation.color === action.color) return;
        const editedBy = actor.name?.trim();
        if (!editedBy) throw new Error('A current user is required to record the highlight edit.');
        updated = { ...annotation, color: action.color, editedAt: utcTimestamp(action.editedAt, 'Highlight edit time'), editedBy };
      } else if (action.type === 'add-comment' && !action.parentId) {
        if (annotation.comment) throw new Error('Annotation already has a comment.');
        updated = { ...annotation, comment: action.comment };
      } else {
        let found = false;
        const visit = (comment: AnnotationComment): AnnotationComment => {
          const id = action.type === 'add-comment' ? action.parentId : action.commentId;
          if (comment.id === id) {
            found = true;
            if (action.type === 'edit-comment') return { ...comment, text: action.text, editedAt: utcTimestamp(action.editedAt), editedBy: actor.name?.trim() ?? '' };
            if (action.type === 'add-comment') return { ...comment, replies: [...comment.replies, action.comment] };
          }
          return { ...comment, replies: comment.replies.map(visit) };
        };
        const comment = annotation.comment && visit(annotation.comment);
        if (!found || !comment) throw new Error('Comment no longer exists.');
        updated = { ...annotation, comment };
      }
      replace(snapshot.map(item => item === annotation ? updated : item), action);
    },
  };
}
