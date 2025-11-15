import {appendButtonToHeading, createMwEditSectionButton, getHeadingTitle} from "./utils";
import state from "../state";
import * as annotationUI from './annotation_ui';

/**
 * 給所有 mw-headings 添加「批註」按鈕。
 * @param pageName {string} 條目標題
 */
export function addMainPageReviewToolButtonsToDOM(pageName: string): void {
    const allHeadings = document.querySelectorAll('.mw-heading');
    allHeadings.forEach(heading => {
        const headingTitle = getHeadingTitle(heading);
        if (!headingTitle) return;
        appendButtonToHeading(heading, createAnnotationButton(pageName, headingTitle));
    });
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
function createAnnotationButton(pageName: string, headingTitle: string): Element {
    return createMwEditSectionButton(
        state.convByVar({hant: '批註', hans: '批注'}),
        state.convByVar({hant: '使用 ReviewTool 小工具添加批註', hans: '使用 ReviewTool 小工具添加批注'}),
        toggleAnnotationMode.bind(null, pageName, headingTitle)
    );
}

function toggleAnnotationMode(pageName: string, headingTitle: string): void {
    state.toggleAnnotationModeState(headingTitle);
    if (state.isAnnotationModeActive(headingTitle)) {
        console.log(`[ReviewTool] 條目「${state.articleTitle}」的章節「${headingTitle}」已啟用批註模式。`);
        // locate section start/end elements and install selection listeners
        const headingEl = Array.from(document.querySelectorAll('.mw-heading')).find(h => getHeadingTitle(h as Element) === headingTitle) as Element | undefined;
        if (headingEl) {
            // section start is the heading element, section end is the next heading with same or higher level
            const allHeadings = Array.from(document.querySelectorAll('.mw-heading')) as Element[];
            const startIndex = allHeadings.indexOf(headingEl);
            let endEl: Element | null = null;
            const getLevel = (el: Element) => {
                const hh = el instanceof HTMLHeadingElement ? el : el.querySelector('h1,h2,h3,h4,h5,h6');
                if (!hh) return 99;
                const tag = (hh as HTMLElement).tagName.toLowerCase();
                const m = tag.match(/h([1-6])/);
                return m ? parseInt(m[1], 10) : 99;
            };
            const currentLevel = getLevel(headingEl);
            for (let i = startIndex + 1; i < allHeadings.length; i++) {
                const lvl = getLevel(allHeadings[i]);
                if (lvl <= currentLevel) { endEl = allHeadings[i]; break; }
            }

            // compute canonical hierarchical sectionPath using ancestor headings (e.g. "H2—H3—H4")
            const parts: string[] = [];
            // start with current heading's title (headingTitle may be id or text from getHeadingTitle)
            parts.unshift(headingTitle);
            let lvlCursor = currentLevel;
            // walk backwards to find nearest ancestor headings of decreasing level
            for (let j = startIndex - 1; j >= 0; j--) {
                const l = getLevel(allHeadings[j]);
                if (l < lvlCursor) {
                    const t = getHeadingTitle(allHeadings[j]);
                    if (t) parts.unshift(t);
                    lvlCursor = l;
                    if (lvlCursor === 1) break; // top most
                }
            }
            const sectionPath = parts.join('—');

            // compute sectionPath using headingTitle and parent headings (simple join)
            annotationUI.installSelectionListenersForSection(state.articleTitle || pageName, headingEl, endEl, sectionPath);
            annotationUI.wrapSectionSentences(headingEl, endEl);
            annotationUI.renderAnnotationBadges(state.articleTitle || pageName, sectionPath);
        }

    } else {
        console.log(`[ReviewTool] 條目「${state.articleTitle}」的章節「${headingTitle}」已停用批註模式。`);
        annotationUI.uninstallSelectionListeners();
        annotationUI.clearWrappedSentences();

    }
}