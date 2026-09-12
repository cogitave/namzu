---
"@namzu/sdk": minor
---

Add optional `terms` to retained-evidence source searches. Supply 1–16 nonblank literal terms instead of `query` to discover matching passages in a shared bounded scan. Exact duplicate terms and their order do not matter; cursors bind membership and case sensitivity. Both writer-captured and closed-run sources preserve scope, integrity checks, Unicode offsets, exact reads and existing resource limits. This is candidate discovery, not automatic recall or relevance ranking. Existing literal-query callers and CLI tool schemas keep their behavior.
