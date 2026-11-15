---
'@namzu/desktop': patch
---

The sidebar no longer jumps by 4 px a moment after it first paints: a conversation row that had not been laid out yet was held at its old 32 px placeholder height, not the 28 px a row now has, so everything under it (the Recents heading and its list) slid up when the row was measured. The placeholder now follows the row height token.
