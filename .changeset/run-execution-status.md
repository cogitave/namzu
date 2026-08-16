---
'@namzu/sdk': minor
---

`AgentStatus` is renamed to `RunExecutionStatus`. The union is unchanged (`'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'`), and `AgentStatus` remains exported as a `@deprecated` alias — your code still compiles and warns. Removal is a later major.

It never typed an agent. Every use of it in the package is a run's status, a run's audit outcome, or the status field of a run's result; `AbstractAgent` and `ReactiveAgent` have no status of their own, because an agent is a configuration and it is the *run* that is idle, running or cancelled. A reader importing `AgentStatus` to describe an agent's lifecycle was reaching for the type that governs something else, and the name was the only thing telling them otherwise.

`isTerminalStatus` now takes `RunExecutionStatus`. A value typed with the old alias is still accepted, since the alias resolves to the same union.
