---
'@namzu/sandbox': minor
---

Allow a workspace suspend or explicit disk deletion to carry a captured `expectedIdentity` and explicit epoch. This mode freshly verifies the Sandbox, PVC ownership and pinned guest, conditions terminal writes on UID/resource version/epoch, and retains the original target for lost-reply reconciliation. It waits for the original pod to stop before completion. The host must hold workload exclusion through the transition; existing unbound lifecycle behavior is unchanged.
