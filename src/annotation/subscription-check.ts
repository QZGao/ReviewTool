import { dataPageTitle } from './live-storage';
import type { AnnotationVisit } from './visits';

type Request = (params: Record<string, unknown>) => Promise<unknown>;
interface Revision { revid: number; parentid: number }
interface Result { query?: { pages?: { title: string; missing?: boolean; revisions?: Revision[] }[] }; continue?: Record<string, unknown> }

/** Count revision metadata only; no annotation content, journal or viewed marker is read or written. */
export async function checkSubscriptions(request: Request, subscriptions: AnnotationVisit[], notify: (visit: AnnotationVisit, count: number) => void, failed: (error: unknown) => void): Promise<void> {
  for (let offset = 0; offset < subscriptions.length; offset += 50) {
    const batch = subscriptions.slice(offset, offset + 50);
    let data: Result;
    try {
      data = await request({ action: 'query', prop: 'revisions', titles: batch.map(visit => dataPageTitle(visit.oldid)).join('|'), rvprop: 'ids', formatversion: 2 }) as Result;
      if (!data.query?.pages) throw new Error('Subscription metadata is unavailable.');
    } catch (error) { failed(error); continue; }
    // Bounded metadata requests for only the pages whose head has changed.
    for (let start = 0; start < batch.length; start += 5) {
      const results = await Promise.allSettled(batch.slice(start, start + 5).map(async visit => {
        const page = data.query?.pages?.find(page => page.title.replace(/_/g, ' ') === dataPageTitle(visit.oldid));
        const head = page?.revisions?.[0]?.revid, baseline = visit.viewedRevision;
        if (!head || baseline === undefined || head <= baseline) return;
        let continuation: Record<string, unknown> = {}, finished = false;
        const revisions = new Set<number>();
        do {
          const result = await request({ action: 'query', prop: 'revisions', titles: dataPageTitle(visit.oldid), rvprop: 'ids', rvlimit: 'max', rvstartid: head,
            ...(baseline ? { rvendid: baseline } : {}), ...continuation, formatversion: 2 }) as Result;
          const history = result.query?.pages?.[0]?.revisions;
          if (!history) throw new Error('Subscription revision history is unavailable.');
          for (const revision of history) {
            if (revision.revid > baseline && revision.revid <= head) revisions.add(revision.revid);
            if (revision.revid <= baseline || revision.parentid <= baseline) finished = true;
          }
          continuation = result.continue ?? {};
        } while (!finished && Object.keys(continuation).length);
        if (revisions.size) notify(visit, revisions.size);
      }));
      for (const result of results) if (result.status === 'rejected') failed(result.reason);
    }
  }
}
