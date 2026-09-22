---
"@namzu/sdk": patch
---

A child session's log opened through a symlinked path is now recognised as
the log in its place in the layout. Before, when `NAMZU_HOME` (or the
`SessionPaths` home) was reached through a symlink and the log was opened by
its real path, or the other way round, the two spellings compared unequal and
the child's checkpoints were written a second time under its parent. Nothing
to change on your side.
