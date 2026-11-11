---
'@namzu/desktop': patch
---

A file Namzu edited twice now shows the same line counts everywhere. The reply card used to compare the first edit's removed lines with the last edit's added lines, so two one-line edits read "+1 -1" where `git diff` says "+2 -2", and the Changes panel set a removed line from one edit beside an unrelated added line from another. Every count is now the sum of each edit's own numbers as the engine reports them, the card, the Changes panel, each edit row and the details popover read the same figure, and the panel shows one block per edit. When a large diff is cut to its first 400 lines the total stays the true one and the card says "First 400 lines shown" beside it. Nothing to change on your side. A change made by a batch edit or an insert, which has no diff to draw, now counts too and the Changes panel says there is no diff to show for it. Edits that undo each other show no number, like `git diff`.
