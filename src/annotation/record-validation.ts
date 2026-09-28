import { utcTimestamp } from './annotation-state';
import { compareStamp, recordKey, type AnnotationRecord, type RecordSet } from './record-types';
import type { SourceAnchor } from './types';

const own = (value: object, key: string) => Object.getOwnPropertyDescriptor(value, key) !== undefined;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Missing or unexpected record fields.');
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty record text.'); return value;
}
export function identifier(value: unknown): string {
  const id = text(value); if (id.length > 128 || /[\/\x00-\x1f]/.test(id)) throw new Error('Invalid record identifier.'); return id;
}
const color = (value: unknown) => { if (typeof value !== 'string' || !['red', 'yellow', 'green', 'blue'].includes(value)) throw new Error('Invalid highlight color.'); };
const time = (value: unknown) => { const raw = text(value); if (utcTimestamp(raw) !== raw) throw new Error('Record timestamps must use canonical UTC milliseconds.'); };
const reference = (value: unknown, prefix: string) => { const raw = text(value); if (!raw.startsWith(prefix + '/')) throw new Error('Invalid record reference.'); identifier(raw.slice(2)); };
function edited(value: Record<string, unknown>, pair: boolean): void {
  if (value.editedAt !== undefined) time(value.editedAt);
  if (value.editedBy !== undefined) { text(value.editedBy); if (value.editedAt === undefined) throw new Error('Editor without edit time.'); }
  if (pair && (value.editedAt === undefined) !== (value.editedBy === undefined)) throw new Error('Highlight edit metadata must be paired.');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value;
}

/** Validate all records, including losing edits and hidden/deleted entities. Never silently drop data. */
export function validateRecords(raw: unknown, validateAnchor: (anchor: SourceAnchor) => boolean): RecordSet {
  const input = object(raw), records: Record<string, AnnotationRecord> = Object.create(null) as Record<string, AnnotationRecord>;
  const stamps = new Set<string>();
  for (const [key, unknownRecord] of Object.entries(input)) {
    const record = object(unknownRecord), stamp = record.stamp;
    if (typeof record.kind !== 'string') throw new Error('Invalid record kind.');
    if (!Array.isArray(stamp) || stamp.length !== 2 || !Number.isSafeInteger(stamp[0]) || Number(stamp[0]) < 1) throw new Error('Invalid logical clock.');
    identifier(stamp[1]); const stampKey = JSON.stringify(stamp); if (stamps.has(stampKey)) throw new Error('Replica clock reused.'); stamps.add(stampKey);
    if (record.kind === 'highlight') {
      fields(record, ['kind', 'stamp', 'source', 'appearance'], ['author', 'createdAt']); reference(key, 'h');
      if (record.author !== undefined) text(record.author); if (record.createdAt !== undefined) time(record.createdAt);
      const source = record.source;
      if (!Array.isArray(source) || source.length !== 2 || !Number.isSafeInteger(source[0]) || !Number.isSafeInteger(source[1]) || source[0] < 0 || source[0] >= source[1] || !validateAnchor({ unit: 'utf8-byte', start: source[0] as number, end: source[1] as number })) throw new Error('Invalid source interval.');
      const appearance = object(record.appearance); fields(appearance, ['color'], ['editedAt', 'editedBy']); color(appearance.color); edited(appearance, true);
    } else if (record.kind === 'comment') {
      fields(record, ['kind', 'stamp', 'highlight', 'parent', 'author', 'createdAt', 'body']); reference(key, 'c'); reference(record.highlight, 'h');
      if (record.parent !== null) reference(record.parent, 'c'); text(record.author); time(record.createdAt);
      const body = object(record.body); fields(body, ['text'], ['editedAt', 'editedBy']); text(body.text); edited(body, false);
    } else {
      if (!['body', 'appearance', 'resolve', 'delete', 'resolution'].includes(String(record.kind))) throw new Error('Unknown record kind.');
      fields(record, ['kind', 'stamp', 'target', 'by', 'at', ...(record.kind === 'body' ? ['text'] : record.kind === 'appearance' ? ['color'] : record.kind === 'resolution' ? ['resolved'] : [])], ['reason']);
      reference(record.target, ['body', 'resolve', 'resolution'].includes(record.kind) ? 'c' : 'h'); text(record.by); time(record.at);
      if (record.kind === 'resolution' && typeof record.resolved !== 'boolean') throw new Error('Invalid resolution state.');
      if (record.reason !== undefined) text(record.reason);
      if (record.kind === 'body') text(record.text); if (record.kind === 'appearance') color(record.color);
      if (key !== recordKey(record as unknown as Parameters<typeof recordKey>[0])) throw new Error('Change key does not match its record.');
    }
    records[key] = record as unknown as AnnotationRecord;
  }
  const follows = (record: AnnotationRecord, parent: AnnotationRecord | undefined) => {
    if (!parent || record.stamp[0] <= parent.stamp[0] || compareStamp(record.stamp, parent.stamp) <= 0) throw new Error('Missing dependency or noncausal record.');
  };
  for (const [key, record] of Object.entries(records)) {
    if (record.kind === 'comment') {
      const highlight = records[record.highlight]; if (highlight?.kind !== 'highlight') throw new Error('Missing highlight.'); follows(record, highlight);
      if (record.parent !== null) {
        const parent = records[record.parent]; if (parent?.kind !== 'comment' || parent.highlight !== record.highlight) throw new Error('Missing or cross-highlight comment parent.'); follows(record, parent);
      }
      // Strictly increasing clocks preclude cycles; bound depth for the recursive UI projection.
      let parent = record.parent, depth = 0;
      while (parent !== null) { if (++depth > 100 || parent === key) throw new Error('Comment ancestry is too deep or cyclic.'); const node = records[parent]; if (node?.kind !== 'comment') throw new Error('Missing parent.'); parent = node.parent; }
    } else if (record.kind !== 'highlight') {
      const target = records[record.target]; follows(record, target);
      if (record.kind === 'body' || record.kind === 'resolve' || record.kind === 'resolution') { if (target.kind !== 'comment') throw new Error('Invalid comment target.'); if (record.kind !== 'body' && target.parent !== null) throw new Error('Only roots can be resolved.'); }
      else if (target.kind !== 'highlight') throw new Error('Invalid highlight target.');
    }
  }
  // Clone after validation so imported objects cannot mutate immutable records through aliases.
  return freeze(JSON.parse(JSON.stringify(records)) as RecordSet);
}
