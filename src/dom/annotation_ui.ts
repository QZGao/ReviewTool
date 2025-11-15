import * as annotations from '../annotations';
import state from '../state';

let floatingButton: HTMLElement | null = null;
const ANNOTATION_CONTAINER_CLASS = 'review-tool-annotation-ui';
const SENTENCE_CLASS = 'sentence';
const FLOATING_BUTTON_CLASS = 'floating-button';

let activeSectionStart: Element | null = null;
let activeSectionEnd: Element | null = null;
let activeSectionPath: string | null = null;
let activePageName: string | null = null;
let isMouseDown = false; // new flag to ignore selectionchange during drag

const HOVER_INTENT_DELAY_MS = 180;
const HIDE_DELAY_MS = 180;
const SELECTION_SHOW_DELAY_MS = 120;

let selectionShowTimer: number | null = null;
let floatingHideTimer: number | null = null;
const hoverTimers = new WeakMap<HTMLElement, { show?: number; hide?: number }>();

export function installSelectionListenersForSection(pageName: string, sectionStart: Element, sectionEnd: Element, sectionPath: string) {
    uninstallSelectionListeners();
    activeSectionStart = sectionStart;
    activeSectionEnd = sectionEnd;
    activeSectionPath = sectionPath;
    activePageName = pageName;

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
    if (selectionShowTimer) { clearTimeout(selectionShowTimer); selectionShowTimer = null; }
    if (floatingHideTimer) { clearTimeout(floatingHideTimer); floatingHideTimer = null; }
    hideFloatingButton();
    activeSectionStart = null;
    activeSectionEnd = null;
    activeSectionPath = null;
    activePageName = null;
}

function isNodeWithinSection(node: Node | null): boolean {
    if (!node || !activeSectionStart) return false;
    // Prefer an Element ancestor for location checks
    let el: Element | null = null;
    if (node.nodeType === Node.TEXT_NODE) el = (node as Text).parentElement;
    else if (node instanceof Element) el = node as Element;
    if (!el) return false;

    // If the element is the section start or contained within it, it's inside
    if (activeSectionStart === el || activeSectionStart.contains(el)) return true;

    // If there's no explicit section end, any node after start is considered inside
    if (!activeSectionEnd) {
        return (activeSectionStart.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }

    // Otherwise, check start < el < end
    const startBeforeEl = (activeSectionStart.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const elBeforeEnd = (el.compareDocumentPosition(activeSectionEnd) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    return startBeforeEl && elBeforeEnd;
}

function selectionInsideActiveSection(): {range: Range | null, singleSentenceIndex: number | null} {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return { range: null, singleSentenceIndex: null };
    const range = sel.getRangeAt(0);
    if (!activeSectionStart) return { range: null, singleSentenceIndex: null };
    // ensure both startContainer and endContainer are within the section
    const startIn = isNodeWithinSection(range.startContainer as Node);
    const endIn = isNodeWithinSection(range.endContainer as Node);
    // If either endpoint is outside the section, ignore
    if (!startIn || !endIn) return { range: null, singleSentenceIndex: null };
    // Try to find sentence span ancestor for startContainer
    const startSentence = findAncestorSentence(range.startContainer as Node);
    const endSentence = findAncestorSentence(range.endContainer as Node);
    if (startSentence && endSentence && startSentence === endSentence) {
        const idx = parseInt((startSentence as HTMLElement).getAttribute('data-sentence-index') || '-1', 10);
        return { range, singleSentenceIndex: isFinite(idx) ? idx : null };
    }
    return { range: range, singleSentenceIndex: null };
}

function onMouseDown(e?: MouseEvent) {
    // Ignore mousedown on floating button to allow clicking it
    const target = e?.target as Node | undefined;
    if (target && floatingButton && (target === floatingButton || floatingButton.contains(target))) {
        return;
    }
    // When user starts pressing mouse, ignore selectionchange events until mouseup.
    isMouseDown = true;
    hideFloatingButton();
}

function onMouseUp(e?: MouseEvent) {
    // Ignore mouseup originating from the floating button
    const target = e?.target as Node | undefined;
    if (target && floatingButton && (target === floatingButton || floatingButton.contains(target))) {
        isMouseDown = false;
        return;
    }
    // End of drag/selection — allow processing and run selection handler once.
    isMouseDown = false;
    onSelectionChange();
}

function onTouchStart(e?: TouchEvent) {
    // Ignore touchstart on floating button
    const target = e?.target as Node | undefined;
    if (target && floatingButton && (target === floatingButton || floatingButton.contains(target))) {
        return;
    }
    isMouseDown = true;
    hideFloatingButton();
}

function onTouchEnd(e?: TouchEvent) {
    // Ignore touchend on floating button
    const target = e?.target as Node | undefined;
    if (target && floatingButton && (target === floatingButton || floatingButton.contains(target))) {
        isMouseDown = false;
        return;
    }
    isMouseDown = false;
    onSelectionChange();
}

function onSelectionChange() {
    // Ignore live selectionchange events while mouse is down (dragging) — only respond on mouseup.
    if (isMouseDown) return;
    // Debounce selection handling to avoid heavy real-time work
    if (selectionShowTimer) { clearTimeout(selectionShowTimer); selectionShowTimer = null; }
    selectionShowTimer = window.setTimeout(() => {
        const res = selectionInsideActiveSection();
        if (!res.range) {
            hideFloatingButton();
            return;
        }
        const rect = res.range.getBoundingClientRect();
        // Center on the actual selection, clamped to viewport
        const centerX = Math.max(40, Math.min(window.innerWidth - 40, rect.left + rect.width / 2));
        const topY = Math.max(8, rect.top + window.scrollY - 8);
        showFloatingButton(centerX + window.scrollX, topY, () => {
            const selectedText = (res.range && res.range.toString()) ? res.range.toString().trim() : '';
            if (!selectedText) {
                hideFloatingButton();
                return;
            }
            if (activePageName && activeSectionPath) {
                const idx = res.singleSentenceIndex != null ? res.singleSentenceIndex : -1;
                hideFloatingButton();
                const sel = document.getSelection();
                sel && sel.removeAllRanges();
                openAnnotationDialog(activePageName, null, activeSectionPath, idx, selectedText);
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
        floatingButton.onclick = (e) => { e.stopPropagation(); e.preventDefault(); onClick(); };
    }
    if (floatingHideTimer) { clearTimeout(floatingHideTimer); floatingHideTimer = null; }
    floatingButton.style.position = 'absolute';
    floatingButton.style.left = `${x}px`;
    floatingButton.style.top = `${y}px`;
    floatingButton.style.transform = 'translate(-50%, -100%)';
    floatingButton.style.zIndex = '9999';
    floatingButton.style.display = 'block';

    // when moving pointer from sentence to button, avoid hiding immediately
    floatingButton.onmouseenter = () => {
        if (floatingHideTimer) { clearTimeout(floatingHideTimer); floatingHideTimer = null; }
    };
    floatingButton.onmouseleave = () => {
        if (floatingHideTimer) { clearTimeout(floatingHideTimer); }
        floatingHideTimer = window.setTimeout(() => hideFloatingButton(), HIDE_DELAY_MS);
    };
}

function hideFloatingButton() {
    if (floatingHideTimer) { clearTimeout(floatingHideTimer); floatingHideTimer = null; }
    if (floatingButton) {
        floatingButton.style.display = 'none';
    }
}

// Wrap text nodes inside the section into sentence spans, handling nested markup (templates, references, etc.)
export function wrapSectionSentences(sectionStart: Element, sectionEnd: Element | null) {
    // Collect all elements between sectionStart and sectionEnd (not inclusive of sectionEnd)
    const sectionElements: Node[] = [];
    let cur: Node | null = sectionStart.nextSibling;
    while (cur && cur !== sectionEnd) {
        sectionElements.push(cur);
        cur = cur.nextSibling;
    }

    let sentenceIndex = 0;

    // Helper to split a block element's concatenated text into sentence ranges
    function splitTextIntoRanges(text: string): Array<{start:number,end:number}> {
        const ranges: Array<{start:number,end:number}> = [];
        const isPunct = (ch: string) => /[。！？!?；;】\]}]/.test(ch);
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (isPunct(ch)) {
                // move j after any following whitespace
                let j = i + 1;
                while (j < text.length && /\s/.test(text[j])) j++;
                const end = j;
                const part = text.slice(start, end);
                if (part.trim()) ranges.push({ start, end });
                start = end;
                i = j - 1;
            }
        }
        // remaining tail
        if (start < text.length) {
            const tail = text.slice(start);
            if (tail.trim()) ranges.push({ start, end: text.length });
        }
        return ranges;
    }

    // Process an element root - gather its text nodes and map offsets
    function processElementRoot(root: Element) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        const segments: Array<{node: Text, start:number, end:number}> = [];
        let acc = '';
        let tn = walker.nextNode() as Text | null;
        while (tn) {
            const t = tn.nodeValue || '';
            if (t) {
                segments.push({ node: tn, start: acc.length, end: acc.length + t.length });
                acc += t;
            }
            tn = walker.nextNode() as Text | null;
        }
        if (!segments.length) return;
        const ranges = splitTextIntoRanges(acc);

        // Map ranges to actual text node offsets first
        const mapped: Array<{
            startNode: Text, startOffset: number,
            endNode: Text, endOffset: number,
            absStart: number, absEnd: number
        }> = [];

        for (const r of ranges) {
            let startNode: Text | null = null; let startOffset = 0;
            let endNode: Text | null = null; let endOffset = 0;
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
                mapped.push({ startNode, startOffset, endNode, endOffset, absStart: r.start, absEnd: r.end });
            }
        }

        if (!mapped.length) return;

        // Process mappings from end to start to avoid invalidating earlier offsets
        mapped.sort((a,b) => b.absStart - a.absStart);

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

        if (successCount === 0) {
            // If no ranges could be safely wrapped, fall back to naive wrapping for this root
            console.warn('[ReviewTool] no mapped ranges wrapped successfully, performing fallback wrapping for this root');
            const walker2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
            let tn2 = walker2.nextNode() as Text | null;
            while (tn2) {
                const text = tn2.nodeValue || '';
                if (!text.trim()) { tn2 = walker2.nextNode() as Text | null; continue; }
                const parts = text.split(/(?<=[。！？!?；;】\]}])\s*/g).filter(p => p.trim());
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
            processElementRoot(rootNode as Element);
        } else if (rootNode.nodeType === Node.TEXT_NODE) {
            const textNode = rootNode as Text;
            const text = textNode.textContent || '';
            if (!text.trim()) return;
            const parts = text.split(/(?<=[。！？!?；;」』】〗〕\]］}｝])\s*/g).filter(p => p.trim());
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
    // attach hover handlers for the sentences we created
    try {
        attachSentenceHoverHandlers(sectionStart, sectionEnd);
    } catch (e) {
        console.warn('[ReviewTool] attachSentenceHoverHandlers failed', e);
    }
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
 }

/**
 * Render visual badges on sentences that have annotations
 */
export function renderAnnotationBadges(pageName: string, sectionPath: string) {
    // Clear existing badges in this section first
    document.querySelectorAll('.review-tool-annotation-badge').forEach(badge => badge.remove());

    const sectionAnnotations = annotations.getAnnotationsForSection(pageName, sectionPath);
    sectionAnnotations.forEach(anno => {
        const sentenceEl = document.querySelector(
            `.${ANNOTATION_CONTAINER_CLASS}.${SENTENCE_CLASS}[data-sentence-index="${anno.sentenceIndex}"]`
        );
        if (sentenceEl) {
            const badge = document.createElement('sup');
            badge.className = 'review-tool-annotation-badge';
            badge.textContent = '💬';
            badge.title = anno.opinion;
            badge.style.cursor = 'pointer';
            badge.style.marginLeft = '2px';
            badge.style.color = '#36c';
            badge.dataset.annoId = anno.id;
            badge.onclick = (e) => {
                e.stopPropagation();
                openAnnotationDialog(pageName, anno.id, sectionPath);
            };
            sentenceEl.appendChild(badge);
        }
    });
}

function openAnnotationDialog(pageName: string, annotationId: string | null, sectionPath: string, sentenceIndex?: number, sentenceText?: string) {
    // Remove existing dialog if any
    const existing = document.getElementById('review-tool-annotation-dialog');
    if (existing) existing.remove();

    const isEdit = annotationId !== null;
    const anno = isEdit ? annotations.getAnnotation(pageName, annotationId!) : null;

    // For new annotations, use provided sentenceText and sentenceIndex; for edits, use anno data
    const displaySentenceText = isEdit ? (anno?.sentenceText || '') : (sentenceText || '');
    const displayOpinion = isEdit ? (anno?.opinion || '') : '';

    const overlay = document.createElement('div');
    overlay.id = 'review-tool-annotation-dialog';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.background = 'rgba(0,0,0,0.2)';
    overlay.style.zIndex = '10001';

    const dialog = document.createElement('div');
    dialog.style.position = 'absolute';
    dialog.style.top = '50%';
    dialog.style.left = '50%';
    dialog.style.transform = 'translate(-50%, -50%)';
    dialog.style.width = '520px';
    dialog.style.maxWidth = '90vw';
    dialog.style.background = '#fff';
    dialog.style.border = '1px solid #a2a9b1';
    dialog.style.borderRadius = '6px';
    dialog.style.boxShadow = '0 8px 30px rgba(0,0,0,0.2)';
    dialog.style.padding = '16px';
    dialog.style.fontFamily = 'sans-serif';

    const title = document.createElement('h3');
    title.textContent = state.convByVar(isEdit ? {hant: '編輯批註', hans: '编辑批注'} : {hant: '新增批註', hans: '新增批注'});
    title.style.marginTop = '0';
    title.style.marginBottom = '12px';
    dialog.appendChild(title);

    const sectionInfo = document.createElement('div');
    sectionInfo.textContent = state.convByVar({hant: '章節：', hans: '章节：'}) + sectionPath;
    sectionInfo.style.fontSize = '12px';
    sectionInfo.style.color = '#666';
    sectionInfo.style.marginBottom = '8px';
    dialog.appendChild(sectionInfo);

    const sentenceLabel = document.createElement('div');
    sentenceLabel.textContent = state.convByVar({hant: '句子：', hans: '句子：'});
    sentenceLabel.style.marginBottom = '4px';
    dialog.appendChild(sentenceLabel);

    const sentenceBox = document.createElement('div');
    sentenceBox.textContent = displaySentenceText;
    sentenceBox.style.whiteSpace = 'pre-wrap';
    sentenceBox.style.background = '#f8f9fa';
    sentenceBox.style.border = '1px solid #eaecf0';
    sentenceBox.style.padding = '8px';
    sentenceBox.style.borderRadius = '4px';
    sentenceBox.style.maxHeight = '120px';
    sentenceBox.style.overflowY = 'auto';
    sentenceBox.style.marginBottom = '10px';
    dialog.appendChild(sentenceBox);

    const opinionLabel = document.createElement('label');
    opinionLabel.textContent = state.convByVar({hant: '批註內容', hans: '批注内容'});
    opinionLabel.style.display = 'block';
    opinionLabel.style.marginBottom = '4px';
    dialog.appendChild(opinionLabel);

    const textarea = document.createElement('textarea');
    textarea.value = displayOpinion;
    textarea.style.width = '100%';
    textarea.style.height = '120px';
    textarea.style.resize = 'vertical';
    textarea.style.boxSizing = 'border-box';
    textarea.style.padding = '8px';
    textarea.style.border = '1px solid #a2a9b1';
    textarea.style.borderRadius = '4px';
    textarea.placeholder = state.convByVar({hant: '請輸入批註內容...', hans: '请输入批注内容...'});
    dialog.appendChild(textarea);

    // Auto-focus the textarea
    setTimeout(() => textarea.focus(), 50);

    const footer = document.createElement('div');
    footer.style.marginTop = '12px';
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.justifyContent = 'flex-end';

    // Only show delete button when editing
    if (isEdit) {
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = state.convByVar({hant: '刪除', hans: '删除'});
        deleteBtn.style.background = '#d33';
        deleteBtn.style.color = '#fff';
        deleteBtn.style.border = 'none';
        deleteBtn.style.padding = '6px 12px';
        deleteBtn.style.borderRadius = '4px';
        deleteBtn.style.cursor = 'pointer';
        deleteBtn.onclick = () => {
            const ok = confirm(state.convByVar({hant: '確定要刪除這條批註？', hans: '确定要删除这条批注？'}));
            if (!ok) return;
            const removed = annotations.deleteAnnotation(pageName, annotationId!);
            if (removed) {
                overlay.remove();
                renderAnnotationBadges(pageName, sectionPath);
            }
        };
        footer.appendChild(deleteBtn);
    }

    const saveBtn = document.createElement('button');
    saveBtn.textContent = state.convByVar(isEdit ? {hant: '儲存', hans: '保存'} : {hant: '新增', hans: '新增'});
    saveBtn.style.background = '#36c';
    saveBtn.style.color = '#fff';
    saveBtn.style.border = 'none';
    saveBtn.style.padding = '6px 12px';
    saveBtn.style.borderRadius = '4px';
    saveBtn.style.cursor = 'pointer';
    saveBtn.onclick = () => {
        const opinionValue = textarea.value.trim();
        if (!opinionValue) {
            alert(state.convByVar({hant: '批註內容不能為空', hans: '批注内容不能为空'}));
            return;
        }

        if (isEdit) {
            const updated = annotations.updateAnnotation(pageName, annotationId!, { opinion: opinionValue });
            if (updated) {
                overlay.remove();
                renderAnnotationBadges(pageName, sectionPath);
            }
        } else {
            // Create new annotation
            const idx = sentenceIndex !== undefined ? sentenceIndex : -1;
            annotations.createAnnotation(pageName, sectionPath, idx, displaySentenceText, opinionValue);
            renderAnnotationBadges(pageName, sectionPath);
            console.log('[ReviewTool] annotation saved', { page: pageName, section: sectionPath, idx, opinion: opinionValue, text: displaySentenceText });
            overlay.remove();
        }
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = state.convByVar({hant: '取消', hans: '取消'});
    cancelBtn.style.background = '#fff';
    cancelBtn.style.color = '#202122';
    cancelBtn.style.border = '1px solid #a2a9b1';
    cancelBtn.style.padding = '6px 12px';
    cancelBtn.style.borderRadius = '4px';
    cancelBtn.style.cursor = 'pointer';
    cancelBtn.onclick = () => overlay.remove();

    footer.appendChild(saveBtn);
    footer.appendChild(cancelBtn);

    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    overlay.onclick = (e) => {
        if (e.target === overlay) overlay.remove();
    };

    document.body.appendChild(overlay);
}

// Attach hover handlers to sentence spans inside the given section range
function attachSentenceHoverHandlers(sectionStart: Element, sectionEnd: Element | null) {
    if (!sectionStart) return;
    const sectionElements: Node[] = [];
    let cur: Node | null = sectionStart.nextSibling;
    while (cur && cur !== sectionEnd) {
        sectionElements.push(cur);
        cur = cur.nextSibling;
    }

    sectionElements.forEach(rootNode => {
        if (rootNode.nodeType === Node.ELEMENT_NODE) {
            const el = rootNode as Element;
            el.querySelectorAll(`.${ANNOTATION_CONTAINER_CLASS}.${SENTENCE_CLASS}`).forEach((span) => {
                const s = span as HTMLElement;
                if (s.dataset.hoverAttached) return; // already attached
                s.dataset.hoverAttached = '1';
                s.addEventListener('mouseenter', () => {
                    if (!activePageName || !activeSectionPath) return;
                    // cancel pending hide when re-entering a sentence
                    if (floatingHideTimer) { clearTimeout(floatingHideTimer); floatingHideTimer = null; }
                    // start intent timer
                    const timers = hoverTimers.get(s) || {};
                    if (timers.hide) { clearTimeout(timers.hide); timers.hide = undefined; }
                    if (timers.show) { clearTimeout(timers.show); }
                    timers.show = window.setTimeout(() => {
                        const idx = parseInt(s.getAttribute('data-sentence-index') || '-1', 10);
                        const sentenceText = (s.textContent || '').trim();
                        // place button near the sentence rect (top-center), clamped to viewport
                        const r = s.getBoundingClientRect();
                        const centerX = Math.max(40, Math.min(window.innerWidth - 40, r.left + r.width / 2));
                        const topY = Math.max(8, r.top + window.scrollY - 8);
                        showFloatingButton(centerX + window.scrollX, topY, () => {
                            if (activePageName && activeSectionPath) {
                                const idxx = isFinite(idx) ? idx : -1;
                                hideFloatingButton();
                                openAnnotationDialog(activePageName, null, activeSectionPath, idxx, sentenceText);
                            }
                        });
                    }, HOVER_INTENT_DELAY_MS);
                    hoverTimers.set(s, timers);
                });
                s.addEventListener('mouseleave', (ev) => {
                    const timers = hoverTimers.get(s) || {};
                    if (timers.show) { clearTimeout(timers.show); timers.show = undefined; }
                    const rt = (ev as MouseEvent).relatedTarget as Node | null;
                    if (rt && floatingButton && (rt === floatingButton || floatingButton.contains(rt))) {
                        // pointer moved to the floating button — keep it visible
                        hoverTimers.set(s, timers);
                        return;
                    }
                    // schedule hide to avoid flicker
                    if (timers.hide) { clearTimeout(timers.hide); }
                    timers.hide = window.setTimeout(() => hideFloatingButton(), HIDE_DELAY_MS);
                    hoverTimers.set(s, timers);
                });
            });
        }
    });
}

export function showAnnotationViewer(pageName: string) {
    const existing = document.getElementById('review-tool-annotation-viewer');
    if (existing) { existing.remove(); return; }
    const store = annotations.loadAnnotations(pageName);
    const grouped: Record<string, typeof store.annotations> = {};
    store.annotations.forEach(anno => {
        if (!grouped[anno.sectionPath]) grouped[anno.sectionPath] = [];
        grouped[anno.sectionPath].push(anno);
    });
    const viewer = document.createElement('div');
    viewer.id = 'review-tool-annotation-viewer';
    viewer.style.position = 'fixed';
    viewer.style.top = '80px';
    viewer.style.right = '20px';
    viewer.style.width = '360px';
    viewer.style.maxHeight = '600px';
    viewer.style.overflowY = 'auto';
    viewer.style.background = '#fff';
    viewer.style.border = '1px solid #a2a9b1';
    viewer.style.borderRadius = '4px';
    viewer.style.boxShadow = '0 4px 16px rgba(0,0,0,0.2)';
    viewer.style.zIndex = '10000';
    viewer.style.padding = '14px';
    viewer.style.fontFamily = 'sans-serif';
    viewer.style.fontSize = '14px';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';

    const title = document.createElement('h3');
    title.textContent = state.convByVar({hant: '批註列表', hans: '批注列表'});
    title.style.margin = '0';
    title.style.fontSize = '16px';
    title.style.fontWeight = 'bold';
    header.appendChild(title);

    const close = document.createElement('button');
    close.textContent = '×';
    close.style.border = 'none';
    close.style.background = 'transparent';
    close.style.fontSize = '20px';
    close.style.cursor = 'pointer';
    close.onclick = () => viewer.remove();
    header.appendChild(close);

    viewer.appendChild(header);

    if (store.annotations.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = state.convByVar({hant: '尚無批註', hans: '尚无批注'});
        empty.style.color = '#666';
        empty.style.marginTop = '12px';
        viewer.appendChild(empty);
    } else {
        Object.keys(grouped).sort().forEach(sectionPath => {
            const secHeader = document.createElement('h4');
            secHeader.textContent = sectionPath;
            secHeader.style.margin = '12px 0 6px';
            secHeader.style.fontSize = '13px';
            secHeader.style.fontWeight = 'bold';
            secHeader.style.color = '#202122';
            viewer.appendChild(secHeader);

            const list = document.createElement('ul');
            list.style.listStyle = 'disc';
            list.style.margin = '0 0 4px 18px';
            list.style.padding = '0';

            grouped[sectionPath].forEach(anno => {
                const li = document.createElement('li');
                li.style.marginBottom = '8px';
                const spanText = document.createElement('span');
                spanText.textContent = `"${anno.sentenceText.slice(0,50)}${anno.sentenceText.length>50?'…':''}"`;
                spanText.style.fontStyle = 'italic';
                spanText.style.color = '#555';
                li.appendChild(spanText);
                const opDiv = document.createElement('div');
                opDiv.textContent = anno.opinion;
                opDiv.style.marginTop = '4px';
                li.appendChild(opDiv);
                const meta = document.createElement('div');
                meta.textContent = `${state.convByVar({hant:'由', hans:'由'})} ${anno.createdBy} ${state.convByVar({hant:'於', hans:'于'})} ${new Date(anno.createdAt).toLocaleString()}`;
                meta.style.fontSize = '11px';
                meta.style.color = '#888';
                meta.style.marginTop = '2px';
                li.appendChild(meta);
                // quick edit shortcut
                const editLink = document.createElement('a');
                editLink.href = 'javascript:void(0)';
                editLink.textContent = state.convByVar({hant: '編輯', hans: '编辑'});
                editLink.style.fontSize = '11px';
                editLink.style.marginRight = '8px';
                editLink.onclick = (e) => { e.preventDefault(); openAnnotationDialog(pageName, anno.id, sectionPath); };
                const delLink = document.createElement('a');
                delLink.href = 'javascript:void(0)';
                delLink.textContent = state.convByVar({hant: '刪除', hans: '删除'});
                delLink.style.fontSize = '11px';
                delLink.style.color = '#d33';
                delLink.onclick = (e) => { e.preventDefault(); const ok = confirm(state.convByVar({hant:'確定刪除？', hans:'确定删除？'})); if(ok){ if(annotations.deleteAnnotation(pageName, anno.id)){ renderAnnotationBadges(pageName, sectionPath); viewer.remove(); showAnnotationViewer(pageName);} } };
                const actions = document.createElement('div');
                actions.style.marginTop = '4px';
                actions.appendChild(editLink);
                actions.appendChild(delLink);
                li.appendChild(actions);
                list.appendChild(li);
            });
            viewer.appendChild(list);
        });
    }

    document.body.appendChild(viewer);
}
