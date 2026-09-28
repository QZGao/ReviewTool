import { annotationState, threadRoots } from './annotation-state';
import { findAnnotationComment, type AnnotationActor } from './permissions';
import type { AnnotationComment, AnnotationRemoval, HighlightAction, HighlightAnnotation, SourceAnchor } from './types';
import { canonicalJson } from './record-json';
import { identifier, validateRecords } from './record-validation';
import { compareStamp, compareText, recordKey, type AnnotationRecord, type RecordSet, type RecordUpdate, type Stamp, type CommentRecord, type HighlightRecord, type BodyRecord, type AppearanceRecord, type RemovalRecord, type ResolutionRecord } from './record-types';
export type { RecordSet, RecordUpdate } from './record-types';
const required = <T>(value: T | undefined): T => { if (value === undefined) throw new Error('Missing record dependency.'); return value; };

export function normalizeAnnotations(annotations: readonly HighlightAnnotation[], validate: (anchor: SourceAnchor) => boolean): readonly HighlightAnnotation[] {
  const state = annotationState({ initial: annotations }, validate); const result = state.annotations; state.destroy(); return result;
}

/** An append-only record set. Union is the join; whole-value registers use Lamport order. */
export class AnnotationDocument {
  private records: RecordSet;
  private clock = 0;
  private cached: readonly HighlightAnnotation[] | null = null;
  constructor(readonly generation: string, private validate: (anchor: SourceAnchor) => boolean, records: unknown = {}, private replica: string = crypto.randomUUID()) {
    identifier(generation); identifier(replica); this.records = validateRecords(records, validate);
    this.clock = Object.values(this.records).reduce((max, record) => Math.max(max, record.stamp[0]), 0);
  }
  private stamp(): Stamp {
    if (this.clock >= Number.MAX_SAFE_INTEGER) throw new Error('Logical clock exhausted; a new generation is required.');
    return [++this.clock, this.replica];
  }
  private insertComment(records: Record<string, AnnotationRecord>, highlight: string, parent: string | null, comment: AnnotationComment): void {
    records['c/' + comment.id] = { kind: 'comment', stamp: this.stamp(), highlight, parent, author: comment.author, createdAt: comment.createdAt,
      body: { text: comment.text, ...(comment.editedAt ? { editedAt: comment.editedAt } : {}), ...(comment.editedBy ? { editedBy: comment.editedBy } : {}) } };
    if (comment.resolved) { const record = this.removal('resolve', 'c/' + comment.id, comment.resolved); records[recordKey(record)] = record; }
    if (comment.resolution) { const record: ResolutionRecord = { kind: 'resolution', target: 'c/' + comment.id, stamp: this.stamp(), ...comment.resolution }; records[recordKey(record)] = record; }
    for (const reply of comment.replies) this.insertComment(records, highlight, 'c/' + comment.id, reply);
  }
  private insertHighlight(records: Record<string, AnnotationRecord>, annotation: HighlightAnnotation): void {
    records['h/' + annotation.id] = { kind: 'highlight', stamp: this.stamp(), source: [annotation.anchor.start, annotation.anchor.end],
      ...(annotation.author ? { author: annotation.author } : {}), ...(annotation.createdAt ? { createdAt: annotation.createdAt } : {}),
      appearance: { color: annotation.color, ...(annotation.editedAt && annotation.editedBy ? { editedAt: annotation.editedAt, editedBy: annotation.editedBy } : {}) } };
    if (annotation.deleted) { const record = this.removal('delete', 'h/' + annotation.id, annotation.deleted); records[recordKey(record)] = record; }
    for (const root of threadRoots(annotation)) this.insertComment(records, 'h/' + annotation.id, null, root);
  }
  private removal(kind: 'resolve' | 'delete', target: string, value: AnnotationRemoval): RemovalRecord {
    return { kind, target, stamp: this.stamp(), by: value.by, at: value.at, ...(value.reason ? { reason: value.reason } : {}) };
  }
  static seed(generation: string, annotations: readonly HighlightAnnotation[], validate: (anchor: SourceAnchor) => boolean): AnnotationDocument {
    const document = new AnnotationDocument(generation, validate), records: Record<string, AnnotationRecord> = {};
    for (const annotation of normalizeAnnotations(annotations, validate)) document.insertHighlight(records, annotation);
    document.records = validateRecords(records, validate); return document;
  }
  snapshot(): readonly HighlightAnnotation[] {
    if (this.cached) return this.cached;
    const highlights = new Map<string, HighlightRecord>(), comments = new Map<string, CommentRecord>();
    const changes = new Map<string, BodyRecord | AppearanceRecord | RemovalRecord | ResolutionRecord>();
    const children = new Map<string, string[]>();
    for (const [key, record] of Object.entries(this.records)) {
      if (record.kind === 'highlight') highlights.set(key, record);
      else if (record.kind === 'comment') {
        comments.set(key, record); const group = JSON.stringify([record.highlight, record.parent]);
        const list = children.get(group) ?? []; list.push(key); children.set(group, list);
      } else {
        const key = record.target + '/' + record.kind, previous = changes.get(key);
        if (!previous || compareStamp(record.stamp, previous.stamp) > 0) changes.set(key, record);
      }
    }
    for (const list of children.values()) list.sort((a, b) => compareStamp(required(comments.get(a)).stamp, required(comments.get(b)).stamp));
    const removal = (record: RemovalRecord): AnnotationRemoval => ({ by: record.by, at: record.at, ...(record.reason ? { reason: record.reason } : {}) });
    const readComment = (key: string): AnnotationComment => {
      const initial = required(comments.get(key)), edit = changes.get(key + '/body'), resolve = changes.get(key + '/resolve');
      const resolution = changes.get(key + '/resolution');
      const body = edit?.kind === 'body' ? { text: edit.text, editedBy: edit.by, editedAt: edit.at } : initial.body;
      return { id: key.slice(2), author: initial.author, createdAt: initial.createdAt, ...body,
        ...(resolve?.kind === 'resolve' ? { resolved: removal(resolve) } : {}),
        ...(resolution?.kind === 'resolution' ? { resolution: { resolved: resolution.resolved, by: resolution.by, at: resolution.at } } : {}),
        replies: (children.get(JSON.stringify([initial.highlight, key])) ?? []).map(readComment) };
    };
    const snapshot = [...highlights].sort(([a], [b]) => compareText(a, b)).map(([key, initial]): HighlightAnnotation => {
      const edit = changes.get(key + '/appearance'), deleted = changes.get(key + '/delete');
      const appearance = edit?.kind === 'appearance' ? { color: edit.color, editedBy: edit.by, editedAt: edit.at } : initial.appearance;
      const threads = (children.get(JSON.stringify([key, null])) ?? []).map(readComment);
      return { id: key.slice(2), anchor: { unit: 'utf8-byte', start: initial.source[0], end: initial.source[1] },
        ...(initial.author ? { author: initial.author } : {}), ...(initial.createdAt ? { createdAt: initial.createdAt } : {}), ...appearance,
        ...(deleted?.kind === 'delete' ? { deleted: removal(deleted) } : {}), ...(threads.length ? { threads } : {}) };
    });
    this.cached = normalizeAnnotations(snapshot, this.validate); return this.cached;
  }
  toJSON(): RecordSet { return this.records; }
  clone(replica?: string): AnnotationDocument { return new AnnotationDocument(this.generation, this.validate, this.records, replica); }
  contains(update: RecordUpdate): boolean {
    return update.generation === this.generation && Object.entries(update.records).every(([key, record]) => Object.prototype.hasOwnProperty.call(this.records, key) && canonicalJson(this.records[key]) === canonicalJson(record));
  }
  /** Merge transactionally: partial/damaged records cannot replace accepted state. */
  merge(update: RecordUpdate): void {
    if (update.generation !== this.generation) throw new Error('Cannot merge different document generations.');
    const records: Record<string, AnnotationRecord> = { ...this.records };
    for (const [key, record] of Object.entries(update.records)) {
      if (Object.prototype.hasOwnProperty.call(records, key) && canonicalJson(records[key]) !== canonicalJson(record)) throw new Error(`Immutable record changed: ${key}`);
      records[key] = record;
    }
    const next = validateRecords(records, this.validate);
    this.records = next; this.cached = null;
    this.clock = Object.values(next).reduce((max, record) => Math.max(max, record.stamp[0]), this.clock);
  }
  dispatch(action: HighlightAction, actor: AnnotationActor): RecordUpdate {
    const by = actor.name?.trim(); if (!by) throw new Error('A current user is required.');
    if (action.type === 'add-comment' && action.comment.author !== by) throw new Error('New comments must name the current author.');
    if (action.type === 'add-highlight' && action.highlight.author !== by) throw new Error('New highlights must name the current author.');
    const state = annotationState({ initial: this.snapshot() }, this.validate, actor);
    try {
      const before = state.annotations; state.dispatch(action);
      if (state.annotations === before) return Object.freeze({ generation: this.generation, records: Object.freeze({}) });
      const id = action.type === 'add-highlight' ? action.highlight.id : action.id;
      const next = state.annotations.find(annotation => annotation.id === id);
      if (!next) throw new Error('Missing action result.');
      const records: Record<string, AnnotationRecord> = {};
      if (action.type === 'add-highlight') this.insertHighlight(records, next);
      else if (action.type === 'add-comment') this.insertComment(records, 'h/' + id, action.parentId ? 'c/' + action.parentId : null, required(findAnnotationComment(next, action.comment.id)));
      else {
        let record: BodyRecord | AppearanceRecord | RemovalRecord | ResolutionRecord;
        const reason = 'reason' in action && action.reason?.trim() ? { reason: action.reason.trim() } : {};
        if (action.type === 'edit-comment') {
          const comment = required(findAnnotationComment(next, action.commentId));
          record = { kind: 'body', target: 'c/' + action.commentId, stamp: this.stamp(), by, at: required(comment.editedAt), text: comment.text, ...reason };
        } else if (action.type === 'recolor-highlight') {
          if (next.editedAt === undefined) return { generation: this.generation, records: {} };
          record = { kind: 'appearance', target: 'h/' + id, stamp: this.stamp(), by, at: next.editedAt, color: next.color };
        } else if (action.type === 'set-thread-resolution') record = { kind: 'resolution', target: 'c/' + action.commentId, stamp: this.stamp(), by, at: action.at, resolved: action.resolved };
        else if (action.type === 'delete-highlight') record = this.removal('delete', 'h/' + id, required(next.deleted));
        else record = this.removal('resolve', 'c/' + action.commentId, required(required(findAnnotationComment(next, action.commentId)).resolved));
        records[recordKey(record)] = record;
      }
      const update: RecordUpdate = { generation: this.generation, records };
      this.merge(update);
      return Object.freeze({ generation: this.generation, records: Object.freeze(Object.fromEntries(Object.keys(records).map(key => [key, this.records[key]]))) });
    } finally { state.destroy(); }
  }
  destroy(): void { this.records = {}; this.cached = null; }
}
