import {addPortletTrigger, addVectorMenuTab, getHeadingTitle} from "./utils";
import state from "../state";
import {
    createAnnotation,
    deleteAnnotation,
    getAnnotation,
    updateAnnotation,
    buildAnnotationGroups,
    clearAnnotations
} from "../annotations";
import {openAnnotationEditorDialog} from "../dialogs/annotation_editor";
import {
    closeAnnotationViewerDialog,
    isAnnotationViewerDialogOpen,
    openAnnotationViewerDialog,
    updateAnnotationViewerDialogGroups
} from "../dialogs/annotation_viewer";
import { getElementOrderKey } from "./numeric_pos";

let floatingButton: HTMLElement | null = null;
const ANNOTATION_CONTAINER_CLASS = 'review-tool-annotation-ui';
const SENTENCE_CLASS = 'sentence';
const FLOATING_BUTTON_CLASS = 'floating-button';

let activeSectionStart: Element | null = null;
let activeSectionEnd: Element | null = null;
let activeSectionPath: string | null = null;
let activePageName: string | null = null;
let restrictSelectionToDescendants = false;
let isMouseDown = false; // new flag to ignore selectionchange during drag
let mouseDownPos: { x: number, y: number } | null = null; // track mouse position to detect drag vs click

const HIDE_DELAY_MS = 180;
const SELECTION_SHOW_DELAY_MS = 120;

let selectionShowTimer: number | null = null;
let floatingHideTimer: number | null = null;
const inlineAnnotationBubbles = new Map<string, HTMLElement>();

const ARTICLE_ANNOTATION_KEY = '__article__';
const REVIEWTOOL_PORTLET_ID = 'ca-reviewtool-toggle';

// Remove common reference/decoration nodes from an element clone and return cleaned text
function getCleanTextFromElement(el: Element | null): string {
    if (!el) return '';
    const clone = el.cloneNode(true) as Element;
    try {
        // Remove typical ref/citation decorations that shouldn't be part of the sentence
        clone.querySelectorAll('sup.reference, sup.mw-ref, .reference, .mw-ref, .citation, .ref, .reference-text, .qeec-ref-tag-copy-btn').forEach(n => n.remove());
        // Remove elements commonly used by extensions/widgets
        clone.querySelectorAll('[data-reference], [data-ref], .reference-note, .qeec-ref-tag-copy-btn').forEach(n => n.remove());
    } catch (e) {
        console.error('[ReviewTool][getCleanTextFromElement] failed to remove decoration nodes', e);
        throw e;
    }
    const txt = clone.textContent || '';
    // fallback: remove any lingering UI text like "Copy permalink"
    return txt.replace(/Copy permalink/g, '').replace(/\s+/g, ' ').trim();
}

// Remove decoration nodes from an arbitrary container element
function removeDecorationsFromContainer(container: Element) {
    try {
        container.querySelectorAll('sup.reference, sup.mw-ref, .reference, .mw-ref, .citation, .ref, .reference-text, .qeec-ref-tag-copy-btn, style, ipe-quick-edit').forEach(n => n.remove());
        container.querySelectorAll('[data-reference], [data-ref], .reference-note, .qeec-ref-tag-copy-btn').forEach(n => n.remove());
    } catch (e) {
        console.error('[ReviewTool][removeDecorationsFromContainer] failed', e);
        throw e;
    }
}

// Get cleaned text from a Range by cloning its contents and removing decorations
function getCleanTextFromRange(range: Range | null): string {
    if (!range) return '';
    const frag = range.cloneContents();
    const wrapper = document.createElement('div');
    wrapper.appendChild(frag);
    removeDecorationsFromContainer(wrapper);
    let txt = wrapper.textContent || '';
    // fallback cleanup
    txt = txt.replace(/Copy permalink/g, '');
    return txt.replace(/\s+/g, ' ').trim();
}

// Sanitize plain text (e.g. from Range#toString) by stripping obvious citation markers
function sanitizePlainText(text?: string | null): string {
    if (!text) return '';
    // remove bracketed numeric references like [1], [23]
    let s = text.replace(/\[\s*\d+\s*\]/g, '');
    // remove superscript numbers commonly copied as plain digits
    s = s.replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]+/g, '');
    // collapse whitespace
    return s.replace(/\s+/g, ' ').trim();
}

export function installSelectionListenersForSection(
    pageName: string,
    sectionStart: Element,
    sectionEnd: Element,
    sectionPath: string,
    restrictToDescendants = false
) {
    uninstallSelectionListeners();
    activeSectionStart = sectionStart;
    activeSectionEnd = sectionEnd;
    activeSectionPath = sectionPath;
    activePageName = pageName;
    restrictSelectionToDescendants = restrictToDescendants;

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mouseup', onMouseUp as any);
    document.addEventListener('mousedown', onMouseDown as any); // listen for mousedown to detect drag/selection start
    document.addEventListener('touchstart', onTouchStart as any, {passive: true});
    document.addEventListener('touchend', onTouchEnd as any);
}

export function uninstallSelectionListeners() {
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('touchstart', onTouchStart);
    document.removeEventListener('touchend', onTouchEnd);
    // clear timers
    if (selectionShowTimer) {
        clearTimeout(selectionShowTimer);
        selectionShowTimer = null;
    }
    if (floatingHideTimer) {
        clearTimeout(floatingHideTimer);
        floatingHideTimer = null;
    }
    hideFloatingButton();
    // Ensure cursor state is restored
    document.documentElement.classList.remove('rt-selecting');
    activeSectionStart = null;
    activeSectionEnd = null;
    activeSectionPath = null;
    activePageName = null;
    restrictSelectionToDescendants = false;
}

function isNodeWithinSection(node: Node | null): boolean {
    if (!node || !activeSectionStart) return false;
    // Prefer an Element ancestor for location checks
    let el: Element | null = null;
    if (node.nodeType === Node.TEXT_NODE) el = (node as Text).parentElement; else if (node instanceof Element) el = node as Element;
    if (!el) return false;

    // If the element is the section start or contained within it, it's inside
    if (activeSectionStart === el || activeSectionStart.contains(el)) return true;

    // If there's no explicit section end, any node after start is considered inside
    if (!activeSectionEnd) {
        if (restrictSelectionToDescendants) {
            return false;
        }
        return (activeSectionStart.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }

    // Otherwise, check start < el < end
    const startBeforeEl = (activeSectionStart.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const elBeforeEnd = (el.compareDocumentPosition(activeSectionEnd) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    return startBeforeEl && elBeforeEnd;
}

function selectionInsideActiveSection(): Range | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!activeSectionStart) return null;
    // ensure both startContainer and endContainer are within the section
    const startIn = isNodeWithinSection(range.startContainer as Node);
    const endIn = isNodeWithinSection(range.endContainer as Node);
    // If either endpoint is outside the section, ignore
    if (!startIn || !endIn) return null;
    return range;
}

function onMouseDown(e?: MouseEvent) {
    // Ignore mousedown on floating button to allow clicking it
    const target = e?.target as Node | undefined;
    if (target && floatingButton && (target === floatingButton || floatingButton.contains(target))) {
        return;
    }
    // Track mouse position to detect drag vs click
    if (e) {
        mouseDownPos = {x: e.clientX, y: e.clientY};
    }
    // When user starts pressing mouse, ignore selectionchange events until mouseup.
    isMouseDown = true;
    // Add selecting class to switch cursor to I-beam during drag selection
    document.documentElement.classList.add('rt-selecting');
    hideFloatingButton();
}

function onMouseUp(e?: MouseEvent) {
    // Ignore mouseup originating from the floating button
    const target = e?.target as Node | undefined;
    if (target && floatingButton && (target === floatingButton || floatingButton.contains(target))) {
        isMouseDown = false;
        mouseDownPos = null;
        // Remove selecting class
        document.documentElement.classList.remove('rt-selecting');
        return;
    }
    // End of drag/selection — allow processing and run selection handler once.
    isMouseDown = false;
    mouseDownPos = null;
    // Remove selecting class
    document.documentElement.classList.remove('rt-selecting');
    onSelectionChange();
}

function wasMouseDragged(e: MouseEvent): boolean {
    // If we didn't track the initial position, treat as a simple click
    if (!mouseDownPos) return false;

    // Calculate distance moved
    const dx = Math.abs(e.clientX - mouseDownPos.x);
    const dy = Math.abs(e.clientY - mouseDownPos.y);

    // If moved more than 3 pixels in any direction, it's a drag
    return dx > 3 || dy > 3;
}

function onTouchStart(e?: TouchEvent) {
    // Ignore touchstart on floating button
    const target = e?.target as Node | undefined;
    if (target && floatingButton && (target === floatingButton || floatingButton.contains(target))) {
        return;
    }
    isMouseDown = true;
    // Add selecting class as a conservative default (has no effect on touch cursors but keeps logic consistent)
    document.documentElement.classList.add('rt-selecting');
    hideFloatingButton();
}

function onTouchEnd(e?: TouchEvent) {
    // Ignore touchend on floating button
    const target = e?.target as Node | undefined;
    if (target && floatingButton && (target === floatingButton || floatingButton.contains(target))) {
        isMouseDown = false;
        document.documentElement.classList.remove('rt-selecting');
        return;
    }
    isMouseDown = false;
    document.documentElement.classList.remove('rt-selecting');
    onSelectionChange();
}

function onSelectionChange() {
    // Ignore live selectionchange events while mouse is down (dragging) — only respond on mouseup.
    if (isMouseDown) return;
    // Debounce selection handling to avoid heavy real-time work
    if (selectionShowTimer) {
        clearTimeout(selectionShowTimer);
        selectionShowTimer = null;
    }
    selectionShowTimer = window.setTimeout(() => {
        const selectionRange = selectionInsideActiveSection();
        if (!selectionRange) {
            hideFloatingButton();
            return;
        }
        const rect = selectionRange.getBoundingClientRect();
        // Center on the actual selection, clamped to viewport
        const centerX = Math.max(40, Math.min(window.innerWidth - 40, rect.left + rect.width / 2));
        const topY = Math.max(8, rect.top + window.scrollY - 8);
        const rangeClone = selectionRange.cloneRange();
        showFloatingButton(centerX + window.scrollX, topY, () => {
            // Prefer cleaning the actual Range contents (so we can remove DOM decorations like copy buttons)
            const selectedText = getCleanTextFromRange(selectionRange);
            if (!selectedText) {
                hideFloatingButton();
                return;
            }
            if (activePageName) {
                hideFloatingButton();
                const sel = document.getSelection();
                sel && sel.removeAllRanges();
                const computedSectionPath = computeSectionPathFromNode(selectionRange ? selectionRange.startContainer : null);
                const sentencePos = computeSentenceOrderKey(selectionRange ? selectionRange.startContainer : null);
                openAnnotationDialog(activePageName, null, computedSectionPath, {
                    sentenceText: selectedText,
                    selectionRange: rangeClone,
                    sentencePos
                });
            }
        });
    }, SELECTION_SHOW_DELAY_MS);
}

function findAncestorSentence(node: Node | null): Element | null {
    let cur: Node | null = node;
    while (cur && cur !== document.body) {
        if (cur instanceof Element && (cur as Element).classList.contains(SENTENCE_CLASS)) return cur as Element;
        cur = cur.parentNode;
    }
    return null;
}

function computeSentenceOrderKey(target: Node | Element | null): string {
    const sentenceEl = (() => {
        if (!target) return null;
        if (target instanceof Element) {
            return target.classList.contains(SENTENCE_CLASS) ? target : findAncestorSentence(target);
        }
        return findAncestorSentence(target as Node | null);
    })();
    if (!sentenceEl) return '';
    return getElementOrderKey(sentenceEl) || '';
}

// --- Section path helpers -------------------------------------------------
function previousNode(node: Node | null): Node | null {
    if (!node) return null;
    if (node.previousSibling) {
        let p = node.previousSibling;
        let pp: any = node.previousSibling;
        while (pp && pp.lastChild) pp = pp.lastChild;
        return pp as Node | null;
    }
    return node.parentNode;
}

function nextNode(node: Node | null): Node | null {
    if (!node) return null;
    if (node.firstChild) return node.firstChild;
    let n: Node | null = node;
    while (n) {
        if (n.nextSibling) return n.nextSibling;
        n = n.parentNode;
    }
    return null;
}

function findHeadingElementFromNode(node: Node | null): Element | null {
    let cur: Node | null = node;
    while (cur) {
        if (cur instanceof Element) {
            const el = cur as Element;
            const tag = (el.tagName || '').toLowerCase();
            if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return el;
            if (el.classList && el.classList.contains('mw-heading')) return el;
        }
        cur = cur.parentNode;
    }
    return null;
}

function getHeadingLevelAndTitle(el: Element | null): { level: number | null, title: string | null } {
    if (!el) return {level: null, title: null};
    const tag = (el.tagName || '').toLowerCase();
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        const level = parseInt(tag.charAt(1), 10);
        const title = getHeadingTitle(el) || null;
        return {level, title};
    }
    const inner = el.querySelector('h1,h2,h3,h4,h5,h6');
    if (inner) {
        const lvl = parseInt((inner.tagName || '').charAt(1), 10);
        const title = getHeadingTitle(el) || getHeadingTitle(inner as Element) || null;
        return {level: lvl, title};
    }
    const t = getHeadingTitle(el);
    return {level: null, title: t};
}

function findPreviousHeadingOfLevel(startNode: Node | null, targetLevel: number): Element | null {
    let n: Node | null = startNode;
    while (n) {
        n = previousNode(n);
        if (!n) break;
        const h = findHeadingElementFromNode(n);
        if (h) {
            const info = getHeadingLevelAndTitle(h);
            if (info.level === targetLevel) return h;
        }
    }
    return null;
}

function computeSectionPathFromNode(startNode: Node | null): string {
    const pageFallback = state.articleTitle || state.convByVar({hant: '導言', hans: '导言'});
    if (!startNode) return pageFallback;
    let anchor: Node | null = startNode;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = (anchor as Text).parentNode;
    if (!anchor) return pageFallback;

    // Walk strictly backwards from the start position and collect the nearest
    // heading for each level. This ensures we pick the closest H3 rather than
    // an earlier sibling H3 that appears before it.
    const nearestByLevel = new Map<number, string>();
    let cur: Node | null = anchor;
    while (cur) {
        cur = previousNode(cur);
        if (!cur) break;
        const hEl = findHeadingElementFromNode(cur);
        if (!hEl) continue;
        const info = getHeadingLevelAndTitle(hEl);
        if (!info.title || info.level === null) continue;
        // Skip h1: don't treat page title as a section
        if (info.level === 1) continue;
        // If we already found a nearer heading for this level, skip
        if (nearestByLevel.has(info.level)) continue;
        nearestByLevel.set(info.level, info.title);
        // Stop early when we have found an H2 (top-level section)
        if (info.level === 2) break;
    }

    if (nearestByLevel.size === 0) return pageFallback;

    // Build ordered parts from H2 -> H6 using nearest found titles
    const parts: string[] = [];
    for (let lvl = 2; lvl <= 6; lvl++) {
        if (nearestByLevel.has(lvl)) parts.push(nearestByLevel.get(lvl) as string);
    }
    return parts.join('—');
}

// -------------------------------------------------------------------------

function showFloatingButton(x: number, y: number, onClick: () => void) {
    if (!floatingButton) {
        floatingButton = document.createElement('button');
        floatingButton.className = `${ANNOTATION_CONTAINER_CLASS} ${FLOATING_BUTTON_CLASS}`;
        floatingButton.textContent = state.convByVar({hant: '批註', hans: '批注'});
        floatingButton.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            onClick();
        };
        // keep pointer events working
        floatingButton.style.pointerEvents = 'auto';
        document.body.appendChild(floatingButton);
    } else {
        // update click handler
        floatingButton.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            onClick();
        };
    }
    if (floatingHideTimer) {
        clearTimeout(floatingHideTimer);
        floatingHideTimer = null;
    }
    floatingButton.style.position = 'absolute';
    floatingButton.style.left = `${x}px`;
    floatingButton.style.top = `${y}px`;
    floatingButton.style.transform = 'translate(-50%, -100%)';
    floatingButton.style.zIndex = '9999';
    floatingButton.style.display = 'block';

    // when moving pointer from sentence to button, avoid hiding immediately
    floatingButton.onmouseenter = () => {
        if (floatingHideTimer) {
            clearTimeout(floatingHideTimer);
            floatingHideTimer = null;
        }
    };
    floatingButton.onmouseleave = () => {
        if (floatingHideTimer) {
            clearTimeout(floatingHideTimer);
        }
        floatingHideTimer = window.setTimeout(() => hideFloatingButton(), HIDE_DELAY_MS);
    };
}

function hideFloatingButton() {
    if (floatingHideTimer) {
        clearTimeout(floatingHideTimer);
        floatingHideTimer = null;
    }
    if (floatingButton) {
        floatingButton.style.display = 'none';
    }
}

// Wrap text nodes inside the section into sentence spans, handling nested markup (templates, references, etc.)
export function wrapSectionSentences(sectionStart: Element, sectionEnd: Element | null) {
    function getComputedLang(node: Node | null): string | null {
        let el: Element | null = null;
        if (node instanceof Element) el = node;
        if (!el && node && node.parentElement) el = node.parentElement;
        while (el) {
            const lang = el.getAttribute('lang') || el.getAttribute('xml:lang');
            if (lang) return lang.toLowerCase();
            el = el.parentElement;
        }
        const docLang = document.documentElement?.getAttribute('lang');
        return docLang ? docLang.toLowerCase() : null;
    }

    function shouldTreatHalfWidthTerminators(lang: string | null): boolean {
        if (!lang) return false; // default to zh wiki behavior
        return !(lang.startsWith('zh') || lang.startsWith('ja'));
    }

    function getSentenceTerminatorRegex(allowHalfWidth: boolean): RegExp {
        const terminators = allowHalfWidth ? '。！？?!….' : '。！？…';
        return new RegExp(`[」』】〗〕\\)\\]\\}\\"'’”〉》]*[${terminators}]+[」』】〗〕\\)\\]\\}\\"'’”〉》]*`, 'g');
    }

    function splitTextToPartsSimple(text: string, allowHalfWidth: boolean): string[] {
        const terminators = allowHalfWidth
            ? '。！？!?；;」』】〗〕\\]］}｝\\.'
            : '。！？；;」』】〗〕\\]］}｝';
        const re = new RegExp(`(?<=[${terminators}])\\s*`, 'g');
        return text.split(re).filter(p => p.trim());
    }

    // Helper to check if an element should be skipped (belongs to other scripts/widgets)
    function shouldSkipElement(node: Node): boolean {
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        const el = node as Element;

        // Skip elements that are already wrapped by us
        if (el.classList.contains(ANNOTATION_CONTAINER_CLASS)) return true;

        // Skip elements with data attributes indicating they're from other scripts
        if (el.hasAttribute('data-gadget') || el.hasAttribute('data-widget')) return true;

        // Skip common script-inserted containers
        const skipClasses = [
            'mw-editsection', 'mw-indicator', 'navbox', 'infobox', 'metadata', 'noprint', 'navigation', 'catlinks',
            'printfooter', 'mw-jump-link', 'skin-',  // prefix match for skin-specific elements
            'vector-',  // prefix match for Vector skin elements
            'qeec-ref-tag-copy-btn', 'ipe__in-article-link', 'ipe-quick-edit', 'ipe-quick-edit--create-only',
        ];

        for (const cls of skipClasses) {
            if (el.className && (el.classList.contains(cls) || (typeof el.className === 'string' && el.className.includes(cls)))) {
                return true;
            }
        }

        // Skip elements with certain IDs that indicate non-content
        if (el.id) {
            if (el.id.startsWith('mw-') || el.id.startsWith('footer-') || el.id.startsWith('p-') || el.id === 'siteSub' || el.id === 'contentSub') {
                return true;
            }
        }

        return false;
    }

    // Collect all elements between sectionStart and sectionEnd (not inclusive of sectionEnd)
    // If the provided sectionStart is a container for the whole article (e.g. '.mw-parser-output'),
    // treat its child nodes as the section elements. Otherwise iterate siblings after sectionStart.
    const sectionElements: Node[] = [];
    if (sectionStart && sectionStart.childNodes && sectionStart.childNodes.length > 0 && !sectionEnd) {
        // treat children of the container as the section
        sectionStart.childNodes.forEach((n) => {
            if (!shouldSkipElement(n)) sectionElements.push(n); else console.log('[ReviewTool] Skipping element to preserve other scripts:', n);
        });
    } else {
        let cur: Node | null = sectionStart.nextSibling;
        while (cur && cur !== sectionEnd) {
            // Only collect nodes that are safe to process
            if (!shouldSkipElement(cur)) {
                sectionElements.push(cur);
            } else {
                console.log('[ReviewTool] Skipping element to preserve other scripts:', cur);
            }
            cur = cur.nextSibling;
        }
    }

    let sentenceIndex = 0;
    console.log('[ReviewTool] wrapSectionSentences: processing', sectionElements.length, 'child nodes');

    // Helper to split a block element's concatenated text into sentence ranges
    function splitTextIntoRanges(text: string, lang: string | null): Array<{ start: number, end: number }> {
        // Use a regex-based splitter that recognizes both Chinese and Western sentence terminators.
        // This is more robust for mixed-language content than single-character scanning.
        const ranges: Array<{ start: number, end: number }> = [];
        if (!text || !text.trim()) return ranges;

        // Match sentence-ending punctuation sequences including surrounding closing
        // quotes/brackets. This will include cases like:
        //  - "sentence."  (terminator before closing quote)
        //  - "sentence".  (terminator after closing quote)
        // and will recognise CJK terminators such as '。', '？', '！' and ellipsis '…'.
        const re = getSentenceTerminatorRegex(shouldTreatHalfWidthTerminators(lang));
        let lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const endPos = re.lastIndex;
            const part = text.slice(lastIndex, endPos);
            if (part.trim()) ranges.push({start: lastIndex, end: endPos});
            lastIndex = endPos;
        }
        // trailing text
        if (lastIndex < text.length) {
            const tail = text.slice(lastIndex);
            if (tail.trim()) ranges.push({start: lastIndex, end: text.length});
        }

        // If regex splitting produced only a single range but the text contains multiple segments
        // (e.g. sentences separated by newlines or missing terminal punctuation), try a fallback
        // splitter that also splits on newlines or multiple spaces.
        if (ranges.length <= 1) {
            const alt: Array<{ start: number, end: number }> = [];
            const altRe = new RegExp(`${getSentenceTerminatorRegex(shouldTreatHalfWidthTerminators(lang)).source}|(?:\\r?\\n)+|(?:\\s{2,})`, 'g');
            let last = 0;
            let mm: RegExpExecArray | null;
            while ((mm = altRe.exec(text)) !== null) {
                const endPos = altRe.lastIndex;
                const part = text.slice(last, endPos);
                if (part.trim()) alt.push({start: last, end: endPos});
                last = endPos;
            }
            if (last < text.length) {
                const tail2 = text.slice(last);
                if (tail2.trim()) alt.push({start: last, end: text.length});
            }
            if (alt.length > 1) {
                return alt;
            }
        }

        return ranges;
    }

    // Process an element root - gather its text nodes and map offsets
    function processElementRoot(root: Element) {
        const allowHalfWidth = shouldTreatHalfWidthTerminators(getComputedLang(root));
        // If this root has element children that are non-inline (block/boundary),
        // process each child separately to avoid creating ranges that span across
        // sibling block elements (which breaks lists, tables, etc.). However,
        // treat common inline elements (like <a>, <span>, <em>, <strong>) as
        // transparent so their text is included in the same sentence span.
        function isInlineElement(el: Element) {
            if (!el || !el.tagName) return false;
            const t = el.tagName.toLowerCase();
            const inlineTags = new Set([
                'a', 'span', 'em', 'strong', 'b', 'i', 'small', 'sup', 'sub', 'code', 'cite', 'abbr', 'time', 'mark',
                'var', 'img', 'kbd'
            ]);
            return inlineTags.has(t);
        }

        const elementChildren = Array.from(root.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE) as Element[];
        const hasNonInlineElementChildren = elementChildren.some(el => !isInlineElement(el));
        if (hasNonInlineElementChildren) {
            // process children individually so we don't span across block/boundary elements
            Array.from(root.childNodes).forEach((child) => {
                if (child.nodeType === Node.TEXT_NODE) {
                    // simple inline text splitting for direct text nodes
                    const textNode = child as Text;
                    const text = textNode.nodeValue || '';
                    if (!text.trim()) return;
                    const parts = splitTextIntoRanges(text, getComputedLang(textNode)).map(r => text.slice(r.start, r.end)).filter(p => p.trim());
                    if (parts.length <= 1) {
                        const span = document.createElement('span');
                        span.className = `${ANNOTATION_CONTAINER_CLASS} ${SENTENCE_CLASS}`;
                        span.setAttribute('data-sentence-index', String(sentenceIndex++));
                        span.textContent = text;
                        textNode.parentNode && textNode.parentNode.replaceChild(span, textNode);
                    } else {
                        const frag = document.createDocumentFragment();
                        parts.forEach(part => {
                            const span = document.createElement('span');
                            span.className = `${ANNOTATION_CONTAINER_CLASS} ${SENTENCE_CLASS}`;
                            span.setAttribute('data-sentence-index', String(sentenceIndex++));
                            span.textContent = part;
                            frag.appendChild(span);
                        });
                        textNode.parentNode && textNode.parentNode.replaceChild(frag, textNode);
                    }
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    processElementRoot(child as Element);
                }
            });
            return;
        }

        // Custom filter to skip text nodes inside elements we want to preserve
        const filterNode = (node: Node): number => {
            if (node.nodeType !== Node.TEXT_NODE) return NodeFilter.FILTER_SKIP;

            // Check if any ancestor should be skipped
            let parent = node.parentElement;
            while (parent && parent !== root) {
                if (shouldSkipElement(parent)) {
                    return NodeFilter.FILTER_REJECT;
                }
                parent = parent.parentElement;
            }

            return NodeFilter.FILTER_ACCEPT;
        };

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {acceptNode: filterNode});
        const segments: Array<{ node: Text, start: number, end: number }> = [];
        let acc = '';
        let tn = walker.nextNode() as Text | null;
        while (tn) {
            const t = tn.nodeValue || '';
            if (t) {
                segments.push({node: tn, start: acc.length, end: acc.length + t.length});
                acc += t;
            }
            tn = walker.nextNode() as Text | null;
        }
        // console.log('[ReviewTool] processElementRoot: segments count', segments.length);
        if (!segments.length) return;
        const ranges = splitTextIntoRanges(acc, getComputedLang(root));
        // console.log('[ReviewTool] processElementRoot: ranges computed', ranges.length);

        // Map ranges to actual text node offsets first
        const mapped: Array<{
            startNode: Text, startOffset: number, endNode: Text, endOffset: number, absStart: number, absEnd: number
        }> = [];

        for (const r of ranges) {
            let startNode: Text | null = null;
            let startOffset = 0;
            let endNode: Text | null = null;
            let endOffset = 0;
            for (const seg of segments) {
                if (r.start >= seg.start && r.start <= seg.end) {
                    startNode = seg.node;
                    startOffset = r.start - seg.start;
                }
                if (r.end >= seg.start && r.end <= seg.end) {
                    endNode = seg.node;
                    endOffset = r.end - seg.start;
                }
                if (startNode && endNode) break;
            }
            if (startNode && endNode) {
                mapped.push({startNode, startOffset, endNode, endOffset, absStart: r.start, absEnd: r.end});
            }
        }

        // console.log('[ReviewTool] processElementRoot: mapped ranges', mapped.length);
        if (!mapped.length) return;

        // Process mappings from end to start to avoid invalidating earlier offsets
        mapped.sort((a, b) => b.absStart - a.absStart);

        // Try each mapping individually; if none succeed, fall back
        let successCount = 0;
        for (const m of mapped) {
            // Skip empty ranges
            if (m.absStart >= m.absEnd) continue;
            try {
                // Skip if nodes are no longer in DOM or not under the same root
                if (!m.startNode.isConnected || !m.endNode.isConnected) {
                    console.warn('[ReviewTool] mapped nodes not connected, skipping', m);
                    continue;
                }
                // Ensure both nodes are still descendants of the provided root
                if (!root.contains(m.startNode) || !root.contains(m.endNode)) {
                    console.warn('[ReviewTool] mapped nodes no longer in root, skipping', m);
                    continue;
                }

                const range = document.createRange();
                range.setStart(m.startNode, m.startOffset);
                range.setEnd(m.endNode, m.endOffset);

                // extractContents and insert wrapped span at the collapsed range position
                const frag = range.extractContents();
                const span = document.createElement('span');
                span.className = `${ANNOTATION_CONTAINER_CLASS} ${SENTENCE_CLASS}`;
                span.setAttribute('data-sentence-index', String(sentenceIndex++));
                span.appendChild(frag);
                range.insertNode(span);
                range.detach && (range as any).detach();

                successCount++;
            } catch (e) {
                console.warn('[ReviewTool] range wrapping failed for one range, continuing', e, m);
            }
        }

        // console.log('[ReviewTool] processElementRoot: successCount', successCount);
        if (successCount === 0) {
            // If no ranges could be safely wrapped, fall back to naive wrapping for this root
            console.warn('[ReviewTool] no mapped ranges wrapped successfully, performing fallback wrapping for this root');
            const walker2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {acceptNode: filterNode});
            let tn2 = walker2.nextNode() as Text | null;
            while (tn2) {
                const text = tn2.nodeValue || '';
                if (!text.trim()) {
                    tn2 = walker2.nextNode() as Text | null;
                    continue;
                }
                const parts = splitTextToPartsSimple(text, allowHalfWidth);
                if (parts.length <= 1) {
                    const span = document.createElement('span');
                    span.className = `${ANNOTATION_CONTAINER_CLASS} ${SENTENCE_CLASS}`;
                    span.setAttribute('data-sentence-index', String(sentenceIndex++));
                    span.textContent = text;
                    tn2.parentNode && tn2.parentNode.replaceChild(span, tn2);
                } else {
                    const frag = document.createDocumentFragment();
                    parts.forEach(part => {
                        const span = document.createElement('span');
                        span.className = `${ANNOTATION_CONTAINER_CLASS} ${SENTENCE_CLASS}`;
                        span.setAttribute('data-sentence-index', String(sentenceIndex++));
                        span.textContent = part;
                        frag.appendChild(span);
                    });
                    tn2.parentNode && tn2.parentNode.replaceChild(frag, tn2);
                }
                tn2 = walker2.nextNode() as Text | null;
            }
        }
    }

    // Process nodes: for element nodes, process the element; for text nodes, wrap simply
    sectionElements.forEach(rootNode => {
        if (rootNode.nodeType === Node.ELEMENT_NODE) {
            const el = rootNode as Element;
            const tag = (el.tagName || '').toLowerCase();
            // Special-case list containers: process each list item separately to avoid
            // creating ranges that span across <li> siblings which would break list structure.
            if (tag === 'ul' || tag === 'ol' || tag === 'dl') {
                const items = Array.from(el.children).filter(c => c.nodeType === Node.ELEMENT_NODE);
                items.forEach(item => {
                    // process each li/dt/dd as a root so ranges don't cross boundaries
                    processElementRoot(item as Element);
                });
            } else {
                processElementRoot(el);
            }
        } else if (rootNode.nodeType === Node.TEXT_NODE) {
            const textNode = rootNode as Text;
            const text = textNode.textContent || '';
            if (!text.trim()) return;
            const parts = splitTextToPartsSimple(text, shouldTreatHalfWidthTerminators(getComputedLang(textNode)));
            if (parts.length <= 1) {
                const span = document.createElement('span');
                span.className = `${ANNOTATION_CONTAINER_CLASS} ${SENTENCE_CLASS}`;
                span.setAttribute('data-sentence-index', String(sentenceIndex++));
                span.textContent = text;
                textNode.parentNode && textNode.parentNode.replaceChild(span, textNode);
            } else {
                const frag = document.createDocumentFragment();
                parts.forEach(part => {
                    const span = document.createElement('span');
                    span.className = `${ANNOTATION_CONTAINER_CLASS} ${SENTENCE_CLASS}`;
                    span.setAttribute('data-sentence-index', String(sentenceIndex++));
                    span.textContent = part;
                    frag.appendChild(span);
                });
                textNode.parentNode && textNode.parentNode.replaceChild(frag, textNode);
            }
        }
    });
    // end of function's existing processing
    // attach click handlers for the sentences we created
    try {
        attachSentenceClickHandlers(sectionStart, sectionEnd);
    } catch (e) {
        console.error('[ReviewTool] attachSentenceClickHandlers failed', e);
        throw e;
    }
    try {
        // Diagnostics: log how many sentence spans exist in this section/container
        const selector = `.${ANNOTATION_CONTAINER_CLASS}.${SENTENCE_CLASS}`;
        const within = sectionStart.querySelectorAll ? sectionStart.querySelectorAll(selector) : document.querySelectorAll(selector);
        console.log('[ReviewTool] wrapSectionSentences: sentence spans found in section:', within.length);
    } catch (e) {
        console.error('[ReviewTool] counting sentence spans failed', e);
        throw e;
    }
}

/**
 * Ensure sentence spans exist in the section by attempting wrapping multiple times
 * with small delays. This avoids a persistent MutationObserver while still
 * surviving brief page rewrites.
 */
export function ensureWrappedSection(sectionStart: Element, sectionEnd: Element | null, attempts?: number | number[], delayMs?: number) {
    if (!sectionStart) return;
    const sel = `.${ANNOTATION_CONTAINER_CLASS}.${SENTENCE_CLASS}`;

    function countSpans() {
        try {
            if (sectionEnd === null && sectionStart.querySelectorAll) {
                return sectionStart.querySelectorAll(sel).length;
            }
            const all = Array.from(document.querySelectorAll(sel));
            return all.filter(el => sectionStart.contains(el)).length;
        } catch (e) {
            return 0;
        }
    }

    // Default retry schedule in ms: immediate, short, medium, longer, up to 5s
    let schedule: number[];
    if (Array.isArray(attempts)) schedule = attempts as number[]; else schedule = [0, 250, 750, 1500, 3000, 5000];
    // allow attempts as count
    if (!Array.isArray(attempts) && typeof attempts === 'number') {
        // trim or extend schedule to that many attempts
        schedule = schedule.slice(0, Math.max(1, attempts));
    }

    let idx = 0;

    function runOnce() {
        try {
            wrapSectionSentences(sectionStart, sectionEnd);
        } catch (e) {
            console.warn('[ReviewTool] ensureWrappedSection wrap failed', e);
        }
        const found = countSpans();
        console.log('[ReviewTool] ensureWrappedSection: attempt', idx + 1, 'found', found);
        if (found > 0) return;
        idx++;
        if (idx < schedule.length) {
            setTimeout(runOnce, schedule[idx]);
        }
    }

    setTimeout(runOnce, schedule[0]);
}

export function clearWrappedSentences() {
    // select spans that have both classes and unwrap them preserving their child nodes
    document.querySelectorAll(`.${ANNOTATION_CONTAINER_CLASS}.${SENTENCE_CLASS}`).forEach(el => {
        const parent = el.parentNode;
        if (!parent) return;
        const frag = document.createDocumentFragment();
        // move all child nodes (including elements) into fragment to preserve structure
        while (el.firstChild) {
            frag.appendChild(el.firstChild);
        }
        parent.replaceChild(frag, el);
    });
    // also clear any annotation badges
    document.querySelectorAll('.review-tool-annotation-badge').forEach(badge => badge.remove());
    clearAllInlineAnnotationBubbles();
}

function clearAllInlineAnnotationBubbles() {
    inlineAnnotationBubbles.forEach((bubble) => {
        try {
            bubble.remove();
        } catch (e) {
            console.error('[ReviewTool] failed to remove inline annotation bubble', e, bubble);
        }
    });
    inlineAnnotationBubbles.clear();
    // Remove stray nodes that might not be tracked in the map
    document.querySelectorAll('.review-tool-inline-annotation').forEach((bubble) => {
        bubble.remove();
    });
}

function createInlineAnnotationBubbleElement(pageName: string, sectionPath: string, annotationId: string, opinion: string): HTMLElement {
    const bubble = document.createElement('span');
    bubble.className = 'review-tool-inline-annotation';
    bubble.dataset.annoId = annotationId;
    bubble.dataset.sectionPath = sectionPath;
    bubble.title = opinion;

    const icon = document.createElement('span');
    icon.className = 'review-tool-inline-annotation__icon';
    icon.textContent = '💬';
    icon.title = opinion;
    icon.setAttribute('role', 'button');
    icon.tabIndex = 0;
    icon.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openAnnotationDialog(pageName, annotationId, sectionPath);
    };
    icon.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            icon.click();
        }
    };

    bubble.appendChild(icon);
    return bubble;
}

function insertInlineAnnotationBubble(range: Range | null, pageName: string, sectionPath: string, annotationId: string, opinion: string) {
    if (!range) {
        console.warn('[ReviewTool] Cannot insert inline annotation bubble without a selection range.');
        return;
    }

    removeInlineAnnotationBubble(annotationId);

    const bubble = createInlineAnnotationBubbleElement(pageName, sectionPath, annotationId, opinion);
    inlineAnnotationBubbles.set(annotationId, bubble);

    const insertionRange = range.cloneRange();
    insertionRange.collapse(false);
    insertionRange.insertNode(bubble);
}

function updateInlineAnnotationBubble(annotationId: string, opinion: string) {
    const bubble = inlineAnnotationBubbles.get(annotationId);
    if (!bubble) return;
    bubble.setAttribute('data-opinion', opinion);
    bubble.title = opinion;
    if (bubble.firstElementChild) {
        (bubble.firstElementChild as HTMLElement).title = opinion;
    }
}

function removeInlineAnnotationBubble(annotationId: string) {
    const bubble = inlineAnnotationBubbles.get(annotationId);
    if (!bubble) return;
    bubble.remove();
    inlineAnnotationBubbles.delete(annotationId);
}

interface AnnotationDialogOptions {
    sentenceText?: string;
    selectionRange?: Range | null;
    sentencePos?: string;
}

async function openAnnotationDialog(pageName: string, annotationId: string | null, sectionPath: string, options: AnnotationDialogOptions = {}) {
    const selectionRange = options.selectionRange ? options.selectionRange.cloneRange() : null;
    const isEdit = annotationId !== null;
    const existingAnnotation = isEdit ? getAnnotation(pageName, annotationId!) : null;
    const displaySentenceText = isEdit
        ? (existingAnnotation?.sentenceText || '')
        : sanitizePlainText(options.sentenceText || '');
    const initialOpinion = isEdit ? (existingAnnotation?.opinion || '') : '';
    const shouldReopenViewer = isAnnotationViewerDialogOpen();
    sectionPath = sectionPath === '目次' ? '序言' : sectionPath;

    try {
        if (shouldReopenViewer) {
            closeAnnotationViewerDialog();
        }

        const result = await openAnnotationEditorDialog({
            sectionPath,
            sentenceText: displaySentenceText,
            initialOpinion,
            mode: isEdit ? 'edit' : 'create',
            allowDelete: isEdit
        });

        if (!result || result.action === 'cancel') {
            return;
        }

        if (result.action === 'delete' && isEdit && annotationId) {
            const removed = deleteAnnotation(pageName, annotationId);
            if (removed) {
                removeInlineAnnotationBubble(annotationId);
            }
            return;
        }

        if (result.action === 'save') {
            if (isEdit && annotationId) {
                const updated = updateAnnotation(pageName, annotationId, { opinion: result.opinion });
                if (updated) {
                    updateInlineAnnotationBubble(annotationId, result.opinion);
                }
            } else {
                const sentencePosKey = options.sentencePos
                    || computeSentenceOrderKey(selectionRange ? selectionRange.startContainer : null);
                const created = createAnnotation(pageName, sectionPath, displaySentenceText, result.opinion, sentencePosKey);
                insertInlineAnnotationBubble(selectionRange, pageName, sectionPath, created.id, result.opinion);
            }
        }
    } catch (error) {
        console.error('[ReviewTool] Failed to open annotation editor dialog', error);
    } finally {
        if (shouldReopenViewer) {
            showAnnotationViewer(pageName);
        }
    }
}

// Attach click handlers to sentence spans inside the given section range
function attachSentenceClickHandlers(sectionStart: Element, sectionEnd: Element | null) {
    if (!sectionStart) return;
    // If no explicit sectionEnd is provided (container mode), simply attach to all sentence spans inside the container.
    if (!sectionEnd) {
        const spans = sectionStart.querySelectorAll(`.${ANNOTATION_CONTAINER_CLASS}.${SENTENCE_CLASS}`);
        spans.forEach(s => attachHandlerToSpan(s as HTMLElement));
        // Also handle the rare case the container itself is a sentence span
        if (sectionStart.classList && sectionStart.classList.contains(ANNOTATION_CONTAINER_CLASS) && sectionStart.classList.contains(SENTENCE_CLASS)) {
            attachHandlerToSpan(sectionStart as HTMLElement);
        }
        return;
    }

    // Otherwise (heading-range mode), iterate siblings from sectionStart.nextSibling up to sectionEnd
    let cur: Node | null = sectionStart.nextSibling;
    while (cur && cur !== sectionEnd) {
        if (cur.nodeType === Node.ELEMENT_NODE) {
            const el = cur as Element;
            // Attach to descendant sentence spans
            el.querySelectorAll(`.${ANNOTATION_CONTAINER_CLASS}.${SENTENCE_CLASS}`).forEach((span) => {
                attachHandlerToSpan(span as HTMLElement);
            });
            // If the element itself is a sentence span
            if (el.classList && el.classList.contains(ANNOTATION_CONTAINER_CLASS) && el.classList.contains(SENTENCE_CLASS)) {
                attachHandlerToSpan(el as HTMLElement);
            }
        }
        cur = cur.nextSibling;
    }

    function attachHandlerToSpan(s: HTMLElement) {
        if (s.dataset.clickAttached) return; // already attached
        s.dataset.clickAttached = '1';

        // Diagnostic hook: mark and log first-time attachments
        try {
            // add a data attribute to indicate handler attached for debugging
            s.dataset._rtHandler = '1';
        } catch (e) {
            /* ignore */
        }
        if ((attachHandlerToSpan as any)._attachedCount === undefined) (attachHandlerToSpan as any)._attachedCount = 0;
        (attachHandlerToSpan as any)._attachedCount++;
        // if ((attachHandlerToSpan as any)._attachedCount <= 5) {
        //     console.log('[ReviewTool] attachHandlerToSpan: attached handler to span', s.getAttribute('data-sentence-index'));
        // }

        // Remove any inline cursor override; CSS will control cursor state
        // Ensure pointer events and cursor are enabled; add inline cursor as a fail-safe
        try {
            s.style.pointerEvents = 'auto';
        } catch (e) {
            console.error('[ReviewTool] failed to set pointerEvents on sentence span', e, s);
            throw e;
        }
        try {
            s.style.cursor = 'pointer';
        } catch (e) {
            console.error('[ReviewTool] failed to set cursor on sentence span', e, s);
            throw e;
        }

        // Debug: add hover handlers that apply an inline background so we can see highlights
        const origBg = s.style.background;
        s.addEventListener('mouseenter', () => {
            try {
                s.style.background = 'rgba(255,235,59,0.18)';
            } catch (e) {
                console.error('[ReviewTool] span mouseenter styling failed', e, s);
                throw e;
            }
            // console.log('[ReviewTool] span mouseenter', s.getAttribute('data-sentence-index'));
        });
        s.addEventListener('mouseleave', () => {
            try {
                s.style.background = origBg || '';
            } catch (e) {
                console.error('[ReviewTool] span mouseleave styling failed', e, s);
                throw e;
            }
            // console.log('[ReviewTool] span mouseleave', s.getAttribute('data-sentence-index'));
        });

        s.addEventListener('click', (e) => {
            // Check if this was a drag (text selection) rather than a simple click
            if (wasMouseDragged(e as MouseEvent)) {
                // User was selecting text, don't intercept - let the selection handler deal with it
                return;
            }
            // Check if there's already a non-collapsed selection (user just finished selecting text)
            const existingSelection = window.getSelection();
            if (existingSelection && !existingSelection.isCollapsed) {
                // There's already selected text, don't override it with sentence selection
                return;
            }
            e.stopPropagation();
            e.preventDefault();
            if (!activePageName || !activeSectionPath) return;
            const sentenceText = getCleanTextFromElement(s);
            // Create a range to select this sentence
            const range = document.createRange();
            range.selectNodeContents(s);
            const rangeClone = range.cloneRange();
            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
                selection.addRange(range);
            }
            // Show the popup button at the sentence center
            const r = s.getBoundingClientRect();
            const centerX = Math.max(40, Math.min(window.innerWidth - 40, r.left + r.width / 2));
            const topY = Math.max(8, r.top + window.scrollY - 8);

            showFloatingButton(centerX + window.scrollX, topY, () => {
                if (activePageName) {
                    hideFloatingButton();
                    // Clear selection
                    const sel = window.getSelection();
                    sel && sel.removeAllRanges();
                    const computedSectionPath = computeSectionPathFromNode(s);
                    const sentencePos = computeSentenceOrderKey(s);
                    openAnnotationDialog(activePageName, null, computedSectionPath, {
                        sentenceText,
                        selectionRange: rangeClone,
                        sentencePos
                    });
                }
            });
        });
    }
}

export function showAnnotationViewer(pageName: string) {
    if (isAnnotationViewerDialogOpen()) {
        closeAnnotationViewerDialog();
        return;
    }

    const groups = buildAnnotationGroups(pageName);
    openAnnotationViewerDialog({
        groups,
        onEditAnnotation: (annotationId, sectionPath) => {
            openAnnotationDialog(pageName, annotationId, sectionPath);
        },
        onDeleteAnnotation: async (annotationId, sectionPath) => {
            const removed = deleteAnnotation(pageName, annotationId);
            if (removed) {
                removeInlineAnnotationBubble(annotationId);
                updateAnnotationViewerDialogGroups(buildAnnotationGroups(pageName));
            }
        },
        onClearAllAnnotations: async () => {
            const cleared = clearAnnotations(pageName);
            clearAllInlineAnnotationBubbles();
            updateAnnotationViewerDialogGroups(buildAnnotationGroups(pageName));
            return cleared;
        }
    });
}

/**
 * 給所有 mw-headings 添加「批註」按鈕。
 * @param pageName {string} 條目標題
 */
export function addMainPageReviewToolButtonsToDOM(pageName: string): void {
    if (document.querySelector('#ca-annotate')) return;
    // Add a single Vector menu tab to toggle annotation mode for the whole article
    // This replaces per-heading mw-editsection buttons to avoid overlapping areas.
    addVectorMenuTab('ca-annotate', state.convByVar({
        hant: '批註模式', hans: '批注模式'
    }), state.convByVar({
        hant: '切換批註模式', hans: '切换批注模式'
    }), (e) => toggleArticleAnnotationMode(pageName));
    // add global viewer button (guard against duplicate)
    addGlobalAnnotationViewerButton(pageName);
    syncAnnotationModeMenuState(state.isAnnotationModeActive(ARTICLE_ANNOTATION_KEY), pageName);
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
            const fn: any = showAnnotationViewer;
            if (typeof fn === 'function') {
                fn(state.articleTitle || pageName);
            } else {
                console.warn('[ReviewTool] showAnnotationViewer function not available');
            }
        } catch (e) {
            console.error('[ReviewTool] failed to open viewer', e);
            throw e;
        }
    };
    btn.onmouseenter = () => {
        btn.style.backgroundColor = '#447ff5';
    };
    btn.onmouseleave = () => {
        btn.style.backgroundColor = '#36c';
    };
    document.body.appendChild(btn);
}

/**
 * 創建一個「批註」按鈕元素。
 * @param pageName {string} 條目標標題
 * @param headingTitle {string} 章節標題
 */
function toggleArticleAnnotationMode(pageName: string): void {
    state.toggleAnnotationModeState(ARTICLE_ANNOTATION_KEY);
    const isActive = state.isAnnotationModeActive(ARTICLE_ANNOTATION_KEY);
    syncAnnotationModeMenuState(isActive, pageName);
    if (isActive) {
        // mark document so we can override page styles while annotation mode is active
        document.documentElement.classList.add('review-tool-annotation-mode');
        // Notify user
        mw && mw.notify && mw.notify(state.convByVar({
            hant: '批註模式已啟用。', hans: '批注模式已启用。'
        }), {tag: 'review-tool'});
        console.log(`[ReviewTool] 條目「${state.articleTitle}」批註模式已啟用。`);
        // find main content container - prefer the parser output inside mw-content-text
        const selectors = [
            '#mw-content-text .mw-parser-output', '#mw-content-text', '.mw-parser-output', '#content', '#bodyContent'
        ];
        let container: Element | null = null;
        for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) {
                container = el;
                break;
            }
        }
        if (container) {
            console.log('[ReviewTool] chosen content container:', container.tagName, container.id || '(no id)', container.className || '(no class)');
        } else {
            console.warn('[ReviewTool] could not find a content container with selectors', selectors);
        }
        if (!container) {
            console.warn('[ReviewTool] 未找到主要內容容器，無法啟用批註模式。');
            return;
        }
        const sectionPath = state.articleTitle || pageName;
        // install listeners using the container as the active section start (annotation_ui will treat container as parent)
        installSelectionListenersForSection(state.articleTitle || pageName, container, null, sectionPath, true);
        // Try wrapping the section and retry a few times in case the page rewrites content shortly after.
        const tryCount = ensureWrappedSection ? ensureWrappedSection : wrapSectionSentences;
        tryCount(container, null, 4, 220);
        // Ensure global viewer button is visible while annotation mode is active
        const gv = document.querySelector('.review-tool-global-button') as HTMLElement | null;
        if (gv) gv.style.display = 'block';
    } else {
        console.log(`[ReviewTool] 條目「${state.articleTitle}」批註模式已停用。`);
        uninstallSelectionListeners();
        clearWrappedSentences();
        try {
            document.documentElement.classList.remove('review-tool-annotation-mode');
        } catch (e) {
            console.error('[ReviewTool] failed to remove annotation mode class', e);
            throw e;
        }
        try {
            mw && mw.notify && mw.notify(state.convByVar({
                hant: '批註模式已停用。', hans: '批注模式已停用。'
            }), {tag: 'review-tool'});
        } catch (e) {
            console.error('[ReviewTool] mw.notify failed', e);
            throw e;
        }
        // Hide global viewer button when annotation mode is disabled
        try {
            const gv = document.querySelector('.review-tool-global-button') as HTMLElement | null;
            if (gv) gv.style.display = 'none';
        } catch (e) {
            console.error('[ReviewTool] failed to hide global viewer button', e);
            throw e;
        }
    }
}

function getReviewToolPortletLabel(isActive: boolean): string {
    return state.convByVar({
        hant: isActive ? '關閉批註模式' : '啟用批註模式',
        hans: isActive ? '关闭批注模式' : '开启批注模式'
    });
}

function syncAnnotationModeMenuState(isActive: boolean, pageName: string): void {
    const tab = document.getElementById('ca-annotate');
    if (tab) {
        const span = tab.querySelector('a > span');
        if (span && span instanceof HTMLElement) {
            span.style.fontWeight = isActive ? 'bold' : 'normal';
        }
        tab.classList.toggle('selected', isActive);
    }

    addPortletTrigger(REVIEWTOOL_PORTLET_ID, getReviewToolPortletLabel(isActive), () => {
        toggleArticleAnnotationMode(pageName);
    });
    const portlet = document.getElementById(REVIEWTOOL_PORTLET_ID);
    if (portlet) {
        portlet.classList.toggle('selected', isActive);
    }
}
