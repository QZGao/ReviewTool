import { annotationState } from './annotation-state';
import { assertActionAllowed, findComment, moderationReason, type AnnotationActor } from './permissions';
import type { HighlightAction, HighlightAnnotation, SourceAnchor } from './types';

export interface ReviewIdentity { wiki: string; pageId: number; revisionId: number }
export interface DataPage { text: string; revision: number; timestamp: string; readAt: string }
export interface PendingAction { action: HighlightAction; before: readonly HighlightAnnotation[] }
export const dataTemplate = '{{ReviewTool annotation data page}}';

export function encodeData(identity: ReviewIdentity, annotations: readonly HighlightAnnotation[]): string {
  const json = JSON.stringify({ schemaVersion: 1, ...identity, annotations }, null, 2).replace(/</g, '\\u003c');
  return `${dataTemplate}\n<syntaxhighlight lang="json">\n${json}\n</syntaxhighlight>\n`;
}

export function decodeData(text: string, identity: ReviewIdentity): readonly HighlightAnnotation[] {
  const match = /^\s*\{\{ReviewTool annotation data page\}\}\s*<syntaxhighlight\s+lang="json">\s*([\s\S]*?)\s*<\/syntaxhighlight>\s*$/.exec(text);
  if (!match) throw new Error('The annotation page has an unsupported data envelope.');
  const value = JSON.parse(match[1]) as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.wiki !== identity.wiki || value.pageId !== identity.pageId || value.revisionId !== identity.revisionId || !Array.isArray(value.annotations)) throw new Error('Annotation data does not match this wiki/page/revision or schema.');
  return value.annotations as HighlightAnnotation[];
}

// JSON field order can differ after a save/reload; it is not a concurrent edit.
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value: unknown, index) => same(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]));
}
/** Replay explicit actions on the latest page, recognizing an already-accepted retry. */
export function replay(initial: readonly HighlightAnnotation[], pending: readonly PendingAction[], validate: (anchor: SourceAnchor) => boolean, actor: AnnotationActor = {}): readonly HighlightAnnotation[] {
  const state = annotationState({ initial }, validate, actor);
  function conflict(): never { throw new Error('Another edit changed this annotation/comment. Reload or reconcile the pending change before saving.'); }
  for (const { action, before } of pending) {
    if (action.type === 'add-highlight') {
      const existing = state.annotations.find(annotation => annotation.id === action.highlight.id);
      if (existing) { if (!same(existing.anchor, action.highlight.anchor) || existing.color !== action.highlight.color || existing.author !== action.highlight.author || existing.createdAt !== action.highlight.createdAt) conflict(); continue; }
    } else {
      const current = state.annotations.find(annotation => annotation.id === action.id), previous = before.find(annotation => annotation.id === action.id);
      if (action.type === 'resolve-comment' || action.type === 'delete-highlight' || action.type === 'edit-comment') {
        // Check retries too, even if a previous save already removed the thread.
        const target = current ?? previous;
        if (!target) conflict();
        assertActionAllowed(target, action, actor);
      }
      if (action.type === 'delete-highlight') {
        if (!current) continue;
        if (!same(current, previous)) conflict();
      } else {
        if (!current && action.type === 'resolve-comment') continue;
        if (!current) conflict();
        if (action.type === 'recolor-highlight') {
          if (current.color === action.color) continue;
          if (current.color !== previous?.color || current.editedAt !== previous?.editedAt || current.editedBy !== previous?.editedBy) conflict();
        } else if (action.type === 'add-comment') {
          const existing = findComment(current.comment, action.comment.id);
          if (existing) { if (existing.text !== action.comment.text || existing.author !== action.comment.author || existing.createdAt !== action.comment.createdAt) conflict(); continue; }
        } else {
          const target = findComment(current.comment, action.commentId), old = findComment(previous?.comment, action.commentId);
          if (action.type === 'edit-comment') {
            if (target?.text === action.text && target.editedAt === action.editedAt && target.editedBy === actor.name?.trim()) continue;
            if (!target || target.text !== old?.text || target.editedAt !== old?.editedAt || target.editedBy !== old?.editedBy) conflict();
          } else {
            if (!target) continue;
            if (!same(target, old)) conflict();
          }
        }
      }
    }
    state.dispatch(action);
  }
  return state.annotations;
}

/** Serial, debounced read/replay/CAS writes. Errors keep the unsaved queue intact. */
export function saveQueue(options: {
  read: () => Promise<DataPage | null>; write: (text: string, base: DataPage | null, summary: string) => Promise<void>;
  identity: ReviewIdentity; actor: AnnotationActor; validate: (anchor: SourceAnchor) => boolean;
  saved: (annotations: readonly HighlightAnnotation[]) => void; status: (message: string, error?: boolean) => void;
}) {
  const pending: PendingAction[] = [];
  const queuedReason = ({ action, before }: PendingAction) => moderationReason(action, options.actor,
    action.type === 'add-highlight' ? undefined : before.find(annotation => annotation.id === action.id));
  let running: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const flush = (): Promise<void> => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (running !== null) return running;
    if (closed || !pending.length) return Promise.resolve();
    running = (async () => {
      try {
        while (pending.length && !closed) {
          // A reasoned action gets its own wiki revision and exact edit summary.
          const reason = queuedReason(pending[0]);
          let count = 1;
          if (reason === undefined) while (count < pending.length && queuedReason(pending[count]) === undefined) count++;
          const batch = pending.slice(0, count); options.status('Saving…');
          let next: readonly HighlightAnnotation[] = [];
          for (let attempt = 0; ; attempt++) {
            const page = await options.read();
            if (closed) return;
            next = replay(page ? decodeData(page.text, options.identity) : [], batch, options.validate, options.actor);
            try { await options.write(encodeData(options.identity, next), page, reason ?? 'ReviewTool: update revision annotations'); break; }
            catch (error) { if (attempt >= 2 || !['editconflict', 'articleexists'].includes(error instanceof Error ? error.message : String(error))) throw error; }
          }
          pending.splice(0, batch.length);
          if (!closed && !pending.length) options.saved(next);
        }
      } catch (error) { if (!closed) options.status(`Not saved: ${error instanceof Error ? error.message : String(error)}`, true); }
      finally { running = null; }
    })();
    return running;
  };
  return {
    add(action: HighlightAction, before: readonly HighlightAnnotation[]) {
      pending.push({ action, before }); options.status('Changes pending…');
      if (running === null) { if (timer !== undefined) clearTimeout(timer); timer = setTimeout(() => { void flush(); }, 350); }
    },
    flush,
    get dirty() { return pending.length > 0; },
    destroy() { closed = true; if (timer !== undefined) clearTimeout(timer); },
  };
}
