export const activationParameter = 'reviewtool_annotation_view';
export const commentParameter = 'reviewtool_annotation_comment_id';
export function annotationCommentUrl(href: string, id: string, revision?: number): URL {
  const url = new URL(href); url.hash = '';
  url.searchParams.set(activationParameter, '1'); url.searchParams.set(commentParameter, id);
  if (revision !== undefined) url.searchParams.set('oldid', String(revision));
  return url;
}

/** Pin the source revision and select a supported skin without losing other navigation state. */
export function annotationViewUrl(href: string, revision: number, skin: string): URL {
  const url = new URL(href);
  url.searchParams.set('oldid', String(revision));
  url.searchParams.set(activationParameter, '1');
  if (skin !== 'vector-2022' && skin !== 'minerva') url.searchParams.set('useskin', 'vector-2022');
  return url;
}
