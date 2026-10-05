import type { Component, h as renderNode, ref as reactiveRef } from 'vue';
import { cdxIconStar, cdxIconUnStar } from '@wikimedia/codex-icons';
import { loadCodexAndVue } from '../dialog';
import state from '../state';
import type { AnnotationVisits } from './visits';

export async function subscriptionControl(original: HTMLElement, visits: AnnotationVisits, pageName: string, oldid: number, signal: AbortSignal) {
  const { Vue, Codex } = await loadCodexAndVue();
  if (signal.aborted) return;
  const runtime = Vue as typeof Vue & { h: typeof renderNode; ref: typeof reactiveRef };
  if (!Codex.CdxToggleButton || !Codex.CdxIcon) throw new Error('Codex subscription controls are unavailable.');
  const Toggle = Codex.CdxToggleButton as Component, Icon = Codex.CdxIcon as Component;
  const subscribed = runtime.ref(visits.get(oldid)?.subscribed ?? false);
  const host = original.ownerDocument.createElement('div'); host.className = 'annotation-subscription-controls';
  const app = runtime.createMwApp({ render: () => runtime.h(Toggle, {
    modelValue: subscribed.value,
    title: state.convByVar({ hant: '在此瀏覽器中接收這個版本的批註更新提醒', hans: '在此浏览器中接收这个版本的批注更新提醒' }),
    'onUpdate:modelValue': (value: boolean) => {
      try { visits.subscribe(pageName, oldid, value); subscribed.value = value; }
      catch (error) {
        console.warn('[ReviewTool] Subscription could not be saved', error);
        void mw.notify(state.convByVar({ hant: '無法儲存訂閱設定，請檢查瀏覽器是否允許本機儲存。', hans: '无法保存订阅设置，请检查浏览器是否允许本地存储。' }), { title: 'ReviewTool', type: 'error', autoHide: false });
      }
    },
  }, { default: () => [runtime.h(Icon, { icon: subscribed.value ? cdxIconUnStar : cdxIconStar }), state.convByVar({ hant: '訂閱批註', hans: '订阅批注' })] }) });
  const update = (event: StorageEvent) => { if (event.key === null || event.key === visits.prefix + oldid) subscribed.value = visits.get(oldid)?.subscribed ?? false; };
  window.addEventListener('storage', update, { signal });
  original.before(host); app.mount(host);
  signal.addEventListener('abort', () => { app.unmount(); host.remove(); }, { once: true });
}
