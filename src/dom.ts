import { openReviewDialog } from "./app";
import state from "./state";
import { getSectionRegexes } from "./templates";

/**
 * 創建 ReviewTool 按鈕元素。
 * @param articleTitle {string} 評審條目標題
 * @param sectionTitle {string} 當前頁面的小節標題
 * @returns {HTMLElement} ReviewTool 按鈕元素
 */
function createReviewToolButton(articleTitle: string, sectionTitle: string): HTMLElement {
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
    } else if (articleTitle === 'Wikipedia:Wikipedia:特色列表評选') {
        assessmentType = 'featured_list';
    }

    const reviewToolButton = document.createElement('a');
    reviewToolButton.href = '#';
    reviewToolButton.className = 'review-tool-button';
    reviewToolButton.textContent = 'ReviewTool';
    reviewToolButton.setAttribute('title', state.convByVar({ hant: '打開 ReviewTool', hans: '打开 ReviewTool' }));
    reviewToolButton.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.articleTitle = articleTitle;
        state.assessmentType = assessmentType;
        openReviewDialog();
    };

    const leftBracket = document.createElement('span');
    leftBracket.className = 'mw-editsection-bracket';
    leftBracket.textContent = ' [';
    const rightBracket = document.createElement('span');
    rightBracket.className = 'mw-editsection-bracket';
    rightBracket.textContent = ']';

    const reviewToolButtonGroup = document.createElement('span');
    reviewToolButtonGroup.className = 'review-tool-button-group';
    reviewToolButtonGroup.appendChild(leftBracket);
    reviewToolButtonGroup.appendChild(reviewToolButton);
    reviewToolButtonGroup.appendChild(rightBracket);
    return reviewToolButtonGroup;
}

/**
 * 在 DOM 中添加 ReviewTool 按鈕。
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
            appendReviewButtonToHeading(heading, pageName.replace('Talk:', ''), sectionTitle);
        });
    } else { // 評選頁面
        state.inTalkPage = false;
        // 所有二級標題
        allSectionHeadings.forEach(heading => {
            const sectionTitle = getSectionTitle(heading);
            if (!sectionTitle) return;
            appendReviewButtonToHeading(heading, sectionTitle, sectionTitle);
        });
    }
}

/**
 * 在 mw-heading2 元素中提取章節標題。
 * @param heading {Element} mw-heading2 元素
 * @returns {string | null} 章節標題或 null
 */
function getSectionTitle(heading: Element): string | null {
    if (!heading) return null;
    // the heading might already be an H2
    const h2 = heading instanceof HTMLHeadingElement ? heading : heading.querySelector('h2');
    if (!h2) return null;
    // prefer explicit id on the h2
    if ((h2 as HTMLElement).id) return (h2 as HTMLElement).id;
    // some wikis put an inner span with the encoded id (e.g. .E4.B9...)
    const innerWithId = h2.querySelector('[id]');
    if (innerWithId && (innerWithId as HTMLElement).id) return (innerWithId as HTMLElement).id;
    // fallback to data-mw-thread-id
    const threadId = h2.getAttribute && h2.getAttribute('data-mw-thread-id');
    if (threadId) return threadId;
    // last resort: use the visible text
    const text = h2.textContent && h2.textContent.trim();
    return text || null;
}

/**
 * 在指定的 mw-heading2 元素中附加 ReviewTool 按鈕。
 * @param heading {Element} mw-heading2 元素
 * @param articleTitle {string} 評審條目標題
 * @param sectionTitle {string} 當前頁面的小節標題
 */
function appendReviewButtonToHeading(heading: Element, articleTitle: string, sectionTitle: string): void {
    const mwEditSection = heading.querySelector('.mw-editsection');
    if (!mwEditSection) return;
    mwEditSection.appendChild(createReviewToolButton(articleTitle, sectionTitle));
}