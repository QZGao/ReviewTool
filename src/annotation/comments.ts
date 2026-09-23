import { commentLayout } from './comment-layout';
import type { AnnotationComment, CommentDraft, HighlightAnnotation, RenderedView } from './types';
import type { PopupLayout } from './popup-layout';
import { textRects } from './range-rects';

type Draft = { text: string; kind: 'new' } | { text: string; kind: 'reply' | 'edit'; commentId: string };

/** A local comment thread for each source-anchored highlight. */
export function createCommentPanel(doc: Document, view: RenderedView, column: HTMLElement, popups: PopupLayout, author: string, initialDrafts: readonly CommentDraft[] = []) {
  const highlighting = view.highlighting, window = doc.defaultView;
  if (!highlighting || !window) throw new Error('Comments require annotation highlighting in a browser window.');
  const state = highlighting, win = window;
  const currentAuthor = author.trim();
  // Omitting timeZone uses the browser/system timezone, including daylight saving.
  const dateOptions: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const dateFormat = new Intl.DateTimeFormat(undefined, dateOptions);
  const detailedDateFormat = new Intl.DateTimeFormat(undefined, { ...dateOptions, second: '2-digit', timeZoneName: 'long' });
  const metadata = (name: string, createdAt?: string) => {
    const row = doc.createElement('div'); row.className = 'annotation-comment-meta';
    const author = doc.createElement('span'); author.className = 'annotation-comment-author'; author.textContent = name;
    row.append(author);
    if (createdAt) {
      const time = doc.createElement('time'); time.className = 'annotation-comment-date'; time.dateTime = createdAt;
      const date = new Date(createdAt);
      time.textContent = dateFormat.format(date); time.title = detailedDateFormat.format(date);
      row.append(time);
    }
    return row;
  };
  const controller = new AbortController(), options = { signal: controller.signal };
  const container = doc.createElement('aside');
  container.className = 'annotation-comments'; container.setAttribute('aria-label', 'Annotation comments');
  container.dataset.annotationUi = ''; container.hidden = true;
  const hadClass = column.classList.contains('annotation-comments-host');
  column.classList.add('annotation-comments-host'); column.append(container);
  const threads = new Map<string, ReturnType<typeof thread>>();
  const layout = commentLayout(doc, view, column, container, () => [...threads.values()].map(item => ({ element: item.element, anchor: item.annotation.anchor, revision: item.revision })), popups);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const activate = (id: string, anchor: DOMRect) => { cancel(); layout.activate(id, anchor); };
  const atHighlight = (event: MouseEvent) => {
    const annotation = state.annotations.find(item => item.id === layout.active);
    const range = annotation && view.restoreRange(annotation.anchor);
    return range && textRects(range, doc).some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
  };
  doc.addEventListener('pointermove', event => {
    if (!layout.compact || !layout.active || event.buttons) return;
    if (popups.contains(event.target) || container.contains(doc.activeElement) || atHighlight(event)) { cancel(); return; }
    if (timer === undefined) timer = setTimeout(() => { timer = undefined; layout.close(); }, 180);
  }, options);
  doc.addEventListener('pointerdown', event => { if (layout.compact && !popups.contains(event.target) && !atHighlight(event)) { cancel(); layout.close(); } }, options);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') { cancel(); layout.close(); } }, options);
  doc.addEventListener('scroll', event => { if (layout.compact && !popups.contains(event.target)) { cancel(); layout.close(); } }, { ...options, capture: true });

  function thread(initial: HighlightAnnotation) {
    const element = doc.createElement('section'); element.className = 'annotation-comment-thread';
    element.dataset.annotationId = initial.id; element.setAttribute('aria-label', 'Comment thread');
    const drafts = new Map<string, Draft>();
    const hasComment = (comment: AnnotationComment | undefined, id: string): boolean => Boolean(comment && (comment.id === id || comment.replies.some(reply => hasComment(reply, id))));
    for (const draft of initialDrafts) {
      if (draft.annotationId !== initial.id) continue;
      if (draft.kind === 'new' && !initial.comment) drafts.set('root', { kind: 'new', text: draft.text });
      else if (draft.kind !== 'new' && hasComment(initial.comment, draft.commentId)) drafts.set(draft.kind + '/' + draft.commentId, { kind: draft.kind, commentId: draft.commentId, text: draft.text });
    }
    let renderEvents = new AbortController();
    let annotation = initial, signature = '', revision = 0;
    const button = (label: string, action: () => void) => {
      const control = doc.createElement('button'); control.type = 'button'; control.textContent = label;
      control.addEventListener('click', event => { event.stopPropagation(); action(); }, { signal: renderEvents.signal }); return control;
    };
    const focusEditor = (key: string) => {
      const editor = [...element.querySelectorAll<HTMLTextAreaElement>('textarea')].find(input => input.dataset.draft === key);
      editor?.focus({ preventScroll: true });
    };
    const open = (key: string, draft: Draft) => { drafts.set(key, draft); render(); win.requestAnimationFrame(() => focusEditor(key)); };
    const editor = (key: string, draft: Draft, savedComment?: AnnotationComment) => {
      const options = { signal: renderEvents.signal };
      const form = doc.createElement('form'); form.className = 'annotation-comment-body annotation-comment-editor';
      const input = doc.createElement('textarea'); input.dataset.draft = key; input.value = draft.text; input.rows = 1;
      input.placeholder = draft.kind === 'reply' ? 'Write a reply…' : 'Write a comment…';
      input.setAttribute('aria-label', draft.kind === 'reply' ? 'Reply text' : 'Comment text');
      const actions = doc.createElement('div'); actions.className = 'annotation-comment-editor-actions';
      const original = savedComment?.text.replace(/\r\n?/g, '\n');
      const canSubmit = () => Boolean(input.value.trim()) && (draft.kind !== 'edit' || (original !== undefined && input.value !== original));
      const send = button(draft.kind === 'edit' ? 'Save changes' : 'Send', () => {
        if (!canSubmit()) return;
        drafts.delete(key);
        if (draft.kind === 'edit') state.dispatch({ type: 'edit-comment', id: annotation.id, commentId: draft.commentId, text: input.value });
        else {
          const comment: AnnotationComment = { id: win.crypto.randomUUID(), text: input.value, author: currentAuthor, createdAt: new Date().toISOString(), replies: [] };
          state.dispatch({ type: 'add-comment', id: annotation.id, comment, ...(draft.kind === 'reply' ? { parentId: draft.commentId } : {}) });
        }
      });
      const discard = button(draft.kind === 'edit' ? 'Cancel' : 'Discard', () => { drafts.delete(key); render(); });
      actions.append(send, discard); form.append(metadata(savedComment?.author ?? currentAuthor, savedComment?.createdAt), input, actions);
      const resize = () => {
        const previous = input.style.height;
        input.style.height = '0px'; input.style.height = `${Math.min(360, Math.max(21, input.scrollHeight))}px`;
        if (input.style.height !== previous) revision++;
        send.disabled = !canSubmit(); layout.schedule();
      };
      input.addEventListener('input', () => { draft.text = input.value; resize(); }, options);
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
      const editKey = 'edit/' + comment.id, replyKey = 'reply/' + comment.id;
      const edit = drafts.get(editKey);
      if (edit) node.append(editor(editKey, edit, comment));
      else {
        const body = doc.createElement('div'); body.className = 'annotation-comment-body';
        const text = doc.createElement('div'); text.className = 'annotation-comment-text'; text.textContent = comment.text;
        // Keyboard focus offers the same expanded reading state as hover.
        text.tabIndex = 0;
        const actions = doc.createElement('div'); actions.className = 'annotation-comment-actions';
        actions.append(button('Resolve', () => state.dispatch({ type: 'resolve-comment', id: annotation.id, commentId: comment.id })),
          button('Edit', () => open(editKey, { kind: 'edit', text: comment.text, commentId: comment.id })));
        const reply = button('Reply', () => open(replyKey, { kind: 'reply', text: '', commentId: comment.id }));
        reply.className = 'annotation-comment-reply';
        body.append(metadata(comment.author, comment.createdAt), text, actions, reply); node.append(body);
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
      revision++;
      renderEvents.abort(); renderEvents = new AbortController();
      element.replaceChildren();
      const rootDraft = drafts.get('root');
      if (annotation.comment) element.append(message(annotation.comment));
      else if (rootDraft) element.append(editor('root', rootDraft));
      else {
        const placeholder = button('Add a comment…', () => open('root', { kind: 'new', text: '' }));
        placeholder.className = 'annotation-comment-placeholder'; element.append(placeholder);
      }
      layout.schedule();
    };
    return {
      element,
      get annotation() { return annotation; },
      get revision() { return revision; },
      get drafts(): readonly CommentDraft[] { return [...drafts.values()].map(draft => Object.freeze({ ...draft, annotationId: annotation.id })); },
      update(next: HighlightAnnotation) {
        annotation = next; element.dataset.color = next.color;
        const nextSignature = JSON.stringify(next.comment ?? null);
        if (signature !== nextSignature) { signature = nextSignature; render(); }
        layout.schedule();
      },
      destroy() { renderEvents.abort(); drafts.clear(); element.remove(); },
    };
  }

  const sync: Parameters<typeof state.subscribe>[0] = annotations => {
    const ids = new Set(annotations.map(annotation => annotation.id));
    for (const [id, item] of threads) if (!ids.has(id)) { layout.unobserve(item.element); item.destroy(); threads.delete(id); }
    for (const annotation of annotations) {
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
    get drafts(): readonly CommentDraft[] { return Object.freeze([...threads.values()].flatMap(thread => thread.drafts)); },
    activate,
    destroy() {
      cancel(); stop(); controller.abort(); layout.destroy(); for (const item of threads.values()) item.destroy(); threads.clear();
      container.remove(); if (!hadClass) column.classList.remove('annotation-comments-host');
    },
  };
}
