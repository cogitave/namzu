---
"@namzu/sandbox": minor
---

A Kubernetes workspace's writes are now pinned to the Sandbox they were meant for. A handle's `suspend()`, `resume()` and `destroy({ deleteDisk: true })` carry the Sandbox uid the handle bound: a different Sandbox under the same workspace id is refused with `KubernetesWorkspaceReplacedError` and nothing is written, where before the write went to whatever stood under the name. This needs no change to a call; the only visible difference is that a handle that knows its uid now sends a JSON patch (with an extra read) in place of the merge patch it used to send without an epoch. `suspendKubernetesWorkspace` and `deleteKubernetesWorkspace` accept `expectedIdentity: { sandboxUid }` for a host holding no handle.

New, read-only and GET-only: `inspectKubernetesWorkspace` (uids, mode, epoch, readiness), `openKubernetesWorkspace` (authenticate a retained identity, optionally `waitForReady` under one deadline; moves of `resourceVersion` or `Ready` are not a conflict, a real Sandbox or claim replacement is `KubernetesWorkspaceIdentityMismatchError`, running out of time is `KubernetesWorkspaceReadyTimeoutError`) and `reconcileKubernetesWorkspace` (`live`, `suspended`, `absent` or `replaced`). They need `get` on `persistentvolumeclaims` and `pods` as well as `sandboxes`.
