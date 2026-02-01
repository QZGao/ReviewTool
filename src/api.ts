import type {
	ApiComparePagesParams,
	ApiEditPageParams,
	ApiParseParams,
	ApiQueryParams,
	ApiQueryRevisionsParams,
	UnknownApiParams,
} from "types-mediawiki/api_params";
import type { ApiResponse } from "types-mediawiki/mw/Api";
import state from "./state";

// Helper: parse query parameters from a URL-like string
function parseQueryParams(url: string): Record<string, string> {
	const qIdx = url.indexOf('?');
	const query = qIdx >= 0 ? url.slice(qIdx + 1) : url;
	const pairs = query.split('&').filter(Boolean);
	const out: Record<string, string> = {};
	for (const p of pairs) {
		const [k, v] = p.split('=');
		if (!k) continue;
		try { out[decodeURIComponent(k)] = v ? decodeURIComponent(v) : ''; } catch { out[k] = v || ''; }
	}
	return out;
}

function toError(err: unknown): Error {
	if (err instanceof Error) return err;
	if (typeof err === 'string') return new Error(err);
	if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
		return new Error(String(err));
	}
	if (typeof err === 'symbol') return new Error(err.description || 'Unknown error');
	if (typeof err === 'function') return new Error(err.name || 'Unknown error');
	try {
		return new Error(JSON.stringify(err));
	} catch {
		return new Error('Unknown error');
	}
}

/**
 * Find MediaWiki section information from a heading element (DOM node that contains
 * the edit link). It looks for `a.qe-target` or any `a[href*="action=edit"]` and
 * parses the `title` and `section` params from its href.
 *
 * @param headingEl Element | null
 * @returns { pageTitle?: string|null, sectionId?: number|null }
 */
export function findSectionInfoFromHeading(headingEl: Element | null): { pageTitle?: string | null, sectionId?: number | null } {
	if (!headingEl) return { pageTitle: null, sectionId: null };
	// search within the heading wrapper for edit links
	const link = headingEl.querySelector('a.qe-target') || headingEl.querySelector('a[href*="action=edit"]');
	if (!link || !link.getAttribute) return { pageTitle: null, sectionId: null };
	const href = link.getAttribute('href') || '';
	// href may be absolute or relative, with query params
	const params = parseQueryParams(href);
	const title = params['title'] ? decodeURIComponent(params['title']) : null;
	let sectionId: number | null = null;
	if (params['section']) {
		const n = parseInt(params['section'], 10);
		if (!isNaN(n)) sectionId = n;
	}
	return { pageTitle: title, sectionId };
}

/**
 * Create a MediaWiki wikitext header line for the given level and title.
 * level: number of equals on each side (e.g. 3 => ===Title===)
 */
export function createHeaderMarkup(title: string, level: number): string {
	if (!title) return '';
	const eq = '='.repeat(Math.max(1, Math.min(6, level)));
	// Return header line with a single trailing newline. Avoid leading blank lines
	// so callers can control spacing when concatenating multiple headers.
	return `\n${eq}${title}${eq}`;
}

interface ApiEditResponse {
	edit?: {
		result?: string;
	};
	error?: {
		code?: string;
	};
}

interface ApiQueryRevisionSlot {
	content?: string;
	'*'?: string;
}

interface ApiQueryRevision {
	timestamp?: string;
	slots?: {
		main?: ApiQueryRevisionSlot;
	};
}

interface ApiQueryPage {
	revisions?: ApiQueryRevision[];
}

interface ApiQueryRevisionsResponse {
	curtimestamp?: string;
	query?: {
		pages?: ApiQueryPage[];
	};
}

interface ApiParseResponse {
	parse?: {
		text?: {
			'*'?: string;
		};
	};
}

interface ApiCompareResponse {
	compare?: {
		'*'?: string;
	};
}

interface XToolsAssessment {
	value: string;
	badge: string;
}

interface XToolsPageInfo {
	project: string;
	page: string;
	created_rev_id: number;
	modified_rev_id: number;
	pageviews_offset: number;
	creator: string;
	created_at: string;
	revisions: number;
	editors: number;
	watchers: number;
	pageviews: number;
	secs_since_last_edit: number;
	assessment: XToolsAssessment;
	creator_editcount?: number;
}

function isXToolsPageInfo(data: unknown): data is XToolsPageInfo {
	if (!data || typeof data !== 'object') return false;
	const info = data as Partial<XToolsPageInfo>;
	return typeof info.project === 'string'
		&& typeof info.page === 'string'
		&& typeof info.created_rev_id === 'number'
		&& typeof info.modified_rev_id === 'number'
		&& typeof info.pageviews_offset === 'number'
		&& typeof info.creator === 'string'
		&& typeof info.created_at === 'string'
		&& typeof info.revisions === 'number'
		&& typeof info.editors === 'number'
		&& typeof info.watchers === 'number'
		&& typeof info.pageviews === 'number'
		&& typeof info.secs_since_last_edit === 'number'
		&& !!info.assessment
		&& typeof info.assessment.value === 'string'
		&& typeof info.assessment.badge === 'string';
}

/**
 * Append raw wikitext to a specific section of a page using MediaWiki API.
 * Requires that a valid `sectionId` be provided. Returns the API response promise.
 */
export function appendTextToSection(pageTitle: string, sectionId: number, appendText: string, summary?: string): Promise<ApiResponse> {
	return new Promise((resolve, reject) => {
		if (!pageTitle || typeof sectionId !== 'number' || isNaN(sectionId)) {
			reject(new Error('Invalid pageTitle or sectionId'));
			return;
		}
		const api = state.getApi();
		const params: ApiEditPageParams = {
			action: 'edit',
			title: pageTitle,
			section: String(sectionId),
			appendtext: appendText,
			format: 'json',
			formatversion: "2",
		};
		if (summary) params.summary = summary;
		api.postWithToken('csrf', params).done((res: ApiResponse) => {
			const response = res as ApiEditResponse;
			if (response.edit && response.edit.result === 'Success') {
				console.log('[ReviewTool][appendTextToSection] Append successful');
				mw.notify(state.convByVar({
					hant: '已成功將內容附加到指定段落。',
					hans: '已成功将内容附加到指定段落。'
				}));
				refreshPage();
			} else if (response.error && response.error.code === 'editconflict') {
				console.error('[ReviewTool][appendTextToSection] Edit conflict occurred');
				mw.notify(state.convByVar({
					hant: '附加內容時發生編輯衝突。請重新嘗試。',
					hans: '附加内容时发生编辑冲突。请重新尝试。'
				}));
			} else {
				console.error('[ReviewTool][appendTextToSection] Append failed', res);
				mw.notify(state.convByVar({
					hant: '附加內容失敗。請稍後再試。',
					hans: '附加内容失败。请稍后再试。'
				}));
			}
			resolve(res);
		}).fail((err: unknown) => reject(toError(err)));
	});
}

/**
 * Refresh the current page after a short delay.
 */
function refreshPage() {
	setTimeout(() => {
		location.reload();
	}, 2000);  // 2 seconds delay
}

export interface RetrieveFullTextResult {
	text: string;
	starttimestamp: string;
	basetimestamp: string;
}

/**
 * 檢索指定頁面（或段落）的文本與相關時間戳。
 */
export function retrieveFullText(pageTitle: string, sectionId?: number): Promise<RetrieveFullTextResult> {
	return new Promise<RetrieveFullTextResult>((resolve, reject) => {
		if (!pageTitle) {
			reject(new Error('Invalid pageTitle'));
			return;
		}
		const api = state.getApi();
		const params: ApiQueryParams & ApiQueryRevisionsParams = {
			action: 'query',
			prop: 'revisions',
			titles: pageTitle,
			rvslots: 'main',
			rvprop: ['timestamp', 'content'],
			curtimestamp: true,
			format: 'json',
			formatversion: "2",
		};
		if (typeof sectionId === 'number' && !isNaN(sectionId)) {
			params.rvsection = String(sectionId);
		}
		api.postWithToken('csrf', params).done((res: ApiResponse) => {
			try {
				const response = res as ApiQueryRevisionsResponse;
				const page = response.query?.pages?.[0];
				const revision = page?.revisions?.[0];
				if (revision) {
					const mainSlot = revision.slots?.main || { '*': '' };
					const text = typeof mainSlot.content === 'string'
						? mainSlot.content
						: mainSlot['*'];
					resolve({
						text,
						starttimestamp: response.curtimestamp || '',
						basetimestamp: revision.timestamp || '',
					});
					return;
				}
			} catch (error) {
				reject(toError(error));
				return;
			}
			reject(new Error('No content found'));
		}).fail((error: unknown) => reject(toError(error)));
	});
}

/**
 * 獲取XTools頁面資訊。無法獲取時按下不表，返回空字串。
 * @param pageName {string} 頁面名稱
 * @returns {Promise<string>} XTools頁面資訊。
 */
export async function getXToolsInfo(pageName: string): Promise<string> {
	function safeToLocaleString(num: number): string {
		if (typeof num === 'number' && !isNaN(num)) {
			return num.toLocaleString();
		}
		return '0';
	}

	try {
		const server = mw.config.get('wgServerName');
		const url = 'https://xtools.wmcloud.org/api/page/pageinfo/' +
			encodeURIComponent(server) + '/' + encodeURIComponent(pageName);

		const resp = await fetch(url, { method: 'GET' });
		if (!resp.ok) {
			throw new Error(`XTools responded ${resp.status}`);
		}
		const pageInfo: unknown = await resp.json();
		if (!isXToolsPageInfo(pageInfo)) {
			throw new Error('Unexpected XTools response shape');
		}

		const project = pageInfo.project;
		const pageEnc = encodeURIComponent(pageInfo.page);
		const pageUrl = `https://${project}/wiki/${pageInfo.page}`;
		const pageinfoUrl = `https://xtools.wmcloud.org/pageinfo/${project}/${pageEnc}`;
		const permaLinkUrl = `https://${project}/wiki/Special:PermaLink%2F${pageInfo.created_rev_id}`;
		const diffUrl = `https://${project}/wiki/Special:Diff%2F${pageInfo.modified_rev_id}`;
		const pageviewsUrl = `https://pageviews.wmcloud.org/?project=${project}&pages=${pageEnc}&range=latest-${pageInfo.pageviews_offset}`;
		const creatorLink = `https://${project}/wiki/User:${pageInfo.creator}`;
		const creatorContribsUrl = `https://${project}/wiki/Special:Contributions/${pageInfo.creator}`;
		const createdDate = new Date(pageInfo.created_at).toISOString().split('T')[0];
		const revisionsText = safeToLocaleString(pageInfo.revisions);
		const editorsText = safeToLocaleString(pageInfo.editors);
		const watchersText = safeToLocaleString(pageInfo.watchers);
		const pageviewsText = safeToLocaleString(pageInfo.pageviews);
		const days = Math.round(pageInfo.secs_since_last_edit / 86400);

		let creatorText = '';
		if (pageInfo.creator_editcount) {
			creatorText = `<bdi><a href="${creatorLink}" target="_blank">${pageInfo.creator}</a></bdi> (<a href="${creatorContribsUrl}" target="_blank">${safeToLocaleString(pageInfo.creator_editcount)}</a>)`;
		} else {
			creatorText = `<bdi><a href="${creatorContribsUrl}" target="_blank">${pageInfo.creator}</a></bdi>`;
		}
		let pageCreationText = `「<a target="_blank" title="評級: ${pageInfo.assessment.value}" href="${pageinfoUrl}"><img src="${pageInfo.assessment.badge}" style="height:16px !important; vertical-align:-4px; margin-right:3px"/></a><bdi><a target="_blank" href="${pageUrl}">${pageInfo.page}</a></bdi>」由 ${creatorText} 於 <bdi><a target='_blank' href='${permaLinkUrl}'>${createdDate}</a></bdi> 建立，共 ${revisionsText} 個修訂，最後修訂於 <a href="${diffUrl}">${days} 天</a>前。`;
		let pageEditorsText = `共 ${editorsText} 編輯者` + (watchersText !== '0' ? `、${watchersText} 監視者` : '') + `，最近 ${pageInfo.pageviews_offset} 天共 <a target="_blank" href="${pageviewsUrl}">${pageviewsText} 瀏覽數</a>。`;

		return `<span style="line-height:20px">${pageCreationText}${pageEditorsText}<a target="_blank" href="${pageinfoUrl}">檢視完整頁面統計</a>。</span>`.trim();
	} catch (error) {
		console.error('[Voter] Error fetching XTools data:', error);
		return '<span style="color: red; font-weight: bold;">無法獲取 XTools 頁面資訊。</span>';
	}
}

/**
 * Replace the full wikitext of a given section. Uses action=edit with `section` and `text`.
 */
export interface SectionTimestamps {
	starttimestamp: string;
	basetimestamp: string;
}

export async function replaceSectionText(pageTitle: string, sectionId: number, newText: string, summary?: string, timestamps?: SectionTimestamps): Promise<ApiResponse> {
	if (!pageTitle || typeof sectionId !== 'number' || isNaN(sectionId)) {
		throw new Error('Invalid pageTitle or sectionId');
	}
	const api = state.getApi();
	let starttimestamp = timestamps?.starttimestamp;
	let basetimestamp = timestamps?.basetimestamp;
	if (!starttimestamp || !basetimestamp) {
		const fetched = await retrieveFullText(pageTitle, sectionId);
		starttimestamp = fetched.starttimestamp;
		basetimestamp = fetched.basetimestamp;
	}
	const params: ApiEditPageParams = {
		action: 'edit',
		title: pageTitle,
		section: String(sectionId),
		text: newText,
		starttimestamp,
		basetimestamp,
		format: 'json',
		formatversion: "2",
	};
	if (summary) params.summary = summary;
	const data = await new Promise<ApiResponse>((resolve, reject) => {
		api.postWithToken('csrf', params)
			.done((response: ApiResponse) => {
				const result = response as ApiEditResponse;
				if (result.edit?.result === 'Success') {
					refreshPage();
				}
				resolve(response);
			})
			.fail((err: unknown) => reject(toError(err)));
	});
	return data;
}

/**
 * Parse a piece of wikitext into HTML using MediaWiki `action=parse`.
 * Useful for rendering a preview of the wikitext the user is about to save/append.
 */
export function parseWikitextToHtml(wikitext: string, title?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			const api = state.getApi();
			const params: ApiParseParams = { action: 'parse', text: wikitext || '', contentmodel: 'wikitext', format: 'json' };
			if (title) params.title = title;
			api.post(params).done((data: ApiResponse) => {
				try {
					const response = data as ApiParseResponse;
					if (response.parse?.text) {
						resolve(response.parse.text['*'] || '');
						return;
					}
				} catch { /* fallthrough */ }
				resolve('');
			}).fail((err: unknown) => reject(toError(err)));
		} catch (error: unknown) {
			reject(toError(error));
		}
	});
}

/**
 * Produce an HTML diff between two wikitext values using `action=compare`.
 * If the API does not return a ready-made diff HTML, the function returns an
 * empty string so callers can fallback to a plain-text diff.
 */
export function compareWikitext(oldWikitext: string, newWikitext: string): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			const api = state.getApi();
			const params: ApiComparePagesParams & UnknownApiParams = {
				action: 'compare',
				fromslots: 'main',
				'fromtext-main': oldWikitext || '',
				fromtitle: mw.config.get('wgPageName'),
				frompst: true,
				toslots: 'main',
				'totext-main': newWikitext || '',
				totitle: mw.config.get('wgPageName'),
				topst: true,
			};
			api.postWithToken('csrf', params).done((res: ApiResponse) => {
				try {
					const response = res as ApiCompareResponse;
					if (response.compare && response.compare['*']) {
						resolve('<table class="diff"><colgroup><col class="diff-marker"/><col class="diff-content"/><col class="diff-marker"/><col class="diff-content"/></colgroup>' + response.compare['*'] + '</table>');
					}
					resolve(state.convByVar({ hant: '無差異。', hans: '无差异。' }));
				} catch (error) {
					reject(toError(error));
				}
			}).fail((err: unknown) => reject(toError(err)));
		} catch (error: unknown) { reject(toError(error)); }
	});
}
