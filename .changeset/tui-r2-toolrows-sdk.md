---
'@namzu/sdk': minor
---

The line counts `edit` and `write` report are now the counts of a real line diff of the whole file, and `edit` reports them at all. Before, `write` counted everything between the first and last changed line (two lines changed far apart in a 200-line file read `+196 -196`) and a change to only the final newline counted as nothing; `edit` carried no counts, so a host rebuilt them from the call and got a batch, an insertion and `replace_all` wrong.

New: `ToolFacts` of kind `edit` gains `added`, `removed`, `hunks` and `hunksTruncated`, and kind `write` gains `hunks` and `hunksTruncated`, with the new `ToolDiffHunk` type (three lines of context, rows marked by a space, `+` or `-`). `admitToolFacts` reads them back from a saved conversation. Receipts for the model now carry the same counts: `Edited a: 4 replacement(s) (+4 -4)`. `data.fileChange.preview` of `write` now holds the old and new side of the hunks, context included, instead of only the changed lines. `@namzu/sdk` now depends on `diff` 9.0.0.

Nothing is removed and no existing field changes meaning except the counts becoming correct; a host that ignored the new fields keeps working.
