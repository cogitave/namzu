---
'@namzu/sandbox': major
---

Kubernetes workspace failure paths no longer suspend a workspace that is in use. Two observable defaults change, and a suspend on this backend deletes the pod — every terminal, dev server and running command in it, for every process holding the workspace.

**A start that fails no longer always suspends.** `createKubernetesWorkspace` and `KubernetesWorkspace.resume()` used to send `operatingMode: Suspended` on any error while bringing a session up. The errors that reach that path include a caller's `AbortSignal` firing during readiness, a single 5xx or 429 on a Sandbox or pod `GET` (the client does not retry), and a privilege probe that overran its deadline — none of which is a fault of the workspace, and all of which a *second* process meets while the *first* is executing in the pod. A workspace id is a name and not a lock, so that second process is the ordinary case: a restart, or a second revision during a rollout.

A failed start now patches only when the call itself moved the mode — it `POST`ed the object, or its `Running` patch took the object out of `Suspended`. An adopt of an already-running workspace, and a `resume()` that finds another process has already woken it, write nothing and rethrow. `resume()` reads `spec.operatingMode` before patching instead of patching blind, so it no longer claims authorship of a wake it did not perform (and no longer restamps `sandbox.namzu.ai/operating-mode-changed-at` for a mode that did not change).

*To keep the old behaviour there is nothing to do for the case it was right about*: a workspace this call woke and then failed to start is still suspended, because leaving it `Running` with a pod nobody is using burns a node. If you want **no** patch on any start failure — you keep your own holder record and sweep idle workspaces yourself — pass `onStartFailure: 'leave'`, on `KubernetesWorkspaceOptions` for the handle or on `KubernetesWorkspaceTransitionOptions` for one `resume()`. The old blanket behaviour (suspend on every start failure, including another process's workspace) is deliberately not offered.

One thing a failed start still does, unchanged, is leave the handle without a session: after a `resume()` that rejected without writing anything, `workspace.suspended` reads `true` although the cluster is `Running`. It is the handle's own state, not a claim about the object, and another `resume()` is the way back — `refresh()` reports only a suspension somebody else performed.

**An unconfirmed cancellation no longer retires a workspace or sends a patch.** When an execution's cancellation could not be confirmed within the shared controller's eight-second window, the handle retired itself — which on a workspace meant the same `Suspended` patch. Eight seconds of network loss under one `exec()`, or a pod evicted under an in-flight command, therefore stopped the pod for everyone. Nothing is written now:

- `exec()` still rejects with `RemoteCancellationUnknownError`;
- it carries `retirement: { accepted: false, reason: 'workspace-kept' }` instead of `{ accepted: true }`. `reason` is a new optional field on `SandboxRetirementObservation`; `error` is absent, because nothing was attempted. **Code that reads `retirement.accepted` to mean "the pod was stopped" must read `reason` as well**;
- the handle is not retired — `suspended` stays `false` and the next call is admitted;
- one bounded `healthz` over a fresh connection reports through the new `onCancellationUnconfirmed({ error, agent })` on `KubernetesWorkspaceOptions`, where `agent` is `'ok'`, `'retiring'` (the guest fenced itself and only a new pod clears it) or `'unreachable'`.

*To restore the old behaviour, call `suspend()` from `onCancellationUnconfirmed`.* Calling it only when `agent === 'retiring'` restores it for the case it was actually diagnosing.

**A fenced agent is named.** A reservation refused with `agent_retiring` on this backend now rejects with the new `KubernetesAgentRetiringError` instead of `RemoteProtocolError: remote sandbox returned an invalid execution reservation`. Unlike the Firecracker tier's mapping of the same refusal it does not retire the handle: that mapping is `RemoteCancellationUnknownError`, which would take the workspace's pod away. Not retiring the handle is a statement about *this side* — nothing was patched and the workspace is still `Running`; the guest's fence gates every op but `healthz` and `cancel-execution`, so reads, writes, terminals and tcp connections meet it too until the pod is replaced, and the message names the verbs that replace it on each tier (`suspend()` then `resume()` on a workspace, `destroy()` and a new sandbox on the task path).

Nothing here adds a `DELETE`. `destroy({ deleteDisk: true })` and `deleteKubernetesWorkspace` remain the only paths that remove a disk.

Also new on the public surface: `KubernetesWorkspaceStartFailurePolicy`, `KubernetesWorkspaceAgentState`, `KubernetesWorkspaceCancellationNotice`.
