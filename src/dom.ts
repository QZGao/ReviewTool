import state from "./state";
import {getSectionRegexes} from "./templates";
import {openReviewManagementDialog} from "./dialogs/review_management";
import {openCheckWritingDialog} from "./dialogs/check_writing";

/**
 * 創建 mw-editsection 風格的按鈕元素。
 * @param label {string} 按鈕標籤
 * @param title {string} 按鈕提示文字
 * @param onClick {(e: Event) => void} 按鈕點擊事件處理函數
 * @returns {HTMLElement} mw-editsection 風格的按鈕元素
 */
function createMwEditSectionButton(label: string, title: string, onClick: (e: Event) => void): HTMLElement {
    const button = document.createElement('a');
    button.href = '#';
    button.className = 'review-tool-button';
    button.textContent = label;
    button.setAttribute('title', title);
    button.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
    };

    const leftBracket = document.createElement('span');
    leftBracket.className = 'mw-editsection-bracket';
    leftBracket.textContent = ' [';
    const rightBracket = document.createElement('span');
    rightBracket.className = 'mw-editsection-bracket';
    rightBracket.textContent = ']';
    const buttonGroup = document.createElement('span');
    buttonGroup.className = 'review-tool-button-group';
    buttonGroup.appendChild(leftBracket);
    buttonGroup.appendChild(button);
    buttonGroup.appendChild(rightBracket);
    return buttonGroup;
}

/**
 * 根據條目標題與小節標題推斷可能的評級類型。
 * @param articleTitle {string} 評審條目標題
 * @param sectionTitle {string} 當前頁面的小節標題
 * @returns {string | null} 評級類型或 null
 */
function decideAssessmentType(articleTitle: string, sectionTitle: string): string | null {
    let assessmentType = null;
    if (state.inTalkPage) {
        const sectionRegexes = getSectionRegexes();
        for (const [key, regex] of Object.entries(sectionRegexes)) {
            if (regex.test(sectionTitle)) {
                assessmentType = key;
                break;
            }
        }
    } else if (articleTitle === 'Wikipedia:Wikipedia:優良條目評選') {
        assessmentType = 'good';
    } else if (articleTitle === 'Wikipedia:Wikipedia:典范条目评选') {
        assessmentType = 'featured';
    } else if (articleTitle === 'Wikipedia:Wikipedia:特色列表評選') {
        assessmentType = 'featured_list';
    }
    return assessmentType;
}

/**
 * 創建「評審管理」按鈕元素。
 * @param articleTitle {string} 評審條目標題
 * @param sectionTitle {string} 當前頁面的小節標題
 * @returns {HTMLElement} 「評審管理」按鈕元素
 */
function createReviewManagementButton(articleTitle: string, sectionTitle: string): HTMLElement {
    const assessmentType = decideAssessmentType(articleTitle, sectionTitle);

    return createMwEditSectionButton(state.convByVar({
        hant: '管理評審', hans: '管理评审'
    }), state.convByVar({hant: '使用 ReviewTool 小工具管理評審', hans: '使用 ReviewTool 小工具管理评审'}), (e) => {
        state.articleTitle = articleTitle;
        state.assessmentType = assessmentType;
        openReviewManagementDialog();
    });
}

/**
 * 創建「檢查文筆」按鈕元素。
 * @param articleTitle {string} 評審條目標題
 * @param sectionTitle {string} 當前頁面的小節標題
 * @returns {HTMLElement} 「檢查文筆」按鈕元素
 */
function createCheckWritingButton(articleTitle: string, sectionTitle: string): HTMLElement {
    const assessmentType = decideAssessmentType(articleTitle, sectionTitle);

    return createMwEditSectionButton(state.convByVar({
        hant: '檢查文筆', hans: '检查文笔'
    }), state.convByVar({hant: '使用 ReviewTool 小工具檢查文筆', hans: '使用 ReviewTool 小工具检查文笔'}), (e) => {
        state.articleTitle = articleTitle;
        state.assessmentType = assessmentType;
        openCheckWritingDialog();
    });
}

/**
 * 在 DOM 中添加「評審管理」與「檢查文筆」按鈕。
 * @param namespace {number} 當前頁面命名空間編號
 * @param pageName {string} 當前頁面名稱
 */
export function addButtonsToDOM(namespace: number, pageName: string): void {
    const allSectionHeadings = document.querySelectorAll('.mw-heading.mw-heading2');
    if (namespace === 1) { // 討論頁
        state.inTalkPage = true;
        // 篩選評級相關的標題
        const relevantHeadings = Array.from(allSectionHeadings).filter(heading => {
            const sectionTitle = getSectionTitle(heading);
            if (!sectionTitle) return false;
            return Object.values(getSectionRegexes()).some(regex => regex.test(sectionTitle));
        });

        relevantHeadings.forEach(heading => {
            const sectionTitle = getSectionTitle(heading);
            if (!sectionTitle) return;
            appendButtonToHeading(heading, pageName.replace('Talk:', ''), sectionTitle, 'review');
            findAndAppendCheckWritingButton(heading, pageName.replace('Talk:', ''), sectionTitle);
        });
    } else { // 評選頁面
        state.inTalkPage = false;
        // 所有二級標題
        allSectionHeadings.forEach(heading => {
            const sectionTitle = getSectionTitle(heading);
            if (!sectionTitle) return;
            appendButtonToHeading(heading, sectionTitle, sectionTitle, 'review');
            findAndAppendCheckWritingButton(heading, sectionTitle, sectionTitle);
        });
    }
}

/**
 * 在指定的 mw-heading2 元素下尋找所有 mw-heading 元素，並在符合「文筆」標題的章節中附加「檢查文筆」按鈕。
 * @param heading2 {Element} mw-heading2 元素
 * @param articleTitle {string} 評審條目標題
 * @param sectionTitle {string} 當前頁面的小節標題
 */
function findAndAppendCheckWritingButton(heading2: Element, articleTitle: string, sectionTitle: string): void {
    // All headings between this mw-heading2 and the next mw-heading2
    let sibling = heading2.nextElementSibling;
    while (sibling && !sibling.classList.contains('mw-heading2')) {
        if (sibling.classList.contains('mw-heading')) {
            const secTitle = getSectionTitle(sibling);
            if (secTitle && /文[筆笔]/.test(secTitle)) {
                appendButtonToHeading(sibling, articleTitle, sectionTitle, 'check');
            }
        }
        sibling = sibling.nextElementSibling;
    }
}

/**
 * 在 mw-heading 元素中提取章節標題。
 * @param heading {Element} mw-heading 元素
 * @returns {string | null} 章節標題或 null
 */
function getSectionTitle(heading: Element): string | null {
    if (!heading) return null;
    // the heading might already be an HTMLHeadingElement
    const htmlHeading = heading instanceof HTMLHeadingElement ? heading : heading.querySelector('h1, h2, h3, h4, h5, h6');
    if (!htmlHeading) return null;
    // prefer explicit id on the HTMLHeadingElement
    if ((htmlHeading as HTMLElement).id) return (htmlHeading as HTMLElement).id;
    // some wikis put an inner span with the encoded id (e.g. .E4.B9...)
    const innerWithId = htmlHeading.querySelector('[id]');
    if (innerWithId && (innerWithId as HTMLElement).id) return (innerWithId as HTMLElement).id;
    // fallback to data-mw-thread-id
    const threadId = htmlHeading.getAttribute && htmlHeading.getAttribute('data-mw-thread-id');
    if (threadId) return threadId;
    // last resort: use the visible text
    const text = htmlHeading.textContent && htmlHeading.textContent.trim();
    return text || null;
}

/**
 * 在指定的 mw-heading 元素中附加「評審管理」按鈕。
 * @param heading {Element} mw-heading 元素
 * @param articleTitle {string} 評審條目標題
 * @param sectionTitle {string} 當前頁面的小節標題
 * @param buttonType {'review' | 'check'} 按鈕類型
 */
function appendButtonToHeading(heading: Element, articleTitle: string, sectionTitle: string, buttonType: 'review' | 'check'): void {
    const mwEditSection = heading.querySelector('.mw-editsection');
    if (!mwEditSection) return;
    if (buttonType === 'review') {
        mwEditSection.appendChild(createReviewManagementButton(articleTitle, sectionTitle));
    } else if (buttonType === 'check') {
        mwEditSection.appendChild(createCheckWritingButton(articleTitle, sectionTitle));
    }
}