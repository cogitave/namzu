---
"@namzu/sdk": minor
"@namzu/cli": major
---

Conversation search now ignores letter case by default: searching for `destination` also finds `Destination`. Pass `caseSensitive: true` to `search_conversation` to keep the former behavior. Continue pages with the same query and case setting.

SDK run-evidence search adds optional `caseSensitive` (default `true`, unchanged). Active and closed run sources now return distinct matching passages within one text chunk, with continuation at the match limit, rather than hiding later passages in that chunk. Exact retained text, UTF-8/UTF-16 offsets, integrity verification and per-call I/O limits remain intact. Case-insensitive searches bypass exact-case filters and may read more bytes or require more pages.
