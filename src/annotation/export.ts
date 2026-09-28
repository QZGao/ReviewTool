import type { Annotation } from '../annotations';
import type { ReviewIdentity } from './live-storage';
import { threadRoots } from './annotation-state';
import { headingSourceStart } from './heading-anchors';
import { selectionFromSource } from './mapping';
import { SourceIndex } from './source-index';
import type { AnnotationComment, AnnotationRemoval, HighlightAnnotation, Projection, ViewNode } from './types';

interface ExportedComment extends Annotation {
  highlightId: string;
  rootId: string;
  parentId: string | null;
  editedAt?: string;
  editedBy?: string;
  resolution?: AnnotationRemoval;
  closed: boolean;
  closure?: AnnotationRemoval;
}

/** A portable discussion export. The groups also feed the existing review-writing importer. */
export function buildAnnotationExport(identity: ReviewIdentity, pageName: string, projection: Projection, annotations: readonly HighlightAnnotation[]) {
  const index = new SourceIndex(projection.source);
  const sections: { start: number; path: string }[] = [], stack: { level: number; title: string }[] = [];
  const text = (nodes: readonly ViewNode[]): string => nodes.map(node => node.kind === 'text' ? node.text : node.kind === 'element' ? text(node.children) : '').join('');
  const walk = (nodes: readonly ViewNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'element') continue;
      const start = headingSourceStart(node);
      if (start !== undefined) {
        const level = Number(node.tag.slice(1));
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, title: text(node.children).trim() });
        sections.push({ start: index.toByte(start), path: stack.map(item => item.title).join(' / ') });
      }
      walk(node.children);
    }
  };
  walk(projection.blocks);
  const groups = new Map<string, ExportedComment[]>();
  const highlights = [...annotations].sort((a, b) => a.anchor.start - b.anchor.start || a.id.localeCompare(b.id)).map(annotation => {
    const sourceText = projection.source.slice(index.toUtf16(annotation.anchor.start), index.toUtf16(annotation.anchor.end));
    const quote = selectionFromSource(projection, annotation.anchor)?.quote ?? sourceText;
    const sectionPath = [...sections].reverse().find(section => section.start <= annotation.anchor.start)?.path ?? '序言';
    const visit = (comment: AnnotationComment, root: AnnotationComment, parentId: string | null) => {
      const entry: ExportedComment = {
        id: comment.id, highlightId: annotation.id, rootId: root.id, parentId,
        sectionPath, sentencePos: String(annotation.anchor.start), sentenceText: quote,
        opinion: comment.text, createdBy: comment.author, createdAt: Date.parse(comment.createdAt),
        resolved: Boolean(root.resolution?.resolved), closed: Boolean(root.resolved),
        ...(comment.editedAt ? { editedAt: comment.editedAt } : {}),
        ...(comment.editedBy ? { editedBy: comment.editedBy } : {}),
        ...(root.resolution ? { resolution: root.resolution } : {}),
        ...(root.resolved ? { closure: root.resolved } : {}),
      };
      const group = groups.get(sectionPath) ?? []; group.push(entry); groups.set(sectionPath, group);
      for (const reply of comment.replies) visit(reply, root, comment.id);
    };
    for (const root of threadRoots(annotation)) visit(root, root, null);
    // Highlight metadata remains independent from comment authorship and edit metadata.
    const metadata = { ...annotation }; delete metadata.threads; delete metadata.comment;
    return { ...metadata, sectionPath, quote, sourceText };
  });
  return { format: 'reviewtool.annotation-export/1', exportedAt: Date.now(), pageName,
    document: { ...identity, offsetUnit: 'utf8-byte' as const }, highlights,
    groups: [...groups].map(([sectionPath, annotations]) => ({ sectionPath, annotations })),
  };
}

export function downloadAnnotationExport(doc: Document, payload: ReturnType<typeof buildAnnotationExport>): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = doc.createElement('a'); link.href = url;
  link.download = `review-tool-annotations-${payload.document.revisionId}-${new Date(payload.exportedAt).toISOString().replace(/[:.]/g, '')}.json`;
  doc.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
