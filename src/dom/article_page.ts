import {appendButtonToHeading, createMwEditSectionButton, getHeadingTitle} from "./utils";
import state from "../state";

/**
 * 給所有 mw-headings 添加「批註」按鈕。
 * @param pageName
 */
export function addMainPageReviewToolButtonsToDOM(pageName: string): void {
    const allHeadings = document.querySelectorAll('.mw-heading');
    allHeadings.forEach(heading => {
        const headingTitle = getHeadingTitle(heading);
        if (!headingTitle) return;
        appendButtonToHeading(heading, createAnnotationButton(headingTitle));
    });
}

/**
 * 創建一個「批註」按鈕元素。
 * @param headingTitle {string} 章節標題
 */
function createAnnotationButton(headingTitle: string): Element {
    return createMwEditSectionButton(
        state.convByVar({hant: '批註', hans: '批注'}),
        state.convByVar({hant: '使用 ReviewTool 小工具添加批註', hans: '使用 ReviewTool 小工具添加批注'}),
        toggleAnnotationMode.bind(null, headingTitle)
    );
}

function toggleAnnotationMode(headingTitle: string): void {
    state.toggleAnnotationModeState(headingTitle);
    if (state.isAnnotationModeActive(headingTitle)) {
        console.log(`[ReviewTool] 條目「${state.articleTitle}」的章節「${headingTitle}」已啟用批註模式。`);

    } else {
        console.log(`[ReviewTool] 條目「${state.articleTitle}」的章節「${headingTitle}」已停用批註模式。`);

    }
}