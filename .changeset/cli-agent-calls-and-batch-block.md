---
'@namzu/cli': minor
---

While the terminal waits on one delegated agent, its last three calls show under its line (what each acts on, a mark for the one running and any that failed, and how many earlier calls are not shown), so you can see what it has been doing without opening the agent view. Several agents waiting together keep one line each, and a short window keeps the one-line form. A batch of waited-on agents that all finished now ends as one block (how many, the totals, a line per agent) instead of two rows each; an agent that failed or was stopped keeps its own row. Ctrl+O on a finished agent's row (a click in fullscreen) lists the calls it made, with how many are not retained, before its answer. To go back to the old rows, set `tui.agentCalls: false` in your own config (`/config`, "Agent calls"); nothing else changes and no default of an existing setting moved.
