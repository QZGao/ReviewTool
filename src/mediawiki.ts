/** Production MediaWiki boundary. The development dry-run build replaces this module. */
export const mode: string = 'normal';
export function createApi(options?: mw.Api.Options): mw.Api { return new mw.Api(options); }
