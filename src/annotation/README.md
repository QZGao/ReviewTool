# Annotation visual model

An isolated R&D module inside the existing ReviewTool source tree. It imports no other ReviewTool TypeScript modules, has no MediaWiki globals, and does not implement comments, storage, revision navigation, or article editing.

## Inputs and output

```ts
import { createProjection, createAnnotationView } from './annotation';
import './annotation/style.css'; // Load with the host application's usual CSS mechanism.

const model = createProjection(wikitext, {
  wikiBaseUrl: 'https://zh.wikipedia.org/wiki/'
});

const view = createAnnotationView(document, model, {
  referenceHtml: renderedHtml,
  referenceBaseUrl: 'https://zh.wikipedia.org/wiki/',
  onSelectionChange(result) {
    // Update the annotation controls from this view's selection.
  }
});

container.replaceChildren(view.element);

const result = view.selection;
// result: { anchor, quote, sourceText, adjusted, viewFrom, viewTo }
// It persists when the user selects text outside the view or interacts with a popup.

const restoredRange = result && view.restoreRange(result.anchor);
// view.readRange(range) remains available for an independent mapping query.
// view.clearSelection() explicitly clears this view's saved selection.

// Before replacing or unmounting this view:
view.destroy();
```

The two inputs have different responsibilities:

1. **Wikitext** defines the immutable content and source coordinates. Parsing produces a visual model in which every source code unit is either visible or deliberately hidden exactly once.
2. **Supplied HTML** provides reusable image elements. Its text, tables, templates, scripts, and captions do not replace source content. No Parsoid metadata or manually supplied table bindings are needed.
3. **Our renderer** creates readable HTML from supported source constructs and displays difficult constructs as escaped raw code. File invocations stay inline as source; hover popups reuse matched images or look up a small thumbnail when no reusable image exists.

`view.projection` is the same immutable input model. Image previews do not enter its text stream or change its coordinates. Only source-backed text, including each file invocation, is annotatable.

`renderToHtml(model)` also provides a DOM-free serialization of the source-only projection. To inspect the mounted output and any open popup, use `view.element.outerHTML`.

## First-version presentation policy

Supported visual treatments:

- Ordinary paragraphs and headings.
- Balanced apostrophe emphasis: italic, bold, and combined bold/italic.
- Internal links and explicit labels; labeled, numbered, bare, and protocol-relative external links, including mail and other configured protocol forms.
- Recognized interlanguage link templates: `tsl`/`translink`, `link-<language>`, and the verified shortcuts `le`, `lj`, `ld`, `lk`, `lvi`, `ly`.
- Bulleted, numbered, definition, and indentation lists using `*`, `#`, `;`, and `:`, including mixed nesting such as `#*#*` and `; term : definition`.
- Semantic HTML formatting such as emphasis, underline, insertions/deletions, small text, quotations, ruby annotations, code, paragraphs, blockquotes, and explicit HTML lists.
- Horizontal rules, explicit line breaks, literal `pre` blocks, and grouped leading-space preformatted text with inline formatting.
- `nowiki` literal content and HTML entities.

Mathematics, generic `span`/`div` constructs, unsupported HTML, and unclosed/complex constructs remain raw code. Short inline constructs stay inside the surrounding paragraph as inline code. Multiline source and block constructs use separate blocks. All code and source containers use the same monospace font family, including partially formatted template/table source. Their default border, background, and padding are removed; code uses 92% of surrounding text size (15.64 px against the lab's 17 px body), with no repeated shrinking in nested code containers.

Each list marker determines one level and its list type. Child lists belong to the appropriate parent item; leading/skipped levels create empty containing items as MediaWiki does. `;`/`:` transitions and inline definitions follow captured MediaWiki examples, including colons protected inside links, URLs, and `nowiki`. List markers and original line endings are hidden without changing source offsets; readable quotations separate parent/child items and siblings with newlines. Explicit `<br>` line breaks remain source-mapped. Nesting beyond 24 and multiline constructs inside a list item currently retain source fallback.

Line-start list syntax is also interpreted inside template/table source containers, including `flatlist` bodies. Those containers keep the source newline after the list so following parameters and closing delimiters stay on their own source line. Nested source blocks participate in preserved line flow without adding a second margin/newline gap.

Tables retain their visible delimiters, attributes, and line breaks while their contents receive the supported inline treatments: links, emphasis, templates, references, and `nowiki`. Nested wikitext tables and source-form HTML table tags follow the same rule. This is formatted table source, not a visual grid reconstruction or reuse of Wikipedia's rendered tables.

Complete `ref` tags become compact `[name]` markers when a nonempty `name` is present, otherwise sequential numbered markers. This also applies within `references` containers and template `refs=` parameters. Unnamed references are numbered in displayed source order; template expansion and MediaWiki reference-group numbering are not reproduced. Each marker is an atomic projection of its entire original reference tag. Selecting it returns that complete source interval; finer selections inside the collapsed reference cannot be restored in this view. Malformed references retain source fallback, and `nowiki` prevents reference interpretation.

Common forms of Chinese Wikipedia's `r`, `rp`, and `sfn` templates receive the same superscript inspection and selection treatment:

- `{{r|甲|乙}}` displays `[甲][乙]`. Up to nine names, explicit argument numbers, name aliases, group parameters, and per-reference page/page-range aliases are recognized. Group information remains in the source popup, following the existing name-based reference presentation.
- `{{rp|51}}` displays `:51`; `Page` and `RP` are verified aliases. Page, page-range and location parameters are supported, along with the AMA parenthesized presentation. Quote metadata remains in the popup.
- `{{sfn|Smith|2006|p=25}}` displays `[Smith 2006:25]`; `Shortened footnote template` is the verified alias. Up to five positional author/year fields, page/page-range aliases and `loc` are supported. This readable label is specific to Annotation View; it does not generate MediaWiki's footnote numbers or bibliography links. Recognized postscript/reference metadata remains in the popup.

Template names accept case variants, the `Template:`/`模板:` prefixes, and spaces/underscores in aliases. Each complete invocation, including a multi-name `r` group or an `rp` locator, is one atomic source selection. Partial selections expand to that whole invocation. These prepared markers do not increment unnamed-reference numbering. Malformed input, unsupported options, dynamic names/locators, and protected `nowiki` keep source presentation. Related templates such as `sfnref` and `sfnp` are distinct templates and are not treated as aliases. Definitions and redirect aliases were checked against [R](https://zh.wikipedia.org/wiki/Template:R/doc), [Rp](https://zh.wikipedia.org/wiki/Template:Rp/doc), [Sfn](https://zh.wikipedia.org/wiki/Template:Sfn/doc), and the wiki API; no template or alias lookup runs in the renderer.

Whitespace-only spans containing line breaks between adjacent reference markers are visually collapsed with `display: inline-block` and normal whitespace handling. This removes both the breaks and their extra line-box height, without changing the source text, coordinates, or projection text. Intervening prose is never compacted by this rule.

Other template invocations keep their names, braces, parameter names, and separators visible while recursively formatting supported text inside them. For example, `{{example|text='''bold''' and [[Page|label]]}}` displays bold text and a link inside the visible template syntax. This does not execute templates/parser functions or claim to reproduce their output. Nested templates follow the same rule. Multiline templates preserve their line breaks in a source container. `nowiki` content remains literal; supported formatting outside that protected region still works. Explicit file invocations inside template text are eligible for image reuse.

Complete `-{…}-` conversion blocks likewise keep their flags, variant labels, separators, and delimiters visible while formatting inline content in every branch. File invocations and captions inside either Chinese variant are parsed. No language conversion is performed and no branch is chosen or hidden. Ordinary rendered HTML may contain just one variant; a missing branch image is looked up on demand through Chinese Wikipedia’s image API. Branch separators at line starts are not interpreted as definition-list markers, and malformed conversion blocks remain source.

Recognized link templates render their selected display parameter with link styling. `{{tsl|en|Water|水|一氧化二氢}}` displays “一氧化二氢” with “水” as its recorded destination; `{{le|膠水語言|glue code}}` displays “膠水語言”. Display defaults and parameter orders follow the [Translink documentation](https://zh.wikipedia.org/wiki/Template:Translink/doc) and [Internal link helper documentation](https://zh.wikipedia.org/wiki/Template:Internal_link_helper/doc). Numeric arguments and the helper's `d` display override are supported. Empty display parameters fall back to the target parameter. Parameter splitting skips nested templates, links, and protected tags, preserving exact original source spans.

These links do not check article existence or reproduce the Wikipedia gadget's foreign-language popover. The unused template syntax is hidden, as with ordinary piped links, and selections map directly into the displayed argument. Unknown options, dynamic targets, and labels that would create block content or nested links retain the generic template presentation. `link-wd`/`link-wikidata` use a different contract and are excluded. Language-marking `lang-*` templates are also outside this link rule; a wildcard over all names starting with `l` is never used.

## Source popups

Article links have no active `href`. Hovering or focusing a link opens a source popup containing its complete original wikitext. There is no additional destination/URL row. Clicking a link (or activating it with Enter/Space) selects the whole link and returns its complete source slice, including brackets or template syntax. Dragging across part of its label retains fine-grained text selection. Whole-link anchors restore as an enclosing element selection, preserving that distinction after remounting.

Reference markers open the same popup with the exact original `ref` occurrence or reference-template invocation, including its body/parameters when present. Clicking a marker or activating it with Enter/Space selects the complete reference source slice. A self-closing named reference shows its own source; no definition lookup or network request is performed. Links and reference markers use the ordinary text-selection cursor (`text`).

Popup text is normally selectable and copyable while remaining excluded from the annotation map. Its native selection does not change the saved article selection or highlight. Reference markers select the whole underlying reference. Popups are non-modal dialogs with a label and a focusable container: Tab from an open trigger enters the popup, and Escape closes it and returns focus to that trigger. They remain open during hover or focus, including while selecting text or moving the pointer to another trigger during popup interaction. Outside clicks, leaving popup focus, and article scrolling dismiss them. Long source remains locally scrollable. Source is inserted as text, never executed as HTML.

The mounted view uses one lazily attached popup and delegated trigger events. Call `view.destroy()` before unmounting to release document/window listeners and timers. The standalone demo does this on every remount. `renderToHtml` produces the same non-navigating labels/markers; interactive popups require `createAnnotationView`.

This is a deliberately bounded presentation parser, not a complete MediaWiki parser. It keeps unknown source visible and does not expand arbitrary templates, execute Lua, automatically convert Chinese variants, or reproduce all MediaWiki whitespace rules. Hard malformed syntax can cause the remaining source to be shown as one raw block. A runtime coverage invariant rejects omissions or overlapping source consumption.

Single source line endings display as line breaks with no additional vertical gap. Blank lines create the normal paragraph gap, including between inline and multiline templates. Block spacing follows the source separators rather than default margins on paragraphs, headings, lists, or code containers. Raw code retains its internal line endings. The original source string is never normalized or reconstructed from HTML; CRLF is counted as one line ending while retaining its original coordinates.

Headings show a decorative `#` just before the text on hover (or focus within a heading). The marker occupies the existing gutter, does not shift layout, and is excluded from selection, annotation text, and the heading's accessible name.

## Image reuse

- Explicit file invocations are candidates, including those inside template text. Bare filenames passed as template parameters and files inside protected/raw regions are not inferred as images.
- File identity is taken from file-page links, an optional `resource` file identifier, or the known Wikimedia upload URL structure. URL encoding and spaces/underscores are normalized. There is no fuzzy filename matching.
- Conflicting identities or multiple distinct image presentations for a filename are not reused; these files use the thumbnail lookup instead. Repeated identical candidates are safe to reuse.
- The existing `img` element is cloned. Ordinary image attributes such as `src`, `srcset`, `sizes`, dimensions, class, and alt text are retained. Relative URLs are resolved against the explicit reference base. Executable attributes and unsafe URL schemes are discarded.
- Surrounding figures, captions, tables, links, and arbitrary HTML are not copied.
- Every file invocation stays inline, retaining the filename, options, and outer delimiters as source. The effective caption is formatted using the existing inline renderer: links, emphasis, entities, templates, and reference markers work inside it. Every parsed file gets a dotted underline; hovering or focusing it opens the shared inspection popup. There is no inline image, figure wrapper, or added block break. If supplied HTML has no reusable match, the popup immediately shows a loading message and queries a 250px thumbnail.
- Caption detection uses the last top-level field that is not an image option, including standard Chinese aliases. Pipes inside nested links, templates, conversion syntax, and tag bodies do not split fields. Recognized options such as `alt=`, `link=`, and dimensions remain literal source; options can also follow the caption. Unsupported block-level captions retain source fallback.
- Caption links and reference markers open their own source popups and select their own source spans. Partial caption text remains precisely selectable, and selecting the complete file invocation returns its full original source, including hidden caption markup.
- Popup images have normal pointer, context-menu and drag behavior, and have no annotation anchor. Code remains individually selectable, including filenames, options, and caption text. Clicking the source selects the complete invocation; interacting with the preview preserves the saved article selection.
- Image lookups use `https://zh.wikipedia.org/w/api.php`, `prop=imageinfo`, `iiprop=url`, and `iiurlwidth=250`, with anonymous CORS access. Only `thumburl` is used, without falling back to the full-resolution original. API title normalization and redirects are followed, including Commons images whose local file page is marked missing. Thumbnail URLs must use HTTPS.
- No lookup occurs at mount. Within a view, filenames normalized for spaces/underscores share cached results, including unavailable results; requests arriving within 40ms are batched, at most 50 filenames per API call. Requests time out after 10 seconds. An unavailable file, network failure, or image load failure shows “Image preview unavailable.” The source stays selectable. Remounting permits a fresh lookup.
- Supplied images are mounted only when their popup opens. Lookup results arriving after the user moves to another trigger do not change that popup or load a hidden image; reopening the file uses its cached lookup. The popup is repositioned after image loading to stay within the viewport. Destroying the view cancels queued/in-flight lookups and releases listeners.

## Coordinate and selection contract

- Each mounted view retains its own immutable `selection` snapshot. `onSelectionChange` only reports changes to that snapshot. The demo's quotation, anchor and source inspector subscribe to this callback rather than clearing themselves for every document-level selection event.
- Outside text selections, form-control selections, popup selections, and ranges crossing the article boundary leave the saved article selection intact. Outside text can still be selected and copied normally. A valid new internal selection replaces the snapshot; a caret click inside article content or `clearSelection()` clears it. Mouse gestures commit at release, so dragging beyond the container does not commit an intermediate partial selection. Shift-click extension is preserved.
- A CSS Custom Highlight keeps the saved range visibly selected independently of the document's native selection, without inserting wrappers or modifying mapped text. This uses the CSS Custom Highlight API available in current browsers; when that API is absent, selection state still persists but the extra visual highlight is unavailable. Separate views own separate ranges, and destroying one view removes only its highlight and listeners. Call `destroy()` before unmounting.
- Parser/model positions use half-open UTF-16 offsets into the exact original string.
- Public anchors explicitly use half-open **UTF-8 byte offsets**: `{ unit: 'utf8-byte', start, end }`.
- Revision identity belongs to the caller; an anchor is meaningful only with its source revision.
- `SourceIndex` converts coordinate units and rejects byte offsets inside encoded characters, surrogate halves, and malformed source strings.
- Visible ordinary text remains selectable inside long paragraphs and parser nodes. No whole-paragraph/token selection restriction is imposed.
- A quotation spanning formatted text omits hidden syntax. Its enclosing `sourceText` can contain that syntax. Readable quotations use `\n` for line transitions and `\n\n` for paragraph transitions; list items use `\n`. Structural breaks already present at a block boundary are not added twice.
- Entity replacements and collapsed references are atomic. A partial selection expands to the whole source construct and reports `adjusted: true`; ordinary Unicode scalar values are not split.
- Source restoration returns `null` when a boundary cannot be represented exactly in the current view. Complete link intervals are represented by selecting the enclosing link, including its hidden delimiters; arbitrary subranges of hidden syntax remain unrepresentable. Image-code annotations restore identically whether or not a preview is available.
- DOM ranges outside the view or within a source popup are rejected. Source offsets are never recovered by searching for quoted text.
- A rebuilt view can restore anchors from the same source. The renderer owns its DOM; callers should remount rather than mutate mapped text themselves.

Selecting only a popup image or its preview wrapper returns no annotation. Selecting file source produces ordinary source coordinates, and larger text selections can pass through that inline source without invented block separators. Restoring an image-related source interval selects the code.

## Files

| File | Responsibility |
| --- | --- |
| `parse.ts`, `opaque.ts` | Bounded source parsing and conservative raw-code boundaries |
| `lists.ts` | Mixed list/indentation nesting, definition terms, and source-coordinate preservation |
| `template-links.ts` | Recognized link-template arguments, display spans, and destinations |
| `template-fields.ts` | Shared source-aware argument boundaries for recognized templates |
| `reference-template.ts` | Named reference groups, page locators, short citations, and verified aliases |
| `file-caption.ts` | Top-level file fields, image-option recognition, and the effective caption span |
| `external-links.ts`, `html-format.ts` | External-link forms and safe semantic HTML presentation |
| `projection.ts` | Immutable model, source coverage checks, readable text, escaped HTML serialization |
| `source-index.ts`, `mapping.ts` | Exact coordinate conversion, selection mapping, restoration policy |
| `selection-state.ts` | Per-view selection persistence, gesture boundaries, and persistent highlights |
| `reference-html.ts` | Filename matching and copying reusable images |
| `image-preview.ts` | Lazy, batched and cached 250px thumbnail lookup for unmatched files |
| `render.ts` | DOM construction and native `Range` translation |
| `source-popups.ts` | Hover/focus/tap source inspection, positioning, and lifecycle cleanup |
| `style.css` | Scoped typography and raw-code presentation |

## Verification and playground

From the repository root:

```sh
npm ci
npm run check:annotation
npm run test:annotation
npm run demo:annotation
```

Tests use Node's test runner and Playwright. They use installed Google Chrome on macOS when available; otherwise install Playwright Chromium with `npx playwright install chromium`. `ANNOTATION_BROWSER_CHANNEL` can select another installed Playwright-supported channel.

The standalone lab runs at `http://127.0.0.1:4178` by default; override `PORT` if needed. It accepts wikitext and supplied HTML, displays the resulting view, and shows a selected passage's readable quotation, UTF-8 anchor, source slice, and generated HTML. It does not write anything to Wikipedia.

To load the real article fixtures, run:

```sh
npm run prepare:annotation-articles
npm run test:annotation:articles
npm run demo:annotation
```

The article selector provides these pinned Chinese Wikipedia snapshots:

| Article | Revision | Demo |
| --- | --- | --- |
| 地球 | `94197675` | [Open](http://127.0.0.1:4178/?article=earth) |
| JavaScript | `93611733` | [Open](http://127.0.0.1:4178/?article=javascript) |
| 璃月 | `94264832` | [Open](http://127.0.0.1:4178/?article=liyue) |
| 孫中山 | `94447348` | [Open](http://127.0.0.1:4178/?article=sun-yat-sen) |

Each fixture pairs the exact revision's raw wikitext with ordinary `action=parse` HTML and includes a link to the original article and its license. Use “Jump to image source”, then hover the dotted-underlined code to inspect the image preview. 孫中山 adds a larger reference-heavy article with 26 explicit file invocations and 592 collapsed page locators; four galleries and a rich locator containing a wikilink retain their source presentation.

Downloads are cached in ignored `.cache/annotation-articles/`; entire article snapshots are not committed. Existing fixtures are reused without requests. To explicitly refresh them, run `node tests/annotation/fetch-articles.mjs --refresh`. Source revisions stay pinned, although rerendered template/image output can change. The renderer and mapping do not consume Parsoid metadata. The standard test suite uses local synthetic inputs; the separate article checks use the downloaded fixtures and block external image requests while checking selection behavior.

Tests are in `tests/annotation/`. Build output and screenshots go under `.cache/annotation-rnd/`. There is no nested package, package manifest, dependency directory, or project configuration inside this source module.

The tests cover exact source coordinates, repeated phrases, cross-format/paragraph selections, Unicode/entities/CRLF, remounting, actual mouse dragging, inline code, formatting within templates/tables, protected `nowiki` regions, reference markers, popup behavior and selection exclusion, code typography, narrow viewports, cleanup, image matching/ambiguity, and inert handling of executable markup. Real article checks verify unchanged source, independently calculated selection anchors, exact restoration, and selectable code for every image invocation. Synthetic network tests verify lazy lookups, batching, caching, loading/failure states, safe URLs, late responses, and cancellation.
