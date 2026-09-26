# Live Chrome development

This launches installed Google Chrome with Playwright and loads a local Manifest V3 extension. The extension injects the compiled ReviewTool in Wikipedia's **MAIN** world, so the real MediaWiki runtime, skin and gadgets are present. Inline source maps include the TypeScript source for DevTools debugging. Nothing needs to be uploaded to a user-script page.

```sh
# Normal is the default. Annotation saves use Wikipedia's real API.
npm run dev:chrome

# Dry run: live reads, local edits.
npm run dev:chrome:dry
# Equivalent:
npm run dev:chrome -- --dry-run

# Choose a specific article/revision.
npm run dev:chrome -- --dry-run --url 'https://zh.wikipedia.org/w/index.php?title=璃月&oldid=94264832&reviewtool_annotation_view=1'
```

The default article is 孫中山. The launcher currently targets Chinese Wikipedia. It uses separate persistent profiles under `.cache/reviewtool-chrome/normal` and `.cache/reviewtool-chrome/dry-run`, leaving your everyday Chrome profile alone. Close that Chrome window or press Ctrl+C to stop. Rebuild/relaunch after source changes. Chrome's DevTools protocol loads/reloads the unpacked extension using `Extensions.loadUnpacked` and the development flag `--enable-unsafe-extension-debugging`; this was verified with installed Chrome 153, without the removed `--load-extension` flag.

For an unpacked extension to load manually in Chrome's developer mode:

```sh
npm run build:extension                    # .cache/reviewtool-extension/normal
npm run build:extension -- --dry-run       # .cache/reviewtool-extension/dry-run
```

Normal and dry-run bundles are separate. Do not enable both in the same browser profile or run another installed copy of ReviewTool alongside this development version. The Playwright launcher manages the separate profiles for you.

## Modes

`src/mediawiki.ts` is the normal transport: `createApi()` returns a real `mw.Api`. Both the existing ReviewTool API helpers and the new Annotation View use that boundary. `--dry-run` replaces that module at build time with `src/mediawiki-dry-run.ts`; it does not replace Wikipedia's global `mw` or alter other gadgets' API objects.

The dry-run API preserves the `mw.Api` get/post/postWithToken interface and jQuery done/fail/abort promises. Live reads still run. Edits copy the current page into an IndexedDB overlay and create local revisions. Subsequent reads of that title return the local page. It supports ReviewTool's full-page, append/prepend and section-edit paths, title/revision-ID reads, local revision history with edit summaries/tags, and revision/timestamp conflict checks. The database upgrades in place to version 2 while preserving existing local pages. Unsupported mutations fail with `dryrun-unsupported`; they never fall through to the real API. This is a simulator for ReviewTool's current API usage, not an implementation of every MediaWiki API module or a complete MediaWiki server.

Local pages live in the `reviewtool-dry-run-v1` IndexedDB database on the wiki origin. They persist across reloads and Chrome restarts. Inspect them in DevTools → Application → IndexedDB, or use `window.__reviewToolDev.createApi()` from the page console. `window.__reviewToolDev.mode` identifies the injected mode. Normal mode does not use this database.

Wikipedia's ordinary page HTML still comes from the server. Annotation View reads its annotation data through the substituted API, so local annotations appear after reload. For older talk-page tools, local API reads and previews see the local overlay, but Wikipedia's own article/talk renderer does not display those simulated edits.

The dry-run **Playwright launcher** additionally blocks Wikipedia mutations at the network boundary, including HTML-form and REST writes outside ReviewTool. It allows GET/HEAD traffic and the known read-only Action API calls, including read-only POSTs. This conservative guard also blocks login requests in the dry-run profile. The manually loaded extension provides the ReviewTool API substitution; it does not install that browser-wide Playwright request guard.

## Annotation View

Use `reviewtool_annotation_view=1`, or the added **Annotation View** entry in Wikipedia's page-actions menu. Entry pins the currently displayed revision with `oldid`. The live view loads that revision's source/section metadata and the corresponding `Talk:<article title>/ReviewTool/<revision>` page. It uses the original live article HTML for image reuse.

While Annotation View is open, Vector's pinned right-column controls move to the left column below the contents panel, leaving the right column for comments aligned with their highlights. The existing left sticky container holds both panels directly, without nested sticky containers. Their original DOM, settings and event handlers are preserved; returning to Article View moves the containers back to their original positions. Native pin/unpin and responsive visibility rules continue to apply. Narrow screens retain the existing floating-comment behavior.

Each new highlight stores its original `author` and UTC `createdAt`. Recoloring stores UTC `editedAt` and `editedBy` on that highlight; unchanged colors produce no new edit. Comment/reply timestamps remain independent. Legacy missing creation dates stay unknown, including when a later recolor adds edit metadata. Save retries reuse the timestamps captured by the action.

The data page uses `{{ReviewTool annotation data page}}` and a JSON syntaxhighlight block containing `reviewtool.annotation-records/1`. Its fixed header identifies the article, generation and external baseline. Every immutable highlight, comment or change record occupies one line. There is no Base64 field or duplicated current-state snapshot. See [the format specification](../../src/annotation/record-format.md).

The provider polls visible views every five seconds, requests metadata before changed content, and refreshes on visibility return/reconnection. Whole-message/color changes use Lamport-ordered registers; independent comments merge by record-set union. Resolution/deletion records retain their data while hiding the relevant UI. Send and Save changes remain the publication boundary; incoming updates preserve private drafts and caret state.

Publications serialize fresh reads and reason-separated batches, using `baserevid` without `basetimestamp`. Submitted records are acknowledged by exact key/payload presence after reading accepted state. MediaWiki may text-merge independent line insertions; those results still undergo application validation. Duplicate keys, altered immutable records and missing dependencies are rejected. No-op/already-published updates clear without another write.

The `ReviewTool` tag is checked once at startup. If usable, edits carry it; otherwise summaries are exactly `/* ReviewTool */` or `/* ReviewTool */ Reason`. Both markers remain recognized. An explicit tag rejection switches to fallback without another lookup.

Every intervening revision is checked. Valid manual replacements establish a fresh generation; incompatible pending changes remain available for review/resubmission. Malformed manual edits are repaired from valid server history against the damaged head. Unsupported formats, identity mismatches, deleted pages and missing history are not overwritten automatically.

The account-scoped `reviewtool-annotation-records-v1` IndexedDB database holds full record checkpoints, pending record batches and private drafts. Drafts are additionally scoped to the article/tab session. The old development database is left untouched; runtime code does not read its Yjs checkpoints. Use `tests/live/convert-records.mjs` for a one-time development data conversion.

Normal mode requires a logged-in account to publish new annotation changes and asserts that account in the edit request. Log in before testing saves. Dry run can use `Example` when logged out. Dry-run content has not been published; actual server permissions, CAPTCHA/abuse-filter behavior and real same-user/concurrent MediaWiki merge behavior are not simulated completely.

## Moderation and edited dates

Ordinary users may edit only their own messages, and each root comment's author may resolve their own thread. Resolve is never offered on replies. Members of the local `patroller`, `sysop` or `bureaucrat` group may edit other users' messages and remove their threads. The live adapter reads these groups from [`wgUserGroups`](https://www.mediawiki.org/wiki/Manual:Interface/JavaScript), independently of the stored annotations.

Those groups retain ordinary author rights: their own comment edits, own thread resolutions/deletions, and own bare-highlight deletions are prompt-free. The reason prompt is used only when acting with moderator privileges on someone else’s content. Ownership follows the specific comment for Edit, the first comment for thread removal, and the creator for an uncommented highlight. The prompt explains that moderation rights allow the action on another user’s content, and that a public edit-summary reason lets other editors understand the action. It uses Codex’s [Dialog with form inputs](https://doc.wikimedia.org/codex/main/components/demos/dialog.html#with-form-inputs), loaded through `src/dialog.ts`. It opens immediately on Edit, Resolve or Delete. The Edit textbox appears after confirmation; the draft retains the reason and Save does not ask again. Cancel leaves the action unapplied. The confirmation button stays disabled for blank input or a reason exceeding 483 characters, reserving the fallback marker within the [500-character edit-summary limit](https://www.mediawiki.org/wiki/Help:Edit_summary). The trimmed reason follows the fallback marker when a tag is unavailable; otherwise it is the edit summary; automatic conflict retries reuse it. Dry run stores it on the local revision and returns it as `revisions[].comment`.

A saved edit records UTC `editedAt` and the actual editor as `editedBy`, retains the original `createdAt` and author, and displays the edit time in the system timezone with `(edited)`. A different editor is shown as `Original author (edited by Latest editor)`; self-edits keep the original name alone. Old comments without `editedAt` continue to display their posting dates. Account assertions and these application checks do not add Wikipedia page protection; direct data-page edits still follow wiki permissions.

Native `window.prompt()` was unsuitable for this harness: [Playwright dismisses unhandled native dialogs](https://playwright.dev/docs/dialogs), while earlier automated tests supplied handlers that masked the interactive failure. The in-page Codex dialog does not depend on those handlers. It uses the top layer above existing annotation popups, traps focus through Codex, handles IME Escape cancellation, and unmounts on completion or view destruction.

## Verification

```sh
npm run check:live
npm run test:live
```

The tests use live read-only Wikipedia access. They exercise the actual Chrome extension and source maps, local highlight/comment saves, a simulated moderator group with a real reason prompt and local edit-summary verification, edited timestamps, reload and browser-restart persistence, local CAS conflicts, blocked unsupported mutations, record-set convergence, strict JSON/record validation, development conversion, generation resets, malformed repair and retry behavior. The normal-mode write test intercepts the API response before the request reaches Wikipedia. These tests do not publish test edits.

Local dialog tests use the actual Codex 1.18 components, compatible with the repository’s Vue 3.4.27, on the downloaded Wikipedia HTML/styles. This dependency is for tests; the live script loads Wikipedia’s deployed Vue/Codex through ResourceLoader.

Development `npm run build` bundles now include inline source maps; `npm run release` remains a minified normal bundle without source maps. A dry-run release is rejected.
