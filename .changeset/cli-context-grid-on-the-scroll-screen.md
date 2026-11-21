---
'@namzu/cli': patch
---

`/context` shows its grid on the full-screen transcript too. There the view was drawn as its plain-text copy (a list of categories with no grid); it now draws the grid of cells with the legend beside it, then the lists and notes, as the inline transcript does. The shell permission prompt also keeps its readable view when a call carries a short `description`, instead of falling back to the raw input.
