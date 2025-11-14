import state from "../state";
import {getSectionRegexes} from "../templates";
import {openReviewManagementDialog} from "../dialogs/review_management";
import {openCheckWritingDialog} from "../dialogs/check_writing";
import {appendButtonToHeading, createMwEditSectionButton, getHeadingTitle} from "./utils";

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
export function addTalkPageReviewToolButtonsToDOM(namespace: number, pageName: string): void {
    const allSectionHeadings = document.querySelectorAll('.mw-heading.mw-heading2');
    if (namespace === 1) { // 討論頁
        state.inTalkPage = true;
        // 篩選評級相關的標題
        const relevantHeadings = Array.from(allSectionHeadings).filter(heading => {
            const sectionTitle = getHeadingTitle(heading);
            if (!sectionTitle) return false;
            return Object.values(getSectionRegexes()).some(regex => regex.test(sectionTitle));
        });

        relevantHeadings.forEach(heading => {
            const sectionTitle = getHeadingTitle(heading);
            if (!sectionTitle) return;
            appendButtonToHeading(heading, createReviewManagementButton(pageName.replace('Talk:', ''), sectionTitle));
            findAndAppendCheckWritingButton(heading, pageName.replace('Talk:', ''), sectionTitle);
        });
    } else { // 評選頁面
        state.inTalkPage = false;
        // 所有二級標題
        allSectionHeadings.forEach(heading => {
            const sectionTitle = getHeadingTitle(heading);
            if (!sectionTitle) return;
            appendButtonToHeading(heading, createReviewManagementButton(sectionTitle, sectionTitle));
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
            const secTitle = getHeadingTitle(sibling);
            if (secTitle && /文[筆笔]/.test(secTitle)) {
                appendButtonToHeading(sibling, createCheckWritingButton(articleTitle, sectionTitle));
            }
        }
        sibling = sibling.nextElementSibling;
    }
}
