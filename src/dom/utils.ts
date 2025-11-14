/**
 * 創建 mw-editsection 風格的按鈕元素。
 * @param label {string} 按鈕標籤
 * @param title {string} 按鈕提示文字
 * @param onClick {(e: Event) => void} 按鈕點擊事件處理函數
 * @returns {HTMLElement} mw-editsection 風格的按鈕元素
 */
export function createMwEditSectionButton(label: string, title: string, onClick: (e: Event) => void): HTMLElement {
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
 * 在 mw-heading 元素中提取章節標題。
 * @param heading {Element} mw-heading 元素
 * @returns {string | null} 章節標題或 null
 */
export function getHeadingTitle(heading: Element): string | null {
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
 * 在指定的 mw-heading 元素中附加按鈕。
 * @param heading {Element} mw-heading 元素
 * @param button {Element} 按鈕元素
 */
export function appendButtonToHeading(heading: Element, button: Element): void {
    const mwEditSection = heading.querySelector('.mw-editsection');
    if (!mwEditSection) return;
    mwEditSection.append(button);
}