import type { AnnotationGroup } from '../annotations';
import { buildAnnotationExport } from './export';
import { decodePage } from './live-storage';
import { createProjection } from './projection';
import { SourceIndex } from './source-index';

export type AnnotationReadRequest = (params: Record<string, unknown>) => Promise<unknown>;
export interface AnnotationArticle { pageId: number; title: string }
export interface AnnotationPagePrefix { namespace: number; mainText: string; title: string }
export interface AnnotatedRevision { revisionId: number; dataTitle: string; timestamp?: string }
interface Revision { revid: number; parentid?: number; timestamp?: string; comment?: string; tags?: string[]; slots?: { main?: { content?: string } } }
interface QueryResult {
  query?: { pages?: { pageid: number; title: string; missing?: boolean; revisions?: Revision[] }[]; allpages?: { title: string; ns: number }[] };
  continue?: { apcontinue?: string; continue?: string };
}

export async function resolveAnnotationArticle(request: AnnotationReadRequest, title: string): Promise<AnnotationArticle | null> {
  const result = await request({ action: 'query', titles: title, prop: 'info', redirects: true, converttitles: true, formatversion: 2 }) as QueryResult;
  const page = result.query?.pages?.[0];
  if (page?.missing) return null;
  if (!page || !Number.isSafeInteger(page.pageid) || page.pageid < 1) throw new Error('Article identity is unavailable.');
  return { pageId: page.pageid, title: page.title };
}

/** Enumerate exact revision subpages, following every continuation before sorting numerically. */
export async function listAnnotatedRevisions(request: AnnotationReadRequest, article: AnnotationArticle, prefix: AnnotationPagePrefix): Promise<AnnotatedRevision[]> {
  const choices = new Map<number, AnnotatedRevision>();
  let continuation: QueryResult['continue'];
  do {
    const result = await request({ action: 'query', list: 'allpages', apnamespace: prefix.namespace, apprefix: prefix.mainText, aplimit: 'max', formatversion: 2, ...continuation }) as QueryResult;
    if (!Array.isArray(result.query?.allpages)) throw new Error('Annotation page listing is unavailable.');
    for (const page of result.query.allpages) {
      if (page.ns !== prefix.namespace || !page.title.startsWith(prefix.title)) continue;
      const suffix = page.title.slice(prefix.title.length), revisionId = Number(suffix);
      if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(revisionId)) continue;
      choices.set(revisionId, { revisionId, dataTitle: page.title });
    }
    if (result.continue?.apcontinue && result.continue.apcontinue === continuation?.apcontinue) throw new Error('Annotation page listing did not advance.');
    continuation = result.continue;
  } while (continuation?.apcontinue);
  const revisions = [...choices.values()].sort((a, b) => b.revisionId - a.revisionId);
  // Only metadata is loaded for the selector; source and discussion text wait until selection.
  for (let offset = 0; offset < revisions.length; offset += 50) {
    const batch = revisions.slice(offset, offset + 50);
    const result = await request({ action: 'query', prop: 'revisions', revids: batch.map(item => item.revisionId).join('|'), rvprop: 'ids|timestamp', formatversion: 2 }) as QueryResult;
    for (const page of result.query?.pages ?? []) {
      if (page.pageid !== article.pageId) continue;
      for (const revision of page.revisions ?? []) {
        const choice = choices.get(revision.revid);
        if (choice && revision.timestamp && Number.isFinite(Date.parse(revision.timestamp))) choice.timestamp = revision.timestamp;
      }
    }
  }
  return revisions;
}

/** Read-only import, using the fixed article source and the same complete comment projection as export. */
export async function loadAnnotationRevision(request: AnnotationReadRequest, wiki: string, article: AnnotationArticle, choice: AnnotatedRevision): Promise<AnnotationGroup[]> {
  const [source, data] = await Promise.all([
    request({ action: 'parse', oldid: choice.revisionId, prop: 'wikitext|revid', formatversion: 2 }),
    request({ action: 'query', titles: choice.dataTitle, prop: 'revisions', rvslots: 'main', rvprop: 'ids|timestamp|content|tags|comment', formatversion: 2 }),
  ]) as [{ parse?: { revid: number; pageid: number; wikitext: string } }, QueryResult];
  const parsed = source.parse, revision = data.query?.pages?.[0]?.revisions?.[0];
  if (!parsed || parsed.revid !== choice.revisionId || parsed.pageid !== article.pageId || typeof parsed.wikitext !== 'string') throw new Error('The selected source revision does not belong to this article.');
  const content = revision?.slots?.main?.content;
  if (!revision || typeof content !== 'string') throw new Error('The annotation page is unavailable.');
  const index = new SourceIndex(parsed.wikitext);
  const identity = { wiki, pageId: article.pageId, revisionId: choice.revisionId };
  const stored = decodePage({ text: content, revision: revision.revid, parentId: revision.parentid ?? 0, timestamp: revision.timestamp ?? '', tags: revision.tags ?? [], summary: revision.comment ?? '' }, identity, anchor => {
    try { return anchor.unit === 'utf8-byte' && index.toUtf16(anchor.start) < index.toUtf16(anchor.end); } catch { return false; }
  });
  try { return buildAnnotationExport(identity, article.title, createProjection(parsed.wikitext), stored.annotations).groups; }
  finally { stored.document.destroy(); }
}
