---
"@namzu/cli": major
---

Ctrl+O now opens a detailed transcript instead of expanding one tool body. The screen replaces the composer and shows the last 30 rows with every tool body, shell command, diff and agent answer in full, plus the model's thinking (dim italic, marked `∵`). Ctrl+E shows or hides the older rows, the arrow, page, `g` and `G` keys scroll a conversation taller than the terminal, and Ctrl+O, Esc, `q` or Ctrl+C returns to the composer with your draft untouched. Nothing is written to scrollback. A permission request that arrives while the screen is open waits behind it (`dialog waiting` in the footer) and appears when you close it.

Removed: the in-place expansion of a single body, the `Tool output` viewer with its left and right keys, and the `Nothing to expand yet` row. If you scripted Ctrl+O to reprint one result, press Ctrl+O and scroll to it instead. The PageUp scroll view is unchanged.
