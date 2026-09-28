import type { AnnotationComment, HighlightAction, HighlightAnnotation, ModerationReasonPrompt } from './types';

const roots = (annotation: HighlightAnnotation) => annotation.comment ? [annotation.comment] : annotation.threads ?? [];
export const findAnnotationComment = (annotation: HighlightAnnotation, id: string) => roots(annotation).map(root => findComment(root, id)).find(Boolean);
export const canResolveThread = (annotation: HighlightAnnotation, id: string, actor: AnnotationActor) => Boolean(roots(annotation).some(root => root.id === id && (root.author === actor.name?.trim() || isModerator(actor))));

/** Supplied by the host, never taken from an annotation action or stored comment. */
export interface AnnotationActor { readonly name?: string; readonly groups?: readonly string[] }
type ModeratedAction = Extract<HighlightAction, { type: 'edit-comment' | 'resolve-comment' | 'delete-highlight' }>;
export type ModerationTarget = { type: 'edit-comment' | 'resolve-comment'; commentId: string } | { type: 'delete-highlight' };
const moderated = (action: HighlightAction): action is ModeratedAction => ['edit-comment', 'resolve-comment', 'delete-highlight'].includes(action.type);

export function isModerator(actor: AnnotationActor): boolean {
  return Boolean(actor.name?.trim() && actor.groups?.some(group => ['patroller', 'sysop', 'bureaucrat'].includes(group)));
}

export function canEditComment(comment: AnnotationComment, actor: AnnotationActor): boolean {
  return isModerator(actor) || Boolean(actor.name?.trim() && comment.author === actor.name.trim());
}

export function canRemoveAnnotation(annotation: HighlightAnnotation, actor: AnnotationActor): boolean {
  return isModerator(actor) || canActWithoutModeration({ type: 'delete-highlight' }, actor, annotation);
}

export function findComment(comment: AnnotationComment | undefined, id: string): AnnotationComment | undefined {
  if (!comment || comment.id === id) return comment;
  for (const child of comment.replies) { const found = findComment(child, id); if (found) return found; }
  return undefined;
}

export function checkedReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('A reason is required for this action.');
  const value = reason.trim();
  if ([...value].length > 483) throw new Error('The reason must fit in a MediaWiki edit summary (483 characters maximum, reserving the ReviewTool summary prefix).');
  return value;
}

function canActWithoutModeration(action: ModerationTarget, actor: AnnotationActor, annotation?: HighlightAnnotation): boolean {
  if (!annotation) return false;
  let author: string | undefined;
  if (action.type === 'edit-comment') author = findAnnotationComment(annotation, action.commentId)?.author;
  else if (action.type === 'resolve-comment') author = roots(annotation).find(root => root.id === action.commentId)?.author;
  else {
    const threads = roots(annotation);
    if (threads.length) return threads.every(root => root.author === actor.name?.trim());
    author = annotation.author;
    // Keep the existing ordinary-user deletion behavior for legacy unattributed bare highlights.
    if (!author) return true;
  }
  return Boolean(author && actor.name?.trim() === author);
}

export function needsModerationReason(action: ModerationTarget, actor: AnnotationActor, annotation?: HighlightAnnotation): boolean {
  return isModerator(actor) && !canActWithoutModeration(action, actor, annotation);
}

/** A reason is needed only when the action uses moderator privileges. */
export function moderationReason(action: HighlightAction, actor: AnnotationActor, annotation?: HighlightAnnotation): string | undefined {
  return moderated(action) && needsModerationReason(action, actor, annotation) ? checkedReason(action.reason) : undefined;
}

export function assertActionAllowed(annotation: HighlightAnnotation, action: HighlightAction, actor: AnnotationActor): void {
  if (action.type === 'set-thread-resolution' && (!actor.name?.trim() || !roots(annotation).some(root => root.id === action.commentId && !root.resolved))) throw new Error('A current user and an open root discussion are required.');
  if (action.type === 'resolve-comment' && !roots(annotation).some(root => root.id === action.commentId)) throw new Error('Only the first comment can resolve a thread.');
  if (action.type === 'resolve-comment' || action.type === 'delete-highlight') {
    if (!(action.type === 'resolve-comment' ? canResolveThread(annotation, action.commentId, actor) : canRemoveAnnotation(annotation, actor))) throw new Error(roots(annotation).length
      ? 'Only the author of the first comment or a moderator can resolve or delete this thread.'
      : 'Only the highlight creator or a moderator can delete this highlight.');
  } else if (action.type === 'edit-comment') {
    const comment = findAnnotationComment(annotation, action.commentId);
    if (!comment) throw new Error('Comment no longer exists.');
    if (!canEditComment(comment, actor)) throw new Error('Only the comment author or a moderator can edit this comment.');
  }
  moderationReason(action, actor, annotation);
}

/** The host provides an asynchronous in-page dialog; no native browser prompts. */
export async function requestActionReason(action: ModerationTarget, actor: AnnotationActor, prompt: ModerationReasonPrompt | undefined, signal: AbortSignal, annotation?: HighlightAnnotation): Promise<string | null> {
  if (!needsModerationReason(action, actor, annotation)) return '';
  if (!prompt) throw new Error('A moderation reason dialog is required for moderator controls.');
  const reason = await prompt(action.type, signal);
  return signal.aborted || reason === null ? null : checkedReason(reason);
}
