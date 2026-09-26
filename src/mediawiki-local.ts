export interface LocalPage { title: string; pageid: number; revid: number; timestamp: string; content: string; summary?: string }
export class LocalApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Page/revision storage, isolated by the wiki origin and the Chrome profile. */
export class LocalWiki {
  private database: Promise<IDBDatabase>;
  constructor() {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open('reviewtool-dry-run-v1', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('pages', { keyPath: 'title' }); request.result.createObjectStore('meta'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async read(title: string): Promise<LocalPage | undefined> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = db.transaction('pages').objectStore('pages').get(title);
      request.onsuccess = () => resolve(request.result as LocalPage | undefined); request.onerror = () => reject(request.error);
    });
  }
  async edit(title: string, content: string, parameters: Record<string, unknown>, seed?: LocalPage, aborted: () => boolean = () => false): Promise<Record<string, unknown>> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['pages', 'meta'], 'readwrite'), pages = transaction.objectStore('pages'), meta = transaction.objectStore('meta');
      let result: Record<string, unknown>, failure: unknown;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure instanceof Error ? failure : transaction.error ?? new Error('Local transaction aborted.'));
      transaction.onerror = () => { /* onabort reports the failure */ };
      const request = pages.get(title);
      request.onsuccess = () => {
        try {
          if (aborted()) throw new LocalApiError('aborted', 'Request aborted.');
          const current = (request.result as LocalPage | undefined) ?? seed;
          const enabled = (value: unknown) => value !== undefined && value !== false;
          if (enabled(parameters.createonly) && current) throw new LocalApiError('articleexists', 'The local page already exists.');
          if (enabled(parameters.nocreate) && !current) throw new LocalApiError('missingtitle', 'The local page does not exist.');
          if (parameters.baserevid !== undefined && Number(parameters.baserevid) !== (current?.revid ?? 0)) throw new LocalApiError('editconflict', 'The local page changed since it was read.');
          if (typeof parameters.basetimestamp === 'string' && current && Date.parse(parameters.basetimestamp) !== Date.parse(current.timestamp)) throw new LocalApiError('editconflict', 'The local page timestamp changed.');
          if (current?.content === content) { result = { edit: { result: 'Success', nochange: true, title, pageid: current.pageid, contentmodel: 'wikitext' } }; return; }
          const counter = meta.get('revision');
          counter.onsuccess = () => {
            if (aborted()) { failure = new LocalApiError('aborted', 'Request aborted.'); transaction.abort(); return; }
            const revid = Math.max(Number(counter.result) || 1000000000, current?.revid ?? 0) + 1;
            const page: LocalPage = { title, pageid: current?.pageid ?? revid, revid, timestamp: new Date().toISOString(), content, summary: typeof parameters.summary === 'string' ? parameters.summary : '' };
            meta.put(revid, 'revision'); pages.put(page);
            result = { edit: { result: 'Success', pageid: page.pageid, title, oldrevid: current?.revid ?? 0, newrevid: revid, newtimestamp: page.timestamp, contentmodel: 'wikitext' } };
          };
        } catch (error) { failure = error; transaction.abort(); }
      };
    });
  }
}
