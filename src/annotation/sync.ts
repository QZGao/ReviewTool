import { AnnotationDocument } from './record-document';
import { decodePage, emptyDocument, encodePage, IncompatibleData, MalformedData, recognizedEdit, sameData, type DataPage, type PageRevision, type ReviewIdentity, type StoredDocument } from './live-storage';
import { threadRoots } from './annotation-state';
import { assertActionAllowed, findComment, moderationReason, type AnnotationActor } from './permissions';
import type { SyncJournal, PendingUpdate } from './sync-journal';
import type { WikiSource } from './wiki-source';
import type { HighlightAction, HighlightAnnotation, SourceAnchor } from './types';

interface SyncOptions {
  identity: ReviewIdentity; actor: AnnotationActor; source: WikiSource; journal: SyncJournal;
  validate: (anchor: SourceAnchor) => boolean;
  changed: (annotations: readonly HighlightAnnotation[]) => void;
  status: (message: string, error?: boolean) => void;
  canWrite: boolean;
}
const race = (error: unknown) => error instanceof Error && ['editconflict', 'articleexists'].includes(error.message);

/** Polling and publication share one serial loop; remote state never discards the local outbox. */
export function annotationSync(options: SyncOptions) {
  const replica = crypto.randomUUID();
  let base = emptyDocument(options.validate), model = base.document.clone(replica);
  let current: PageRevision | null = null, initialized = false, closed = false;
  let serial = 0, notice: string | undefined;
  let pending: PendingUpdate[] = [], running: Promise<void> | null = null;
  let persistence: Promise<void> = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    options.changed(model.snapshot());
    if (options.journal.checkpoint) {
      const checkpoint = { generation: base.generation, baseline: base.baseline, base: base.document.toJSON(), local: model.toJSON(), revision: current };
      void persist(async () => { await options.journal.checkpoint?.(checkpoint); }).catch(error => options.status(`Local recovery storage failed: ${String(error)}`, true));
    }
  };
  const persist = (work: () => Promise<void>) => { persistence = persistence.then(work); return persistence; };
  const put = (entry: PendingUpdate) => persist(() => options.journal.put(entry));
  const forget = (id: string) => persist(() => options.journal.remove(id));
  const rebuild = () => {
    model.destroy(); model = base.document.clone(replica);
    for (const entry of pending) if (!entry.held && entry.generation === model.generation) model.merge(entry.update);
    notify();
  };
  const acknowledge = async (document: AnnotationDocument) => {
    const count = pending.length;
    for (const entry of pending) {
      if (document.contains(entry.update)) {
        if (entry.action.type === 'add-comment' && entry.action.parentId) {
          const id = entry.action.id, parentId = entry.action.parentId;
          const annotation = document.snapshot().find(item => item.id === id);
          if (annotation && (annotation.deleted || threadRoots(annotation).some(root => root.resolved && findComment(root, parentId)))) notice = 'Reply saved in a discussion that has been resolved or removed.';
        }
        await forget(entry.id); continue;
      }
    }
    pending = pending.filter(entry => !document.contains(entry.update));
    return pending.length !== count;
  };
  const adopt = async (next: StoredDocument, revision: PageRevision | null) => {
    if (closed) { next.document.destroy(); return; }
    await acknowledge(next.document);
    for (const entry of pending) {
      if (entry.generation !== next.generation) {
        // Two writers may create a previously absent page concurrently.
        if (current === null && entry.baseline === 0 && next.baseline === 0 && !entry.held) {
          const staged = next.document.clone();
          try {
            for (const earlier of pending) if (earlier === entry) break; else if (!earlier.held && earlier.generation === next.generation && !staged.contains(earlier.update)) staged.merge(earlier.update);
            entry.update = staged.dispatch(entry.action, options.actor); entry.generation = next.generation;
          } catch { entry.held = true; } finally { staged.destroy(); }
        } else entry.held = true;
        await put(entry);
      }
    }
    base.document.destroy(); base = next; current = revision; initialized = true; rebuild();
  };
  const parse = (page: DataPage, manual = false) => decodePage(page, options.identity, options.validate, manual);
  const validBefore = async (head: PageRevision): Promise<StoredDocument> => {
    const history = await options.source.history(head.revision);
    for (const revision of history) {
      if (revision.revision === head.revision) continue;
      const page = await options.source.read(revision.revision);
      try { return parse(page, !recognizedEdit(page)); }
      catch (error) { if (!(error instanceof MalformedData)) throw error; }
    }
    throw new Error('No valid annotation revision is available for automatic repair.');
  };
  async function inspect(head: PageRevision): Promise<{ stored: StoredDocument; rewrite: boolean }> {
    const page = await options.source.read(head.revision);
    let stored: StoredDocument;
    try { stored = parse(page); }
    catch (error) {
      if (!(error instanceof MalformedData) || recognizedEdit(page)) throw error;
      return { stored: await validBefore(head), rewrite: true };
    }
    const revisions = initialized && current ? await options.source.history(head.revision, current.revision) : [head];
    const manual = revisions.find(revision => !recognizedEdit(revision));
    if (manual) {
      const external = manual.revision === head.revision ? page : await options.source.read(manual.revision);
      const recordedManual = stored.baseline;
      if (manual.revision > recordedManual) {
        let edited: StoredDocument;
        try { edited = parse(external, true); }
        catch (error) {
          if (!(error instanceof MalformedData)) { stored.document.destroy(); throw error; }
          // A later valid tool revision may already have repaired malformed external data.
          if (manual.revision !== head.revision) return { stored, rewrite: false };
          stored.document.destroy(); return { stored: await validBefore(head), rewrite: true };
        }
        let unchanged = false;
        if (external.parentId) {
          const priorPage = await options.source.read(external.parentId);
          let prior: StoredDocument | undefined, externalDocument: StoredDocument | undefined;
          try {
            prior = parse(priorPage); externalDocument = parse(external);
            unchanged = prior.generation === externalDocument.generation && sameData(prior.document.toJSON(), externalDocument.document.toJSON());
          } catch (error) { if (!(error instanceof MalformedData)) { edited.document.destroy(); stored.document.destroy(); throw error; } }
          finally { prior?.document.destroy(); externalDocument?.document.destroy(); }
        }
        if (!unchanged) { stored.document.destroy(); return { stored: edited, rewrite: true }; }
        edited.document.destroy();
      }
    }
    if (current && recognizedEdit(head) && stored.generation === base.generation && !stored.document.contains({ generation: base.generation, records: base.document.toJSON() })) {
      stored.document.destroy(); throw new IncompatibleData('Published records were changed or removed without a generation reset. Local work has been retained.');
    }
    return { stored, rewrite: false };
  }
  async function refresh(): Promise<boolean> {
    const head = await options.source.head();
    if (closed) return false;
    if (!head) {
      if (current) throw new IncompatibleData('The annotation data page was deleted; local work has been retained.');
      if (pending.some(entry => entry.generation !== base.generation && entry.baseline === 0 && !entry.held)) await adopt({ ...base, document: base.document.clone() }, null);
      initialized = true; return false;
    }
    if (current?.revision === head.revision) return false;
    const inspected = await inspect(head);
    if (closed) { inspected.stored.document.destroy(); return false; }
    if (inspected.rewrite && options.canWrite) {
      try { await options.source.write(encodePage(options.identity, inspected.stored, inspected.stored.document), head); }
      catch (error) { inspected.stored.document.destroy(); throw error; }
      await adopt(inspected.stored, head);
      return true;
    }
    await adopt(inspected.stored, head);
    return false;
  }
  const report = () => {
    if (pending.some(entry => entry.held)) options.status('The data page changed manually. Pending work is retained for review.', true);
    else options.status(pending.length ? 'Changes pending…' : notice ?? 'Up to date');
  };
  async function work() {
    try {
      await persistence;
      for (let attempt = 0; attempt < 4 && !closed; attempt++) {
        try {
          if (await refresh()) { attempt--; continue; }
          if (closed) return;
          if (await acknowledge(base.document)) rebuild();
          if (current && options.canWrite) await options.source.ensureIndexed?.();
          const first = pending.find(entry => !entry.held);
          if (!first || !options.canWrite) { report(); return; }
          const batch: PendingUpdate[] = [];
          for (const entry of pending) {
            if (entry.held) continue;
            if (batch.length && (first.reason !== undefined || entry.reason !== undefined)) break;
            batch.push(entry);
          }
          const outgoing = base.document.clone();
          try {
            for (const entry of batch) {
              if (outgoing.contains(entry.update)) continue;
              if (entry.action.type !== 'add-highlight') {
                const id = entry.action.id, target = outgoing.snapshot().find(item => item.id === id);
                if (!target) throw new Error('The target no longer exists; pending work is retained.');
                assertActionAllowed(target, entry.action, options.actor);
              }
              outgoing.merge(entry.update);
            }
            options.status('Saving…');
            await persistence;
            if (closed) return;
            await options.source.write(encodePage(options.identity, base, outgoing), current, first.reason);
            if (closed) return;
            // Read back before acknowledgement, including after server-side merges.
            await refresh();
            const savedAll = batch.every(entry => base.document.contains(entry.update));
            if (!savedAll) throw new Error('Save acknowledgement did not contain all submitted changes; retained for retry.');
          } finally { outgoing.destroy(); }
          attempt--; // Continue remaining reason-separated batches without changing their provenance.
        } catch (error) { if (!race(error) || attempt === 3) throw error; }
      }
      report();
    } catch (error) { if (!closed) options.status(`Not synchronized: ${error instanceof Error ? error.message : String(error)}`, true); }
  }
  const sync = (): Promise<void> => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (closed) return Promise.resolve();
    if (running !== null) return running;
    running = work().finally(() => { running = null; }); return running;
  };
  return {
    async start() {
      pending = (await options.journal.load()).filter(entry => entry.actor.name === options.actor.name).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
      serial = pending.reduce((max, entry) => Math.max(max, entry.sequence ?? 0), 0);
      const checkpoint = await options.journal.checkpoint?.();
      if (checkpoint) {
        const document = new AnnotationDocument(checkpoint.generation, options.validate, checkpoint.base);
        base.document.destroy(); model.destroy();
        base = { ...checkpoint, document, annotations: document.snapshot() }; current = checkpoint.revision;
        model = new AnnotationDocument(checkpoint.generation, options.validate, checkpoint.local, replica); initialized = true;
      }
      await sync();
      if (!initialized) throw new Error('Could not initialize shared annotations.');
      rebuild(); return model.snapshot();
    },
    get annotations() { return model.snapshot(); },
    get dirty() { return pending.length > 0; },
    get retained() { return pending.filter(entry => entry.held); },
    sync,
    add(action: HighlightAction) {
      const id = action.type === 'add-highlight' ? action.highlight.id : action.id;
      const before = model.snapshot().find(item => item.id === id);
      const reason = moderationReason(action, options.actor, before), operationId = crypto.randomUUID();
      const update = model.dispatch(action, options.actor);
      if (!Object.keys(update.records).length) return;
      const entry: PendingUpdate = { id: operationId, sequence: ++serial, generation: base.generation, baseline: base.baseline, update, action, actor: options.actor, ...(reason ? { reason } : {}) };
      notice = undefined; pending.push(entry); void put(entry).catch(error => options.status(`Local recovery storage failed: ${String(error)}`, true));
      notify(); options.status('Changes pending…');
      // Bounded batching: continuous actions cannot defer publication indefinitely.
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; void sync(); }, 350);
    },
    async resubmit() {
      for (const entry of pending.filter(item => item.held)) {
        entry.update = model.dispatch(entry.action, options.actor); entry.generation = base.generation; entry.baseline = base.baseline; entry.held = false; await put(entry);
      }
      notify(); await sync();
    },
    async discardRetained() { for (const entry of pending.filter(item => item.held)) await forget(entry.id); pending = pending.filter(item => !item.held); rebuild(); report(); },
    destroy() { closed = true; if (timer !== undefined) clearTimeout(timer); base.document.destroy(); model.destroy(); },
  };
}
