---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add an optional SQLite resident learning journal with atomic event/summary updates, scoped ancestry and recorded usage, plus hash-verified immutable JSON artifacts. `runStoredResidentLearningCycle` connects existing generation and independent evaluation callbacks to the journal without adding another model loop. The store requires Node.js 22.13 or newer when used; other SDK stores retain their existing support.

Add `namzu resident learn <experiment.learning.mjs>` for explicit trusted host modules and `namzu resident learning [cycle-id]` for read-only inspection. Modules select and bound their own providers and evaluators. Interrupted work and incomplete prices remain visible; these commands do not automatically replay experiments, activate unverified guidance or start background learning. Records live in `state/learning.sqlite` and `learning/artifacts/`; accepted skills remain in the existing resident agenda.

Expose `pathBuilder`, `runStore` and `checkpointStore` on `runAgent`, forwarding the kernel's existing host storage controls. Hosts can separate generated execution evidence from a searched workspace. Omitting these options preserves the SDK's current local layout; the CLI retains its application-home layout.
