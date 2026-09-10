---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Remove the coding doctrine's unconditional read-before-edit instruction. Agents can reuse content from successful prior reads or writes, while re-observing missing, stale or partial evidence and respecting project instructions and tool prerequisites. Clarify that tool intentions and failed calls do not establish completion. Runtime permissions and freshness checks are unchanged.

Clarify prior-turn action evidence and Namzu’s kernel/SDK identity in the CLI. Make verification proportional to the task and remove unconditional concurrency and child-context claims from shared guidance.
