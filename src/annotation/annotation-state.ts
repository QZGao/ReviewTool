import type { AnnotationComment, HighlightAction, HighlightAnnotation, HighlightOptions, SourceAnchor, AnnotationRemoval } from './types';
import { assertActionAllowed, type AnnotationActor } from './permissions';

export function utcTimestamp(value: string, label = 'Comment posting time'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error(`${label} must be a UTC ISO timestamp.`);
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  const date = new Date(canonical);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) throw new Error(`Invalid ${label.toLowerCase()}.`);
  return canonical;
}

export function threadRoots(annotation: HighlightAnnotation): readonly AnnotationComment[] {
  return annotation.comment ? [annotation.comment] : annotation.threads ?? [];
}

export function annotationVisible(annotation: HighlightAnnotation): boolean {
  const roots = threadRoots(annotation);
  return !annotation.deleted && (!roots.length || roots.some(root => !root.resolved));
}

function removal(value: AnnotationRemoval): AnnotationRemoval {
  if (!value || typeof value.by !== 'string' || !value.by.trim() || (value.reason !== undefined && typeof value.reason !== 'string')) throw new Error('Invalid removal record.');
  return Object.freeze({ by: value.by, at: utcTimestamp(value.at, 'Removal time'), ...(value.reason ? { reason: value.reason } : {}) });
}

function freezeComment(comment: AnnotationComment, ids: Set<string>, root = true): AnnotationComment {
  if (!comment || typeof comment.id !== 'string' || !comment.id.trim() || ids.has(comment.id)
    || typeof comment.author !== 'string' || !comment.author.trim()
    || typeof comment.text !== 'string' || !comment.text.trim() || !Array.isArray(comment.replies)) throw new Error('Invalid or duplicate comment.');
  ids.add(comment.id);
  if (!root && comment.resolved) throw new Error('Only root comments can be resolved.');
  if (comment.resolution && (!root || typeof comment.resolution.resolved !== 'boolean')) throw new Error('Invalid thread resolution.');
  if (comment.editedBy !== undefined && (!comment.editedAt || typeof comment.editedBy !== 'string' || !comment.editedBy.trim())) throw new Error('Invalid comment editor.');
  return Object.freeze({ id: comment.id, text: comment.text, author: comment.author, createdAt: utcTimestamp(comment.createdAt),
    ...(comment.editedAt !== undefined ? { editedAt: utcTimestamp(comment.editedAt) } : {}),
    ...(comment.editedBy !== undefined ? { editedBy: comment.editedBy } : {}),
    ...(comment.resolved ? { resolved: removal(comment.resolved) } : {}),
    ...(comment.resolution ? { resolution: { ...removal(comment.resolution), resolved: comment.resolution.resolved } } : {}),
    replies: Object.freeze(comment.replies.map((reply: AnnotationComment) => freezeComment(reply, ids, false))) });
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
      if (!validate(annotation.anchor)) throw new Error('Highlight anchor cannot be restored in this source revision. This may be caused by damaged annotation page data or by another gadget or user script modifying the page and disrupting text mapping.');
      if (annotation.anchor.target !== undefined && annotation.anchor.target !== 'block') throw new Error('Invalid highlight target kind.');
      if (annotation.author !== undefined && (typeof annotation.author !== 'string' || !annotation.author.trim())) throw new Error('Invalid highlight author.');
      if ((annotation.editedAt === undefined) !== (annotation.editedBy === undefined)
        || (annotation.editedBy !== undefined && (typeof annotation.editedBy !== 'string' || !annotation.editedBy.trim()))) throw new Error('Highlight edit time and editor must be provided together.');
      ids.add(annotation.id);
      if (annotation.threads !== undefined && !Array.isArray(annotation.threads)) throw new Error('Invalid threads.');
      const threads = threadRoots(annotation).map(root => freezeComment(root, commentIds));
      return Object.freeze({ id: annotation.id, anchor: Object.freeze({ ...annotation.anchor }), color: annotation.color,
        ...(annotation.author !== undefined ? { author: annotation.author } : {}),
        ...(annotation.createdAt !== undefined ? { createdAt: utcTimestamp(annotation.createdAt, 'Highlight creation time') } : {}),
        ...(annotation.editedAt !== undefined && annotation.editedBy !== undefined ? { editedAt: utcTimestamp(annotation.editedAt, 'Highlight edit time'), editedBy: annotation.editedBy } : {}),
        ...(threads.length ? { threads: Object.freeze(threads) } : {}),
        ...(annotation.deleted ? { deleted: removal(annotation.deleted) } : {}) });
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
      const id = action.id;
      const annotation = snapshot.find(annotation => annotation.id === id);
      if (!annotation) throw new Error('Annotation no longer exists.');
      assertActionAllowed(annotation, action, actor);
      if (annotation.deleted) throw new Error('Annotation has been deleted.');
      let updated: HighlightAnnotation = annotation;
      if (action.type === 'delete-highlight' || action.type === 'resolve-comment') {
        const record = removal({ by: actor.name?.trim() || 'Anonymous', at: action.at ?? new Date().toISOString(), ...(action.reason ? { reason: action.reason } : {}) });
        const commentId = action.type === 'resolve-comment' ? action.commentId : undefined;
        updated = action.type === 'delete-highlight' ? { ...annotation, deleted: record } : { ...annotation, threads: threadRoots(annotation).map(root => root.id === commentId ? { ...root, resolved: record } : root) };
        replace(snapshot.map(item => item === annotation ? updated : item), { ...action, at: record.at }); return;
      } else if (action.type === 'set-thread-resolution') {
        if (typeof action.resolved !== 'boolean') throw new Error('Invalid resolution state.');
        const resolution = { ...removal({ by: actor.name ?? '', at: action.at }), resolved: action.resolved };
        updated = { ...annotation, threads: threadRoots(annotation).map(root => root.id === action.commentId ? { ...root, resolution } : root) };
      } else if (action.type === 'recolor-highlight') {
        if (annotation.color === action.color) return;
        const editedBy = actor.name?.trim();
        if (!editedBy) throw new Error('A current user is required to record the highlight edit.');
        updated = { ...annotation, color: action.color, editedAt: utcTimestamp(action.editedAt, 'Highlight edit time'), editedBy };
      } else if (action.type === 'add-comment' && !action.parentId) {
        updated = { ...annotation, threads: [...threadRoots(annotation), action.comment] };
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
        const threads = threadRoots(annotation).map(visit);
        if (!found) throw new Error('Comment no longer exists.');
        updated = { ...annotation, threads };
      }
      replace(snapshot.map(item => item === annotation ? updated : item), action);
    },
  };
}
