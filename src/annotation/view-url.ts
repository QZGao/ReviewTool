export const activationParameter = 'reviewtool_annotation_view';
export const commentParameter = 'reviewtool_annotation_comment_id';
export function annotationCommentUrl(href: string, id: string, revision?: number): URL {
  const url = new URL(href); url.hash = '';
  url.searchParams.set(activationParameter, '1'); url.searchParams.set(commentParameter, encodeId(id));
  if (revision !== undefined) url.searchParams.set('oldid', String(revision));
  return url;
}

/** An oldid identifies the article revision across index.php, /wiki/, and Chinese variant URLs. */
export function samePageCommentId(href: string, currentHref: string): string | null {
  let target: URL, current: URL;
  try { current = new URL(currentHref); target = new URL(href, current); } catch { return null; }
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== current.origin || target.username || target.password) return null;
  if (target.searchParams.getAll(commentParameter).length !== 1 || target.searchParams.getAll('oldid').length > 1) return null;
  const id = target.searchParams.get(commentParameter);
  if (!id || (target.searchParams.has('action') && target.searchParams.get('action') !== 'view') || target.searchParams.has('diff')) return null;
  const revision = current.searchParams.get('oldid'), destination = target.searchParams.get('oldid');
  if (revision !== null) {
    if (!/^[1-9]\d*$/.test(revision) || destination !== revision) return null;
    const articlePath = target.pathname === current.pathname || target.pathname === '/w/index.php' || /^\/(?:wiki|zh(?:-(?:hans|hant|cn|tw|hk|mo|sg|my))?)\//.test(target.pathname);
    if (!articlePath) return null;
  } else if (destination !== null || target.pathname !== current.pathname || target.searchParams.get('title') !== current.searchParams.get('title')) return null;
  return commentIdFromUrl(id);
}

/** Pin the source revision and select a supported skin without losing other navigation state. */
export function annotationViewUrl(href: string, revision: number, skin: string): URL {
  const url = new URL(href);
  url.searchParams.set('oldid', String(revision));
  url.searchParams.set(activationParameter, '1');
  if (skin !== 'vector-2022' && skin !== 'minerva') url.searchParams.set('useskin', 'vector-2022');
  return url;
}
import { commentIdFromUrl, encodeId } from './uuid';
