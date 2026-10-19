---
"@namzu/sandbox": minor
---

`workspace.quiesce({ onlyIfIdle: true })` asks whether a Kubernetes workspace is idle without stopping anything. It never signals or marks a process: it resolves with a report (`rounds: 0`, `stopped: []`) only when the guest's whole PID namespace holds nothing but init and the agent, and otherwise rejects with the new `KubernetesQuiesceBusyError`, which lists what it saw so you can retry later. A guest image that cannot tell reliably (an unreadable `/proc` entry, or an agent that cannot see its whole namespace) rejects with `KubernetesQuiesceUnconfirmedError` instead of reporting idle. It needs the new `quiesce-idle` guest feature: against an older workspace image the call rejects with `KubernetesQuiesceUnsupportedError` and sends nothing, so rebuild the image from this release to use it. Existing `quiesce()` and `suspend({ quiesce })` calls are unchanged. `QUIESCE_IDLE_FEATURE` is exported alongside the new error.
