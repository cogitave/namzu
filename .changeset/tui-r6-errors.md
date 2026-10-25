---
'@namzu/cli': patch
---

A failed agent and a workflow script that could not start now show the error text itself in red (the call's first 10 lines then `… +N lines (ctrl+o to expand)`, the whole message under an `Error` heading in the agent's own view, ` — <error>` on the agent's row in a workflow, and `✘` plus the first line for a script that did not start) instead of a plain sentence. Each line of the text is wrapped to the width at word boundaries (a break falls at a space; only a word longer than the whole width is cut inside), and the 10-line cap and the `+N` count are the text's own lines, not wrapped rows. A failed agent's row in a workflow's two-pane agent list keeps its `✘` mark and label however long the error after it is.
