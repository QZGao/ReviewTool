import state from "./state";
import styles from './styles.css';
import {addButtonsToDOM} from "./dom";

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
    // Inject bundled CSS into the page
    if (typeof document !== 'undefined') {
        injectStyles(styles);
    }

    const namespace = mw.config.get('wgNamespaceNumber');
    const pageName = mw.config.get('wgPageName');
    const allowedPrefixes = [
        'Wikipedia:同行评审', 'Wikipedia:優良條目評選', 'Wikipedia:典范条目评选', 'Wikipedia:特色列表評選'
    ];
    if (namespace !== 1 && !allowedPrefixes.some((p) => pageName.startsWith(p))) {
        console.log('[ReviewTool] 不是目標頁面，小工具終止。');
        return;
    }

    mw.loader.using('ext.gadget.HanAssist').then((require) => {
        const {convByVar} = require('ext.gadget.HanAssist');
        state.convByVar = convByVar;
        state.userName = mw.config.get('wgUserName') || 'Example';

        addButtonsToDOM(namespace, pageName);
    });
}

init();