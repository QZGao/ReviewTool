type PopupKind = 'source' | 'highlight' | 'comment';
interface Popup { element: HTMLElement; anchor: () => DOMRect }
interface Placement { top: number; height: number; distance: number; below: boolean }

/** Coordinate floating surfaces without covering each other at viewport edges. */
export function popupLayout(doc: Document) {
  const visible = new Map<PopupKind, Popup>();
  const margin = 12, gap = 8;
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
  const position = () => {
    const { clientWidth: width, clientHeight: height } = doc.documentElement;
    const bar = visible.get('highlight');
    const obstacles: DOMRect[] = [];
    if (bar) {
      const anchor = bar.anchor(), box = bar.element.getBoundingClientRect();
      const above = anchor.top - box.height - gap;
      bar.element.style.left = `${clamp(anchor.left + anchor.width / 2 - box.width / 2, margin, width - box.width - margin)}px`;
      bar.element.style.top = `${clamp(above >= margin ? above : anchor.bottom + gap, margin, height - box.height - margin)}px`;
      obstacles.push(bar.element.getBoundingClientRect());
    }
    for (const kind of ['comment', 'source'] as const) {
      const source = visible.get(kind);
      if (!source) continue;
      const popup = source.element;
      popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
      // A growing comment must leave room for the source tooltip and its padding.
      const reserved = kind === 'comment' && visible.has('source') ? 100 + gap * 2 + (obstacles[0]?.height ?? 0) : 0;
      popup.style.maxHeight = `${Math.max(0, Math.min(360, height - margin * 2 - reserved))}px`;
      const anchor = source.anchor(), box = popup.getBoundingClientRect();
      const left = clamp(anchor.left, margin, width - box.width - margin);
      // Free vertical intervals guarantee that even a tall image/source popup cannot
      // overlap the bar. Oversized content scrolls within the chosen interval.
      let intervals = [[margin, height - margin]];
      for (const obstacle of obstacles) {
        if (left >= obstacle.right + gap || left + box.width <= obstacle.left - gap) continue;
        intervals = intervals.flatMap(([low, high]) => [
          [low, Math.min(high, obstacle.top - gap)], [Math.max(low, obstacle.bottom + gap), high],
        ].filter(([start, end]) => end > start));
      }
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
      obstacles.push(popup.getBoundingClientRect());
    }
  };
  return {
    show(kind: PopupKind, element: HTMLElement, anchor: () => DOMRect) {
      // Keep DOM ancestry (theme inheritance, source mapping and event delegation),
      // but paint above article/sidebar stacking contexts and connector SVGs.
      element.setAttribute('popover', 'manual');
      if (!element.matches(':popover-open')) element.showPopover();
      visible.set(kind, { element, anchor }); position();
    },
    hide(kind: PopupKind) {
      const popup = visible.get(kind)?.element;
      visible.delete(kind);
      if (popup?.matches(':popover-open')) popup.hidePopover();
      // The comment area resumes its normal sidebar role on wider screens.
      popup?.removeAttribute('popover');
      position();
    },
    contains(target: EventTarget | null) {
      return Boolean(target && 'nodeType' in target && [...visible.values()].some(popup => popup.element.contains(target as Node)));
    },
  };
}

export type PopupLayout = ReturnType<typeof popupLayout>;
