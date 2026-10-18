---
"@namzu/cli": patch
---

Workflows and subagents are now separate in the terminal. An agent started with a `workflow` label no longer shows up as an agent row on the rail: it appears only inside its workflow, which is one row after the agent rows, and the `main` row shows only when there is an agent row. Enter on the workflow opens its phases (numbered, turning ✔ or ✘, with done/total), then the agents of a phase, then an agent's transcript; ← or Esc goes back up and `x` stops the whole workflow or one agent. In the conversation a workflow's launch is one `Workflow <name>` line instead of a row per agent, and the turn summary no longer counts phases.
