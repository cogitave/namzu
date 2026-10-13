---
'@namzu/sandbox': minor
---

Add `openKubernetesWorkspaceForClosure` to reconnect to a previously acquired, retained live guest under the host's durable workload exclusion. The opener verifies exact Sandbox, PVC, Pod, guest boot and holder epoch evidence without creating, waking or replacing compute. Its transport stays pinned and its handle permits only terminal transitions with the original identity and epoch; failed opening never mutates provider resources.
