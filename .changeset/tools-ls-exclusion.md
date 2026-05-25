---
'@namzu/cli': patch
---

`namzu tools ls` now hides the clawtool tools namzu excludes from the agent (the `.claude/agents` Agent* family), so the listing reflects what the model can actually call instead of advertising bridged tools that are filtered out.
