import state from "./state";

declare var mw: any;

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