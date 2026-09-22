import { scalarBoundary, SourceIndex } from './source-index';
import type { MappedSelection, Projection, SourceAnchor, TextRun, ViewNode } from './types';

function sourcePosition(projection: Projection, run: TextRun, position: number, side: 'start' | 'end'): number {
  if (run.mapping === 'atomic') return side === 'start' ? run.from : run.to;
  return scalarBoundary(projection.source, run.from + position - run.viewFrom, side);
}

function viewPosition(run: TextRun, source: number, side: 'start' | 'end'): number {
  return run.mapping === 'atomic' ? (side === 'start' ? run.viewFrom : run.viewTo) : run.viewFrom + source - run.from;
}

/** Read a selection in the projected text. No phrase searching or inferred relocation. */
export function selectionFromView(projection: Projection, from: number, to: number): MappedSelection | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > projection.text.length) throw new RangeError('Invalid view interval.');
  if (from === to) return null;
  const selected = projection.runs.filter(run => run.viewTo > from && run.viewFrom < to);
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (!first || !last) return null;
  const sourceFrom = sourcePosition(projection, first, Math.max(from, first.viewFrom), 'start');
  const sourceTo = sourcePosition(projection, last, Math.min(to, last.viewTo), 'end');
  const viewFrom = viewPosition(first, sourceFrom, 'start');
  const viewTo = viewPosition(last, sourceTo, 'end');
  const index = new SourceIndex(projection.source);
  return {
    anchor: { unit: 'utf8-byte', start: index.toByte(sourceFrom), end: index.toByte(sourceTo) },
    quote: projection.text.slice(viewFrom, viewTo),
    sourceText: projection.source.slice(sourceFrom, sourceTo),
    adjusted: from !== viewFrom || to !== viewTo,
    viewFrom, viewTo,
  };
}

/** Hidden-only anchors cannot be restored. Partial entity spans expand explicitly. */
export function selectionFromSource(projection: Projection, anchor: SourceAnchor): MappedSelection | null {
  if (anchor.unit !== 'utf8-byte' || anchor.end < anchor.start) throw new RangeError('Invalid source anchor.');
  const index = new SourceIndex(projection.source);
  const from = index.toUtf16(anchor.start);
  const to = index.toUtf16(anchor.end);
  if (from === to) return null;
  const first = projection.runs.find(run => from >= run.from && from < run.to);
  const last = [...projection.runs].reverse().find(run => to > run.from && to <= run.to);
  if (!first || !last) {
    const isWholeLink = (nodes: readonly ViewNode[]): boolean => nodes.some(node => node.kind === 'element' && (
      (node.inspection?.kind === 'link' && node.inspection.from === from && node.inspection.to === to) || isWholeLink(node.children)
    ));
    if (!isWholeLink(projection.blocks)) return null;
    const runs = projection.runs.filter(run => run.from >= from && run.to <= to);
    if (!runs.length) return null;
    const selected = selectionFromView(projection, runs[0].viewFrom, runs[runs.length - 1].viewTo);
    return selected ? { ...selected, anchor, sourceText: projection.source.slice(from, to), adjusted: false } : null;
  }
  const selection = selectionFromView(projection, viewPosition(first, from, 'start'), viewPosition(last, to, 'end'));
  if (selection && (selection.anchor.start !== anchor.start || selection.anchor.end !== anchor.end)) selection.adjusted = true;
  return selection;
}
