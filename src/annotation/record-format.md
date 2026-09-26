# Annotation records

The data page contains `{{ReviewTool annotation data page}}` and one `<syntaxhighlight lang="json">` block. The application reads only `reviewtool.annotation-records/1`. Earlier development formats have a standalone converter; they are not handled by the runtime.

```json
{
  "format": "reviewtool.annotation-records/1",
  "document": {"offsetUnit":"utf8-byte","pageId":139,"revisionId":94447348,"wiki":"zhwiki"},
  "generation": "example-generation",
  "baseline": 0,
  "records": {
    "c/comment-id": {"author":"Example","body":{"text":"Check this source."},"createdAt":"2026-09-26T00:00:00.000Z","highlight":"h/highlight-id","kind":"comment","parent":null,"stamp":[2,"replica-id"]},
    "h/highlight-id": {"appearance":{"color":"blue"},"author":"Example","kind":"highlight","source":[17382,17658],"stamp":[1,"replica-id"]}
  }
}
```

`revisionId` identifies the fixed article source revision. `baseline` identifies the annotation-page revision incorporated by a generation reset/import; it stays constant during ordinary edits. It defaults to zero for a new document. `generation` changes for an external replacement or deliberate reseeding. Producers use UUIDs for generations, replicas and entity IDs.

## Immutable records

Each record occupies one physical line. Keys and object properties use ordinal sorting; string newlines and `<` are escaped. Existing record values never change. A save adds records, with no materialized `annotations` mirror, encoded binary field, shared order array or per-save header timestamp.

| Kind | Key | Fields in addition to `kind` and `stamp` |
|---|---|---|
| Highlight | `h/<id>` | `source: [start, end]`, optional original `author`/`createdAt`, initial `appearance` |
| Comment | `c/<id>` | `highlight`, `parent` (null for roots), original `author`/`createdAt`, initial `body` |
| Body edit | `<comment key>/body/<clock>@<replica>` | `target`, `text`, `by`, `at`, optional `reason` |
| Recolor | `<highlight key>/appearance/<clock>@<replica>` | `target`, `color`, `by`, `at`, optional `reason` |
| Resolution | `<root key>/resolve/<clock>@<replica>` | `target`, `by`, `at`, optional `reason` |
| Deletion | `<highlight key>/delete/<clock>@<replica>` | `target`, `by`, `at`, optional `reason` |

Source ranges are half-open UTF-8 byte intervals. A body contains `text` and optional imported `editedAt`/`editedBy`. An appearance contains `color` and paired optional imported `editedAt`/`editedBy`. Unknown highlight creation dates remain absent. All stored dates use UTC ISO strings with milliseconds.

Each stamp is `[positive safe integer, replica ID]`. A writer emits a clock greater than everything it has observed/emitted. Counter first, then ordinal replica ID, defines a total order; dates are display metadata, not conflict ordering. Fresh comments refer to already observed highlight/parent records. Siblings follow their immutable creation stamps. Whole-message edits are supported; this is not a character-editing CRDT.

## Merge and visibility

Merge unions record maps. Identical duplicate records are harmless; a matching key with different content is invalid. Different document identities/generations never union. The latest body/appearance record determines the value and its editor/time atomically. Losing edits remain in the data. A causally later edit wins over values it observed; concurrent edits have a deterministic winner.

Any resolution hides the root and its replies, including concurrent or later replies. Any deletion hides the highlight and its discussions. Both retain their records. Bare highlights remain visible; a discussed highlight remains visible while any root is unresolved. A new independent root is distinct from a late reply to a resolved root.

Validation checks all records, including hidden entities and losing edits. It rejects duplicate JSON keys (including escaped aliases), unexpected fields, reused clocks, noncausal/missing/cross-highlight references, invalid intervals/metadata and reply-level resolution. Full remote documents are dependency-complete. Local deltas are applied in submission order against their baseline.

## Publication and recovery

The provider polls metadata every five seconds while visible. Changed content is validated before adoption; local pending updates remain separate. Save batches fetch the current head, union pending records, and write with `baserevid`. Moderator exceptions keep their own edit summaries. The `ReviewTool` tag is checked once per startup; its permanent fallback is `/* ReviewTool */` followed by a reason for moderator exceptions.

A successful MediaWiki text merge is still validated. Acknowledgement requires every submitted record key and payload to appear in accepted state, even if its scalar value loses to a concurrent edit. Already-published/no-op journal entries clear without another save. Retries reuse the same records. Same-generation tool revisions cannot silently remove or mutate accepted records.

Valid manual changes create a new generation with `baseline` set to that external revision. Cosmetic wrapper/formatting edits preserve the generation. Malformed manual data is restored conditionally from the latest valid server history. Unsupported formats, foreign identities, unavailable history and deleted pages are not treated as damaged data to overwrite. Incompatible pending changes and hidden-target drafts stay available for review.

The record rules do not replace authorization: existing comment-author/root-author/highlight-ownership rules and moderator-reason checks run at submission/publication. Wikipedia's own page permissions govern direct edits.

Edits accumulate records. A future compactor can reseed the materialized state, retaining resolved/deleted discussions, under a fresh generation. No automatic compaction threshold is enabled. Publication still sends a whole page, even when only a record line changes.

## Development conversion

```sh
node tests/live/convert-records.mjs old.wikitext new.wikitext 1000000046
```

The last argument is the old **annotation storage revision**, not the article revision. The converter accepts a development snapshot, preserves IDs, content, relationships and metadata, and verifies reconstruction before writing the new file. It does not edit Wikipedia or carry obsolete Yjs clocks into the new generation. Browser recovery databases are separated by format; migrating local drafts is a deliberate development step.
