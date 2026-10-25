---
'@namzu/cli': minor
---

Consecutive reads, searches, directory listings, read-only shell commands (`rg`, `grep`, `find`, `cat`, `head`, `ls` and similar, with no redirect other than `2>&1` or to `/dev/null`, and no substitution) and connector (MCP) calls now fold into one counted line such as `Searched for 2 patterns, read 3 files, listed 1 directory`, with `(ctrl+o to expand)`. While the run is open it reads `Reading 1 file…` with the latest target under it; Ctrl+O opens the line once it has settled, not while it is open. The `Explored` heading and the row per call are gone, and a connector call or a read-only shell command no longer prints its output in the transcript; press Ctrl+O to see it. A failed call still prints its own row. A script that matched on the old `Explored` heading or per-call `⎿` rows should read the counted line instead.
