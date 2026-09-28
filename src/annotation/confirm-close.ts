import type { AnnotationMessages } from './i18n';

/** Standalone-view confirmation; the live host supplies its Codex dialog. */
export function confirmThreadClose(doc: Document, messages: AnnotationMessages, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const dialog = doc.createElement('dialog'); dialog.className = 'annotation-close-confirm';
    dialog.setAttribute('aria-label', messages.closeThreadTitle);
    const text = doc.createElement('p'); text.textContent = messages.closeThreadExplanation;
    const finish = (value: boolean) => { signal.removeEventListener('abort', abort); dialog.remove(); resolve(value); };
    const abort = () => finish(false);
    const cancel = doc.createElement('button'); cancel.textContent = messages.cancel; cancel.onclick = () => finish(false);
    const confirm = doc.createElement('button'); confirm.textContent = messages.resolveThread; confirm.onclick = () => finish(true);
    dialog.append(text, cancel, confirm); doc.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    signal.addEventListener('abort', abort, { once: true }); dialog.showModal(); cancel.focus();
  });
}
