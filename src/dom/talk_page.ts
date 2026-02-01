import state from "../state";
import {getSectionRegexes, supplementarySectionTitleRegexes} from "../templates";
import {openReviewManagementDialog} from "../dialogs/review_management";
import {openCheckWritingDialog} from "../dialogs/check_writing";
import {appendButtonToHeading, createMwEditSectionButton, getHeadingTitle} from "./utils";

/**
 * 根據討論頁名稱推斷對應的評審條目標題。
 * @param pageName {string} 討論頁名稱
 * @returns {string} 評審條目標題
 */
function deriveSubjectArticleTitle(pageName: string): string {
    if (!pageName) {
        return '';
    }

    if (typeof mw !== 'undefined' && mw?.Title?.newFromText) {
        try {
            const talkTitle = mw.Title.newFromText(pageName);
            const subject = talkTitle?.getSubjectPage?.();
            if (subject?.getPrefixedText) {
                return subject.getPrefixedText();
            }
        } catch (err) {
            console.warn('[ReviewTool] deriveSubjectArticleTitle failed to parse Title', err);
        }
    }

    // Fallback heuristics for common talk namespaces when mw.Title is unavailable
    const replacements: Array<{ regex: RegExp; replacement: string }> = [
        { regex: /^User_talk:/i, replacement: 'User:' },
        { regex: /^Wikipedia_talk:/i, replacement: 'Wikipedia:' },
        { regex: /^Project_talk:/i, replacement: 'Project:' },
        { regex: /^Template_talk:/i, replacement: 'Template:' },
        { regex: /^Help_talk:/i, replacement: 'Help:' },
        { regex: /^Category_talk:/i, replacement: 'Category:' },
        { regex: /^Portal_talk:/i, replacement: 'Portal:' },
        { regex: /^Draft_talk:/i, replacement: 'Draft:' },
        { regex: /^Module_talk:/i, replacement: 'Module:' },
        { regex: /^Talk:/i, replacement: '' }
    ];

    for (const { regex, replacement } of replacements) {
        if (regex.test(pageName)) {
            return pageName.replace(regex, replacement);
        }
    }

    return pageName;
}

/**
 * 根據條目標題與小節標題推斷可能的評級類型。
 * @param articleTitle {string} 評審條目標題
 * @param sectionTitle {string} 當前頁面的小節標題
 * @returns {string | null} 評級類型或 null
 */
function decideAssessmentType(articleTitle: string, sectionTitle: string): string | null {
    let assessmentType: string | null = null;
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
    } else if (articleTitle === 'Wikipedia:Wikipedia:特色列表评选') {
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
    }), state.convByVar({hant: '使用 ReviewTool 小工具管理評審', hans: '使用 ReviewTool 小工具管理评审'}), () => {
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
    }), state.convByVar({hant: '使用 ReviewTool 小工具檢查文筆', hans: '使用 ReviewTool 小工具检查文笔'}), () => {
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
    if (document.querySelector('#review-tool-buttons-added')) return;
    const allSectionHeadings = document.querySelectorAll('.mw-heading.mw-heading2');
    const titleObj = typeof mw !== 'undefined' && mw?.Title?.newFromText ? mw.Title.newFromText(pageName) : null;
    const isTalkPage = (titleObj && typeof titleObj.isTalkPage === 'function' && titleObj.isTalkPage())
        || (typeof namespace === 'number' ? namespace % 2 === 1 : false);

    if (isTalkPage) {
        state.inTalkPage = true;
        const articleTitle = deriveSubjectArticleTitle(pageName);
        state.articleTitle = articleTitle;
        // 篩選評級相關的標題
        const relevantHeadings = Array.from(allSectionHeadings).filter(heading => {
            const sectionTitle = getHeadingTitle(heading);
            if (!sectionTitle) return false;
            return Object.values(getSectionRegexes()).some(regex => regex.test(sectionTitle)) || supplementarySectionTitleRegexes.some(regex => regex.test(sectionTitle));
        });

        relevantHeadings.forEach(heading => {
            const sectionTitle = getHeadingTitle(heading);
            if (!sectionTitle) return;
            appendButtonToHeading(heading, createReviewManagementButton(articleTitle, sectionTitle));
            findAndAppendCheckWritingButton(heading, articleTitle, sectionTitle);
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
    // 標記已添加按鈕
    const marker = document.createElement('div');
    marker.id = 'review-tool-buttons-added';
    marker.style.display = 'none';
    document.querySelector('#mw-content-text .mw-parser-output')?.appendChild(marker);
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
