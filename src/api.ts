import state from "./state";

declare var mw: any;

// Helper: parse query parameters from a URL-like string
function parseQueryParams(url: string): Record<string, string> {
	const qIdx = url.indexOf('?');
	const query = qIdx >= 0 ? url.slice(qIdx + 1) : url;
	const pairs = query.split('&').filter(Boolean);
	const out: Record<string, string> = {};
	for (const p of pairs) {
		const [k, v] = p.split('=');
		if (!k) continue;
		try { out[decodeURIComponent(k)] = v ? decodeURIComponent(v) : ''; } catch (e) { out[k] = v || ''; }
	}
	return out;
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
	const link = headingEl.querySelector('a.qe-target') || headingEl.querySelector('a[href*="action=edit"]') as HTMLAnchorElement | null;
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

/**
 * Append raw wikitext to a specific section of a page using MediaWiki API.
 * Requires that a valid `sectionId` be provided. Returns the API response promise.
 */
export function appendTextToSection(pageTitle: string, sectionId: number, appendText: string, summary?: string): Promise<any> {
	return new Promise((resolve, reject) => {
		if (!pageTitle || typeof sectionId !== 'number' || isNaN(sectionId)) {
			reject(new Error('Invalid pageTitle or sectionId'));
			return;
		}
		const api = state.getApi();
		const params: any = {
			action: 'edit',
			title: pageTitle,
			section: sectionId,
			appendtext: appendText,
			format: 'json',
			formatversion: 2,
		};
		if (summary) params.summary = summary;
		api.postWithToken('csrf', params).done((res: any) => {
			if (res.edit && res.edit.result === 'Success') {
				console.log('[ReviewTool][appendTextToSection] Append successful');
				mw.notify(state.convByVar({
					hant: '已成功將內容附加到指定段落。',
					hans: '已成功将内容附加到指定段落。'
				}));
				refreshPage();
			} else if (res.error && res.error.code === 'editconflict') {
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
		}).fail((err: any) => reject(err));
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
	return new Promise((resolve, reject) => {
		if (!pageTitle) {
			reject(new Error('Invalid pageTitle'));
			return;
		}
		const api = state.getApi();
		const params: any = {
			action: 'query',
			prop: 'revisions',
			titles: pageTitle,
			rvslots: 'main',
			rvprop: ['timestamp', 'content'],
			curtimestamp: 1,
			format: 'json',
			formatversion: 2,
		};
		if (typeof sectionId === 'number' && !isNaN(sectionId)) {
			params.rvsection = sectionId;
		}
		api.postWithToken('csrf', params).done((res: any) => {
			try {
				const page = res?.query?.pages?.[0];
				const revision = page?.revisions?.[0];
				if (revision) {
					const mainSlot = revision.slots?.main || {};
					const text = typeof mainSlot.content === 'string'
						? mainSlot.content
						: (mainSlot['*'] || '');
					resolve({
						text,
						starttimestamp: res?.curtimestamp || '',
						basetimestamp: revision.timestamp || '',
					});
					return;
				}
			} catch (err) {
				reject(err);
				return;
			}
			reject(new Error('No content found'));
		}).fail((error: any) => reject(error));
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
		const pageInfo = await resp.json();

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

export function replaceSectionText(pageTitle: string, sectionId: number, newText: string, summary?: string, timestamps?: SectionTimestamps): Promise<any> {
	return new Promise(async (resolve, reject) => {
		try {
			if (!pageTitle || typeof sectionId !== 'number' || isNaN(sectionId)) {
				reject(new Error('Invalid pageTitle or sectionId'));
				return;
			}
			const api = state.getApi();
			let starttimestamp = timestamps?.starttimestamp;
			let basetimestamp = timestamps?.basetimestamp;
			if (!starttimestamp || !basetimestamp) {
				const fetched = await retrieveFullText(pageTitle, sectionId);
				starttimestamp = fetched.starttimestamp;
				basetimestamp = fetched.basetimestamp;
			}
			const params: any = {
				action: 'edit',
				title: pageTitle,
				section: sectionId,
				text: newText,
				starttimestamp,
				basetimestamp,
				format: 'json',
				formatversion: 2,
			};
			if (summary) params.summary = summary;
			api.postWithToken('csrf', params)
				.done((data: any) => {
					if (data?.edit?.result === 'Success') {
						refreshPage();
					}
					resolve(data);
				})
				.fail((err: any) => reject(err));
		} catch (error) {
			reject(error);
		}
	});
}

/**
 * Parse a piece of wikitext into HTML using MediaWiki `action=parse`.
 * Useful for rendering a preview of the wikitext the user is about to save/append.
 */
export function parseWikitextToHtml(wikitext: string, title?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			const api = state.getApi();
			const params: any = { action: 'parse', text: wikitext || '', contentmodel: 'wikitext', format: 'json' };
			if (title) params.title = title;
			api.post(params).done((data: any) => {
				try {
					if (data && data.parse && data.parse.text) {
						resolve(data.parse.text['*'] || '');
						return;
					}
				} catch (e) { /* fallthrough */ }
				resolve('');
			}).fail((err: any) => reject(err));
		} catch (e) {
			reject(e);
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
			const params: any = {
				action: 'compare',
				fromslots: 'main',
				'fromtext-main': oldWikitext || '',
				fromtitle: mw.config.get('wgPageName'),
				frompst: 'true',
				toslots: 'main',
				'totext-main': newWikitext || '',
				totitle: mw.config.get('wgPageName'),
				topst: 'true',
			};
			api.postWithToken('csrf', params).done((res: any) => {
				try {
					if (res && res.compare && res.compare['*']) {
						resolve('<table class="diff"><colgroup><col class="diff-marker"/><col class="diff-content"/><col class="diff-marker"/><col class="diff-content"/></colgroup>' + res.compare['*'] + '</table>');
					}
					resolve(state.convByVar({ hant: '無差異。', hans: '无差异。' }));
				} catch (e) {
					reject(e);
				}
			}).fail((err: any) => reject(err));
		} catch (e) { reject(e); }
	});
}
