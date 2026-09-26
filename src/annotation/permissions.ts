import type { AnnotationComment, HighlightAction, HighlightAnnotation, ModerationReasonPrompt } from './types';

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
  if ([...value].length > 500) throw new Error('The reason must fit in a MediaWiki edit summary (500 characters maximum).');
  return value;
}

function canActWithoutModeration(action: ModerationTarget, actor: AnnotationActor, annotation?: HighlightAnnotation): boolean {
  if (!annotation) return false;
  let author: string | undefined;
  if (action.type === 'edit-comment') author = findComment(annotation.comment, action.commentId)?.author;
  else if (action.type === 'resolve-comment') author = annotation.comment?.id === action.commentId ? annotation.comment.author : undefined;
  else {
    author = annotation.comment?.author ?? annotation.author;
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
  if (action.type === 'resolve-comment' && annotation.comment?.id !== action.commentId) throw new Error('Only the first comment can resolve a thread.');
  if (action.type === 'resolve-comment' || action.type === 'delete-highlight') {
    if (!canRemoveAnnotation(annotation, actor)) throw new Error(annotation.comment
      ? 'Only the author of the first comment or a moderator can resolve or delete this thread.'
      : 'Only the highlight creator or a moderator can delete this highlight.');
  } else if (action.type === 'edit-comment') {
    const comment = findComment(annotation.comment, action.commentId);
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
