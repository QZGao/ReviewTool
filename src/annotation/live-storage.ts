import { AnnotationDocument } from './record-document';
import { canonicalJson, parseRecordJson } from './record-json';
import { fields, identifier, object } from './record-validation';
import type { HighlightAnnotation, SourceAnchor } from './types';

export interface ReviewIdentity { wiki: string; pageId: number; revisionId: number }
export interface PageRevision { revision: number; parentId: number; timestamp: string; tags: readonly string[]; summary: string }
export interface DataPage extends PageRevision { text: string }
export interface StoredDocument { generation: string; baseline: number; document: AnnotationDocument; annotations: readonly HighlightAnnotation[] }
export const recordFormat = 'reviewtool.annotation-records/1';
export const summaryMarker = '/* ReviewTool */';
export function dataPageTitle(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid article revision ID.');
  return `Wikipedia:ReviewTool/data/${revision}.json`;
}
export class IncompatibleData extends Error {}
export class MalformedData extends Error {}
export const recognizedEdit = (revision: Pick<PageRevision, 'tags' | 'summary'>): boolean => revision.tags.includes('ReviewTool') || revision.summary === summaryMarker || revision.summary.startsWith(summaryMarker + ' ');
export const sameData = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export function decodePage(page: DataPage, identity: ReviewIdentity, validate: (anchor: SourceAnchor) => boolean, manual = false): StoredDocument {
  let value: Record<string, unknown>;
  try { value = object(parseRecordJson(page.text)); } catch (error) { throw new MalformedData(error instanceof Error ? error.message : 'Invalid annotation JSON.'); }
  if (typeof value.format !== 'string') {
    if ('schemaVersion' in value) throw new IncompatibleData('This development data uses an old format. Convert it with the development converter.');
    throw new MalformedData('Missing record format.');
  }
  if (value.format !== recordFormat) throw new IncompatibleData('Unsupported annotation format; update ReviewTool before editing this page.');
  let documentIdentity: Record<string, unknown>;
  try {
    fields(value, ['format', 'document', 'generation', 'records'], ['baseline']); documentIdentity = object(value.document);
    fields(documentIdentity, ['wiki', 'pageId', 'revisionId', 'offsetUnit']);
    if (typeof documentIdentity.wiki !== 'string' || !documentIdentity.wiki || !Number.isSafeInteger(documentIdentity.pageId) || Number(documentIdentity.pageId) < 1 || !Number.isSafeInteger(documentIdentity.revisionId) || Number(documentIdentity.revisionId) < 1) throw new Error('Invalid document identity.');
    identifier(value.generation);
    if (value.baseline !== undefined && (!Number.isSafeInteger(value.baseline) || Number(value.baseline) < 0)) throw new Error('Invalid baseline revision.');
  } catch (error) { throw new MalformedData(error instanceof Error ? error.message : 'Invalid document envelope.'); }
  if (documentIdentity.wiki !== identity.wiki || documentIdentity.pageId !== identity.pageId || documentIdentity.revisionId !== identity.revisionId || documentIdentity.offsetUnit !== 'utf8-byte') throw new IncompatibleData('Annotation data belongs to another wiki/page/revision or offset convention.');
  let document: AnnotationDocument;
  try { document = new AnnotationDocument(value.generation as string, validate, value.records); }
  catch (error) { throw new MalformedData(error instanceof Error ? error.message : 'Invalid shared records.'); }
  const annotations = document.snapshot();
  if (manual) { document.destroy(); document = AnnotationDocument.seed(crypto.randomUUID(), annotations, validate); }
  return { generation: document.generation, baseline: manual ? page.revision : Number(value.baseline ?? 0), document, annotations };
}

/** One immutable record per line; only generation changes rewrite the fixed header. */
export function encodePage(identity: ReviewIdentity, stored: Pick<StoredDocument, 'baseline'>, document: AnnotationDocument): string {
  const json = (value: unknown) => canonicalJson(value).replace(/</g, '\\u003c');
  const records = document.toJSON(), keys = Object.keys(records).sort();
  return ['{', `  "format": ${json(recordFormat)},`, `  "document": ${json({ ...identity, offsetUnit: 'utf8-byte' })},`,
    `  "generation": ${json(document.generation)},`, `  "baseline": ${stored.baseline},`, '  "records": {',
    ...keys.map((key, index) => `    ${json(key)}: ${json(records[key])}${index + 1 < keys.length ? ',' : ''}`), '  }', '}'].join('\n') + '\n';
}
export function emptyDocument(validate: (anchor: SourceAnchor) => boolean): StoredDocument {
  const generation = crypto.randomUUID(), document = new AnnotationDocument(generation, validate);
  return { generation, baseline: 0, document, annotations: [] };
}
