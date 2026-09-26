import type { UnknownApiParams } from 'types-mediawiki/api_params';
import { createApi, mode } from '../mediawiki';
import { createProjection } from './projection';
import { mountWikipediaAnnotation } from './wikipedia-view';
import type { ReviewIdentity } from './live-storage';
import { wikiSource, type WikiSource } from './wiki-source';
import { annotationSync } from './sync';
import { syncJournal } from './sync-journal';
import type { ModerationReasonPrompt, WikipediaHeadingAnchor } from './types';
import styles from './style.css';
import { annotationVisible, threadRoots } from './annotation-state';
import { findComment, isModerator } from './permissions';
import { createCodexReasonPrompt } from './codex-reason-dialog';
import { addMainPageReviewToolButtonsToDOM } from '../dom/article_page';
import state from '../state';
import { buildAnnotationExport, downloadAnnotationExport } from './export';

export const activationParameter = 'reviewtool_annotation_view';
function dataPageTitle(title: string, revision: number): string {
  const talk = mw.Title.newFromText(title)?.getTalkPage()?.getPrefixedText();
  if (!talk) throw new Error('This page has no associated talk page for annotations.');
  return `${talk}/ReviewTool/${revision}`;
}
interface ParsedRevision { parse: { title: string; pageid: number; revid: number; wikitext: string; tocdata?: { sections?: { fromTitle?: string; codepointOffset?: number; hLevel: number; anchor: string }[] } } }
function response<T>(request: mw.Api.AbortablePromise): Promise<T> {
  return new Promise((resolve, reject) => { request.done(value => resolve(value as T)).fail((code: unknown) => reject(new Error(typeof code === 'string' ? code : 'MediaWiki request failed'))); });
}

/** One revision-bound view, entered through the existing article tab and action menu. */
export async function initLiveAnnotation(): Promise<boolean> {
  const namespace = mw.config.get('wgNamespaceNumber');
  if ((namespace !== 0 && mw.config.get('wgPageName') !== 'User:SuperGrey/gadgets/ReviewTool/TestPage') || mw.config.get('wgAction') !== 'view' || !mw.config.get('wgRevisionId')) return false;
  if (document.getElementById('ca-annotate')) return true;
  let session: ReturnType<typeof startLiveAnnotation> | undefined, closing = false;
  const revision = mw.config.get('wgRevisionId');
  const api = createApi(), author = mw.config.get('wgUserName') || (mode === 'dry-run' ? 'Example' : 'Anonymous');
  const canWrite = mode === 'dry-run' || Boolean(mw.config.get('wgUserName'));
  const storageTitle = dataPageTitle(mw.config.get('wgPageName'), revision);
  const sourceApi = wikiSource(async (params, write) => {
    if (write && !canWrite) throw new Error('Log in before saving annotations.');
    return response(write ? api.postWithToken('csrf', { ...params, ...(mode === 'normal' ? { assert: 'user', assertuser: author } : {}) }) : api.get(params as UnknownApiParams));
  }, storageTitle);
  const updateUrl = (active: boolean) => {
    const url = new URL(location.href);
    if (active) url.searchParams.set(activationParameter, '1'); else url.searchParams.delete(activationParameter);
    history.replaceState(history.state, '', url.href);
  };
  const toggle = async () => {
    if (closing) return;
    if (session) {
      closing = true;
      const previous = session; session = undefined;
      updateUrl(false); navigation.update(false, true);
      try { await previous.close(); } finally { closing = false; navigation.update(false); }
      return;
    }
    const url = new URL(location.href);
    if (url.searchParams.get('oldid') !== String(revision)) {
      url.searchParams.set('oldid', String(revision)); url.searchParams.set(activationParameter, '1');
      location.assign(url.href); return;
    }
    updateUrl(true); navigation.update(true, true);
    const opened = startLiveAnnotation(() => { void toggle(); }, api, sourceApi); session = opened;
    await opened.ready;
    if (session === opened) navigation.update(true);
  };
  const navigation = addMainPageReviewToolButtonsToDOM(() => { void toggle(); }); navigation.update(false);
  if (new URL(location.href).searchParams.get(activationParameter) === '1') await toggle();
  return true;
}

/** Own all requests, listeners, drafts and mounted DOM for one opening of Annotation View. */
function startLiveAnnotation(onClose: () => void, api: mw.Api, sourceApi: WikiSource) {
  const revision = mw.config.get('wgRevisionId'), title = mw.config.get('wgPageName').replace(/_/g, ' ');
  const author = mw.config.get('wgUserName') || (mode === 'dry-run' ? 'Example' : 'Anonymous');
  const actor = { name: author, groups: mw.config.get('wgUserGroups') ?? [] }, canWrite = mode === 'dry-run' || Boolean(mw.config.get('wgUserName'));
  const identity: ReviewIdentity = { wiki: mw.config.get('wgDBname'), pageId: mw.config.get('wgArticleId'), revisionId: revision };
  const storageTitle = dataPageTitle(title, revision);
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const tools = document.createElement('section'); tools.className = 'reviewtool-live-controls';
  tools.style.cssText = 'margin:1em 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:var(--color-base);font:14px/1.5 system-ui';
  const label = document.createElement('strong'); label.textContent = mode === 'dry-run' ? 'Annotation View · Dry run (local writes)' : 'Annotation View';
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.textContent = 'Loading revision and annotations…';
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry save'; retry.hidden = true;
  const recovery = document.createElement('details'); recovery.hidden = true;
  const summary = document.createElement('summary'); summary.textContent = 'Retained local changes';
  const retained = document.createElement('pre'); retained.style.cssText = 'white-space:pre-wrap;max-height:240px;overflow:auto';
  const resubmit = document.createElement('button'); resubmit.textContent = 'Resubmit against current data'; resubmit.type = 'button';
  const discard = document.createElement('button'); discard.textContent = 'Discard retained submissions'; discard.type = 'button';
  recovery.append(summary, retained, resubmit, discard);
  const exit = document.createElement('a'), originalUrl = new URL(location.href); originalUrl.searchParams.delete(activationParameter); exit.href = originalUrl.href; exit.textContent = 'Original article';
  const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.disabled = true;
  exportButton.textContent = state.convByVar({ hant: '匯出所有批註', hans: '导出所有批注' });
  exportButton.title = state.convByVar({ hant: '匯出所有已提交的留言及回覆，包括已解決的討論；不含草稿', hans: '导出所有已提交的留言及回复，包括已解决的讨论；不含草稿' });
  tools.append(label, status, exportButton, retry, recovery, exit); document.getElementById('mw-content-text')?.before(tools);
  let mount: ReturnType<typeof mountWikipediaAnnotation> | undefined, sync: ReturnType<typeof annotationSync> | undefined;
  let closed = false, draftSave: ReturnType<typeof setTimeout> | undefined, polling: ReturnType<typeof setInterval> | undefined;
  let saveDrafts = async () => {};
  const controller = new AbortController(), listener = { signal: controller.signal };
  exit.addEventListener('click', event => { event.preventDefault(); onClose(); }, listener);
  const setStatus = (message: string, error = false) => {
    if (closed) return;
    status.textContent = message === 'Up to date' ? (!canWrite ? 'Read-only · Log in to add annotations' : mode === 'dry-run' ? 'Saved locally (dry run)' : 'Saved to Wikipedia') : message;
    retry.hidden = !error; status.style.color = error ? 'var(--color-destructive, #b32424)' : '';
    const hiddenDrafts = (mount?.view.comments?.drafts ?? []).filter(draft => {
      const annotation = sync?.annotations.find(item => item.id === draft.annotationId);
      return !annotation || !annotationVisible(annotation) || (draft.kind !== 'new' && !threadRoots(annotation).some(root => !root.resolved && findComment(root, draft.commentId)));
    });
    recovery.hidden = !sync?.retained.length && !hiddenDrafts.length;
    retained.textContent = [...(sync?.retained.map(entry => entry.action) ?? []), ...hiddenDrafts].map(value => JSON.stringify(value, null, 2)).join('\n\n');
    resubmit.disabled = discard.disabled = !sync?.retained.length;
  };
  const ready = (async () => {
    try {
      const journalKey = [mode, identity.wiki, identity.pageId, revision, author].join('/');
      const draftSlot = 'reviewtool-draft-session/' + journalKey;
      const draftSession = sessionStorage.getItem(draftSlot) ?? crypto.randomUUID(); sessionStorage.setItem(draftSlot, draftSession);
      const journal = syncJournal(journalKey, draftSession);
      const configuredVariant: unknown = mw.config.get('wgUserVariant');
      const [parsed, requestModerationReason, drafts] = await Promise.all([
        response<ParsedRevision>(api.get({ action: 'parse', oldid: revision, prop: 'wikitext|tocdata|revid', formatversion: 2, variant: typeof configuredVariant === 'string' ? configuredVariant : 'zh' })),
        isModerator(actor) ? createCodexReasonPrompt(document) : Promise.resolve<ModerationReasonPrompt | undefined>(undefined), journal.drafts(),
      ]);
      if (closed) return;
      if (parsed.parse.revid !== revision || parsed.parse.pageid !== identity.pageId || typeof parsed.parse.wikitext !== 'string') throw new Error('Source revision does not match the displayed article.');
      const source = parsed.parse.wikitext, bytes = [0], encoder = new TextEncoder();
      for (const char of source) bytes.push(bytes[bytes.length - 1] + encoder.encode(char).length);
      const headings: WikipediaHeadingAnchor[] = [];
      for (const section of parsed.parse.tocdata?.sections ?? []) {
        if (section.fromTitle?.replace(/_/g, ' ') !== parsed.parse.title.replace(/_/g, ' ') || section.codepointOffset === undefined || section.codepointOffset < 0) continue;
        const start = bytes[section.codepointOffset]; if (start === undefined) throw new Error('Heading offset is outside this source revision.');
        headings.push({ unit: 'utf8-byte', start, level: section.hLevel, id: section.anchor });
      }
      const byteLength = bytes[bytes.length - 1], boundaries = new Set(bytes);
      sync = annotationSync({ identity, actor, source: sourceApi, journal, canWrite, status: setStatus,
        validate: anchor => Boolean(anchor && anchor.unit === 'utf8-byte' && anchor.start < anchor.end && anchor.end <= byteLength && boundaries.has(anchor.start) && boundaries.has(anchor.end)),
        changed: annotations => { if (!closed) mount?.view.highlighting?.replace(annotations); },
      });
      const shared = sync, initial = await shared.start();
      if (closed) return;
      const projection = createProjection(source, { wikiBaseUrl: new URL('/wiki/', location.href).href });
      mount = mountWikipediaAnnotation(document, projection, {
        comments: true, commentAuthor: author, commentUserGroups: actor.groups, headingAnchors: headings, commentDrafts: drafts,
        ...(requestModerationReason ? { requestModerationReason } : {}),
        highlighting: { initial, onChange: (_next, action) => {
          try { if (!canWrite) throw new Error('Log in before saving annotations.'); shared.add(action); } catch (error) { mount?.view.highlighting?.replace(shared.annotations); setStatus(String(error), true); }
        } },
      });
      exportButton.disabled = false;
      exportButton.addEventListener('click', () => {
        try { downloadAnnotationExport(document, buildAnnotationExport(identity, title, projection, shared.annotations)); }
        catch (error) { setStatus(`Could not export annotations: ${String(error)}`, true); }
      }, listener);
      retry.addEventListener('click', () => { void shared.sync(); }, listener);
      resubmit.addEventListener('click', () => { void shared.resubmit().catch(error => setStatus(String(error), true)); }, listener);
      discard.addEventListener('click', () => { void shared.discardRetained().catch(error => setStatus(String(error), true)); }, listener);
      saveDrafts = () => journal.drafts(mount?.view.comments?.drafts ?? []).then(() => {}).catch(error => setStatus(`Could not retain drafts: ${String(error)}`, true));
      document.addEventListener('input', event => {
        if (!(event.target as Element).closest('.annotation-comments')) return;
        if (draftSave !== undefined) clearTimeout(draftSave);
        draftSave = setTimeout(() => { void saveDrafts(); }, 200);
      }, listener);
      document.addEventListener('click', event => { if ((event.target as Element).closest('.annotation-comments')) queueMicrotask(() => { if (!closed) void saveDrafts(); }); }, listener);
      const refresh = () => { if (!document.hidden) void shared.sync(); };
      polling = setInterval(refresh, 5000);
      document.addEventListener('visibilitychange', refresh, listener); window.addEventListener('online', refresh, listener);
      window.addEventListener('beforeunload', event => { if (shared.dirty) { event.preventDefault(); event.returnValue = ''; } }, listener);
      document.documentElement.dataset.reviewtoolAnnotationReady = mode;
      window.dispatchEvent(new CustomEvent('reviewtool-annotation-ready', { detail: { mode, revision, storageTitle } }));
    } catch (error) { if (closed) return; sync?.destroy(); mount?.destroy(); setStatus(`Annotation View could not start: ${error instanceof Error ? error.message : String(error)}`, true); }
  })();
  let cleanup: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (cleanup !== undefined) return cleanup;
    closed = true;
    const draftsSaved = saveDrafts();
    if (draftSave !== undefined) clearTimeout(draftSave);
    if (polling !== undefined) clearInterval(polling);
    controller.abort();
    mount?.destroy(); tools.remove(); style.remove();
    delete document.documentElement.dataset.reviewtoolAnnotationReady;
    // An unfinished startup has no submitted actions to flush; abort its reads immediately.
    if (!mount) api.abort();
    cleanup = (async () => {
      await ready;
      await draftsSaved;
      // Closing the view keeps the existing outbox if publication fails.
      if (sync?.dirty) await sync.sync();
      api.abort(); sync?.destroy();
    })();
    return cleanup;
  };
  window.addEventListener('pagehide', () => { void close(); }, { once: true, ...listener });
  return { ready, close };
}
