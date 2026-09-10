---
"@namzu/cli": patch
---

Prevent Ctrl+O from repeatedly appending full tool results and diffs to the
transcript. Older outputs and expansions that exceed the live viewport open in
a bounded, scrollable detail view. Use arrows and Page Up/Down to navigate,
left/right to switch outputs, and Escape or Ctrl+O to return. Small results
still expand in place. Viewing output does not alter conversation history.
