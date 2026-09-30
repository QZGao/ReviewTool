import { opaqueAt, readTag, tagExtent } from './opaque';
import { templateFields } from './template-fields';

const template = 'ReviewTool talk page notice';
const protectedTags = new Set(['nowiki', 'pre', 'syntaxhighlight', 'source', 'code', 'math']);
interface Notice { end: number; revisions: number[]; nextParameter: number; numbered: boolean }
const revisionId = (value: string): number | null => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

/** Only actual top-level invocations count; examples in comments, literal tags, and other templates do not. */
function notices(source: string): Notice[] {
  const found: Notice[] = [];
  for (let cursor = 0; cursor < source.length;) {
    const tag = source[cursor] === '<' ? readTag(source, cursor) : null;
    if (tag && !tag.closing && protectedTags.has(tag.name)) { cursor = tagExtent(source, cursor, tag); continue; }
    const opaque = opaqueAt(source, cursor);
    if (!opaque) { cursor++; continue; }
    if (opaque.reason === 'template' && !source.startsWith('{{{', cursor)) {
      const fields = templateFields(source, cursor + 2, opaque.end - 2);
      const name = fields && source.slice(fields[0].from, fields[0].to).replace(/_/g, ' ').replace(/<!--[^]*?-->/g, '').trim().replace(/^(?:Template|模板):\s*/i, '');
      if (fields && name && name[0].toUpperCase() + name.slice(1) === template) {
        const parameters = new Map<number, string>();
        let implicit = 1, numbered = false;
        for (const field of fields.slice(1)) {
          const key = field.equals === undefined ? implicit++ : revisionId(source.slice(field.from, field.equals).trim());
          if (key === null) continue;
          numbered ||= field.equals !== undefined;
          parameters.set(key, source.slice(field.equals === undefined ? field.from : field.equals + 1, field.to).replace(/<!--[^]*?-->/g, '').trim());
        }
        found.push({ end: opaque.end, revisions: [...parameters.values()].map(revisionId).filter((id): id is number => id !== null), numbered,
          nextParameter: Math.max(0, ...parameters.keys()) + 1 });
      }
    }
    cursor = opaque.end;
  }
  return found;
}

export function noticeRevisions(source: string): number[] {
  return [...new Set(notices(source).flatMap(notice => notice.revisions))].sort((a, b) => b - a);
}

/** Preserve talk text and existing arguments; adding the same revision is a no-op. */
export function addNoticeRevision(source: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid article revision ID.');
  const entries = notices(source);
  if (entries.some(notice => notice.revisions.includes(revision))) return source;
  const first = entries[0];
  if (!first) return `{{${template}|${revision}}}\n` + source;
  if (!Number.isSafeInteger(first.nextParameter)) throw new Error('The annotation notice parameter index is too large.');
  const insert = first.end - 2;
  return source.slice(0, insert) + '|' + (first.numbered ? first.nextParameter + '=' : '') + revision + source.slice(insert);
}
