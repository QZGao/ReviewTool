import { createApi, mode } from '../mediawiki';
import { createProjection } from './projection';
import { mountWikipediaAnnotation } from './wikipedia-view';
import { decodeData, saveQueue, type DataPage, type ReviewIdentity } from './live-storage';
import type { HighlightAnnotation, ModerationReasonPrompt, WikipediaHeadingAnchor } from './types';
import styles from './style.css';
import { isModerator } from './permissions';
import { createCodexReasonPrompt } from './codex-reason-dialog';

export const activationParameter = 'reviewtool_annotation_view';
interface ParsedRevision { parse: { title: string; pageid: number; revid: number; wikitext: string; tocdata?: { sections?: { fromTitle?: string; codepointOffset?: number; hLevel: number; anchor: string }[] } } }
interface PageResponse { curtimestamp: string; query: { pages: { missing?: boolean; revisions?: { revid: number; timestamp: string; slots: { main: { content: string } } }[] }[] } }
function response<T>(request: mw.Api.AbortablePromise): Promise<T> {
  return new Promise((resolve, reject) => { request.done(value => resolve(value as T)).fail((code: unknown) => reject(new Error(typeof code === 'string' ? code : 'MediaWiki request failed'))); });
}

/** Add live entry/navigation without activating the legacy annotation DOM rewriter. */
export async function initLiveAnnotation(): Promise<boolean> {
  if (mw.config.get('wgNamespaceNumber') !== 0 || mw.config.get('wgAction') !== 'view' || !mw.config.get('wgRevisionId')) return false;
  const revision = mw.config.get('wgRevisionId'), title = mw.config.get('wgPageName').replace(/_/g, ' ');
  const url = new URL(location.href); url.searchParams.set(activationParameter, '1'); url.searchParams.set('oldid', String(revision));
  mw.util.addPortletLink('p-cactions', url.href, 'Annotation View', 'ca-reviewtool-annotation-view');
  if (new URL(location.href).searchParams.get(activationParameter) !== '1') return false;
  if (new URL(location.href).searchParams.get('oldid') !== String(revision)) { location.replace(url.href); return true; }

  const api = createApi(), author = mw.config.get('wgUserName') || (mode === 'dry-run' ? 'Example' : 'Anonymous');
  const groups = mw.config.get('wgUserGroups') ?? [];
  const actor = { name: author, groups };
  const identity: ReviewIdentity = { wiki: mw.config.get('wgDBname'), pageId: mw.config.get('wgArticleId'), revisionId: revision };
  const storageTitle = `Talk:${title}/ReviewTool/${revision}`;
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const tools = document.createElement('section'); tools.className = 'reviewtool-live-controls';
  tools.style.cssText = 'margin:1em 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:var(--color-base);font:14px/1.5 system-ui';
  const label = document.createElement('strong'); label.textContent = mode === 'dry-run' ? 'Annotation View · Dry run (local writes)' : 'Annotation View';
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.textContent = 'Loading revision and annotations…';
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry save'; retry.hidden = true;
  const exit = document.createElement('a'); const originalUrl = new URL(location.href); originalUrl.searchParams.delete(activationParameter);
  exit.href = originalUrl.href; exit.textContent = 'Original article';
  tools.append(label, status, retry, exit); document.getElementById('mw-content-text')?.before(tools);
  const setStatus = (message: string, error = false) => { status.textContent = message; retry.hidden = !error; status.style.color = error ? 'var(--color-destructive, #b32424)' : ''; };
  const read = async (): Promise<DataPage | null> => {
    const data = await response<PageResponse>(api.get({ action: 'query', titles: storageTitle, prop: 'revisions', rvprop: 'ids|timestamp|content', rvslots: 'main', curtimestamp: true, formatversion: 2 }));
    const page = data.query.pages[0]; if (page?.missing) return null;
    const rev = page?.revisions?.[0]; if (!rev || typeof rev.slots.main.content !== 'string') throw new Error('Could not read the annotation data page.');
    return { text: rev.slots.main.content, revision: rev.revid, timestamp: rev.timestamp, readAt: data.curtimestamp };
  };
  try {
    const configuredVariant: unknown = mw.config.get('wgUserVariant');
    const variant = typeof configuredVariant === 'string' ? configuredVariant : 'zh';
    const reasonPrompt: Promise<ModerationReasonPrompt | undefined> = isModerator(actor) ? createCodexReasonPrompt(document) : Promise.resolve<ModerationReasonPrompt | undefined>(undefined);
    const [parsed, stored, requestModerationReason] = await Promise.all([
      response<ParsedRevision>(api.get({ action: 'parse', oldid: revision, prop: 'wikitext|tocdata|revid', formatversion: 2, variant })), read(),
      reasonPrompt,
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
    let previous: readonly HighlightAnnotation[] = stored ? decodeData(stored.text, identity) : [];
    const mount = mountWikipediaAnnotation(document, createProjection(source, { wikiBaseUrl: new URL('/wiki/', location.href).href }), {
      comments: true, commentAuthor: author, commentUserGroups: groups, headingAnchors: headings,
      ...(requestModerationReason ? { requestModerationReason } : {}),
      highlighting: { initial: previous, onChange: (next, action) => { const before = previous; previous = next; queue.add(action, before); } },
    });
    // Keep the queue's baseline identical to the validated, normalized UI snapshot.
    previous = mount.view.highlighting?.annotations ?? previous;
    const queue = saveQueue({ identity, actor, read, validate: anchor => Boolean(mount.view.restoreRange(anchor)), status: setStatus,
      write: async (text, base, summary) => {
        if (mode === 'normal' && !mw.config.get('wgUserName')) throw new Error('Log in before saving annotations.');
        const result = await response<{ edit?: { result?: string } }>(api.postWithToken('csrf', { action: 'edit', title: storageTitle, text, summary, contentmodel: 'wikitext', formatversion: 2,
          ...(base ? { baserevid: base.revision, basetimestamp: base.timestamp, starttimestamp: base.readAt, nocreate: true } : { createonly: true }),
          ...(mode === 'normal' ? { assert: 'user', assertuser: author } : {}),
        }));
        if (result.edit?.result !== 'Success') throw new Error('MediaWiki did not accept the edit. Check for a CAPTCHA or editing restriction.');
      },
      saved: annotations => { previous = annotations; mount.view.highlighting?.replace(annotations); setStatus(mode === 'dry-run' ? 'Saved locally (dry run)' : 'Saved to Wikipedia'); },
    });
    retry.addEventListener('click', () => { void queue.flush(); });
    setStatus(`${title} · revision ${revision} · ${previous.length} annotations${mode === 'normal' && !mw.config.get('wgUserName') ? ' · Log in to save changes' : ''}`);
    const warn = (event: BeforeUnloadEvent) => { if (queue.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', () => { queue.destroy(); mount.destroy(); window.removeEventListener('beforeunload', warn); }, { once: true });
    window.dispatchEvent(new CustomEvent('reviewtool-annotation-ready', { detail: { mode, revision, storageTitle } }));
    document.documentElement.dataset.reviewtoolAnnotationReady = mode;
  } catch (error) { setStatus(`Annotation View could not start: ${error instanceof Error ? error.message : String(error)}`); }
  return true;
}
