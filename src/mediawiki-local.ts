export interface LocalPage { title: string; pageid: number; revid: number; timestamp: string; content: string; contentmodel?: string; contentformat?: string; summary?: string; tags?: string[]; parentid?: number }
export class LocalApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Page/revision storage, isolated by the wiki origin and the Chrome profile. */
export class LocalWiki {
  private database: Promise<IDBDatabase>;
  constructor() {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open('reviewtool-dry-run-v1', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'title' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('revisions')) db.createObjectStore('revisions', { keyPath: 'revid' }).createIndex('title', 'title');
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
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
  async pages(): Promise<LocalPage[]> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = db.transaction('pages').objectStore('pages').getAll();
      request.onsuccess = () => resolve(request.result as LocalPage[]); request.onerror = () => reject(request.error);
    });
  }
  async revision(id: number): Promise<LocalPage | undefined> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['revisions', 'pages']), request = tx.objectStore('revisions').get(id);
      request.onsuccess = () => {
        if (request.result) { resolve(request.result as LocalPage); return; }
        const pages = tx.objectStore('pages').getAll(); pages.onsuccess = () => resolve((pages.result as LocalPage[]).find(page => page.revid === id)); pages.onerror = () => reject(pages.error);
      }; request.onerror = () => reject(request.error);
    });
  }
  async history(title: string): Promise<LocalPage[]> {
    const db = await this.database;
    const versions = await new Promise<LocalPage[]>((resolve, reject) => { const request = db.transaction('revisions').objectStore('revisions').index('title').getAll(title); request.onsuccess = () => resolve(request.result as LocalPage[]); request.onerror = () => reject(request.error); });
    const current = await this.read(title); if (current && !versions.some(item => item.revid === current.revid)) versions.push(current);
    return versions.sort((a, b) => b.revid - a.revid);
  }
  async edit(title: string, content: string, parameters: Record<string, unknown>, seed?: LocalPage, aborted: () => boolean = () => false): Promise<Record<string, unknown>> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['pages', 'meta', 'revisions'], 'readwrite'), pages = transaction.objectStore('pages'), meta = transaction.objectStore('meta'), revisions = transaction.objectStore('revisions');
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
          const contentmodel = typeof parameters.contentmodel === 'string' ? parameters.contentmodel : current?.contentmodel ?? 'wikitext';
          const contentformat = typeof parameters.contentformat === 'string' ? parameters.contentformat : contentmodel === 'json' ? 'application/json' : current?.contentformat ?? 'text/x-wiki';
          if (contentmodel === 'json') {
            try { JSON.parse(content); } catch { throw new LocalApiError('invalid-content-data', 'Invalid JSON content.'); }
          }
          if (current?.content === content && (current.contentmodel ?? 'wikitext') === contentmodel) { result = { edit: { result: 'Success', nochange: true, title, pageid: current.pageid, contentmodel } }; return; }
          const counter = meta.get('revision');
          counter.onsuccess = () => {
            if (aborted()) { failure = new LocalApiError('aborted', 'Request aborted.'); transaction.abort(); return; }
            const revid = Math.max(Number(counter.result) || 1000000000, current?.revid ?? 0) + 1;
            const page: LocalPage = { title, pageid: current?.pageid ?? revid, revid, timestamp: new Date().toISOString(), content, contentmodel, contentformat, summary: typeof parameters.summary === 'string' ? parameters.summary : '', parentid: current?.revid ?? 0, tags: typeof parameters.tags === 'string' ? parameters.tags.split('|') : [] };
            meta.put(revid, 'revision'); pages.put(page); if (current) revisions.put(current); revisions.put(page);
            result = { edit: { result: 'Success', pageid: page.pageid, title, oldrevid: current?.revid ?? 0, newrevid: revid, newtimestamp: page.timestamp, contentmodel } };
          };
        } catch (error) { failure = error; transaction.abort(); }
      };
    });
  }
}
