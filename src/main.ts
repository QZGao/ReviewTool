import state from "./state";
import styles from './styles.css';
import { addTalkPageReviewToolButtonsToDOM } from "./dom/talk_page";
import { initLiveAnnotation } from './annotation/live';
import { browserVisits, dataPageRevision, pageAnnotationNotifications } from './annotation/notifications';

/**
 * 將 CSS 樣式注入到頁面中。
 * @param css {string} 要注入的 CSS 樣式
 */
function injectStyles(css: string): void {
	if (!css) return;
	try {
		const styleEl = document.createElement('style');
		styleEl.appendChild(document.createTextNode(css));
		document.head.appendChild(styleEl);
	} catch {
		// Fallback for older environments
		const div = document.createElement('div');
		div.innerHTML = `<style>${css}</style>`;
		document.head.appendChild(div.firstChild as Node);
	}
}

/**
 * 小工具入口。
 */
async function init(): Promise<void> {
	await mw.loader.using(['mediawiki.api', 'mediawiki.util', 'mediawiki.Title']);
	if (document.readyState === 'loading') await new Promise<void>(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
	// Inject bundled CSS into the page.
	if (typeof document !== 'undefined') {
		injectStyles(styles);
	}

	// 檢查當前頁面是否為目標頁面；不是則終止小工具。
	const namespace = mw.config.get('wgNamespaceNumber');
	const pageName = mw.config.get('wgPageName');
	const allowedNamespaces = [
		0,  // 主
		1   // 討論頁
	];
	const allowedNamePrefixes = [
		'Wikipedia:同行评审', 'Wikipedia:優良條目評選', 'Wikipedia:典范条目评选', 'Wikipedia:特色列表评选', 'User:SuperGrey/gadgets/ReviewTool/TestPage', 'User_talk:SuperGrey/gadgets/ReviewTool/TestPage'
	];
	const targetPage = allowedNamespaces.includes(namespace) || allowedNamePrefixes.some((p) => pageName.startsWith(p));
	let hasNotifications = dataPageRevision() !== null;
	try { hasNotifications ||= browserVisits().subscriptions().length > 0; }
	catch (error) { console.warn('[ReviewTool] Annotation subscriptions are unavailable', error); }
	if (targetPage || hasNotifications) await state.initHanAssist().catch(error => console.warn('[ReviewTool] Language helper unavailable; using default labels.', error));
	const checkNotifications = () => { if (hasNotifications) void pageAnnotationNotifications().catch(error => console.warn('[ReviewTool] Annotation notifications failed', error)); };
	if (!targetPage) {
		checkNotifications();
		console.log('[ReviewTool] 不是目標頁面，小工具終止。');
		return;
	}

	state.articleTitle = pageName;
	const article = await initLiveAnnotation();
	if (!document.querySelector('.annotation-document')) checkNotifications();
	if (article) return;
	if (namespace === 0 || pageName === 'User:SuperGrey/gadgets/ReviewTool/TestPage') return;
	mw.hook('wikipage.content').add(function () {
		addTalkPageReviewToolButtonsToDOM(namespace, pageName);
	});
}

void init().catch(error => console.error('[ReviewTool] Startup failed', error));
