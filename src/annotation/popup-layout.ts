type PopupKind = 'source' | 'highlight';
interface Popup { element: HTMLElement; anchor: () => DOMRect }
interface Placement { top: number; height: number; distance: number; below: boolean }

/** Coordinate the two floating surfaces without covering each other at viewport edges. */
export function popupLayout(doc: Document) {
  const visible = new Map<PopupKind, Popup>();
  const margin = 12, gap = 8;
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
  const position = () => {
    const { clientWidth: width, clientHeight: height } = doc.documentElement;
    const bar = visible.get('highlight'), source = visible.get('source');
    let barRect: DOMRect | undefined;
    if (bar) {
      const anchor = bar.anchor(), box = bar.element.getBoundingClientRect();
      const above = anchor.top - box.height - gap;
      bar.element.style.left = `${clamp(anchor.left + anchor.width / 2 - box.width / 2, margin, width - box.width - margin)}px`;
      bar.element.style.top = `${clamp(above >= margin ? above : anchor.bottom + gap, margin, height - box.height - margin)}px`;
      barRect = bar.element.getBoundingClientRect();
    }
    if (!source) return;
    const popup = source.element;
    popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    popup.style.maxHeight = `${Math.max(0, Math.min(360, height - margin * 2))}px`;
    const anchor = source.anchor(), box = popup.getBoundingClientRect();
    const left = clamp(anchor.left, margin, width - box.width - margin);
    const overlapsBar = barRect && left < barRect.right + gap && left + box.width > barRect.left - gap;
    // Free vertical intervals guarantee that even a tall image/source popup cannot
    // overlap the bar. Oversized content scrolls within the chosen interval.
    const intervals = overlapsBar && barRect
      ? [[margin, barRect.top - gap], [barRect.bottom + gap, height - margin]]
      : [[margin, height - margin]];
    const candidates: Placement[] = [];
    for (const [low, high] of intervals) {
      const below = Math.max(low, anchor.bottom + gap);
      const above = Math.min(high, anchor.top - gap);
      if (below < high) candidates.push({ top: below, height: Math.min(box.height, high - below), distance: below - anchor.bottom, below: true });
      if (above > low) {
        const size = Math.min(box.height, above - low);
        candidates.push({ top: above - size, height: size, distance: anchor.top - above, below: false });
      }
    }
    // Prefer a complete popup, then the closest placement. A source-only tooltip
    // keeps its existing above preference; paired tooltips prefer below the bar.
    candidates.sort((a, b) => b.height - a.height || a.distance - b.distance
      || (bar ? Number(b.below) - Number(a.below) : Number(a.below) - Number(b.below)));
    const chosen = candidates[0];
    if (chosen) {
      popup.style.maxHeight = `${chosen.height}px`;
      popup.style.top = `${chosen.top}px`;
    }
    popup.style.left = `${left}px`;
  };
  return {
    show(kind: PopupKind, element: HTMLElement, anchor: () => DOMRect) {
      visible.set(kind, { element, anchor }); position();
    },
    hide(kind: PopupKind) { visible.delete(kind); position(); },
    contains(target: EventTarget | null) {
      return Boolean(target && 'nodeType' in target && [...visible.values()].some(popup => popup.element.contains(target as Node)));
    },
  };
}

export type PopupLayout = ReturnType<typeof popupLayout>;
