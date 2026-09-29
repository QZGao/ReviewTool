import { annotationMessages, type AnnotationMessages } from './i18n';
import { commentLayout } from './comment-layout';
import type { AnnotationComment, CommentDraft, HighlightAnnotation, ModerationReasonPrompt, RenderedView, RenderOptions } from './types';
import type { PopupLayout } from './popup-layout';
import { textRects } from './range-rects';
import { canEditComment, canResolveThread, findAnnotationComment, findComment, needsModerationReason, requestActionReason, type ModerationTarget } from './permissions';

import { threadRoots, annotationVisible } from './annotation-state';
import { renderCommentMarkup } from './comment-markup';
import { confirmThreadClose } from './confirm-close';
import { annotationCommentUrl } from './view-url';

type Draft = { text: string; kind: 'new' } | { text: string; kind: 'reply' | 'edit'; commentId: string; reason?: string };

/** A local comment thread for each source-anchored highlight. */
export function createCommentPanel(doc: Document, view: RenderedView, column: HTMLElement, popups: PopupLayout, author: string, initialDrafts: readonly CommentDraft[] = [], groups: readonly string[] = [], promptReason?: ModerationReasonPrompt, messages: AnnotationMessages = annotationMessages(), renderOptions: RenderOptions = {}) {
  const onDraftsChange = renderOptions.onCommentDraftsChange;
  const confirmClose = renderOptions.requestCloseConfirmation ?? ((signal: AbortSignal) => confirmThreadClose(doc, messages, signal));
  const highlighting = view.highlighting, window = doc.defaultView;
  if (!highlighting || !window) throw new Error('Comments require annotation highlighting in a browser window.');
  const state = highlighting, win = window;
  const currentAuthor = author.trim();
  const actor = { name: currentAuthor, groups };
  // Omitting timeZone uses the browser/system timezone, including daylight saving.
  const dateOptions: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const dateFormat = new Intl.DateTimeFormat(messages.dateLocale, dateOptions);
  const detailedDateFormat = new Intl.DateTimeFormat(messages.dateLocale, { ...dateOptions, second: '2-digit', timeZoneName: 'long' });
  const metadata = (name: string, createdAt?: string, editedAt?: string, editedBy?: string) => {
    const row = doc.createElement('div'); row.className = 'annotation-comment-meta';
    const author = doc.createElement('span'); author.className = 'annotation-comment-author'; author.textContent = name + (editedBy && editedBy !== name ? messages.editedBy(editedBy) : '');
    row.append(author);
    if (createdAt) {
      const time = doc.createElement('time'); time.className = 'annotation-comment-date'; time.dateTime = editedAt ?? createdAt;
      const date = new Date(editedAt ?? createdAt);
      time.textContent = dateFormat.format(date) + (editedAt ? messages.edited : ''); time.title = detailedDateFormat.format(date);
      row.append(time);
    }
    return row;
  };
  const controller = new AbortController(), options = { signal: controller.signal };
  const container = doc.createElement('aside');
  container.className = 'annotation-comments'; container.setAttribute('aria-label', messages.comments);
  container.dataset.annotationUi = ''; container.hidden = true;
  const hadClass = column.classList.contains('annotation-comments-host');
  column.classList.add('annotation-comments-host'); column.append(container);
  const draftKey = (draft: CommentDraft) => `${draft.annotationId}/${draft.kind}/${'commentId' in draft ? draft.commentId : ''}`;
  const retainedDrafts = new Map(initialDrafts.map(draft => [draftKey(draft), draft]));
  const threads = new Map<string, ReturnType<typeof thread>>();
  const expandedRoots = new Set<string>();
  const readDrafts = (): readonly CommentDraft[] => Object.freeze([...retainedDrafts.values(), ...[...threads.values()].flatMap(thread => thread.drafts)].map(draft => Object.freeze({ ...draft })));
  const draftsChanged = () => onDraftsChange?.(readDrafts());
  const layout = commentLayout(doc, view, column, container, () => [...threads.values()].map(item => ({ element: item.element, anchor: item.annotation.anchor, revision: item.revision })), popups);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reasonPending = false;
  const reasonFor = async (action: ModerationTarget, annotation: HighlightAnnotation) => {
    if (reasonPending) return null;
    reasonPending = true; cancel();
    try {
      if (action.type === 'resolve-comment' && !needsModerationReason(action, actor, annotation)) return await confirmClose(controller.signal) ? '' : null;
      return await requestActionReason(action, actor, promptReason, controller.signal, annotation);
    }
    finally { reasonPending = false; }
  };
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const activate = (id: string, anchor: DOMRect) => { cancel(); layout.activate(id, anchor); };
  const atHighlight = (event: MouseEvent) => {
    const annotation = state.annotations.find(item => item.id === layout.active);
    const range = annotation && view.restoreRange(annotation.anchor);
    return range && textRects(range, doc).some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
  };
  doc.addEventListener('pointermove', event => {
    if (reasonPending || !layout.compact || !layout.active || event.buttons) return;
    if (popups.contains(event.target) || container.contains(doc.activeElement) || atHighlight(event)) { cancel(); return; }
    if (timer === undefined) timer = setTimeout(() => { timer = undefined; layout.close(); }, 180);
  }, options);
  doc.addEventListener('pointerdown', event => { if (!reasonPending && layout.compact && !popups.contains(event.target) && !atHighlight(event)) { cancel(); layout.close(); } }, options);
  doc.addEventListener('keydown', event => { if (!reasonPending && event.key === 'Escape') { cancel(); layout.close(); } }, options);
  doc.addEventListener('scroll', event => {
    // Startup layout changes can scroll the page after a permalink receives focus.
    // Keep a focused discussion open, just as pointer movement outside already does.
    if (!reasonPending && layout.compact && !container.contains(doc.activeElement) && !popups.contains(event.target)) { cancel(); layout.close(); }
  }, { ...options, capture: true });

  function thread(initial: HighlightAnnotation) {
    const element = doc.createElement('section'); element.className = 'annotation-comment-thread';
    element.dataset.annotationId = initial.id; element.setAttribute('aria-label', messages.thread);
    const content = doc.createElement('div'); content.className = 'annotation-comment-content'; element.append(content);
    // Keep the last message's controls in place when crossing into the card footer.
    let hoveredBody: HTMLElement | null = null;
    const clearHoveredBody = () => { hoveredBody?.classList.remove('annotation-comment-action-hover'); hoveredBody = null; };
    element.addEventListener('pointerover', event => {
      const body = (event.target as Element).closest<HTMLElement>('.annotation-comment-body');
      if (body && element.contains(body) && body !== hoveredBody) {
        clearHoveredBody(); hoveredBody = body; body.classList.add('annotation-comment-action-hover');
      }
    }, options);
    element.addEventListener('pointerleave', clearHoveredBody, options);
    const drafts = new Map<string, Draft>();
    const hasComment = (comment: AnnotationComment | undefined, id: string): boolean => Boolean(comment && (comment.id === id || comment.replies.some(reply => hasComment(reply, id))));
    for (const [storedKey, draft] of retainedDrafts) {
      if (draft.annotationId !== initial.id) continue;
      if (draft.kind === 'new') drafts.set('root', { kind: 'new', text: draft.text });
      else if (threadRoots(initial).some(root => hasComment(root, draft.commentId))
        && (draft.kind !== 'edit' || !needsModerationReason({ type: 'edit-comment', commentId: draft.commentId }, actor, initial) || draft.reason?.trim())) drafts.set(draft.kind + '/' + draft.commentId, { kind: draft.kind, commentId: draft.commentId, text: draft.text, ...(draft.reason ? { reason: draft.reason } : {}) });
      else continue;
      // Consume restored drafts once; a later hide/show must not replay the startup snapshot.
      retainedDrafts.delete(storedKey);
    }
    let renderEvents = new AbortController();
    let annotation = initial, signature = '', revision = 0, composing = false;
    element.addEventListener('compositionstart', () => { composing = true; }, options);
    element.addEventListener('compositionend', () => { composing = false; render(); }, options);
    const button = (label: string, action: () => void | Promise<void>) => {
      const control = doc.createElement('button'); control.type = 'button'; control.textContent = label;
      control.addEventListener('click', event => { event.stopPropagation(); void action(); }, { signal: renderEvents.signal }); return control;
    };
    const focusEditor = (key: string) => {
      const editor = [...element.querySelectorAll<HTMLTextAreaElement>('textarea')].find(input => input.dataset.draft === key);
      editor?.focus({ preventScroll: true });
    };
    const open = (key: string, draft: Draft) => { drafts.set(key, draft); render(); draftsChanged(); win.requestAnimationFrame(() => focusEditor(key)); };
    const removeDraft = (key: string, draft: Draft) => {
      drafts.delete(key); retainedDrafts.delete(draftKey({ ...draft, annotationId: initial.id }));
      if (threads.get(initial.id)?.element === element) render();
      draftsChanged();
    };
    const editor = (key: string, draft: Draft, savedComment?: AnnotationComment) => {
      const options = { signal: renderEvents.signal };
      const form = doc.createElement('form'); form.className = 'annotation-comment-body annotation-comment-editor';
      const input = doc.createElement('textarea'); input.dataset.draft = key; input.value = draft.text; input.rows = 1;
      input.placeholder = draft.kind === 'reply' ? messages.writeReply : messages.writeComment;
      input.setAttribute('aria-label', draft.kind === 'reply' ? messages.replyText : messages.commentText);
      const actions = doc.createElement('div'); actions.className = 'annotation-comment-editor-actions';
      const original = savedComment?.text.replace(/\r\n?/g, '\n');
      const canSubmit = () => Boolean(input.value.trim()) && (draft.kind !== 'edit' || (original !== undefined && input.value !== original));
      const send = button(draft.kind === 'edit' ? messages.saveChanges : messages.send, () => {
        if (!canSubmit()) return;
        const commentId = draft.kind === 'edit' ? draft.commentId : win.crypto.randomUUID();
        if (draft.kind === 'edit') {
          state.dispatch({ type: 'edit-comment', id: annotation.id, commentId, text: input.value, editedAt: new Date().toISOString(), ...(draft.reason ? { reason: draft.reason } : {}) });
        } else {
          const comment: AnnotationComment = { id: commentId, text: input.value, author: currentAuthor, createdAt: new Date().toISOString(), replies: [] };
          state.dispatch({ type: 'add-comment', id: annotation.id, comment, ...(draft.kind === 'reply' ? { parentId: draft.commentId } : {}) });
        }
        // A host can reject and roll back a submission (for example, after a permission change).
        const current = state.annotations.find(item => item.id === initial.id);
        if (current && findAnnotationComment(current, commentId)?.text === input.value) removeDraft(key, draft);
      });
      const discard = button(draft.kind === 'edit' ? messages.cancel : messages.discard, () => removeDraft(key, draft));
      actions.append(send, discard); form.append(metadata(savedComment?.author ?? currentAuthor, savedComment?.createdAt, savedComment?.editedAt, savedComment?.editedBy), input, actions);
      const resize = () => {
        const previous = input.style.height;
        input.style.height = '0px'; input.style.height = `${Math.min(360, Math.max(21, input.scrollHeight))}px`;
        if (input.style.height !== previous) revision++;
        send.disabled = !canSubmit(); layout.schedule();
      };
      input.addEventListener('input', () => { draft.text = input.value; resize(); draftsChanged(); }, options);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); send.click(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); discard.click(); }
      }, options);
      form.addEventListener('submit', event => { event.preventDefault(); send.click(); }, options);
      send.disabled = !canSubmit();
      win.requestAnimationFrame(() => { if (input.isConnected) resize(); });
      return form;
    };
    const message = (comment: AnnotationComment): HTMLElement => {
      const node = doc.createElement('div'); node.className = 'annotation-comment-node'; node.dataset.commentId = comment.id;
      node.tabIndex = -1;
      if (expandedRoots.has(comment.id)) node.dataset.commentAnchored = '';
      const copyLink = button('#', async () => {
        let copied = false;
        try {
          const link = renderOptions.commentLink?.(comment.id) ?? annotationCommentUrl(doc.location.href, comment.id).href;
          await win.navigator.clipboard.writeText(link); copied = true;
        } catch { /* The host reports unavailable or denied clipboard access. */ }
        copyLink.title = copied ? messages.linkCopied : messages.linkCopyFailed;
        renderOptions.onCommentLinkCopy?.(copied);
      });
      copyLink.title = messages.copyCommentLink; copyLink.setAttribute('aria-label', messages.copyCommentLink);
      const root = threadRoots(annotation).some(root => root.id === comment.id);
      const setResolution = (resolved: boolean) => state.dispatch({ type: 'set-thread-resolution', id: annotation.id, commentId: comment.id, resolved, at: new Date().toISOString() });
      let summary: HTMLElement | undefined, resolutionToggle: HTMLButtonElement | undefined;
      if (root && comment.resolution?.resolved) {
        node.dataset.resolved = '';
        node.tabIndex = 0;
        if ([...drafts.values()].some(draft => 'commentId' in draft && hasComment(comment, draft.commentId))) node.dataset.resolvedEditing = '';
        summary = doc.createElement('div'); summary.className = 'annotation-resolved-summary';
        const author = doc.createElement('span'); author.className = 'annotation-comment-author'; author.textContent = comment.author;
        const text = doc.createElement('span'); text.className = 'annotation-resolved-text'; text.textContent = renderCommentMarkup(doc, comment.text).textContent;
        summary.append(author, text);
        resolutionToggle = button(messages.resolved, () => setResolution(false)); resolutionToggle.className = 'annotation-resolution-toggle';
        const normal = doc.createElement('span'); normal.textContent = messages.resolved;
        const hover = doc.createElement('span'); hover.textContent = messages.unresolve;
        resolutionToggle.replaceChildren(normal, hover); resolutionToggle.disabled = renderOptions.commentCanWrite === false;
      }
      const editKey = 'edit/' + comment.id, replyKey = 'reply/' + comment.id;
      const edit = drafts.get(editKey);
      if (edit && canEditComment(comment, actor)) node.append(editor(editKey, edit, comment));
      else {
        const body = doc.createElement('div'); body.className = 'annotation-comment-body';
        const text = doc.createElement('div'); text.className = 'annotation-comment-text'; text.append(renderCommentMarkup(doc, comment.text));
        // Keyboard focus offers the same expanded reading state as hover.
        text.tabIndex = 0;
        const actions = doc.createElement('div'); actions.className = 'annotation-comment-actions';
        actions.append(copyLink);
        if (resolutionToggle) actions.append(resolutionToggle);
        else if (root && renderOptions.commentCanWrite !== false) actions.append(button(messages.markResolved, () => setResolution(true)));
        if (canResolveThread(annotation, comment.id, actor)) {
          actions.append(button(messages.resolve, async () => {
            const reason = await reasonFor({ type: 'resolve-comment', commentId: comment.id }, annotation);
            if (reason !== null && node.isConnected && !controller.signal.aborted) state.dispatch({ type: 'resolve-comment', id: annotation.id, commentId: comment.id, ...(reason ? { reason } : {}) });
          }));
        }
        if (canEditComment(comment, actor)) actions.append(button(messages.edit, async () => {
          const reason = await reasonFor({ type: 'edit-comment', commentId: comment.id }, annotation);
          if (reason !== null && node.isConnected && !controller.signal.aborted) open(editKey, { kind: 'edit', text: comment.text, commentId: comment.id, ...(reason ? { reason } : {}) });
        }));
        const reply = button(messages.reply, () => open(replyKey, { kind: 'reply', text: '', commentId: comment.id }));
        reply.className = 'annotation-comment-reply';
        if (summary) body.append(summary);
        body.append(metadata(comment.author, comment.createdAt, comment.editedAt, comment.editedBy), text, actions, reply); node.append(body);
      }
      if (comment.replies.length || drafts.has(replyKey)) {
        const replies = doc.createElement('div'); replies.className = 'annotation-comment-replies';
        for (const child of comment.replies) replies.append(message(child));
        const draft = drafts.get(replyKey); if (draft) replies.append(editor(replyKey, draft));
        node.append(replies);
      }
      return node;
    };
    const render = () => {
      if (composing) return;
      revision++;
      renderEvents.abort(); renderEvents = new AbortController();
      const scrollTop = content.scrollTop;
      const focused = doc.activeElement instanceof win.HTMLTextAreaElement && content.contains(doc.activeElement) ? doc.activeElement : null;
      const caret = focused ? { key: focused.dataset.draft, start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
      element.querySelector('.annotation-highlight-attribution')?.remove(); content.replaceChildren();
      if (annotation.author && (!threadRoots(annotation).length || threadRoots(annotation).some(root => root.author !== annotation.author))) {
        const attribution = doc.createElement('div'); attribution.className = 'annotation-highlight-attribution';
        attribution.textContent = messages.highlightedBy(annotation.author); attribution.title = attribution.textContent; element.prepend(attribution);
      }
      const rootDraft = drafts.get('root');
      const roots = threadRoots(annotation).filter(root => !root.resolved);
      element.toggleAttribute('data-all-resolved', Boolean(roots.length && roots.every(root => root.resolution?.resolved) && !drafts.size));
      for (const root of threadRoots(annotation)) if (!root.resolved) content.append(message(root));
      if (rootDraft) content.append(editor('root', rootDraft));
      else {
        const placeholder = button(threadRoots(annotation).length ? messages.addSeparateComment : messages.addComment, () => open('root', { kind: 'new', text: '' }));
        placeholder.className = 'annotation-comment-placeholder'; content.append(placeholder);
      }
      content.scrollTop = scrollTop;
      if (caret) { const input = [...content.querySelectorAll('textarea')].find(input => input.dataset.draft === caret.key); input?.focus({ preventScroll: true }); input?.setSelectionRange(caret.start, caret.end, caret.direction); }
      layout.schedule();
    };
    return {
      element,
      get annotation() { return annotation; },
      get revision() { return revision; },
      get drafts(): readonly CommentDraft[] { return [...drafts.values()].map(draft => Object.freeze({ ...draft, annotationId: annotation.id })); },
      reveal() { render(); },
      update(next: HighlightAnnotation) {
        annotation = next; element.dataset.color = next.color;
        const nextSignature = JSON.stringify([next.author ?? null, threadRoots(next)]);
        if (signature !== nextSignature) { signature = nextSignature; render(); }
        layout.schedule();
      },
      destroy() { renderEvents.abort(); drafts.clear(); element.remove(); },
    };
  }

  const sync: Parameters<typeof state.subscribe>[0] = annotations => {
    const visible = annotations.filter(annotationVisible);
    const ids = new Set(visible.map(annotation => annotation.id));
    for (const [id, item] of threads) if (!ids.has(id)) { for (const draft of item.drafts) retainedDrafts.set(draftKey(draft), draft); layout.unobserve(item.element); item.destroy(); threads.delete(id); }
    for (const annotation of visible) {
      let item = threads.get(annotation.id);
      if (!item) { item = thread(annotation); threads.set(annotation.id, item); container.append(item.element); layout.observe(item.element); }
      item.update(annotation);
    }
    layout.schedule();
  };
  sync(state.annotations);
  const stop = state.subscribe(sync);
  return {
    element: container,
    get drafts(): readonly CommentDraft[] { return readDrafts(); },
    async reveal(id: string): Promise<boolean> {
      const annotation = state.annotations.find(item => annotationVisible(item) && findAnnotationComment(item, id));
      const root = annotation && threadRoots(annotation).find(root => !root.resolved && findComment(root, id));
      if (!annotation || !root) return false;
      expandedRoots.add(root.id); threads.get(annotation.id)?.reveal();
      // Measure the passage after the article and responsive comment layout have mounted.
      await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
      if (controller.signal.aborted) return false;
      const range = view.restoreRange(annotation.anchor), first = range && textRects(range, doc)[0];
      if (first) win.scrollBy({ top: first.top - win.innerHeight / 3, behavior: 'instant' });
      await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
      if (controller.signal.aborted) return false;
      const anchor = range && textRects(range, doc)[0];
      if (anchor) activate(annotation.id, anchor);
      await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
      if (controller.signal.aborted) return false;
      const target = [...container.querySelectorAll<HTMLElement>('[data-comment-id]')].find(node => node.dataset.commentId === id);
      if (!target) return false;
      if (layout.compact) {
        // scrollIntoView can also move the page behind a popover, triggering its scroll-to-close handler.
        // Keep navigation inside the open panel, including replies below a long root comment.
        const content = target.closest<HTMLElement>('.annotation-comment-content');
        if (content) {
          const box = target.getBoundingClientRect(), viewport = content.getBoundingClientRect();
          if (box.top < viewport.top || box.bottom > viewport.bottom) content.scrollBy({ top: box.top - viewport.top, behavior: 'instant' });
        }
      } else target.scrollIntoView({ block: 'nearest' });
      target.focus({ preventScroll: true });
      return true;
    },
    activate,
    destroy() {
      cancel(); stop(); controller.abort(); layout.destroy(); for (const item of threads.values()) item.destroy(); threads.clear();
      container.remove(); if (!hadClass) column.classList.remove('annotation-comments-host');
    },
  };
}
