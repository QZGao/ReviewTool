export const activationParameter = 'reviewtool_annotation_view';

/** Pin the source revision and select a supported skin without losing other navigation state. */
export function annotationViewUrl(href: string, revision: number, skin: string): URL {
  const url = new URL(href);
  url.searchParams.set('oldid', String(revision));
  url.searchParams.set(activationParameter, '1');
  if (skin !== 'vector-2022' && skin !== 'minerva') url.searchParams.set('useskin', 'vector-2022');
  return url;
}
