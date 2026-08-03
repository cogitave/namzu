---
'@namzu/sdk': major
'@namzu/telemetry': patch
---

Retire the declarations that promised behaviour nothing implemented, and implement the ones worth keeping.

Seven fields were declared on exported types and read by nothing. Each was a contract a host could satisfy and get no result from — the worst kind of gap, because the only signal is that nothing happens.

**Implemented**

- `maxToolContentBytes` capped the rich channel of a tool result, and no caller could set it: `ToolingBootstrapConfig` had no such field, so the cap was always `0` and the capping branch was unreachable. It is now settable on `ReactiveAgentConfig` and on query params, and reaches the executor through the same chain `maxToolOutputChars` already had.
- `AdvisoryResult.warnings` and `.decisions` had two consumers each — the advisory phase folds decisions into working state so they survive compaction, and renders warnings back to the executing agent — and no producer at all. Advisors are now told the convention their answer is read with, and `parseAdvisoryResponse` lifts `<warnings>` / `<decisions>` blocks out of the prose. The contract is appended to a host-written prompt and a persona-assembled one too, not only the default; an advisor never told the convention would have had its warnings silently discarded.
- `AdvisoryBudget.maxCostPerRun` is enforced before each call against real accumulated spend, and `maxTokensPerCall` clamps the advisor's own response ceiling. Cost is now computed from a new optional `AdvisorDefinition.pricing`, and a run that sets a cost cap over unpriced advisors is **refused at construction** rather than left with a cap that could never be reached.

**Removed** — declared, never read, and not worth building:

- `AdvisoryBudget.maxCallsPerSession` and `maxCostPerSession`: the advisory stack is built once per run, so no accumulator outlived one and a per-session cap could only ever be decoration. `maxCostPerCall` went with them — a per-call cap can only be checked after the spend, which is a log line, not a budget.
- `AdvisoryResult.plan`, `.modelSuggestion`, `.toolGuidance`: no producer and no consumer.
- `ToolsetDefinition.toolPolicies`: stored on the toolset and never consulted, so a per-tool `{ enabled: false }` override was inert.
- `SandboxConfig.cleanupOnDestroy`: defaulted to `true` and read by nothing; `destroy()` removes unconditionally either way.
- `StructuredOutputConfig.enforceToolChoice`: documented a tool-choice mechanism no code implemented.
- `RuntimeConfig.promptCache`: caching is unconditional at both model calls, and no surface accepts a `RuntimeConfig`, so nothing could set it even in principle.

Also ports the telemetry provider to the current tracing API — `Resource` became a type with a factory, and span processors moved to the provider constructor — and lifts a run deadline inside the long-document flow test that aborted the run at 5s and read as a broken flow rather than a busy machine.
