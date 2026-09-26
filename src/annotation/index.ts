export { createProjection, renderToHtml } from './projection';
export { createAnnotationView } from './render';
export { mountWikipediaAnnotation } from './wikipedia-view';
export { SourceIndex } from './source-index';
export { selectionFromSource, selectionFromView } from './mapping';
export type { AnnotationComment, CommentDraft, ModerationReasonPrompt } from './types';
export type { Projection, ProjectionOptions, SourceAnchor, MappedSelection, RenderedView, RenderOptions, WikipediaHeadingAnchor, WikipediaViewOptions, HighlightAnnotation, HighlightColor, HighlightAction, HighlightOptions, HighlightingView } from './types';

export { annotationMessages } from './i18n';
export type { AnnotationMessages } from './i18n';
