import { identifier, object, text } from './record-validation';
import { decodeId, encodeId } from './uuid';

/** Change only identifiers. Authored text, names, summaries and source coordinates are opaque here. */
function mapRecordIds(raw: unknown, convert: (id: string) => string): Record<string, unknown> {
  const records = object(raw);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const reference = (value: unknown, prefix: string): string => {
    const ref = text(value);
    if (!ref.startsWith(prefix + '/')) throw new Error('Invalid record reference.');
    return prefix + '/' + convert(ref.slice(2));
  };
  // Sort canonical keys before encoding so shortening cannot reorder the stored record lines.
  for (const key of Object.keys(records).sort()) {
    const record = object(records[key]), kind = text(record.kind), stamp = record.stamp;
    if (!Array.isArray(stamp) || stamp.length !== 2 || typeof stamp[0] !== 'number' || !Number.isSafeInteger(stamp[0]) || stamp[0] < 1 || typeof stamp[1] !== 'string') throw new Error('Invalid logical clock.');
    const nextStamp = [stamp[0], convert(stamp[1])];
    const mapped: Record<string, unknown> = { ...record, stamp: nextStamp };
    let nextKey: string;
    if (kind === 'highlight') nextKey = reference(key, 'h');
    else if (kind === 'comment') {
      nextKey = reference(key, 'c');
      mapped.highlight = reference(record.highlight, 'h');
      mapped.parent = record.parent === null ? null : reference(record.parent, 'c');
    } else {
      if (!['body', 'appearance', 'resolve', 'delete', 'resolution'].includes(kind)) throw new Error('Unknown record kind.');
      const target = text(record.target);
      if (key !== `${target}/${kind}/${stamp[0]}@${stamp[1]}`) throw new Error('Change key does not match its record.');
      const nextTarget = reference(target, ['body', 'resolve', 'resolution'].includes(kind) ? 'c' : 'h');
      mapped.target = nextTarget;
      nextKey = `${nextTarget}/${kind}/${stamp[0]}@${nextStamp[1]}`;
    }
    if (Object.prototype.hasOwnProperty.call(result, nextKey)) throw new Error('Duplicate record identity after UUID decoding.');
    result[nextKey] = mapped;
  }
  return result;
}

export const encodeRecordIds = (records: unknown): Record<string, unknown> => mapRecordIds(records, id => encodeId(identifier(id)));
export const decodeRecordIds = (records: unknown): Record<string, unknown> => mapRecordIds(records, id => identifier(decodeId(id)));
