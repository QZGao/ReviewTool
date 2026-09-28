import { annotationMessages, type AnnotationMessages } from './i18n';
import type { Component, h as renderNode, ref as reactiveRef } from 'vue';
import { loadCodexAndVue } from '../dialog';
import type { ModerationReasonPrompt } from './types';
import { checkedReason } from './permissions';

/** Load once before enabling moderator controls; each prompt owns its mount and cleanup. */
export async function createCodexReasonPrompt(doc: Document, messages: AnnotationMessages = annotationMessages()): Promise<ModerationReasonPrompt> {
  const { Vue, Codex } = await loadCodexAndVue();
  const runtime = Vue as typeof Vue & { h: typeof renderNode; ref: typeof reactiveRef };
  if (!Codex.CdxDialog || !Codex.CdxTextInput) throw new Error('Codex dialog components are unavailable.');
  const Dialog = Codex.CdxDialog as Component, TextInput = Codex.CdxTextInput as Component;
  const browserWindow = doc.defaultView;
  if (!browserWindow) throw new Error('The reason dialog requires a browser window.');
  const win = browserWindow;
  let active = false;
  return (action, signal) => {
    if (active || signal.aborted) return Promise.resolve(null);
    active = true;
    const confirmation = action === 'confirm-close';
    return new Promise(resolve => {
      const host = doc.createElement('div'); host.dataset.annotationReasonDialog = '';
      host.setAttribute('popover', 'manual');
      host.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;color:var(--color-base,#202122)';
      const inputId = 'reviewtool-reason-' + win.crypto.randomUUID();
      const value = runtime.ref(''), reasonError = () => {
        if (confirmation) return '';
        try { checkedReason(value.value); return ''; }
        catch { return value.value.trim() ? messages.reasonTooLong : messages.reasonRequired; }
      };
      const title = confirmation ? messages.closeThreadTitle : action === 'edit-comment' ? messages.editReason : action === 'resolve-comment' ? messages.resolveReason : messages.deleteReason;
      const label = confirmation ? messages.resolveThread : action === 'edit-comment' ? messages.continueEditing : action === 'resolve-comment' ? messages.resolveThread : messages.deleteHighlight;
      const moderationAction = action === 'edit-comment' ? messages.moderatorEdit : action === 'resolve-comment' ? messages.moderatorResolve : messages.moderatorDelete;
      let settled = false, composing = false, compositionEnded = -Infinity;
      const previousFocus = doc.activeElement as HTMLElement | null;
      const app = runtime.createMwApp({
        render() {
          const error = reasonError();
          return runtime.h(Dialog, {
            open: true, renderInPlace: true, title, useCloseButton: true, closeButtonLabel: messages.close,
            primaryAction: { label, actionType: action === 'edit-comment' ? 'progressive' : 'destructive', disabled: Boolean(error) },
            defaultAction: { label: messages.cancel },
            onPrimary: () => { if (!reasonError()) finish(confirmation ? '' : checkedReason(value.value)); },
            onDefault: () => finish(null), 'onUpdate:open': (open: boolean) => { if (!open) finish(null); },
          }, { default: () => confirmation ? [runtime.h('p', messages.closeThreadExplanation)] : [
            runtime.h('p', moderationAction),
            runtime.h('p', messages.reasonExplanation),
            runtime.h('label', { for: inputId, style: 'display:block;font-weight:600;margin-bottom:8px' }, messages.reason),
            runtime.h(TextInput, { id: inputId, modelValue: value.value, 'onUpdate:modelValue': (next: string) => { value.value = next; },
              status: value.value && error ? 'error' : 'default', 'aria-describedby': inputId + '-help', autofocus: true,
            }),
            runtime.h('p', { id: inputId + '-help', 'aria-live': 'polite', style: 'font-size:0.875em;color:var(--color-subtle,#54595d)' },
              value.value && error ? error : messages.reasonHelp),
          ] });
        },
      }) as ReturnType<typeof Vue.createMwApp> & { unmount(): void };
      function finish(reason: string | null) {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', abort);
        win.removeEventListener('keydown', guardEscape, true); win.removeEventListener('keyup', guardEscape, true);
        app.unmount(); host.remove(); active = false;
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        resolve(reason);
      }
      const abort = () => finish(null);
      // Preserve Escape for Chinese/Japanese IME cancellation rather than closing the dialog.
      host.addEventListener('compositionstart', () => { composing = true; });
      host.addEventListener('compositionend', () => { composing = false; compositionEnded = Date.now(); });
      const guardEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && host.contains(event.target as Node) && (event.isComposing || composing || Date.now() - compositionEnded < 500)) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      };
      win.addEventListener('keydown', guardEscape, true);
      win.addEventListener('keyup', guardEscape, true);
      signal.addEventListener('abort', abort, { once: true });
      doc.body.append(host); host.showPopover(); app.mount(host);
      win.requestAnimationFrame(() => { if (!settled) host.querySelector<HTMLInputElement>('input')?.focus(); });
    });
  };
}
