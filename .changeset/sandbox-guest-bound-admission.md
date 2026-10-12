---
'@namzu/sandbox': minor
---

Add `KubernetesWorkspace.pinGuest(identity)` for data operations that must stay on one prepared guest. The non-owning view preserves workspace admission and cleanup but uses its own immutable transport, without following replacement pods. Requests use a guest-bound operation checked by the agent before execution, including every multipart write and command reservation. An older agent rejects that operation; no unguarded fallback runs. Deploy the matching agent image before using this API.
