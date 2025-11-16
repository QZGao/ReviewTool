import state from "./state";

declare var mw: any;

// Helper: parse query parameters from a URL-like string
function parseQueryParams(url: string): Record<string,string> {
	const qIdx = url.indexOf('?');
	const query = qIdx >= 0 ? url.slice(qIdx + 1) : url;
	const pairs = query.split('&').filter(Boolean);
	const out: Record<string,string> = {};
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
		// Prefer mw.user.tokens if available
		let token = null;
		try {
			token = mw && mw.user && typeof mw.user.tokens.get === 'function' ? mw.user.tokens.get('csrf') : null;
		} catch (e) {
			token = null;
		}
		const params: any = {
			action: 'edit',
			title: pageTitle,
			section: sectionId,
			appendtext: appendText,
			format: 'json'
		};
		if (summary) params.summary = summary;
		if (token) params.token = token;

		// Ensure we have a csrf token; if not available via mw.user.tokens, request one from the API
		function doPostWithToken(tkn: string | null) {
			if (tkn) params.token = tkn;
			try {
				api.post(params).done((data: any) => resolve(data)).fail((err: any) => reject(err));
			} catch (e) {
				reject(e);
			}
		}

		if (token) {
			doPostWithToken(token);
		} else {
			// ask the API for a csrf token
			api.get({ action: 'query', meta: 'tokens', type: 'csrf', format: 'json' })
				.done((d: any) => {
					const t = d && d.query && d.query.tokens && (d.query.tokens.csrftoken || d.query.tokens['csrf']);
					doPostWithToken(t || null);
				})
				.fail((err: any) => {
					// If token fetch fails, still attempt post without token (mw.Api may handle it),
					// but report the original failure instead of hanging.
					doPostWithToken(null);
				});
		}
	});
}

/**
 * 檢索指定頁面的完整文本內容。
 * @param pageTitle {string} 頁面標題
 * @returns {Promise<string>} 頁面完整文本內容。
 */
function retrieveFullText(pageTitle: string): Promise<string> {
	return new Promise((resolve, reject) => {
		state.getApi().get({
			action: 'query',
			prop: 'revisions',
			titles: pageTitle,
			rvprop: 'content',
			rvslots: '*',
			format: 'json'
		}).done((data) => {
			const pages = data.query.pages;
			const page = pages[Object.keys(pages)[0]];
			if (page && page.revisions) {
				resolve(page.revisions[0].slots.main['*']);
			} else {
				reject('No content found');
			}
		}).fail((error) => {
			reject(error);
		});
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
 * Retrieve the raw wikitext for a specific section of a page.
 * Uses `rvsection` to fetch only the section content.
 */
export function getSectionWikitext(pageTitle: string, sectionId: number): Promise<string> {
	return new Promise((resolve, reject) => {
		if (!pageTitle || typeof sectionId !== 'number' || isNaN(sectionId)) {
			reject(new Error('Invalid pageTitle or sectionId'));
			return;
		}
		const api = state.getApi();
		api.get({ action: 'query', prop: 'revisions', titles: pageTitle, rvprop: 'content', rvslots: '*', rvsection: sectionId, format: 'json' })
			.done((data: any) => {
				try {
					const pages = data.query && data.query.pages;
					const page = pages && pages[Object.keys(pages)[0]];
					if (page && page.revisions && page.revisions[0] && page.revisions[0].slots && page.revisions[0].slots.main) {
						resolve(page.revisions[0].slots.main['*'] || '');
						return;
					}
				} catch (e) { /* fallthrough */ }
				resolve('');
			})
			.fail((err: any) => reject(err));
	});
}

/**
 * Replace the full wikitext of a given section. Uses action=edit with `section` and `text`.
 */
export function replaceSectionText(pageTitle: string, sectionId: number, newText: string, summary?: string): Promise<any> {
	return new Promise((resolve, reject) => {
		if (!pageTitle || typeof sectionId !== 'number' || isNaN(sectionId)) {
			reject(new Error('Invalid pageTitle or sectionId'));
			return;
		}
		const api = state.getApi();
		// try to fetch token similarly as appendTextToSection
		let token = null;
		try { token = mw && mw.user && typeof mw.user.tokens.get === 'function' ? mw.user.tokens.get('csrf') : null; } catch (e) { token = null; }

		const params: any = {
			action: 'edit',
			title: pageTitle,
			section: sectionId,
			text: newText,
			format: 'json'
		};
		if (summary) params.summary = summary;
		if (token) params.token = token;

		function doPost(tkn: string | null) {
			if (tkn) params.token = tkn;
			try {
				api.post(params).done((data: any) => resolve(data)).fail((err: any) => reject(err));
			} catch (e) { reject(e); }
		}

		if (token) doPost(token);
		else {
			api.get({ action: 'query', meta: 'tokens', type: 'csrf', format: 'json' })
				.done((d: any) => {
					const t = d && d.query && d.query.tokens && (d.query.tokens.csrftoken || d.query.tokens['csrf']);
					doPost(t || null);
				})
				.fail((err: any) => { doPost(null); });
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
			api.get(params).done((data: any) => {
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
				format: 'json',
				fromtext: oldWikitext || '',
				totext: newWikitext || ''
			};
			api.get(params).done((data: any) => {
				try {
					if (data && data.compare) {
						// The API may return HTML under different keys depending on mw version
						if (data.compare['*']) return resolve(data.compare['*']);
						if (data.compare.body) return resolve(data.compare.body);
						if (data.compare.html) return resolve(data.compare.html);
					}
				} catch (e) { /* fallthrough */ }
				resolve('');
			}).fail((err: any) => reject(err));
		} catch (e) { reject(e); }
	});
}
