---
"@namzu/cli": minor
---

A file-only `compaction` key: `strategy: salience` opts a project into the kernel's salience-scored working set (every message scored, the context held near half the window, no model in the loop), and `contextWindowTokens` overrides the window the kernel resolves from the model for a project that wants compaction earlier or knows its model's window better than the table. Absent, nothing changes: the structured strategy and the model's own window. The transcript row for a pass now also counts the narrations it stubbed. A `/context` command shows how full the window is, which strategy the session runs with its thresholds, and what the passes so far cleared, stubbed, summarised and reclaimed; `/cost` names the strategy instead of a fixed 70%.
