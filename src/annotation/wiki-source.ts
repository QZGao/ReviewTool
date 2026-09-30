import { recognizedEdit, summaryMarker, type DataPage, type PageRevision } from './live-storage';
import { addNoticeRevision } from './talk-notice';

export interface WikiSource {
  head(): Promise<PageRevision | null>;
  read(revision: number): Promise<DataPage>;
  history(head: number, stop?: number): Promise<PageRevision[]>;
  write(text: string, base: PageRevision | null, reason?: string): Promise<void>;
  ensureIndexed?(): Promise<void>;
}
type Request = (params: Record<string, unknown>, write?: boolean) => Promise<unknown>;
interface ApiRevision { revid: number; parentid: number; timestamp: string; tags?: string[]; comment?: string; slots?: { main?: { content?: string; contentmodel?: string } } }
interface ApiPage { title?: string; missing?: boolean; revisions?: ApiRevision[] }
interface ApiResult { query?: { pages?: ApiPage[]; tags?: { name: string; active?: boolean; source?: string[] }[] }; continue?: Record<string, unknown>; edit?: { result?: string } }
const revision = (value: ApiRevision): PageRevision => ({ revision: value.revid, parentId: value.parentid, timestamp: value.timestamp, tags: value.tags ?? [], summary: value.comment ?? '' });

/** Exactly one startup lookup; an unavailable/unlisted tag uses the permanent summary fallback. */
export function wikiSource(request: Request, title: string, index?: { talkTitle: string; revisionId: number; summary?: string }): WikiSource {
  const tag = (async () => {
    try {
      const data = await request({ action: 'query', list: 'tags', tgprop: 'active|source', tglimit: 'max', formatversion: 2 }) as ApiResult;
      return Boolean(data.query?.tags?.some(item => item.name === 'ReviewTool' && item.active !== undefined && item.active !== false && item.source?.includes('manual')));
    } catch { return false; }
  })();
  let rejectedTag = false;
  let indexed = false;
  const edit = async (pageTitle: string, text: string, contentmodel: 'json' | 'wikitext', base: PageRevision | null, reason?: string) => {
    let useTag = await tag && !rejectedTag;
    for (;;) {
      try {
        const result = await request({ action: 'edit', title: pageTitle, text, contentmodel, contentformat: contentmodel === 'json' ? 'application/json' : 'text/x-wiki', formatversion: 2,
          summary: useTag ? reason ?? 'ReviewTool: update revision annotations' : summaryMarker + (reason ? ' ' + reason : ''),
          ...(useTag ? { tags: 'ReviewTool' } : {}),
          // Do not supply basetimestamp: it suppresses same-user conflict detection.
          ...(base ? { baserevid: base.revision, nocreate: true } : { createonly: true }),
        }, true) as ApiResult;
        if (result.edit?.result !== 'Success') throw new Error('MediaWiki did not accept the edit.');
        return;
      } catch (error) {
        if (useTag && error instanceof Error && ['badtags', 'taggingnotallowed'].includes(error.message)) { rejectedTag = true; useTag = false; continue; }
        throw error;
      }
    }
  };
  const query = async (params: Record<string, unknown>): Promise<ApiResult> => await request({ action: 'query', prop: 'revisions', rvprop: 'ids|timestamp|tags|comment', formatversion: 2, ...params }) as ApiResult;
  const read = async (id: number): Promise<DataPage> => {
    const result = await query({ revids: id, rvslots: 'main', rvprop: 'ids|timestamp|tags|comment|content' });
    const value = result.query?.pages?.flatMap(page => page.revisions ?? []).find(item => item.revid === id);
    if (!value || typeof value.slots?.main?.content !== 'string') throw new Error('Annotation revision content is unavailable.');
    return { ...revision(value), text: value.slots.main.content };
  };
  return {
    async head() {
      const result = await query({ titles: title });
      const page = result.query?.pages?.[0];
      if (page?.missing) return null;
      if (!page?.revisions?.[0]) throw new Error('Could not read annotation revision metadata.');
      return revision(page.revisions[0]);
    },
    read,
    async history(head, stop) {
      const found: PageRevision[] = []; let continuation: Record<string, unknown> = {};
      do {
        const result = await query({ titles: title, rvstartid: head, rvlimit: 'max', ...continuation });
        const revisions = result.query?.pages?.[0]?.revisions;
        if (!revisions) throw new Error('Annotation history is unavailable.');
        for (const value of revisions) {
          if (value.revid > head || found.some(item => item.revision === value.revid)) continue;
          if (value.revid === stop) return found;
          if (stop !== undefined && value.revid < stop) throw new Error('Annotation history does not contain the previous baseline.');
          found.push(revision(value));
        }
        continuation = result.continue ?? {};
      } while (Object.keys(continuation).length);
      if (stop !== undefined) throw new Error('Incomplete annotation history; local work has been retained.');
      return found;
    },
    write: (text, base, reason) => edit(title, text, 'json', base, reason),
    async ensureIndexed() {
      if (!index || indexed) return;
      // A failed index edit can be retried independently after the JSON submission was acknowledged.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await query({ titles: index.talkTitle, redirects: true, rvslots: 'main', rvprop: 'ids|timestamp|content|contentmodel' });
          const page = result.query?.pages?.[0], value = page?.revisions?.[0], slot = value?.slots?.main;
          if (!page || (!page.missing && (!value || typeof slot?.content !== 'string'))) throw new Error('The talk page source is unavailable.');
          if (slot?.contentmodel && slot.contentmodel !== 'wikitext') throw new Error('The talk page is not wikitext.');
          const before = page.missing ? '' : slot?.content ?? '', after = addNoticeRevision(before, index.revisionId);
          if (after === before) { indexed = true; return; }
          await edit(page.title ?? index.talkTitle, after, 'wikitext', value ? revision(value) : null, index.summary ?? 'ReviewTool: update annotation revision index');
          // Read back on the next pass, including after MediaWiki's automatic text merging.
        } catch (error) {
          if (attempt < 3 && error instanceof Error && ['editconflict', 'articleexists', 'missingtitle'].includes(error.message)) continue;
          throw new Error(`Could not update the talk-page annotation index: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error('Could not confirm the talk-page annotation index; it will be retried.');
    },
  };
}
export { recognizedEdit };
