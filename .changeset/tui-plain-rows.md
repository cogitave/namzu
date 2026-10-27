---
'@namzu/cli': patch
---

Plain rows in the terminal. The plan file is called "the plan" on screen (the tool row, "Wrote N lines to the plan", the approval box and the approval note) instead of printing its session folder. `/compact` now reads "Compacted · N messages summarized · context about 190k to 20k tokens" with estimated sizes. `/resume` says "The only conversation in this folder is the one already open." when that is the case, instead of claiming there are none. A declined write shows only that it was declined, not the file it proposed. Text only; nothing to change in how you use Namzu.
