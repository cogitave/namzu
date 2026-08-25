---
'@namzu/sdk': minor
'@namzu/computer-use': minor
---

Expose a stable computer-use unknown-outcome contract and preserve it in tool results. A host can now report that a desktop action started without proving its final state, and models receive explicit unsafe-to-retry guidance plus structured action, timeout, and exit evidence.

Classify subprocess failures after click, drag, scroll, text-entry, and key actions as unknown outcomes. Consumers can catch `ComputerUseOutcomeUnknownError`; ordinary read failures, idempotent pointer moves, and process-start failures keep their existing error behavior.
