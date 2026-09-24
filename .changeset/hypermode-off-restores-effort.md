---
"@namzu/cli": patch
---

`/hypermode off` now puts back the reasoning effort you had before turning the mode on (the message says which: `Hypermode is off — effort back to low.`). Before, turning the mode off left effort pinned at the level the mode chose, so later turns kept running — and spending — at that level although the help said both settings revert. If you picked a level yourself while the mode was on, that level stays. Nothing to change on your side.
