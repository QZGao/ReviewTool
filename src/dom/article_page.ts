import {addVectorMenuTab} from "./utils";
import state from "../state";
import * as annotationUI from './annotation_ui';
declare var mw: any;

/**
 * 給所有 mw-headings 添加「批註」按鈕。
 * @param pageName {string} 條目標題
 */
export function addMainPageReviewToolButtonsToDOM(pageName: string): void {
    if (document.querySelector('#ca-annotate')) return;
    // Add a single Vector menu tab to toggle annotation mode for the whole article
    // This replaces per-heading mw-editsection buttons to avoid overlapping areas.
    const tab = addVectorMenuTab(
        'ca-annotate',
        state.convByVar({hant: '批註模式', hans: '批注模式'}),
        state.convByVar({hant: '切換整頁批註模式', hans: '切换整页批注模式'}),
        (e) => toggleArticleAnnotationMode(pageName)
    );
    // add global viewer button (guard against duplicate)
    addGlobalAnnotationViewerButton(pageName);
}

function addGlobalAnnotationViewerButton(pageName: string): void {
    if (document.querySelector('.review-tool-global-button')) return; // already added
    const btn = document.createElement('button');
    btn.className = 'review-tool-global-button';
    btn.textContent = state.convByVar({hant: '查看批註', hans: '查看批注'});
    btn.title = state.convByVar({hant: '查看本頁所有批註', hans: '查看本页所有批注'});
    btn.style.position = 'fixed';
    btn.style.bottom = '20px';
    btn.style.right = '20px';
    btn.style.zIndex = '10100';
    btn.style.padding = '10px 16px';
    btn.style.backgroundColor = '#36c';
    btn.style.color = '#fff';
    btn.style.border = 'none';
    btn.style.borderRadius = '4px';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '14px';
    btn.style.fontWeight = 'bold';
    btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
    // Hidden by default; show only when annotation mode is active
    btn.style.display = 'none';
    btn.onclick = () => {
        try {
            const fn: any = (annotationUI as any).showAnnotationViewer;
            if (typeof fn === 'function') {
                fn(state.articleTitle || pageName);
            } else {
                console.warn('[ReviewTool] showAnnotationViewer function not available');
            }
        } catch (e) {
            console.error('[ReviewTool] failed to open viewer', e);
        }
    };
    btn.onmouseenter = () => { btn.style.backgroundColor = '#447ff5'; };
    btn.onmouseleave = () => { btn.style.backgroundColor = '#36c'; };
    document.body.appendChild(btn);
}

/**
 * 創建一個「批註」按鈕元素。
 * @param pageName {string} 條目標標題
 * @param headingTitle {string} 章節標題
 */
function toggleArticleAnnotationMode(pageName: string): void {
    const key = '__article__';
    state.toggleAnnotationModeState(key);
    if (state.isAnnotationModeActive(key)) {
        // mark document so we can override page styles while annotation mode is active
        try { document.documentElement.classList.add('rt-annotation-mode'); } catch (e) {}
        // Update Vector tab appearance to bold
        try {
            const tab = document.getElementById('ca-annotate');
            if (tab) {
                const span = tab.querySelector('a > span');
                if (span && span instanceof HTMLElement) span.style.fontWeight = 'bold';
                tab.classList.add('selected');
            }
        } catch (e) { /* ignore */ }
        // Notify user
        try { mw && mw.notify && mw.notify(state.convByVar({hant: '整頁批註模式已啟用。', hans: '整页批注模式已启用。'}), { tag: 'review-tool' }); } catch (e) {}
        console.log(`[ReviewTool] 條目「${state.articleTitle}」整頁批註模式已啟用。`);
        // find main content container - prefer the parser output inside mw-content-text
        const selectors = [
            '#mw-content-text .mw-parser-output',
            '#mw-content-text',
            '.mw-parser-output',
            '#content',
            '#bodyContent'
        ];
        let container: Element | null = null;
        for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) { container = el; break; }
        }
        if (container) {
            console.log('[ReviewTool] chosen content container:', container.tagName, container.id || '(no id)', container.className || '(no class)');
        } else {
            console.warn('[ReviewTool] could not find a content container with selectors', selectors);
        }
        if (!container) {
            console.warn('[ReviewTool] 未找到主要內容容器，無法啟用整頁批註模式。');
            return;
        }
        const sectionPath = state.articleTitle || pageName;
        // install listeners using the container as the active section start (annotation_ui will treat container as parent)
        annotationUI.installSelectionListenersForSection(state.articleTitle || pageName, container, null, sectionPath);
        // Try wrapping the section and retry a few times in case the page rewrites content shortly after.
        const tryCount = (annotationUI as any).ensureWrappedSection ? (annotationUI as any).ensureWrappedSection : annotationUI.wrapSectionSentences;
        tryCount(container, null, 4, 220);
        annotationUI.renderAnnotationBadges(state.articleTitle || pageName, sectionPath);
        // Ensure global viewer button is visible while annotation mode is active
        try {
            const gv = document.querySelector('.review-tool-global-button') as HTMLElement | null;
            if (gv) gv.style.display = 'block';
        } catch (e) { /* ignore */ }
    } else {
        console.log(`[ReviewTool] 條目「${state.articleTitle}」整頁批註模式已停用。`);
        annotationUI.uninstallSelectionListeners();
        annotationUI.clearWrappedSentences();
        // Update Vector tab appearance to normal
        try {
            const tab = document.getElementById('ca-annotate');
            if (tab) {
                const span = tab.querySelector('a > span');
                if (span && span instanceof HTMLElement) span.style.fontWeight = 'normal';
                tab.classList.remove('selected');
            }
        } catch (e) { /* ignore */ }
        try { document.documentElement.classList.remove('rt-annotation-mode'); } catch (e) {}
        // Notify user
        try { mw && mw.notify && mw.notify(state.convByVar({hant: '整頁批註模式已停用。', hans: '整页批注模式已停用。'}), { tag: 'review-tool' }); } catch (e) {}
        // Hide global viewer button when annotation mode is disabled
        try {
            const gv = document.querySelector('.review-tool-global-button') as HTMLElement | null;
            if (gv) gv.style.display = 'none';
        } catch (e) { /* ignore */ }
    }
}