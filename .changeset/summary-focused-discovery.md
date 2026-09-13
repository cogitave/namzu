---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Text evidence searches accept `excludeDerivedSummaries`, defaulting to false.
This excludes only explicitly marked compaction summaries, binds the selection
into cursors, and reports `excludedSummaries` as skipped part visits. Summary
text remains available through unfiltered searches and exact reads.

When a partial automatic CLI evidence page contains derived summaries, the host
can spend its existing refinement page on source records instead. The general
cursor and already retrieved summaries are preserved. This helps discovery reach
original observations behind repeated summaries without increasing the four-page,
8 MiB read or context allowances. Explicit tool continuations restore the exact
filter; new literal searches remain unfiltered. An incomplete scan still cannot
establish absence.
