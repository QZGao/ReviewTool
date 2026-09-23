/** All parser/model positions are half-open UTF-16 offsets in the original string. */
export interface SourceExtent { from: number; to: number }

export interface TextRun extends SourceExtent {
  kind: 'text';
  text: string;
  mapping: 'identity' | 'atomic';
  id: string;
  viewFrom: number;
  viewTo: number;
  referenceGap?: true;
  lineBreak?: true;
}

export interface HiddenSource extends SourceExtent { kind: 'hidden' }

export type Tag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'strong' | 'em' | 'a' | 'sup' | 'sub' | 'code' | 'span' | 'ul' | 'ol' | 'li' | 'dl' | 'dt' | 'dd' | 'pre' | 'div'
  | 'u' | 's' | 'del' | 'ins' | 'small' | 'big' | 'mark' | 'abbr' | 'bdi' | 'bdo' | 'cite' | 'dfn' | 'kbd'
  | 'q' | 'ruby' | 'rt' | 'rp' | 'samp' | 'time' | 'var' | 'blockquote' | 'hr';

export interface ElementNode {
  kind: 'element';
  tag: Tag;
  children: ViewNode[];
  href?: string;
  rawKind?: string;
  fileName?: string;
  fileCaption?: true;
  template?: true;
  lineBreak?: true;
  externalNumber?: true;
  flowBreak?: 'line' | 'paragraph';
  attributes?: Record<string, string>;
  sourceKind?: 'table' | 'references' | 'markup' | 'conversion';
  inspection?: SourceExtent & { kind: 'link' | 'reference' | 'image'; name?: string };
}

export type ViewNode = TextRun | HiddenSource | ElementNode;

export interface Fallback extends SourceExtent { reason: string }

export interface Projection {
  readonly source: string;
  readonly blocks: readonly ViewNode[];
  readonly runs: readonly TextRun[];
  readonly hidden: readonly HiddenSource[];
  readonly fallbacks: readonly Fallback[];
  /** Readable text, with explicit separators between visual blocks. */
  readonly text: string;
}

export interface ProjectionOptions {
  /** Absolute HTTP(S) article-directory URL. No MediaWiki globals are used. */
  wikiBaseUrl?: string;
}

/** Persistent coordinates explicitly identify their unit. Revision identity belongs to the caller. */
export interface SourceAnchor { unit: 'utf8-byte'; start: number; end: number }

export interface MappedSelection {
  anchor: SourceAnchor;
  quote: string;
  sourceText: string;
  /** True if an entity, Unicode boundary, or non-text block separator expanded/trimmed the selection. */
  adjusted: boolean;
  viewFrom: number;
  viewTo: number;
}

export type HighlightColor = 'red' | 'yellow' | 'green' | 'blue';

export interface AnnotationComment {
  readonly id: string;
  readonly text: string;
  readonly author: string;
  /** Posting time as a UTC ISO 8601 string ending in Z. Display formatting belongs to the view. */
  readonly createdAt: string;
  readonly replies: readonly AnnotationComment[];
}

/** Unsent UI state, kept separately from committed annotation/comment data. */
export type CommentDraft = { annotationId: string; text: string } & (
  { kind: 'new' } | { kind: 'reply' | 'edit'; commentId: string }
);

export interface HighlightAnnotation {
  readonly id: string;
  readonly anchor: Readonly<SourceAnchor>;
  readonly color: HighlightColor;
  readonly comment?: AnnotationComment;
}

/** Local user actions; persistence and revision identity belong to the caller. */
export type HighlightAction =
  | { type: 'add-highlight'; highlight: HighlightAnnotation }
  | { type: 'recolor-highlight'; id: string; color: HighlightColor }
  | { type: 'delete-highlight'; id: string }
  | { type: 'add-comment'; id: string; comment: AnnotationComment; parentId?: string }
  | { type: 'edit-comment'; id: string; commentId: string; text: string }
  | { type: 'resolve-comment'; id: string; commentId: string };

export interface HighlightOptions {
  initial?: readonly HighlightAnnotation[];
  onChange?: (annotations: readonly HighlightAnnotation[], action: HighlightAction) => void;
}

export interface HighlightingView {
  readonly annotations: readonly HighlightAnnotation[];
  /** Replace a committed snapshot without generating a user action. Invalid anchors throw. */
  replace(annotations: readonly HighlightAnnotation[]): void;
  dispatch(action: HighlightAction): void;
  subscribe(listener: (annotations: readonly HighlightAnnotation[], action?: HighlightAction) => void): () => void;
}

export interface RenderedView {
  element: HTMLElement;
  projection: Projection;
  /** Last selection made in this view; outside selections and popups do not clear it. */
  readonly selection: MappedSelection | null;
  readonly highlighting: HighlightingView | null;
  readonly comments: { element: HTMLElement; readonly drafts: readonly CommentDraft[] } | null;
  clearSelection(): void;
  readRange(range: Range): MappedSelection | null;
  restoreRange(anchor: SourceAnchor): Range | null;
  /** Release selection highlights, popup listeners and timers before unmounting this view. */
  destroy(): void;
}

export interface RenderOptions {
  referenceHtml?: string;
  /** Resolves relative URLs in the reference HTML. */
  referenceBaseUrl?: string;
  /** Only notified when this view's source selection changes or is explicitly cleared. */
  onSelectionChange?: (selection: MappedSelection | null) => void;
  /** Opt in to source-anchored markers and the selection/hover color bar. */
  highlighting?: HighlightOptions;
  /** Optional host for comment threads, outside the article's selectable source. */
  commentContainer?: HTMLElement;
  /** Name recorded on new comments/replies; required when a comment panel is enabled. */
  commentAuthor?: string;
  commentDrafts?: readonly CommentDraft[];
}

/** Temporary navigation metadata for a heading in this exact source revision. */
export interface WikipediaHeadingAnchor {
  unit: 'utf8-byte';
  start: number;
  level: number;
  id: string;
}

export interface WikipediaViewOptions extends RenderOptions {
  headingAnchors?: readonly WikipediaHeadingAnchor[];
  /** Mount comment threads in Vector's existing right column. Requires highlighting. */
  comments?: boolean;
}
