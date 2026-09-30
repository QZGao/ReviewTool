import type { AnnotationGroup } from '../annotations';
import { buildAnnotationExport } from './export';
import { dataPageTitle, decodePage } from './live-storage';
import { noticeRevisions } from './talk-notice';
import { createProjection } from './projection';
import { SourceIndex } from './source-index';

export type AnnotationReadRequest = (params: Record<string, unknown>) => Promise<unknown>;
export interface AnnotationArticle { pageId: number; title: string }
export interface AnnotatedRevision { revisionId: number; dataTitle: string; timestamp?: string }
interface Revision { revid: number; parentid?: number; timestamp?: string; comment?: string; tags?: string[]; slots?: { main?: { content?: string } } }
interface QueryResult {
  query?: { pages?: { pageid: number; title: string; missing?: boolean; revisions?: Revision[] }[] };
}

export async function resolveAnnotationArticle(request: AnnotationReadRequest, title: string): Promise<AnnotationArticle | null> {
  const result = await request({ action: 'query', titles: title, prop: 'info', redirects: true, converttitles: true, formatversion: 2 }) as QueryResult;
  const page = result.query?.pages?.[0];
  if (page?.missing) return null;
  if (!page || !Number.isSafeInteger(page.pageid) || page.pageid < 1) throw new Error('Article identity is unavailable.');
  return { pageId: page.pageid, title: page.title };
}

/** Read the article's notice; only revision metadata is fetched until the user chooses a revision. */
export async function listAnnotatedRevisions(request: AnnotationReadRequest, article: AnnotationArticle, talkTitle: string): Promise<AnnotatedRevision[]> {
  const result = await request({ action: 'query', titles: talkTitle, prop: 'revisions', rvslots: 'main', rvprop: 'content', redirects: true, formatversion: 2 }) as QueryResult;
  const page = result.query?.pages?.[0];
  if (page?.missing) return [];
  const text = page?.revisions?.[0]?.slots?.main?.content;
  if (typeof text !== 'string') throw new Error('The article talk page is unavailable.');
  const choices = new Map<number, AnnotatedRevision>(noticeRevisions(text).map(revisionId => [revisionId, { revisionId, dataTitle: dataPageTitle(revisionId) }]));
  const revisions = [...choices.values()].sort((a, b) => b.revisionId - a.revisionId);
  // Only metadata is loaded for the selector; source and discussion text wait until selection.
  const belonging = new Set<number>();
  for (let offset = 0; offset < revisions.length; offset += 50) {
    const batch = revisions.slice(offset, offset + 50);
    const result = await request({ action: 'query', prop: 'revisions', revids: batch.map(item => item.revisionId).join('|'), rvprop: 'ids|timestamp', formatversion: 2 }) as QueryResult;
    for (const page of result.query?.pages ?? []) {
      if (page.pageid !== article.pageId) continue;
      for (const revision of page.revisions ?? []) {
        const choice = choices.get(revision.revid);
        if (choice) belonging.add(revision.revid);
        if (choice && revision.timestamp && Number.isFinite(Date.parse(revision.timestamp))) choice.timestamp = revision.timestamp;
      }
    }
  }
  return revisions.filter(choice => belonging.has(choice.revisionId));
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
