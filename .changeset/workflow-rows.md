---
"@namzu/cli": patch
---

Agents that the model gave one `workflow` label now also appear as a single row on the rail under the message box: `◯ name`, a progress bar, `3/7 · elapsed · ↓ tokens`. Press ↓ to reach it; Enter opens that workflow's phases and agents (Esc comes back to the row), `x` stops its running agents or clears the row once it has finished, and the row leaves 30 seconds after the last agent ends. When a workflow's turn ends, one line in the conversation says how it ended. The rail's key line now reads `enter to view · x to stop`.
