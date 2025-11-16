import state from "./state";
import styles from './styles.css';
import {addTalkPageReviewToolButtonsToDOM} from "./dom/talk_page";
import {addMainPageReviewToolButtonsToDOM} from "./dom/article_page";

declare var mw: any;

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
    } catch (e) {
        // Fallback for older environments
        const div = document.createElement('div');
        div.innerHTML = `<style>${css}</style>`;
        document.head.appendChild(div.firstChild as any);
    }
}

/**
 * 小工具入口。
 */
function init(): void {
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
        'Wikipedia:同行评审', 'Wikipedia:優良條目評選', 'Wikipedia:典范条目评选', 'Wikipedia:特色列表評選', 'User_talk:SuperGrey/gadgets/ReviewTool/TestPage'
    ];
    if (!allowedNamespaces.includes(namespace) && !allowedNamePrefixes.some((p) => pageName.startsWith(p))) {
        console.log('[ReviewTool] 不是目標頁面，小工具終止。');
        return;
    }

    state.initHanAssist().then(() => {
        if (namespace === 0) {
            state.articleTitle = pageName;
            mw.hook('wikipage.content').add(function () {
                addMainPageReviewToolButtonsToDOM(pageName);
            });
        } else {
            mw.hook('wikipage.content').add(function () {
                addTalkPageReviewToolButtonsToDOM(namespace, pageName);
            });
        }
    });
}

init();