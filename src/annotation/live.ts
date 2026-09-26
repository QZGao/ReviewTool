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
import { annotationMessages } from './i18n';

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
    const opened = startLiveAnnotation(api, sourceApi); session = opened;
    await opened.ready;
    if (session === opened) navigation.update(true);
  };
  const navigation = addMainPageReviewToolButtonsToDOM(() => { void toggle(); }); navigation.update(false);
  if (new URL(location.href).searchParams.get(activationParameter) === '1') await toggle();
  return true;
}

/** Own all requests, listeners, drafts and mounted DOM for one opening of Annotation View. */
function startLiveAnnotation(api: mw.Api, sourceApi: WikiSource) {
  const revision = mw.config.get('wgRevisionId'), title = mw.config.get('wgPageName').replace(/_/g, ' ');
  const author = mw.config.get('wgUserName') || (mode === 'dry-run' ? 'Example' : 'Anonymous');
  const actor = { name: author, groups: mw.config.get('wgUserGroups') ?? [] }, canWrite = mode === 'dry-run' || Boolean(mw.config.get('wgUserName'));
  const identity: ReviewIdentity = { wiki: mw.config.get('wgDBname'), pageId: mw.config.get('wgArticleId'), revisionId: revision };
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const messages = annotationMessages(text => state.convByVar(text));
  let exportItem: HTMLElement | null = null;
  let mount: ReturnType<typeof mountWikipediaAnnotation> | undefined, sync: ReturnType<typeof annotationSync> | undefined;
  let closed = false, draftSave: ReturnType<typeof setTimeout> | undefined, polling: ReturnType<typeof setInterval> | undefined;
  let saveDrafts = async () => {};
  const controller = new AbortController(), listener = { signal: controller.signal };
  let notice: { close(): void } | undefined, lastNotice = '';
  const notify = (message: string | HTMLElement, type: 'warn' | 'error' = 'error') => {
    void mw.notify(message, { tag: 'reviewtool-annotations', type, autoHide: false }).then(result => {
      if (closed) result.close(); else notice = result;
    });
  };
  const failure = (label: { hant: string; hans: string }, error: unknown) => {
    if (closed) return;
    console.error('[ReviewTool]', error);
    notify(state.convByVar(label));
  };
  const setStatus = (message: string, error = false) => {
    if (closed) return;
    const hiddenDrafts = (mount?.view.comments?.drafts ?? []).filter(draft => {
      const annotation = sync?.annotations.find(item => item.id === draft.annotationId);
      return draft.text.trim() && (!annotation || !annotationVisible(annotation) || (draft.kind !== 'new' && !threadRoots(annotation).some(root => !root.resolved && findComment(root, draft.commentId))));
    });
    const retained = sync?.retained ?? [];
    const lateReply = message === 'Reply saved in a discussion that has been resolved or removed.';
    if (!error && !retained.length && !hiddenDrafts.length && !lateReply) {
      if (message === 'Up to date') { notice?.close(); notice = undefined; lastNotice = ''; }
      return;
    }
    const signature = JSON.stringify([message, retained.map(entry => entry.id), hiddenDrafts]);
    if (signature === lastNotice) return;
    lastNotice = signature;
    if (error) console.warn('[ReviewTool]', message);
    const content = document.createElement('div');
    const text = document.createElement('p');
    text.textContent = state.convByVar(retained.length
      ? { hant: '批註資料頁已被手動修改。您的修改尚未同步，請檢查後重新儲存，或放棄修改。', hans: '批注数据页已被手动修改。您的修改尚未同步，请检查后重新保存，或放弃修改。' }
      : lateReply ? { hant: '回覆已儲存，但原討論已結束或刪除，不會再顯示。', hans: '回复已保存，但原讨论已结束或删除，不会再显示。' }
      : hiddenDrafts.length ? { hant: '原討論已不再顯示。以下是尚未送出的草稿：', hans: '原讨论已不再显示。以下是尚未发送的草稿：' }
      : { hant: '批註暫時無法同步，請稍後再試。', hans: '批注暂时无法同步，请稍后再试。' });
    content.append(text);
    for (const entry of retained) {
      const item = document.createElement('p'), action = entry.action;
      item.textContent = action.type === 'edit-comment' ? action.text : action.type === 'add-comment' ? action.comment.text
        : state.convByVar(action.type === 'resolve-comment' ? { hant: '結束討論', hans: '结束讨论' }
          : action.type === 'delete-highlight' ? { hant: '刪除高亮', hans: '删除高亮' }
          : action.type === 'recolor-highlight' ? { hant: '更改高亮顏色', hans: '更改高亮颜色' } : { hant: '新增高亮', hans: '添加高亮' });
      content.append(item);
    }
    for (const draft of hiddenDrafts) { const text = document.createElement('pre'); text.textContent = draft.text; text.style.whiteSpace = 'pre-wrap'; content.append(text); }
    const action = (label: { hant: string; hans: string }, run: () => Promise<unknown> | undefined) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = state.convByVar(label);
      button.addEventListener('click', () => { button.disabled = true; void run()?.catch(error => failure({ hant: '操作未完成，請稍後重試。', hans: '操作未完成，请稍后重试。' }, error)).finally(() => { button.disabled = false; }); }, listener);
      content.append(button);
    };
    if (retained.length) {
      action({ hant: '重新儲存', hans: '重新保存' }, () => sync?.resubmit());
      action({ hant: '放棄修改', hans: '放弃修改' }, () => sync?.discardRetained());
    } else if (error) action({ hant: '重試', hans: '重试' }, () => sync?.sync());
    notify(content, error ? 'error' : 'warn');
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
        isModerator(actor) ? createCodexReasonPrompt(document, messages) : Promise.resolve<ModerationReasonPrompt | undefined>(undefined), journal.drafts(),
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
        comments: true, messages, commentAuthor: author, commentUserGroups: actor.groups, headingAnchors: headings, commentDrafts: drafts,
        ...(requestModerationReason ? { requestModerationReason } : {}),
        highlighting: { initial, onChange: (_next, action) => {
          try { if (!canWrite) throw new Error('Log in before saving annotations.'); shared.add(action); } catch (error) { mount?.view.highlighting?.replace(shared.annotations); failure({ hant: '修改未能儲存，請再試一次。', hans: '修改未能保存，请再试一次。' }, error); }
        } },
      });
      exportItem = mw.util.addPortletLink('p-cactions', '#', state.convByVar({ hant: '匯出所有批註', hans: '导出所有批注' }), 'ca-reviewtool-export',
        state.convByVar({ hant: '匯出高亮、評論與回覆', hans: '导出高亮、评论和回复' }));
      exportItem?.querySelector('a')?.addEventListener('click', event => {
        event.preventDefault();
        try { downloadAnnotationExport(document, buildAnnotationExport(identity, title, projection, shared.annotations)); }
        catch (error) { failure({ hant: '無法匯出批註，請稍後重試。', hans: '无法导出批注，请稍后重试。' }, error); }
      }, listener);
      saveDrafts = () => journal.drafts(mount?.view.comments?.drafts ?? []).then(() => {}).catch(error => failure({ hant: '無法儲存草稿，請先複製文字，以免遺失。', hans: '无法保存草稿，请先复制文字，以免丢失。' }, error));
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
      if (!canWrite) notify(state.convByVar({ hant: '登入後即可新增批註。', hans: '登录后即可添加批注。' }), 'warn');
    } catch (error) { if (closed) return; sync?.destroy(); mount?.destroy(); failure({ hant: '無法開啟批註模式，請稍後重試。', hans: '无法开启批注模式，请稍后重试。' }, error); }
  })();
  let cleanup: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (cleanup !== undefined) return cleanup;
    closed = true;
    const draftsSaved = saveDrafts();
    if (draftSave !== undefined) clearTimeout(draftSave);
    if (polling !== undefined) clearInterval(polling);
    controller.abort();
    mount?.destroy(); exportItem?.remove(); notice?.close(); style.remove();
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
