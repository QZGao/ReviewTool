import type { UnknownApiParams } from 'types-mediawiki/api_params';
import { createApi, mode } from '../mediawiki';
import { createProjection } from './projection';
import { mountWikipediaAnnotation } from './wikipedia-view';
import type { ReviewIdentity } from './live-storage';
import { wikiSource } from './wiki-source';
import { annotationSync } from './sync';
import { syncJournal } from './sync-journal';
import type { ModerationReasonPrompt, WikipediaHeadingAnchor } from './types';
import styles from './style.css';
import { annotationVisible, threadRoots } from './annotation-state';
import { findComment, isModerator } from './permissions';
import { createCodexReasonPrompt } from './codex-reason-dialog';

export const activationParameter = 'reviewtool_annotation_view';
interface ParsedRevision { parse: { title: string; pageid: number; revid: number; wikitext: string; tocdata?: { sections?: { fromTitle?: string; codepointOffset?: number; hLevel: number; anchor: string }[] } } }
function response<T>(request: mw.Api.AbortablePromise): Promise<T> {
  return new Promise((resolve, reject) => { request.done(value => resolve(value as T)).fail((code: unknown) => reject(new Error(typeof code === 'string' ? code : 'MediaWiki request failed'))); });
}

/** Fixed source revision, shared annotations, private editors, and a Wikipedia publication adapter. */
export async function initLiveAnnotation(): Promise<boolean> {
  if (mw.config.get('wgNamespaceNumber') !== 0 || mw.config.get('wgAction') !== 'view' || !mw.config.get('wgRevisionId')) return false;
  const revision = mw.config.get('wgRevisionId'), title = mw.config.get('wgPageName').replace(/_/g, ' ');
  const url = new URL(location.href); url.searchParams.set(activationParameter, '1'); url.searchParams.set('oldid', String(revision));
  mw.util.addPortletLink('p-cactions', url.href, 'Annotation View', 'ca-reviewtool-annotation-view');
  if (new URL(location.href).searchParams.get(activationParameter) !== '1') return false;
  if (new URL(location.href).searchParams.get('oldid') !== String(revision)) { location.replace(url.href); return true; }
  const api = createApi(), author = mw.config.get('wgUserName') || (mode === 'dry-run' ? 'Example' : 'Anonymous');
  const actor = { name: author, groups: mw.config.get('wgUserGroups') ?? [] }, canWrite = mode === 'dry-run' || Boolean(mw.config.get('wgUserName'));
  const identity: ReviewIdentity = { wiki: mw.config.get('wgDBname'), pageId: mw.config.get('wgArticleId'), revisionId: revision };
  const storageTitle = `Talk:${title}/ReviewTool/${revision}`;
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
  tools.append(label, status, retry, recovery, exit); document.getElementById('mw-content-text')?.before(tools);
  let mount: ReturnType<typeof mountWikipediaAnnotation> | undefined, sync: ReturnType<typeof annotationSync> | undefined;
  const setStatus = (message: string, error = false) => {
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
  try {
    const journalKey = [mode, identity.wiki, identity.pageId, revision, author].join('/');
    const draftSlot = 'reviewtool-draft-session/' + journalKey;
    const draftSession = sessionStorage.getItem(draftSlot) ?? crypto.randomUUID(); sessionStorage.setItem(draftSlot, draftSession);
    const journal = syncJournal(journalKey, draftSession);
    const sourceApi = wikiSource(async (params, write) => {
      if (write && !canWrite) throw new Error('Log in before saving annotations.');
      return response(write ? api.postWithToken('csrf', { ...params, ...(mode === 'normal' ? { assert: 'user', assertuser: author } : {}) }) : api.get(params as UnknownApiParams));
    }, storageTitle);
    const configuredVariant: unknown = mw.config.get('wgUserVariant');
    const [parsed, requestModerationReason, drafts] = await Promise.all([
      response<ParsedRevision>(api.get({ action: 'parse', oldid: revision, prop: 'wikitext|tocdata|revid', formatversion: 2, variant: typeof configuredVariant === 'string' ? configuredVariant : 'zh' })),
      isModerator(actor) ? createCodexReasonPrompt(document) : Promise.resolve<ModerationReasonPrompt | undefined>(undefined), journal.drafts(),
    ]);
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
      changed: annotations => { mount?.view.highlighting?.replace(annotations); },
    });
    const shared = sync, initial = await shared.start();
    mount = mountWikipediaAnnotation(document, createProjection(source, { wikiBaseUrl: new URL('/wiki/', location.href).href }), {
      comments: true, commentAuthor: author, commentUserGroups: actor.groups, headingAnchors: headings, commentDrafts: drafts,
      ...(requestModerationReason ? { requestModerationReason } : {}),
      highlighting: { initial, onChange: (_next, action) => {
        try { if (!canWrite) throw new Error('Log in before saving annotations.'); shared.add(action); } catch (error) { mount?.view.highlighting?.replace(shared.annotations); setStatus(String(error), true); }
      } },
    });
    const controller = new AbortController(), listener = { signal: controller.signal };
    retry.addEventListener('click', () => { void shared.sync(); }, listener);
    resubmit.addEventListener('click', () => { void shared.resubmit().catch(error => setStatus(String(error), true)); }, listener);
    discard.addEventListener('click', () => { void shared.discardRetained().catch(error => setStatus(String(error), true)); }, listener);
    let draftSave: ReturnType<typeof setTimeout> | undefined;
    const saveDrafts = () => journal.drafts(mount?.view.comments?.drafts ?? []).catch(error => setStatus(`Could not retain drafts: ${String(error)}`, true));
    document.addEventListener('input', event => {
      if (!(event.target as Element).closest('.annotation-comments')) return;
      if (draftSave !== undefined) clearTimeout(draftSave);
      draftSave = setTimeout(() => { void saveDrafts(); }, 200);
    }, listener);
    document.addEventListener('click', event => { if ((event.target as Element).closest('.annotation-comments')) queueMicrotask(() => { void saveDrafts(); }); }, listener);
    const refresh = () => { if (!document.hidden) void shared.sync(); };
    const polling = setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh, listener); window.addEventListener('online', refresh, listener);
    window.addEventListener('beforeunload', event => { if (shared.dirty) { event.preventDefault(); event.returnValue = ''; } }, listener);
    window.addEventListener('pagehide', () => {
      void saveDrafts(); if (draftSave !== undefined) clearTimeout(draftSave); clearInterval(polling); controller.abort(); api.abort(); shared.destroy(); mount?.destroy();
    }, { once: true });
    document.documentElement.dataset.reviewtoolAnnotationReady = mode;
    window.dispatchEvent(new CustomEvent('reviewtool-annotation-ready', { detail: { mode, revision, storageTitle } }));
  } catch (error) { sync?.destroy(); mount?.destroy(); setStatus(`Annotation View could not start: ${error instanceof Error ? error.message : String(error)}`, true); }
  return true;
}
