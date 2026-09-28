import { bracketExtent, opaqueAt, readTag, tagExtent } from './opaque';
import type { SourceExtent } from './types';

interface Field extends SourceExtent { equals?: number }

/** Split only top-level arguments; pipes/equals inside protected syntax are not delimiters. */
export function templateFields(source: string, from: number, to: number): Field[] | null {
  const result: Field[] = [];
  let field: Field = { from, to };
  for (let cursor = from; cursor < to;) {
    const opaque = opaqueAt(source, cursor);
    const tag = source[cursor] === '<' ? readTag(source, cursor) : null;
    const skip = opaque?.end ?? (source.startsWith('[[', cursor) ? bracketExtent(source, cursor)
      : tag ? tagExtent(source, cursor, tag) : cursor);
    if (skip > to) return null;
    if (skip > cursor) { cursor = skip; continue; }
    if (source[cursor] === '|') {
      field.to = cursor; result.push(field); field = { from: cursor + 1, to };
    } else if (source[cursor] === '=' && field.equals === undefined) field.equals = cursor;
    cursor++;
  }
  result.push(field);
  return result;
}

