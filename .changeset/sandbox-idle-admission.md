---
'@namzu/sandbox': minor
---

Add `quiesce({ onlyIfIdle: true })` to check whole-guest idle without stopping running work. Busy guests raise `KubernetesQuiesceBusyError`; pending starts, detached children and unreadable process evidence cannot pass as idle. The mode requires the new `quiesce-idle` guest capability and refuses older images before dispatch. `pinGuest(identity)` also exposes quiesce through its immutable guest transport. Keep host admission closed around the check and deploy the matching agent image before using it. Default quiesce behavior is unchanged.
