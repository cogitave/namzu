---
'@namzu/sdk': patch
---

`grep` over a large local tree is about ten times faster (a 5,700-file tree: about 3.5 s down to about 0.4 s), with the same results in the same order. It no longer resolves the real path of every file or stats each one before opening it: each directory is resolved once, each file is opened once with links refused, and the walk overlaps with the matching while yielding to the event loop every few milliseconds. Nothing to change in a caller; a sandbox's search still reads through the sandbox as before. One behaviour differs in a race only: a file deleted after the walk listed it is now treated as absent rather than counted as unreadable.
