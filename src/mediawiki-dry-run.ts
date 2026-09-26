import type { UnknownApiParams } from 'types-mediawiki/api_params';
import type { ApiResponse } from 'types-mediawiki/mw/Api';
import { LocalApiError, LocalWiki, type LocalPage } from './mediawiki-local';

export const mode: string = 'dry-run';
let local: LocalWiki | undefined;
const readActions = new Set(['query', 'parse', 'compare', 'paraminfo', 'help', 'expandtemplates', 'opensearch']);
const titleKey = (title: string) => mw.Title.newFromText(title)?.getPrefixedText() ?? title.replace(/_/g, ' ').trim();
const scalar = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new LocalApiError('badparameter', 'Expected a scalar API parameter.');
};
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(scalar) : scalar(value).split('|').filter(Boolean);

/** Same mw.Api methods and jQuery promise contract; no write falls through to the network. */
export function createApi(options?: mw.Api.Options): mw.Api {
  local ??= new LocalWiki();
  const storage = local;
  class DryRunApi extends mw.Api {
    private pending = new Set<() => void>();
    override abort() { for (const abort of this.pending) abort(); super.abort(); }
    override ajax(parameters: UnknownApiParams, ajaxOptions?: JQuery.AjaxSettings): mw.Api.AbortablePromise {
      const params: UnknownApiParams = { action: 'query', ...options?.parameters, ...parameters };
      const deferred = $.Deferred(), action = typeof params.action === 'string' ? params.action : 'unknown';
      let aborted = false;
      const abort = () => { aborted = true; deferred.reject('http', { textStatus: 'abort', exception: 'abort' }); };
      this.pending.add(abort);
      const signal = (ajaxOptions as JQuery.AjaxSettings & { signal?: AbortSignal } | undefined)?.signal;
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      const network = (request: UnknownApiParams): Promise<ApiResponse> => new Promise((resolve, reject) => {
        super.ajax(request, ajaxOptions).done(resolve).fail((code: unknown) => reject(new LocalApiError(typeof code === 'string' ? code : 'http', 'MediaWiki read failed.')));
      });
      const readRemote = async (title: string): Promise<LocalPage | undefined> => {
        const response = await network({ action: 'query', titles: title, prop: 'revisions', rvslots: 'main', rvprop: 'ids|timestamp|content', formatversion: 2 });
        const pages = (response as { query?: { pages?: Array<{ missing?: boolean; title: string; pageid: number; revisions?: Array<{ revid: number; timestamp: string; slots?: { main?: { content?: string } } }> }> } }).query?.pages;
        const page = pages?.[0], revision = page?.revisions?.[0];
        if (!page || page.missing) return undefined;
        if (!revision || typeof revision.slots?.main?.content !== 'string') throw new LocalApiError('missingcontent', 'The original page source is not accessible.');
        return { title, pageid: page.pageid, revid: revision.revid, timestamp: revision.timestamp, content: revision.slots.main.content };
      };
      const section = async (page: LocalPage, index: string): Promise<[number, number]> => {
        const parsed = await network({ action: 'parse', text: page.content, title: page.title, prop: 'tocdata', formatversion: 2 });
        const sections = (parsed as { parse?: { tocdata?: { sections?: Array<{ index: string; codepointOffset?: number; hLevel: number; fromTitle?: string }> } } }).parse?.tocdata?.sections;
        const points = [0]; for (const character of page.content) points.push(points[points.length - 1] + character.length);
        if (index === '0') return [0, points[sections?.[0]?.codepointOffset ?? points.length - 1]];
        const at = sections?.findIndex(item => String(item.index) === index) ?? -1;
        const start = sections?.[at];
        if (!start || start.codepointOffset === undefined || (start.fromTitle && titleKey(start.fromTitle) !== page.title)) throw new LocalApiError('nosuchsection', 'Cannot locate this source section in the local page.');
        const next = sections?.slice(at + 1).find(item => item.hLevel <= start.hLevel && item.codepointOffset !== undefined);
        return [points[start.codepointOffset], next?.codepointOffset === undefined ? page.content.length : points[next.codepointOffset]];
      };
      const execute = async (): Promise<ApiResponse> => {
        if (aborted) throw new LocalApiError('aborted', 'Request aborted.');
        if (action === 'edit') {
          if (typeof params.title !== 'string') throw new LocalApiError('missingparam', 'Dry-run edits require a title.');
          const title = titleKey(params.title);
          const current = await storage.read(title) ?? await readRemote(title);
          let content = typeof params.text === 'string' ? params.text : current?.content ?? '';
          if (params.section !== undefined) {
            if (scalar(params.section) === 'new') content = `${current?.content ?? ''}\n\n== ${scalar(params.sectiontitle ?? params.summary ?? '')} ==\n${scalar(params.text ?? params.appendtext ?? '')}`;
            else {
              if (!current) throw new LocalApiError('missingtitle', 'Cannot edit a section of a missing local page.');
              const [from, to] = await section(current, scalar(params.section));
              const text = params.text === undefined ? current.content.slice(from, to) : scalar(params.text);
              content = current.content.slice(0, from) + scalar(params.prependtext ?? '') + text + scalar(params.appendtext ?? '') + current.content.slice(to);
            }
          } else content = scalar(params.prependtext ?? '') + content + scalar(params.appendtext ?? '');
          // The read used for composing a section/append also participates in CAS.
          return storage.edit(title, content, { ...params, baserevid: params.baserevid ?? current?.revid ?? 0 }, current, () => aborted);
        }
        if (!readActions.has(action)) throw new LocalApiError('dryrun-unsupported', `Dry-run blocks unsupported API action: ${action}`);
        if (action === 'query' && params.titles) {
          const titles = list(params.titles).map(titleKey);
          const pages = await Promise.all(titles.map(title => storage.read(title)));
          if (pages.some(Boolean)) {
            if (params.generator || params.list || params.meta || list(params.prop).some(prop => !['revisions', 'info'].includes(prop))) throw new LocalApiError('dryrun-unsupported', 'Unsupported local-page query.');
            const records: Array<Record<string, unknown>> = [];
            for (const [index, title] of titles.entries()) {
              const page = pages[index] ?? await readRemote(title);
              if (!page) { records.push({ ns: mw.Title.newFromText(title)?.getNamespaceId() ?? 1, title, missing: true }); continue; }
              const extent = params.rvsection === undefined ? [0, page.content.length] : await section(page, scalar(params.rvsection));
              const content = page.content.slice(extent[0], extent[1]);
              const slot = Number(params.formatversion) === 2 ? { content, contentmodel: 'wikitext', contentformat: 'text/x-wiki' } : { '*': content, contentmodel: 'wikitext', contentformat: 'text/x-wiki' };
              records.push({ pageid: page.pageid, ns: mw.Title.newFromText(title)?.getNamespaceId() ?? 1, title, lastrevid: page.revid, contentmodel: 'wikitext', revisions: [{ revid: page.revid, timestamp: page.timestamp, comment: page.summary ?? '', slots: { main: slot }, '*': content }] });
            }
            return { curtimestamp: new Date().toISOString(), query: { pages: Number(params.formatversion) === 2 ? records : Object.fromEntries(records.map((page, index) => [scalar('pageid' in page ? page.pageid : -index - 1), page])) } };
          }
        }
        if (action === 'parse' && typeof params.page === 'string') {
          const page = await storage.read(titleKey(params.page));
          if (page) return network({ ...params, page: undefined, oldid: undefined, text: page.content, title: page.title, contentmodel: 'wikitext' });
        }
        return network(params);
      };
      void Promise.resolve().then(execute).then(result => { if (!aborted) deferred.resolve(result); }, (error: unknown) => {
        if (aborted) return;
        const code = error instanceof LocalApiError ? error.code : 'dryrun-storage';
        const response = { error: { code, info: error instanceof Error ? error.message : 'Local API request failed.' } };
        deferred.reject(code, response, response);
      }).finally(() => { this.pending.delete(abort); signal?.removeEventListener('abort', abort); });
      return deferred.promise({ abort }) as mw.Api.AbortablePromise;
    }
  }
  return new DryRunApi(options);
}
