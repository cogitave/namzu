---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Prevent checkpoint resume from repeating a tool that started but never recorded
its completion. Previously, resuming a partially completed batch could execute
such a call again, duplicating an external effect. The resumed conversation now
receives an explicit unknown outcome and can verify current state before further
work. Completed calls remain recovered and proven unstarted calls can continue.

Add optional `RunStore.readToolExecutions` and exported `ToolExecutionSnapshot` /
`ToolExecutionRecord` types. Disk and memory stores implement the scan; custom
stores without it use their strict `readEvents` contract. Missing or contradictory
execution evidence does not authorize replay. The disk scan has documented size
bounds; exceeded bounds produce unknown outcomes instead of automatic re-execution.

Explicitly answered durable questions may still re-enter their own asking tool,
without granting the same exception to interrupted siblings.

CLI `drain` now passes configured run limits to its resume host. Previously a
bounded run could fail with a token-budget root-limit mismatch because `drain`
silently used an unlimited limit. Keep the original token limit in configuration;
the existing ledger still enforces its spent allowance.
