import type { UnknownApiParams } from 'types-mediawiki/api_params';
import { createApi, mode } from '../mediawiki';
import state from '../state';
import { annotationVisits } from './visits';
import { annotationViewUrl } from './view-url';
import { checkSubscriptions } from './subscription-check';
import type { ActivityGroup, AnnotationActivity } from './activity';

export const browserVisits = () => annotationVisits(localStorage, `${mode}/${mw.config.get('wgDBname')}`);
export const annotationDestination = (oldid: number) => annotationViewUrl(new URL('/w/index.php', location.href).href, oldid, mw.config.get('skin'));

/** Native links retain keyboard/modifier navigation; ordinary clicks may navigate within the mounted view. */
export function notifyAnnotationLink(title: string, text: string, href: string, navigate?: () => void | Promise<unknown>, tag?: string) {
  const link = document.createElement('a');
  link.href = href; link.textContent = text; link.style.display = 'block';
  let closed = false, notification: { close(): void } | undefined;
  const close = () => { closed = true; notification?.close(); };
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    close();
    if (navigate) { event.preventDefault(); void Promise.resolve().then(navigate).catch(error => console.error('[ReviewTool] Notification navigation failed', error)); }
  });
  void mw.notify(link, { title, autoHide: false, ...(tag ? { tag } : {}) }).then(result => { notification = result; if (closed) result.close(); });
  return { close };
}

const excerpt = (text: string) => { const clean = text.replace(/\s+/g, ' ').trim(); return clean.length > 90 ? clean.slice(0, 90) + '…' : clean; };
export function activityDescription(action: AnnotationActivity): string {
  const record = action.record, c = (hant: string, hans: string) => state.convByVar({ hant, hans });
  switch (record.kind) {
    case 'highlight': return c('新增了高亮', '添加了高亮');
    case 'comment': return (record.parent ? c('回覆了評論：', '回复了评论：') : c('新增了評論：', '添加了评论：')) + excerpt(record.body.text);
    case 'body': return c('修改了評論：', '修改了评论：') + excerpt(record.text);
    case 'appearance': return c('更改了高亮顏色', '更改了高亮颜色');
    case 'resolve': return c('結束了討論', '结束了讨论');
    case 'delete': return c('刪除了高亮及其討論', '删除了高亮及其讨论');
    case 'resolution': return record.resolved ? c('將討論標記為已解決', '将讨论标记为已解决') : c('將討論標記為尚未解決', '将讨论标记为尚未解决');
  }
}
export function activityNotice(group: ActivityGroup) {
  const names = [...new Set(group.actions.map(action => action.author))];
  const title = names.length < 2 ? names[0] : names.slice(0, -1).join('、') + '和' + names[names.length - 1];
  const text = group.actions.length === 1 ? activityDescription(group.actions[0])
    : state.convByVar({ hant: `這則評論及其回覆有 ${group.actions.length} 項新動態。`, hans: `这条评论及其回复有 ${group.actions.length} 项新动态。` }) + activityDescription(group.target);
  return { title, text };
}

export function dataPageRevision(): number | null {
  if (mw.config.get('wgNamespaceNumber') !== 4) return null;
  const match = /^ReviewTool\/data\/([1-9]\d*)\.json$/.exec(mw.config.get('wgTitle'));
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Called once on ordinary pages, including namespaces where the rest of ReviewTool exits early. */
export async function pageAnnotationNotifications() {
  const oldid = dataPageRevision();
  if (oldid) notifyAnnotationLink('ReviewTool', state.convByVar({ hant: '快速跳轉至批註頁', hans: '快速跳转至批注页' }), annotationDestination(oldid).href, undefined, 'reviewtool-data-page');
  const subscriptions = browserVisits().subscriptions();
  if (!subscriptions.length) return;
  const api = createApi();
  const request = (params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    api.get(params as UnknownApiParams).done(resolve).fail((error: unknown) => reject(new Error(typeof error === 'string' ? error : 'MediaWiki request failed')));
  });
  await checkSubscriptions(request, subscriptions, (visit, count) => {
    // Another tab may have opened the view or unsubscribed while these requests were running.
    const current = browserVisits().get(visit.oldid);
    if (!current?.subscribed || current.viewedRevision !== visit.viewedRevision) return;
    notifyAnnotationLink(state.convByVar({ hant: `${visit.pageName}的${visit.oldid}批註頁`, hans: `${visit.pageName}的${visit.oldid}批注页` }),
      state.convByVar({ hant: `自上次查看後已有 ${count} 次更新，點此查看。`, hans: `自上次查看后已有 ${count} 次更新，点此查看。` }),
      annotationDestination(visit.oldid).href, undefined, `reviewtool-subscription-${visit.oldid}`);
  }, error => console.warn('[ReviewTool] Could not check annotation subscriptions', error));
}
