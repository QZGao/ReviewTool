import { parseSource } from './parse';
import { SourceIndex } from './source-index';
import type { Fallback, HiddenSource, Projection, ProjectionOptions, TextRun, ViewNode } from './types';

function leaves(node: ViewNode): (TextRun | HiddenSource)[] {
  return node.kind === 'element' ? node.children.reduce<(TextRun | HiddenSource)[]>((all, child) => all.concat(leaves(child)), []) : [node];
}

function markReferenceGaps(children: ViewNode[]): void {
  let afterReference = false;
  let whitespace: TextRun[] = [];
  for (const child of children) {
    if (child.kind === 'hidden') continue;
    if (child.kind === 'element' && child.inspection?.kind === 'reference') {
      if (afterReference && whitespace.some(run => /[\r\n]/.test(run.text))) whitespace.forEach(run => { run.referenceGap = true; });
      afterReference = true; whitespace = [];
    } else if (afterReference && child.kind === 'text' && !child.text.trim()) whitespace.push(child);
    else { afterReference = false; whitespace = []; }
  }
}

/** The returned document is immutable. Source is never reserialized or normalized. */
export function createProjection(source: string, options: ProjectionOptions = {}): Projection {
  return finalizeProjection(source, parseSource(source, options));
}

/** Finalize the source model; reference images never change its coordinates. */
function finalizeProjection(source: string, blocks: ViewNode[]): Projection {
  new SourceIndex(source); // Reject strings which cannot have lossless UTF-8 coordinates.
  const runs: TextRun[] = [];
  const hidden: HiddenSource[] = [];
  const fallbacks: Fallback[] = [];
  let readable = '';
  let referenceNumber = 0;
  let externalNumber = 0;
  const visit = (node: ViewNode) => {
    if (node.kind === 'hidden') { hidden.push(node); return; }
    if (node.kind === 'text') {
      node.id = `r${runs.length}`;
      node.viewFrom = readable.length;
      readable += node.text;
      node.viewTo = readable.length;
      runs.push(node);
      return;
    }
    if (node.flowBreak && readable) {
      const required = node.flowBreak === 'paragraph' ? 2 : 1;
      const trailing = readable.match(/(?:\r\n|\r|\n)+$/)?.[0].match(/\r\n|\r|\n/g)?.length ?? 0;
      readable += '\n'.repeat(Math.max(0, required - trailing));
    }
    if (node.rawKind) {
      const extent = leaves(node);
      fallbacks.push({ from: extent[0].from, to: extent[extent.length - 1].to, reason: node.rawKind });
    }
    if (node.inspection?.kind === 'reference') {
      const marker = node.children[0] as TextRun;
      if (!marker.text) marker.text = `[${node.inspection.name ?? ++referenceNumber}]`;
    }
    if (node.externalNumber) (node.children[0] as TextRun).text = `[${++externalNumber}]`;
    markReferenceGaps(node.children);
    node.children.forEach((child, i) => {
      const nestedList = ['li', 'dt', 'dd'].includes(node.tag) && child.kind === 'element' && ['ul', 'ol', 'dl'].includes(child.tag);
      const listItem = ['ul', 'ol', 'dl'].includes(node.tag) && child.kind === 'element' && ['li', 'dt', 'dd'].includes(child.tag);
      if (i && (listItem || nestedList) && readable && !readable.endsWith('\n')) readable += '\n';
      visit(child);
    });
  };
  for (const block of blocks) {
    visit(block);
  }
  // Every input code unit must be visible or deliberately hidden exactly once.
  // This invariant also catches parser mistakes before a misleading view is displayed.
  let cursor = 0;
  for (const leaf of blocks.reduce<(TextRun | HiddenSource)[]>((all, block) => all.concat(leaves(block)), [])) {
    if (leaf.from !== cursor || leaf.to < leaf.from || leaf.to > source.length) {
      throw new Error(`Invalid projection coverage at source offset ${cursor}.`);
    }
    if (leaf.kind === 'text' && leaf.mapping === 'identity' && leaf.text !== source.slice(leaf.from, leaf.to)) {
      throw new Error('Identity run differs from original source.');
    }
    cursor = leaf.to;
  }
  if (cursor !== source.length) throw new Error(`Projection omitted source after offset ${cursor}.`);
  const freeze = (node: ViewNode): void => {
    if (node.kind === 'element') { node.children.forEach(freeze); Object.freeze(node.children); if (node.inspection) Object.freeze(node.inspection); if (node.attributes) Object.freeze(node.attributes); }
    Object.freeze(node);
  };
  blocks.forEach(freeze);
  return Object.freeze({ source, blocks: Object.freeze(blocks), runs: Object.freeze(runs), hidden: Object.freeze(hidden), fallbacks: Object.freeze(fallbacks.map(f => Object.freeze(f))), text: readable });
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
}

/** Core HTML only. Cached presentation previews are handled by createAnnotationView. */
export function renderToHtml(projection: Projection): string {
  const emit = (node: ViewNode): string => {
    if (node.kind === 'hidden') return '';
    if (node.kind === 'text') return `<span data-source-run="${node.id}"${node.referenceGap ? ' data-reference-gap=""' : ''}${node.lineBreak ? ' data-line-break=""' : ''}>${escapeHtml(node.text)}</span>`;
    const attrs = `${node.href ? ` data-target-url="${escapeHtml(node.href)}"` : ''}${node.rawKind ? ` data-raw-kind="${escapeHtml(node.rawKind)}" aria-label="Raw wikitext: ${escapeHtml(node.rawKind)}"` : ''}${node.template ? ' data-template=""' : ''}${node.lineBreak ? ' data-line-break=""' : ''}${node.sourceKind ? ` data-source-kind="${node.sourceKind}"` : ''}${node.inspection && node.inspection.kind !== 'image' ? ` data-inspect="${node.inspection.kind}" role="button" tabindex="0" aria-expanded="false"` : ''}`;
    const presentation = Object.entries(node.attributes ?? {}).map(([key, value]) => ` ${key}="${escapeHtml(value)}"`).join('');
    const spacing = node.flowBreak ? ` data-break-before="${node.flowBreak}"` : '';
    const caption = node.fileCaption ? ' data-file-caption=""' : '';
    if (node.tag === 'hr') return `<hr${attrs}${presentation}${spacing}>`;
    return `<${node.tag}${attrs}${presentation}${spacing}${caption}>${node.children.map(emit).join('')}</${node.tag}>`;
  };
  return `<article class="annotation-document" aria-label="Annotation reading view">${projection.blocks.map(emit).join('')}</article>`;
}
