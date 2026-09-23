---
'@namzu/cli': patch
---

A tool result whose first line is up to 300 characters long shows that line whole on its `⎿` row and not again underneath. It used to be cut at 120 characters on the row and repeated in full as the first line of the output below, so a blocked browser navigation's note appeared twice. A longer first line is still shortened on the row and kept whole in the output.
