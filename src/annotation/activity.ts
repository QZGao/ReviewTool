import { compareStamp, type AnnotationRecord, type RecordSet } from './record-types';
import type { SourceAnchor } from './types';

export interface PublishedAnnotations { revision: number; generation: string; records: RecordSet }
export interface AnnotationActivity {
  key: string;
  record: AnnotationRecord;
  author: string;
  highlightId: string;
  commentId?: string;
  anchor: SourceAnchor;
}
export interface ActivityGroup { actions: AnnotationActivity[]; target: AnnotationActivity }
const username = (name: string) => name.replace(/_/g, ' ').trim();

/** Compare committed records, never local drafts or the optimistic outbox. */
export function annotationActivity(before: PublishedAnnotations, after: PublishedAnnotations, viewer: string): AnnotationActivity[] {
  // A generation reset reseeds historical records and is not a batch of newly authored actions.
  if (before.revision && before.generation !== after.generation) return [];
  const events: AnnotationActivity[] = [];
  for (const [key, record] of Object.entries(after.records)) {
    if (Object.prototype.hasOwnProperty.call(before.records, key)) continue;
    const author = record.kind === 'comment' || record.kind === 'highlight' ? record.author : record.by;
    if (!author || username(author) === username(viewer)) continue;
    const target = record.kind === 'comment' || record.kind === 'highlight' ? key : record.target;
    const comment = after.records[target];
    const highlightKey = comment?.kind === 'comment' ? comment.highlight : target;
    const highlight = after.records[highlightKey];
    if (highlight?.kind !== 'highlight') continue;
    events.push({ key, record, author, highlightId: highlightKey.slice(2),
      ...(comment?.kind === 'comment' ? { commentId: target.slice(2) } : {}),
      anchor: { unit: 'utf8-byte', start: highlight.source[0], end: highlight.source[1], ...(highlight.target ? { target: highlight.target } : {}) },
    });
  }
  return events.sort((a, b) => compareStamp(a.record.stamp, b.record.stamp));
}

/** Catch-up groups descendants only when their ancestor comment is itself new. */
export function groupMissedActivity(actions: AnnotationActivity[], records: RecordSet): ActivityGroup[] {
  const newComments = new Map(actions.filter(action => action.record.kind === 'comment').map(action => [action.key, action]));
  const groups = new Map<string, ActivityGroup>();
  for (const action of actions) {
    let target = action;
    let key: string | null = action.commentId ? 'c/' + action.commentId : null;
    while (key) {
      const candidate = newComments.get(key);
      if (candidate) target = candidate;
      const comment: AnnotationRecord | undefined = records[key];
      key = comment?.kind === 'comment' ? comment.parent : null;
    }
    const group = groups.get(target.key) ?? { target, actions: [] };
    group.actions.push(action); groups.set(target.key, group);
  }
  return [...groups.values()];
}
