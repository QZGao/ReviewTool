import { addPortletTrigger, addVectorMenuTab } from './utils';
import state from '../state';

/** Keep the article tab and its action-menu counterpart on the same view state. */
export function addMainPageReviewToolButtonsToDOM(toggle: () => void) {
    const tab = addVectorMenuTab('ca-annotate', state.convByVar({ hant: '批註模式', hans: '批注模式' }),
        state.convByVar({ hant: '切換批註模式', hans: '切换批注模式' }), toggle);
    return {
        update(active: boolean, busy = false) {
            const label = state.convByVar({
                hant: active ? '關閉批註模式' : '啟用批註模式',
                hans: active ? '关闭批注模式' : '开启批注模式',
            });
            addPortletTrigger('ca-reviewtool-toggle', label, toggle);
            for (const item of [tab, document.getElementById('ca-reviewtool-toggle')]) {
                if (!item) continue;
                item.classList.toggle('selected', active);
                const link = item.querySelector('a');
                link?.setAttribute('aria-expanded', String(active));
                link?.setAttribute('aria-busy', String(busy));
                const span = item.querySelector<HTMLElement>('a > span');
                if (span) span.style.fontWeight = active ? 'bold' : 'normal';
            }
        },
    };
}
