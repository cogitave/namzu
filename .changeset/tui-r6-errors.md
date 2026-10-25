---
'@namzu/cli': patch
---

A failed agent and a workflow script that could not start now show the error text itself in red (the call's first 10 lines then `… +N lines (ctrl+o to expand)`, the whole message under an `Error` heading in the agent's own view, ` — <error>` on the agent's row in a workflow, and `✘` plus the first line for a script that did not start) instead of a plain sentence.
