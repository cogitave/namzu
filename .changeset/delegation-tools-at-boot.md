---
'@namzu/cli': patch
'@namzu/sdk': patch
---

A session that can launch an agent or a workflow now holds its task tools (wait, list, send, cancel) loaded from the start, so a turn that launches its first agent waits for it without a search and the tool list stays the same between turns. A skill carried across a compaction no longer loses steps that follow a `# Example` comment line inside a code fence. No action needed.
