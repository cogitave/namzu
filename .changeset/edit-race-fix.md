---
'@namzu/sdk': patch
---

**Fix a race when multiple file-mutating tools run in one turn.**

The tool executor ran every tool call in a batch with `Promise.all`, ignoring each tool's `concurrencySafe` flag. Several `edit`/`write` calls to the same file in one assistant turn therefore raced on read→modify→write — each read the same starting content and the last writer clobbered the others, even though every call reported success. The executor now honors `concurrencySafe`: read-only tools (ls/grep/glob/…) still run in parallel, but concurrency-unsafe tools (edit/write/append/bash) are serialized within the batch, so same-file edits apply one-after-another.
