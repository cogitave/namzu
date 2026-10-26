---
"@namzu/sdk": minor
---

Residents are deprecated and will be removed in the next major release. Every resident export (`runResident`, `stepResident`, `ResidentHost`, `DiskResidentStore`, `DiskResidentAgenda`, `createResidentSelector`, `inspectResidentConsumption`, the outbox, history, tool-evidence and step-context helpers, and their types) is now marked `@deprecated` and behaves as before. Nothing is removed in this release. If you use them for long-running work, move to scheduled tasks (`LocalTaskScheduler`), session goals or background agents; learning has its own module (`runLearningCycle` and the other `Learning*` names), which does not depend on a resident being used.
