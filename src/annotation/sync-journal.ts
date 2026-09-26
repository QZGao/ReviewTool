import type { RecordSet, RecordUpdate } from './record-types';
import type { HighlightAction, CommentDraft } from './types';
import type { PageRevision } from './live-storage';
import type { AnnotationActor } from './permissions';

export interface PendingUpdate { id: string; sequence: number; generation: string; baseline: number; update: RecordUpdate; action: HighlightAction; actor: AnnotationActor; reason?: string; held?: boolean }
export interface DocumentCheckpoint { generation: string; baseline: number; base: RecordSet; local: RecordSet; revision: PageRevision | null; prefix: string; suffix: string }
export interface SyncJournal {
  checkpoint?(value?: DocumentCheckpoint): Promise<DocumentCheckpoint | undefined>;
  load(): Promise<PendingUpdate[]>;
  put(update: PendingUpdate): Promise<void>;
  remove(id: string): Promise<void>;
}
/** One record per operation avoids whole-queue lost updates between tabs. Account is part of the key. */
export function syncJournal(key: string, draftSession = "default"): SyncJournal & { drafts(value?: readonly CommentDraft[]): Promise<readonly CommentDraft[]> } {
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('reviewtool-annotation-records-v1', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('outbox', { keyPath: 'key' }); request.result.createObjectStore('drafts'); };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); }; request.onerror = () => reject(request.error);
  });
  async function transaction<T>(store: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode), request = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error ?? request.error); tx.onerror = () => {};
    });
  }
  return {
    async checkpoint(value) {
      if (value) { await transaction('drafts', 'readwrite', store => store.put(value, key + '/document')); return value; }
      return await transaction('drafts', 'readonly', store => store.get(key + '/document')) as DocumentCheckpoint | undefined;
    },
    async load() { return (await transaction('outbox', 'readonly', store => store.getAll()) as { key: string; scope: string; value: PendingUpdate }[]).filter(item => item.scope === key).map(item => item.value).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id)); },
    async put(value) { await transaction('outbox', 'readwrite', store => store.put({ key: key + '/' + value.id, scope: key, value })); },
    async remove(id) { await transaction('outbox', 'readwrite', store => store.delete(key + '/' + id)); },
    async drafts(value) {
      if (value !== undefined) { await transaction('drafts', 'readwrite', store => store.put(value, key + '/drafts/' + draftSession)); return value; }
      return await transaction('drafts', 'readonly', store => store.get(key + '/drafts/' + draftSession)) as CommentDraft[] | undefined ?? [];
    },
  };
}
