---
'@namzu/cli': patch
---

**Automatic context compression on long turns.** namzu now passes the SDK's structured compaction config to the agent loop, so very long, tool-heavy turns summarize old tool results/notes (keeping recent messages verbatim) instead of growing the context unbounded. Transparent for normal turns.
