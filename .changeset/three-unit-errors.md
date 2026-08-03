---
'@namzu/sdk': patch
---

Fix three defects in delegation and compaction that unit tests could not
see, because the numbers involved stay plausible-looking until you check
their units and their object identity.

- **A child agent's wall-clock deadline was a TOKEN count.** The fallback
  was `context.budgetTracker.remaining` read as `timeoutMs`. It hid because
  a six-figure token budget lands in a plausible range of milliseconds; it
  bit at the edges, where an unlimited budget (`0`) produced a child that
  was out of time on arrival. There is now an explicit
  `AgentManagerConfig.childTimeoutMs` (default 5 minutes).
- **Sibling sub-agents each got a full share of the same pool.**
  `LocalTaskGateway` handed every spawn a *cloned* budget tracker, so
  `AgentManager.spawn`'s `remaining -= allocatedTokens` debited a throwaway
  object. N children were each allocated `maxBudgetFraction` of the
  untouched parent total — N × 50% of a budget that only had 100% in it.
  The tracker is shared, as the debit always assumed.
- **The compaction verifier sent `model: ''`.** Some drivers quietly
  substitute a default and others reject outright — on Bedrock the model id
  IS the endpoint. So compaction's LLM verifier failed exactly on the
  providers where a long run most needs it, and the failure surfaced as
  compaction killing the run it exists to save. It now receives the run's
  model.

Each fix ships with a test that was confirmed to fail against the old code.
