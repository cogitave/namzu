# @namzu/sandbox

## 14.0.0

### Minor Changes

- cd43cfe: `SandboxProviderConfig` gains a real arm for `ACIStandbyPoolBackendConfig` (paired with the `ContainerSandboxLayout` it requires, same as the plain container arm). Previously the exported union only covered `ContainerBackendConfig`, `MicroVMBackendConfig` and `KubernetesBackendConfig`, so `createSandboxProvider({ backend: { tier: 'container', runtime: 'aci-standby-pool', … } })` did not type-check even though the backend was fully implemented and `pickBackend` already dispatched to it internally through two `as unknown as` casts. That call now type-checks with no cast.

  **Minor, not patch:** this is a backward-compatible widening of an exported input type — every config that type-checked before still does, and the only change is that a config shape the runtime already accepted is now also accepted by the type checker. That is additive public surface (a new union arm a consumer's own type-level code can observe), not an implementation-only correction, so it does not qualify for patch under this repo's rule that patch is reserved for changes that leave the public surface untouched.

  No runtime behavior changed: the ACI backend's construction, options and defaults are exactly what they were.

- f54f6f1: The microVM guest agent can now listen on a TCP port and require a per-instance
  token. Both are opt-in through the environment and both are absent from every
  shipped backend's configuration today, so an existing Firecracker deployment
  behaves exactly as it did: with neither variable set, the agent authenticates
  nothing and listens exactly where it listened before.

  `NAMZU_AGENT_TCP_PORT` is a third listen mode, after `NAMZU_AGENT_UNIX_PATH`
  and the inherited vsock descriptor and in that order, binding `0.0.0.0` for a
  deployment that reaches the guest over a routed network rather than a
  host-local socket. It fails closed: set with neither token variable it is
  refused at startup, naming both, instead of binding an unauthenticated
  listener. Framing, ops, execution leases, terminals, loopback TCP and
  file IO are unchanged — only the listen address differs. A guest configured
  with none of the three still refuses to start, and the message now names all
  three.

  `NAMZU_AGENT_BIND_TOKEN` makes every op except `healthz` present that exact
  token in the request envelope, from the first frame of a connection; anything
  else is answered `unauthorized` and the connection is closed before a handler
  runs. Comparison is constant-time over a fixed-width digest, so neither the
  value nor its length is learnable by probing. `NAMZU_AGENT_REQUIRE_TOKEN`
  without a preset token is a fallback that binds to the first token seen and
  refuses every other for the life of the process. `healthz` never requires a
  token and never echoes one, so readiness probing needs no secret. An empty
  `NAMZU_AGENT_BIND_TOKEN` is refused at startup in every mode — that is what a
  downward-API injection looks like when it resolved to nothing.

  A refused connection is destroyed rather than `end()`ed, so a refused peer can
  no longer keep streaming into the agent's frame buffer over the readable half
  that `end()` leaves open. Alongside it, bounds on what an unauthenticated peer
  may spend before the gate — which cannot run until a whole frame is parsed,
  because the credential rides inside the envelope.
  `NAMZU_AGENT_MAX_FRAME_BYTES` (default 256 MiB) caps the length ANY frame
  header may announce, on every listen mode, where the 8-hex prefix used to allow
  4 GiB. `NAMZU_AGENT_REFUSAL_FLUSH_GRACE_MS` (default 1s) likewise applies
  everywhere: it is how long a refusal frame may take to reach the wire before
  the socket is destroyed regardless, so a peer that stops reading cannot hold a
  refusal open. `NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES` (default 8 MiB),
  `NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS` (default 64),
  `NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES` (default 32 MiB),
  `NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS` (default 10s) and
  `NAMZU_AGENT_PREAUTH_DEADLINE_MS` (default 10s) apply only in the token
  modes, so the Firecracker path sees none of them; together they bound what an
  unauthenticated peer can make the agent hold to one number rather than to a
  number per connection. One bound needs no variable and applies everywhere: a
  frame header is exactly nine bytes, so a peer streaming bytes with no newline
  in them is refused on the ninth rather than buffered against a newline that
  never arrives. Note what the pre-auth cap
  costs in a token mode: a `write-file` body shares the first frame with the
  token, so that cap is the ceiling on the body — about 6 MiB of file content at
  the default — and a body above it is refused `frame_too_large`, naming the
  limit and the variable to raise.

  Two of those pre-auth bounds are shaped by a slow loris rather than by a flood,
  and an operator who tunes them should know which is which.
  `NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS` is an idle timer that every byte resets,
  so on its own it retires only a silent connection;
  `NAMZU_AGENT_PREAUTH_DEADLINE_MS` runs from accept, is reset by nothing, and is
  the bound a peer dripping one byte every few seconds actually meets. And a full
  pre-auth pool evicts its **oldest** unauthenticated connection — answering it
  `too_many_unauthenticated_connections` — rather than refusing the arrival, so a
  poolful of squatters can no longer decide that nobody else, `healthz` included,
  gets served. None of this stops a peer that can reach the port from causing
  churn; the NetworkPolicy ingress rule in front of that port is the boundary,
  and these bounds are defence in depth behind it.

  The guest protocol version is deliberately NOT bumped: `token` is an optional,
  additive envelope field, and the wire is otherwise byte-for-byte what it was.
  Taking this release therefore requires no coupled rollout — no golden image has
  to be rebuilt and no host has to be redeployed in step with it. A deployment
  that wants the new modes turns them on in its own pod or image environment.

  Read `NAMZU_AGENT_BIND_TOKEN` as an instance credential, not an isolation
  boundary: the agent and the workload share a uid after deprivileging, so a
  workload can read the agent's own environment out of `/proc`. It is
  per-instance for that reason, and the network rule in front of the agent port
  is the boundary it sits behind.

  One behaviour changes for every existing deployment, Firecracker included, and
  it is the reason to read this entry before upgrading. The `terminal` op used to
  hand its shell the agent's whole environment; it now gets the same scrubbed
  environment an `execute` child has always had, with every `NAMZU_AGENT_*` and
  `NAMZU_SANDBOX_*` variable removed, and so does the `stty` resize helper behind
  it. That closed a hole this release would otherwise have opened — the bind
  token was visible in an interactive shell — and it means a terminal session no
  longer sees the agent's own settings, such as `NAMZU_SANDBOX_WORKSPACE`. A
  workload that needs a value in its terminal passes it in `env` on the
  `openTerminal` call, which still wins over everything else, `TERM` included.
  The bump stays `minor`: nothing exported changes shape, and the environment a
  terminal is handed is guest-internal behaviour rather than a typed API, but it
  is a change a terminal user can observe.

- 5604f73: A Kubernetes backend that claims VM-isolated sandboxes out of an [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) warm pool. New exported types `KubernetesBackendConfig` and `KubernetesClusterAccess`; `SandboxBackendConfig` and `SandboxProviderConfig` each gain an arm for it, so `createSandboxProvider({ backend: { tier: 'microvm', service: 'kubernetes', … } })` type-checks with no cast. Nothing existing changes shape.

  **Take this upgrade for the new backend, not for a complete one.** This changeset covers acquire, readiness, address resolution and teardown; the execution surface, the acquire-time privilege probe and the lease arrive in the same release under their own changesets, and persistent workspaces (suspend/resume with a block-mode disk) and the cluster manifests follow in later ones. Every other backend is untouched.

  What it does today, on a cluster running agent-sandbox v1.0.2 with a VM-isolating `RuntimeClass`:

  - **Warm claim, or a direct Sandbox.** With `warmPoolName`, `create()` POSTs a `SandboxClaim` at that pool and the controller binds an already-running sandbox. Without it, it POSTs a `Sandbox` built from `sandboxTemplateName`'s pod template — necessitated rather than offered, since `SandboxClaim.spec.warmPoolRef` is required and a pool-less claim does not exist in the API.
  - **The claim is pristine.** `spec.env` and `spec.volumeClaimTemplates` are never set, because a claim carrying either is forced to cold-start upstream instead of adopting a pool sandbox. It would still work; it would just stop being fast. Per-sandbox `env`, `memoryLimitMb`, `maxProcesses` and `egress` are therefore refused by name instead of accepted and dropped — set them on the `SandboxTemplate` the pool is built from.
  - **The bound sandbox's own identity.** A pool sandbox keeps the name the pool generated for it, so the backend reads `status.sandbox` back rather than assuming the claim's name; the sandbox `id` is that cluster name, which makes an id in a log line a `kubectl get sandbox` argument.
  - **Nothing left behind.** Every created object carries an absolute `shutdownTime` (default one hour, `claimTtlSeconds`) plus `shutdownPolicy: Delete`, so a host that dies mid-run costs one expiry rather than a leaked sandbox — `ttlSecondsAfterFinished` deliberately is not used, because its timer starts from a `Finished` condition a crashed host never reaches. Every failure on the create path deletes what it created on a separate short budget; an object already gone counts as released.
  - **A per-instance agent credential.** The pod's own `metadata.uid`, read with one `GET` after readiness and delivered to the guest through the downward API. No claim mutation, so the warm path stays pristine.

  Credentials arrive through `access`: `{ inCluster: true }` reads the projected ServiceAccount volume, and anything else supplies `{ server, ca?, getToken }`. There is no kubeconfig parsing in the package and no new dependency — `@namzu/sandbox` still declares no `dependencies` key.

- 437e3d3: The Kubernetes backend now ships the cluster-side half of itself: the guest image, its entrypoint, the `RuntimeClass`/`SandboxTemplate`/`SandboxWarmPool`/`NetworkPolicy`/RBAC manifests, and five scripts that measure the five acceptance criteria against a live cluster — all under `packages/sandbox/k8s/`, which is **not part of the published package** (the `files` array still packs only `dist` and `src`; `npm pack --dry-run` confirms it). None of that is a consumer-visible surface. What IS:

  **The guest agent now exits cleanly on `SIGTERM` — bumped `minor`, not `patch`, for exactly this.** `k8s/entrypoint.sh` `exec`s straight into `agent/agent.cjs`, so in a real pod the agent is pid 1 of the container's own pid namespace, and Linux leaves a signal whose default action is "terminate" un-applied for pid 1 unless the process installs its own handler. With none registered, an operator deleting a sandbox watched it ride out the pod's full `terminationGracePeriodSeconds` before `SIGKILL` finally landed — every delete paid that tax, cluster-wide, whatever backend dialed the agent. The new handler closes the listener and calls `process.exit(0)` the moment `SIGTERM` arrives. It is not a graceful drain: an in-flight `exec` or an open terminal gets no grace window, the same "gone" a caller already has to handle from a pod the cluster removed out from under it. This is additive guest behavior on a file the Firecracker tier also runs in production — nothing about the vsock/unix paths changes, and `REMOTE_EXECUTION_PROTOCOL_VERSION`/`FIRECRACKER_AGENT_PROTOCOL_VERSION` are untouched — but it is a real, observable change to when a pod actually terminates, which is why this is `minor` rather than `patch`.

  **Documented for the first time, no behavior change:** a confirmed `exec` cancellation on this backend resolves with the terminal signal/exit code the shared `RemoteExecutionController` observed — the same contract the Firecracker tier's `exec` already honors, now stated on `docs/sdk/kubernetes-sandbox.md` rather than left implicit.

  Everything else in this change is infrastructure an operator applies by hand — see `packages/sandbox/k8s/README.md` for the apply order and how to run each acceptance script, and `docs/sdk/kubernetes-sandbox.md`'s new deployment section for what each one measures. The five acceptance numbers themselves are not yet in that table; they are gathered by running those scripts against a real Kata cluster, not by this change.

- 432db25: The Kubernetes backend's `KubernetesBackendConfig` gains an optional `egress` block: `{ policy: EgressPolicy; networkPolicyName?: string; engine?: 'core' | 'cilium' }` (`engine` defaults to `'core'`). New exported types `KubernetesEgressConfig` and `KubernetesEgressEngine`. Nothing existing changes shape — `egress` is additive and optional, and every Sandbox this backend produces now carries a `sandbox.namzu.ai/template` label it did not carry before, which is additive metadata rather than a behavior change for an existing caller.

  **What it does.** `deny-all` and `allow-all` translate into a `NetworkPolicy` (egress rules that always leave the cluster's own DNS reachable, even under `deny-all`). `static` and `resolver` — hostname allowlists — are **refused at construction**, before any API call, naming the policy kind and what the cluster needs: core Kubernetes `NetworkPolicy` has no FQDN concept at all. Declaring `engine: 'cilium'` turns that refusal into an emission: a `CiliumNetworkPolicy` with a `toFQDNs` entry for every allowed host. This backend never emits `HTTP_PROXY`/`HTTPS_PROXY` as a substitute for an unenforceable policy — that is the container tier's still-open gap, not repeated here.

  **Verify, never trust.** This backend never creates the `NetworkPolicy`/`CiliumNetworkPolicy` itself — like the docker backend's network, it is operator-applied. The first `create()` after construction (not `createSandboxProvider`, which still contacts nothing) `GET`s the object named by `networkPolicyName` (default `${sandboxTemplateName}-egress`) and refuses to proceed on a 404 or a shape mismatch, naming the field that is wrong. It runs once per backend and is not cached across a failure, so fixing the cluster and creating again retries it.

  **Take this upgrade for the label, even without using `egress`.** Every Sandbox this backend creates directly now carries `sandbox.namzu.ai/template: <sandboxTemplateName>` on its pod — agent-sandbox's own controller-owned template label is written only on a Sandbox adopted out of a `SandboxWarmPool`, never on one this backend POSTs directly, so a `NetworkPolicy` an operator writes against a direct Sandbox should select by this new label. A `SandboxWarmPool`'s own `SandboxTemplate` needs the same label added to its `podTemplate.metadata.labels` for a pooled sandbox to match it too — this backend has no path to add it after the fact.

  RBAC: when `config.egress` is set, the ServiceAccount also needs `get` on `networkpolicies` (`networking.k8s.io`), or `get` on `ciliumnetworkpolicies` (`cilium.io`) under `engine: 'cilium'`.

- a3ae83e: The Kubernetes backend now returns a working `Sandbox`, refuses to hand one back until the guest has proved it is deprivileged, and keeps a long run's pod from expiring underneath it.

  **The execution surface exists.** `exec`, `writeFile`, `readFile`, `listFiles`, `openTerminal` and `openTcpConnection` no longer throw `KubernetesAgentTransportPendingError` — that error is gone, and so is the reason for it. `exec` runs through the same reserve-before-admission controller every other remote backend uses, so an `AbortSignal` terminates the guest process and the peer confirms the termination rather than the host abandoning the wait. `destroy()` kills and awaits every terminal it handed out before releasing the object, which is what makes offering `openTerminal` compliant at all; it is idempotent, and an object something else already reaped counts as released. Every call after it throws `KubernetesSandboxDestroyedError` naming the operation.

  **`setNetworkPolicy`, `spawnDetached` and `walkFiles` are absent, deliberately.** Egress here is a `NetworkPolicy` on the pool's `SandboxTemplate` and there is no per-running-pod knob, the guest agent has no detached-spawn op, and bounded search is not in this batch. The SDK's contract says a backend that cannot honour an optional method must omit it rather than accept it and quietly do nothing; a test asserts each stays absent.

  **Every acquire now proves the guest is deprivileged.** Before `create()` resolves, the backend reads `/proc/self/status` through the agent's `execute` op and refuses unless `CapInh`, `CapPrm`, `CapEff` and `CapBnd` are ALL zero and `NoNewPrivs` is 1. Checking `CapEff` alone would pass a container running as uid 0 with the full bounding set. A refusal destroys the instance and rejects, so no handle to an under-hardened sandbox escapes, and the error distinguishes "the probe could not run" (a minimal image with no `cat`) from "the process is privileged". **There is no configuration that turns this off.** If your image's entrypoint does not end with `exec setpriv --reuid --regid --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- node agent.cjs`, or equivalent, `create()` will now reject where it previously returned. The probe carries its own deadline — `min(readyTimeoutMs, 15s)` — so a pod whose agent has wedged (out of memory, an event loop the workload blocked) is refused on your acquire budget rather than held open for the execution controller's five-minute default; budget for a `create()` that can take `readyTimeoutMs` plus that again in the worst case. The probe is a check that the deprivileging happened, not a boundary against a guest that is already compromised — it asks the agent to report its own `/proc/self/status`. The boundary is still the VM and the `NetworkPolicy`.

  **A handle renews its own lease.** The absolute `shutdownTime` this backend stamps on every object it creates bounds a leak; unrenewed it also bounded the RUN, so a session outliving `claimTtlSeconds` (default one hour) had its pod deleted mid-command. The handle now merge-PATCHes that expiry a full TTL forward every half TTL, jittered ±10%, and `destroy()` stops it. **This adds an RBAC requirement**: the ServiceAccount needs `patch` on `sandboxclaims` and `sandboxes` in the sandbox namespace, alongside the verbs it already needed. A renewal that fails is reported to the new optional `KubernetesBackendConfig.onLeaseRenewalError` and retried on the next tick; each PATCH is bounded on its own clock (a quarter of the interval, capped at 30 seconds), so an API server that accepts a renewal and never answers it is abandoned and retried rather than parking the loop and letting the lease expire in silence; and one that finds the object already deleted stops the loop and marks the handle gone, so later calls throw `KubernetesSandboxGoneError` instead of dialing a pod that no longer exists. A handle you drop without calling `destroy()` keeps renewing for as long as the process lives, so `destroy()` is now load-bearing for cleanup inside a long-lived host.

  New on the public surface: `KubernetesPrivilegeProbeError` (with `reason`, `PrivilegeProbeFailure` and `ProcStatusPrivileges`), `KubernetesSandboxDestroyedError`, `KubernetesSandboxGoneError`, `KubernetesAgentUnauthorizedError`, `AgentPreauthFrameTooLargeError`, `TCP_PREAUTH_FRAME_LIMIT_BYTES`, and `KubernetesBackendConfig.onLeaseRenewalError`. Removed: `KubernetesAgentTransportPendingError`, which was never exported from the package entry point and could only ever be thrown by a method that now works.

  One limit worth knowing before you write a large file: every request to the guest dials a fresh connection, so every request is that connection's first — not-yet-authenticated — frame and is bounded by the guest's pre-auth ceiling (8 MiB by default) on every call, not once. A `writeFile` whose base64 body would exceed it throws `AgentPreauthFrameTooLargeError` before dialing, naming the limit; in practice bodies above about 5.9 MiB raw do not fit. Chunking is not implemented — raise `NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES` in the deployment, or split the write.

  Every other backend is untouched.

- 53c526c: `SandboxAgentHandle` (re-exported from the package's public entry point)
  gains a fourth arm: `{ kind: 'tcp', host, port, token }`. `VsockAgentTransport`
  (also public) gains a new `executeStreamed()` method, and its
  `VsockTransportOptions` gain an optional `onDial` callback. All three
  changes are additive and backward compatible — existing `unix`/`vsock`/`mtls`
  handles, existing `VsockAgentTransport` callers, and the guest protocol are
  untouched (`firecracker/__tests__/transport.test.ts` passes unmodified) — but
  they are genuinely new surface in the compiled `.d.ts`, not yet constructible
  by anything outside `packages/sandbox/src/backends/` until a later workstream
  wires the kubernetes backend up to them.

  Alongside this, a new (package-internal, not yet exported) `KubernetesAgentTransport`
  in `src/backends/kubernetes/transport.ts` dials the guest agent (`agent/agent.cjs`)
  directly over a routed pod network for the upcoming kubernetes backend.

  The `tcp` dialer is a plain `net.connect({ host, port })` per call — no
  routing preamble, no ack, no cached socket or IP — so a `host` that is a
  Kubernetes Service FQDN is re-resolved on every request and a resumed
  pod's new address costs nothing extra. The handle's optional `token`
  rides in each request envelope (the credential field the guest agent
  already accepts); a wrong token surfaces as a named
  `KubernetesAgentUnauthorizedError` rather than a generic protocol error.

  Because every `tcp` request dials a fresh connection, that connection's
  first frame is also the one the guest agent has not authenticated yet,
  so it is bound by the agent's pre-auth frame ceiling (8 MiB by default)
  on every call, not just on first use. This transport now checks an
  outgoing envelope's size against that ceiling BEFORE dialing and throws
  a named `AgentPreauthFrameTooLargeError` naming the limit, instead of
  opening a connection the agent would refuse anyway. Chunking a large
  `write-file` body across multiple frames is a documented follow-up, not
  implemented here.

  `KubernetesAgentTransport` also accepts an optional `onTiming` callback
  reporting a completed `exec()` call's dial/reserve/execute/drain
  durations (never the token, command, or output), so the kubernetes
  backend's sub-second warm-acquire target can be measured rather than
  assumed.

- 50de52b: The Kubernetes backend can now keep a workspace: a sandbox with a block-mode disk that survives being suspended.

  **New verb, not a new provider.** `createKubernetesWorkspace(config, options)` returns a `KubernetesWorkspace` — the SDK's `Sandbox`, plus `suspend()`, `resume()`, a `suspended` flag, and a `destroy()` that takes `deleteDisk`. It is separate from `createSandboxProvider` because a `SandboxProvider` promises an ephemeral sandbox per run and this promises the opposite; `warmPoolName` is ignored, since a workspace is always a `Sandbox` POSTed directly. `@namzu/sdk`'s `Sandbox` is untouched: no new `SandboxStatus` member, no `suspend?()`/`resume?()` on the shared contract, no `deleteDisk` on the shared `SandboxDestroyOptions`.

  **`destroy()` keeps the disk.** The API has `operatingMode` and it has DELETE, and nothing in between, so there is no delete-compute-keep-disk verb to offer. `destroy()` and `destroy({ deleteDisk: false })` SUSPEND and leave the object standing; only `destroy({ deleteDisk: true })` DELETEs the Sandbox and cascades to its Pod, Service and PVC. The default is the non-destructive one because `destroy()` is what a `finally` block calls. No failure path ever deletes: a create or resume that fails after the object exists suspends it and rethrows — including a create that POSTed the object itself, because two processes can be coming up on one name at once and the one that got the `201` would otherwise delete the disk the other just adopted. The named cost: a failed create can leave one suspended `Sandbox` and its PVC standing, which nothing reaps and which the caller finds again under the same name.

  **A workspace carries no lease.** Unlike a task sandbox it gets no `shutdownTime`, no `shutdownPolicy: Delete` and no renewal loop. An expiry on a workspace is a timer that deletes your files, and a renewal loop makes keeping them conditional on a host process staying up. The trade is explicit: **nothing reaps a workspace you abandon** — the PVC stands until someone calls `destroy({ deleteDisk: true })` or deletes the Sandbox by hand.

  **The disk is fixed at creation and must be `volumeMode: Block` — every entry of it.** `Sandbox.spec.volumeClaimTemplates` is CEL-immutable and a `SandboxClaim` carrying one is forced to cold-start, so "claim a warm diskless sandbox and attach a disk later" is not expressible in this API; resizing is out of scope for the same reason. The `SandboxTemplate` a workspace is built from must declare at least one `volumeClaimTemplates` entry, every entry must be `Block`, and every entry must be claimed through a container's `volumeDevices` rather than `volumeMounts`. Anything else throws the new `KubernetesWorkspaceDiskError` before anything is created — each refused shape otherwise WORKS: no disk gives you a sandbox whose files vanish on the first suspend, and a `Filesystem` PVC under a VM-isolating RuntimeClass reaches the guest over a filesystem passthrough that pays a round trip per file operation, so a dependency-tree walk is several times slower and nothing fails.

  **`config.egress` applies to a workspace too.** `createKubernetesWorkspace` runs the same two steps a provider `create()` runs: a `static`/`resolver` hostname allowlist with no FQDN-capable `engine` is refused synchronously, before any request, and the `NetworkPolicy` an operator applied is fetched and matched against the translation before anything is created. It is checked against the template the workspace is built from (`options.sandboxTemplateName`, falling back to `config.sandboxTemplateName`), because that name is the pod label the policy's `podSelector` matches — a deployment with a separate workspace template needs a policy object for it (`<workspace template>-egress` by default), and the task template's does not cover a workspace pod. Unlike the provider's once-per-backend check, this one runs on every call.

  **A suspend waits for the pod, and only the pod.** `suspend()` resolves once the pod is gone or in a terminal phase — not on the Sandbox's `Suspended` condition, which upstream documents as lingering True after a resume, and not on a `deletionTimestamp`, which is set while the guest is still running and still writing to the disk. A pod that outlives `readyTimeoutMs` rejects with the new `KubernetesWorkspaceSuspendTimeoutError` rather than resolving early. A call already in flight when `suspend()` starts is not cancelled: it fails at the transport, not with the suspended error.

  **A state is recorded when the cluster confirms it, never before.** Both verbs are idempotent by early-returning on a recorded state, so the moment that record is written decides what happens to a failure. `suspended` is written after the patch lands AND the pod is observed stopped; `deleted` after the DELETE resolves, or reports the object already gone. A request that fails leaves the state it found and rethrows, so you can retry: a refused suspend patch leaves the workspace running and still serving calls, a suspend whose pod outlived the wait admits no call but is not recorded as finished, and a failed DELETE does not answer your retry "already deleted" while the `Sandbox`, its pod and its PVC stand on the cluster with nothing left that would remove them. Concurrency is covered the other way round, with a single flight per verb: a second `suspend()` or `destroy()` arriving mid-transition awaits the one in progress instead of sending a second request into the window the deferred record opens, and `destroy()` with no options shares the suspend's flight because it is a suspend — the shared request running under the FIRST caller's `signal`, since that is what sharing one request means. `destroy()` is idempotent across the two shapes as well as within each: a plain `destroy()` on a workspace already removed by `destroy({ deleteDisk: true })` is a no-op in either admission order, because `destroy()` is what a `finally` block calls and what it asks for has happened; an explicit `suspend()` on a deleted workspace still throws.

  **Nothing but `deleteDisk: true` deletes — including the path you never call.** When an execution's cancellation cannot be confirmed (a wedged agent, a partitioned pod, the `cancel-execution` window closing with no answer), the shared execution controller retires the pod that command was left in. On a task sandbox retiring means DELETEing the object, correctly — it is disposable and its disk is scratch. A workspace is retired by the same `operatingMode: Suspended` patch `suspend()` sends: the `exec()` still rejects, carrying `retirement: { accepted: true }` once that patch lands (`accepted: false`, with the error, when it does not), the workspace then reads `suspended: true` and admits nothing, and `resume()` brings up a fresh pod on the same disk. A `destroy({ deleteDisk: true })` whose DELETE fails leaves the same shape — session torn down, nothing admitted, `suspended: true` — because neither the delete nor a suspend reached the cluster, so both `resume()` and a retried delete are open to you.

  **A resume rebuilds the address and the token.** A resumed pod keeps the sandbox's name and gets a new uid and a new IP, so `resume()` re-resolves the address, re-reads the bind token and rebuilds the transport, skipping any pod carrying a `deletionTimestamp` or in a terminal phase — while the outgoing pod terminates, a `GET` by name can still answer with it and a selector list can return it beside the new one. `Ready` is not a transition signal either — the controller leaves it standing across a resume the way it leaves `Suspended` standing — so the uid is POLLED under `readyTimeoutMs` until a live pod with a uid different from the one the last landed suspend patch retired is found, rather than read once from a status that has not caught up. That covers a resume issued straight after a suspend whose pod outlived its own wait, which arrives mid-drain with no live pod of that name to read at all. Every patch that lands is recorded the same way — an explicit `suspend()`, the retirement above, and the cleanup after a failed create or resume, which swallows its own failure and therefore records only when the request actually came back; a pod nobody asked the controller to remove has no replacement to wait for, and excluding it would time out a resume whose workspace was perfectly usable. What visibly moves depends on the Service: the token is always new, the pod IP always changes, and a `status.serviceFQDN` address does not, because the Service outlives the pod. The acquire-time privilege probe runs again on every resume. Between a suspend and a resume every call throws the new `KubernetesWorkspaceSuspendedError` and issues no dial, because the Service outlives the pod and a dial would hang on a connect timeout that names nothing. `status` reports `destroyed` while suspended — `SandboxStatus` has no suspended member — and `suspended` is what tells the recoverable state from the final one.

  **Calling it twice reattaches — and what is adopted is checked.** The Sandbox is named `namzu-ws-<workspaceId>`, so a second process finds the same workspace; a create that collides adopts the existing object and resumes it if it was asleep. Because an adopt is handed an object this call did not build, the object is checked against the configuration before it is woken: it must carry a block disk, its pod template must carry `sandbox.namzu.ai/template` for the template this call builds from, and — when `runtimeClassName` is configured — it must already run under that class. A disagreement throws the new `KubernetesWorkspaceMismatchError` and nothing is patched, woken or dialed. The label check runs whether or not `config.egress` is set, since that label is what a policy's `podSelector` matches and adopting an object built from another template would hand back a pod the verified policy does not select; the RuntimeClass check is there because the privilege probe cannot see a missing VM boundary (`/proc/self/status` reads the same under Kata and under runc). The fix is to point the workspace at the template it was built from, or to delete the Sandbox — which takes its disk with it — and create it again.

  A `workspaceId` that is not already a legal DNS-1123 label is refused rather than sanitised, because two ids that sanitise to one name would silently share one disk. It is a name and not a lock: two host processes can adopt one running workspace, and either one's `destroy()` suspends the pod the other is executing in.

  **Fixed on the task path, in the same change:** a pool-less `create()` copied the `SandboxTemplate`'s `podTemplate` and dropped its `volumeClaimTemplates`, so a task template declaring a disk produced a healthy Sandbox with no disk and a container naming a volume that did not exist. Both paths now copy the template's `volumeClaimTemplates` verbatim. If you have been working around that by declaring no disk on a task template, nothing changes; if you declared one and wondered where it went, it now arrives.

  New on the public surface: `createKubernetesWorkspace`, `KubernetesWorkspace`, `KubernetesWorkspaceOptions`, `KubernetesWorkspaceDestroyOptions`, `KubernetesWorkspaceTransitionOptions`, `KubernetesWorkspaceDiskError`, `KubernetesWorkspaceMismatchError`, `KubernetesWorkspaceSuspendTimeoutError`, `KubernetesWorkspaceSuspendedError`. RBAC is unchanged — a workspace uses verbs the task path already needed. Every other backend is untouched.

- a70c936: A `Sandbox` contract conformance suite: `defineSandboxConformance` (`packages/sandbox/src/testing/sandbox-conformance.ts`) asserts `exec`'s exit codes and streamed output, the `AbortSignal` contract (the process is genuinely terminated, never a resolved result that reads as an unaborted success), a `writeFile`/`readFile` round trip including binary content, `listFiles`, `openTerminal` ownership on `destroy()`, `openTcpConnection` to guest loopback and its refusal of a non-loopback host, destroy idempotence, and every call failing once destroyed. It takes its `describe`/`it`/`expect` and a factory producing a fresh `Sandbox` as arguments, the same shape `@namzu/sdk/testing`'s checkpoint-store and provider-driver suites already use, so `@namzu/sandbox` gains no test dependency from shipping it and a caller can run it against a recording harness.

  **New exported surface, within the package only.** `@namzu/sandbox` has no `testing` subpath in its published `exports` map, and this change does not add one — that is a deliberate, separate decision. A caller inside this monorepo imports `defineSandboxConformance` by relative path (`src/testing/sandbox-conformance.js`), exactly as the two new test files below do. It is minor rather than patch because it is new, intentionally-public TypeScript surface a consumer with access to the package's source can import and depend on, even though nothing in `@namzu/sandbox`'s npm entry point changes shape.

  **Proven against two backends, not one.** `packages/sandbox/src/backends/kubernetes/__tests__/conformance.test.ts` and `packages/sandbox/src/backends/firecracker/__tests__/conformance.test.ts` both run the identical suite — the kubernetes backend over a real `agent/agent.cjs` on a loopback TCP socket, Firecracker over the same agent on its existing unix-domain-socket fixture — which is what makes it a contract suite rather than one backend's tests wearing a new name. `packages/sandbox/src/testing/__tests__/conformance-fails-a-broken-sandbox.test.ts` is the suite's own negative test: three deliberately broken `Sandbox`s (resolves `exec` after abort, `destroy()` leaves a terminal running, `readFile` returns corrupted bytes) each fail it by name.

  Nothing existing changes shape — every other export, every shipped backend's behavior, is untouched.

### Patch Changes

- 4b0e7ad: `defineSandboxConformance`'s `openTcpConnection` positive case now starts its echo listener INSIDE the guest, through `openTerminal`, instead of on the orchestrator/test process's own loopback. The old fixture only ever proved anything for a backend whose "guest" happened to share that loopback with the test process (a Firecracker unit test over a local socket, a fake-agent-in-process kubernetes test) — it could never pass against a real remote sandbox, which cannot dial the orchestrator's loopback at all. Confirmed in-cluster: this case now passes against a live kubernetes backend acquisition on a real kind cluster, where it previously failed with `connect ECONNREFUSED`.

  Two new optional fields on `SandboxConformanceOptions` — `guestCanRunNode` and `guestListenerCommand` — let a backend whose guest cannot run a listener this way skip the case with a stated reason (its own title) rather than fail spuriously; both default to the existing behavior (node is assumed available, since every shipped backend's guest agent already runs on node), so no existing caller of `defineSandboxConformance` needs to change anything.

  Patch, not minor: this module has no `testing` subpath in `@namzu/sandbox`'s own `exports` map (see the file's own doc comment) — a caller reaches it only by relative path within the monorepo, as `backends/kubernetes/__tests__/conformance.test.ts` and `backends/firecracker/__tests__/conformance.test.ts` already do — so this is not yet public surface, and the added options are additive and optional regardless.

  Also corrects a self-contradictory doc comment on `Sandbox.openTerminal` (`@namzu/sdk`): it told an implementer to both "throw" and "omit" for a guest that cannot provide one. It now says only "omit", matching `Sandbox.openTcpConnection`'s own wording and this suite's documented skip-if-unavailable convention. Comment-only; no type or behavior changed.

- 13d01db: Adds an internal Kubernetes API client (`backends/kubernetes/k8s-client.ts`, not yet exported from the package entrypoint) for an in-progress Kubernetes/Kata sandbox backend. It speaks the API server with bare `fetch`, falling back to `node:https` only when a custom cluster CA is supplied, and bootstraps in-cluster credentials straight from the projected ServiceAccount volume — the same zero-dependency pattern the ACI and Firecracker backends already use. `@namzu/sandbox` still declares no `dependencies` key.
- 77adb50: Fix both the kubernetes/Firecracker guest agent (`agent/agent.cjs`) and the
  container-tier HTTP worker (`worker/server.js`) reporting a cancelled
  `exec()` as a clean, unaborted-looking success when the target process
  ignores `SIGTERM` but happens to finish on its own before the cancel grace
  window elapses. Both peers' `terminateAndConfirm` only escalated to
  `SIGKILL` if the owned process group was still alive at the end of that
  window, with nothing checking that the exit was actually caused by the
  signal — so an ignoring process whose natural runtime was under the grace
  period ran to completion untouched, in violation of
  `SandboxExecOptions.signal`'s contract ("must terminate the owned process
  ... never silently ignore the signal and let the command run to
  completion"). This is the same mechanism on both transports, found on the
  guest agent first (issue #469's kind conformance run) and confirmed to
  exist verbatim in the worker once looked for.

  The default (previously `2000`ms on both) is now `250`ms for
  `NAMZU_AGENT_CANCEL_GRACE_MS` (agent) and `NAMZU_SANDBOX_CANCEL_GRACE_MS`
  (worker) — comfortably under the shared conformance suite's adversarial
  fixture (a command that finishes on its own in ~400ms) while still enough
  for a fast, well-behaved SIGTERM handler's cleanup. A deployment that
  genuinely needs a longer window for cooperative shutdown sets either
  variable explicitly; both were already, and remain, overridable. A new
  regression test on each transport deliberately leaves its own grace
  variable unset — the one thing every other suite on that transport
  overrides — and fails against the old default, passes against the new one.

  **Defect 2, found alongside the agent fix, is now MITIGATED for the
  Kubernetes backend's shipped image, not merely documented:** in a real pod
  the agent used to run as the container's PID 1 with no subreaper
  (`packages/sandbox/k8s/entrypoint.sh` `exec`ed straight into it), so a
  background job forked by a cancelled `sh -c` command (`... &`) reparented
  to the agent on `SIGKILL` and was never reaped — Node's `child_process`
  only `waitpid()`s the children it spawned itself — running that
  cancellation out the full `RemoteExecutionController` cancel-confirm window
  (8s by default) and tearing the sandbox down instead of confirming.
  `k8s/entrypoint.sh` now execs into `tini` (installed in `k8s/Dockerfile`)
  as the container's real PID 1 and subreaper, with the guest agent as its
  child; `tini` reaps the orphan and forwards `SIGTERM` to the agent exactly
  as before. **A host building its own image from `agent.cjs` directly rather
  than from `k8s/Dockerfile` must still provide its own subreaper as PID 1**
  — this fix lives in the shipped image, not in the agent itself, since
  `agent.cjs` cannot know what pid it is. Root-caused with live evidence in
  `research/k8s-sandbox/kind-e2e-results.md` ("Defect 2", `2026-09-16`) and
  re-verified in-cluster against the new image in
  `research/k8s-sandbox/abort-case-recheck-results.json`.

  **Patch, not minor or major:** `agent/agent.cjs` and `worker/server.js` are
  guest/worker files that run INSIDE a sandbox or container, never imported
  by a consumer of the published `@namzu/sandbox` tarball (`npm pack
--dry-run` packs only `dist` and `src`); the k8s image's `Dockerfile` and
  `entrypoint.sh` are likewise deployment artifacts, not the package's own
  `exports`. Both defaults that changed are guest-/worker-internal timings
  with no public type or exported symbol affected, and both changes narrow
  when a cancellation escalates to `SIGKILL` and add a real subreaper —
  strictly tightening what `SandboxExecOptions.signal`'s contract already
  promised, never loosening it, so no caller-visible behavior a consumer
  could have depended on gets worse.

- Updated dependencies [68e535b]
- Updated dependencies [a9e4b19]
- Updated dependencies [a54dc71]
- Updated dependencies [86a3818]
- Updated dependencies [03630cd]
- Updated dependencies [f33c62b]
- Updated dependencies [a8df193]
- Updated dependencies [8bfe291]
- Updated dependencies [6ae4072]
- Updated dependencies [dd8702d]
- Updated dependencies [92ab1d9]
- Updated dependencies [e6d6d1e]
- Updated dependencies [7ca8c7d]
  - @namzu/sdk@40.0.0

## 13.0.0

### Patch Changes

- Updated dependencies [40651dd]
- Updated dependencies [b156888]
- Updated dependencies [7bb8163]
- Updated dependencies [2d26b44]
- Updated dependencies [6663561]
- Updated dependencies [2a1e0e5]
- Updated dependencies [ce55c21]
- Updated dependencies [9463b6f]
- Updated dependencies [de53442]
- Updated dependencies [6e4a820]
- Updated dependencies [28d3874]
- Updated dependencies [985db49]
- Updated dependencies [bd4bd2e]
- Updated dependencies [fe6e0fb]
- Updated dependencies [bb0281b]
- Updated dependencies [cff2b6a]
- Updated dependencies [df686fc]
- Updated dependencies [e954d02]
- Updated dependencies [2869fbe]
- Updated dependencies [b1e3bc5]
- Updated dependencies [df143c8]
- Updated dependencies [45c8292]
- Updated dependencies [6e14db9]
- Updated dependencies [6a6921c]
- Updated dependencies [691342c]
- Updated dependencies [d5d2b9a]
- Updated dependencies [b971796]
- Updated dependencies [e9a4192]
- Updated dependencies [612879e]
- Updated dependencies [e7bc7a1]
- Updated dependencies [b2d5b01]
- Updated dependencies [3e09024]
- Updated dependencies [f49a4b8]
- Updated dependencies [43124f0]
- Updated dependencies [e40044b]
- Updated dependencies [6446182]
- Updated dependencies [0a0baf2]
- Updated dependencies [c4aaf9b]
- Updated dependencies [77272e3]
- Updated dependencies [7579aa0]
- Updated dependencies [5996a84]
- Updated dependencies [ebfb3b4]
- Updated dependencies [4828eb0]
- Updated dependencies [97acc32]
- Updated dependencies [c329408]
- Updated dependencies [b649224]
- Updated dependencies [10e9984]
- Updated dependencies [4801a6f]
- Updated dependencies [b9e0f37]
- Updated dependencies [2bcf017]
- Updated dependencies [e63ca83]
- Updated dependencies [830f81e]
- Updated dependencies [6394010]
- Updated dependencies [f4b3ffb]
- Updated dependencies [9a4877a]
- Updated dependencies [f92daf8]
- Updated dependencies [22203b0]
- Updated dependencies [5d31eea]
- Updated dependencies [9ea5074]
- Updated dependencies [f1e33a1]
- Updated dependencies [2e93158]
- Updated dependencies [1d651d0]
- Updated dependencies [b888779]
- Updated dependencies [281859f]
- Updated dependencies [d1a6ce5]
- Updated dependencies [d81aca6]
- Updated dependencies [61aab1f]
- Updated dependencies [ea5367d]
- Updated dependencies [0fa8941]
- Updated dependencies [3c60512]
- Updated dependencies [8095541]
- Updated dependencies [6c682d8]
- Updated dependencies [bdf923d]
- Updated dependencies [656e79d]
- Updated dependencies [3c6326f]
- Updated dependencies [0a36260]
- Updated dependencies [f3b377e]
- Updated dependencies [fd0d270]
  - @namzu/sdk@39.0.0

## 12.0.1

### Patch Changes

- 2d71d68: Make worker lease regression tests deterministic under slow scheduling by controlling the test worker's clock. This changes validation only; sandbox runtime behavior is unchanged.

## 12.0.0

### Major Changes

- 786ca01: Require container workers and Firecracker guests to publish the exact remote-execution protocol during readiness, refuse missing or mismatched peers before command admission, remove identity-less legacy execution, and export the Firecracker guest protocol version for host warm-pool admission checks. Rebuild worker images, standby-pool profiles, and microVM goldens from the same release before deploying the matching host.

### Minor Changes

- 786ca01: Carry explicit Firecracker network intent on the orchestrator create request.
  `allow-all`, `deny-all`, and resolved allowlists now have distinct wire shapes;
  an absent policy keeps the legacy request unchanged.
- 786ca01: Add guest-owned pseudo-terminal and loopback TCP stream capabilities to the
  Firecracker sandbox, including lifecycle ownership and bidirectional
  backpressure.

## 11.0.0

### Patch Changes

- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
  - @namzu/sdk@38.0.0

## 10.0.0

### Patch Changes

- Updated dependencies [4d66337]
- Updated dependencies [c78fd3f]
- Updated dependencies [d045660]
- Updated dependencies [67d8438]
- Updated dependencies [c5cf4de]
- Updated dependencies [4a46cb2]
- Updated dependencies [c5cf4de]
- Updated dependencies [086ade9]
- Updated dependencies [035dcbc]
- Updated dependencies [c635b5a]
- Updated dependencies [e81a109]
- Updated dependencies [e81a109]
- Updated dependencies [2b0d90d]
- Updated dependencies [8a7a4d5]
- Updated dependencies [f370947]
- Updated dependencies [ce514f9]
- Updated dependencies [f370947]
- Updated dependencies [481b3d5]
- Updated dependencies [c78fd3f]
- Updated dependencies [d045660]
- Updated dependencies [b4408d6]
- Updated dependencies [b33dc98]
- Updated dependencies [b4408d6]
  - @namzu/sdk@37.0.0

## 9.0.0

### Major Changes

- 0662f34: Make glob scope explicit and bound filesystem discovery while it runs. Bare `*` and `*.ts` now search only the selected directory; use `**/*` or `**/*.ts` to recurse. Wildcard searches exclude hidden entries by default; set `include_hidden: true` to retain searches that previously included them inside a sandbox. Glob returns regular files only and skips symlink entries during enumeration; authorized local root aliases remain supported. Its execution deadline changes from the generic 120 seconds to 15 seconds, so large searches should use a narrower directory or pattern.

  Glob now uses the optional `Sandbox.walkFiles` capability instead of collecting a complete recursive `listFiles` inventory. Custom sandbox adapters must implement `walkFiles` to support builtin glob; unsupported adapters receive an explicit failure without a host fallback. Local, Docker, ACI and Firecracker adapters implement bounded incremental enumeration. `SandboxWalkFilesOptions` and `walkFilesViaExec` are exported for adapter authors. The sandbox package now requires the matching SDK major through its peer dependency because it imports this new runtime helper.

  Result and traversal limits produce explicit incomplete-search metadata and preserve available matches. Patterns are limited to 4,096 characters and 256 brace expansions, with consistent hidden-file matching in grouped alternatives. Sandbox search paths are resolved once, fixing duplicated absolute paths in glob, grep and ls. Runtime guidance permits direct reads of known paths, and the CLI tool label now shows both the glob pattern and directory.

### Patch Changes

- Updated dependencies [32ef6f6]
- Updated dependencies [0662f34]
- Updated dependencies [afa0712]
- Updated dependencies [32ef6f6]
- Updated dependencies [073a877]
  - @namzu/sdk@36.0.0

## 8.0.0

### Major Changes

- 47e573c: Kernel ID factories, file-lock IDs and SDK-managed Docker/ACI sandbox IDs now generate UUID v4 strings instead of prefixed random strings. Nominal TypeScript entity brands remain, but their underlying type is an opaque string rather than a prefixed template literal. Before upgrading, remove prefix parsing and prefix-only validators in consumers; use checked constructors or the new `isEntityId(value, kind)` predicate and validate ownership through store records. Public Project, Run and Message schemas accept only UUIDs while remaining Zod string schemas. External sandbox/orchestrator IDs retain their service-defined contracts.

  `InvalidIdError.expectedKind` replaces `expectedPrefix`; hosts displaying validation errors must read the entity kind instead. Built-in HTTP/webhook connector IDs and the default shell-hook plugin ID are now stable UUIDs.

  Prefixed records, including formerly accepted safe prefixes, are no longer admitted. Constructors, schemas and disk readers require UUIDs. No automatic migration or deletion is performed. Supply UUIDs for custom IDs and use a fresh dedicated application home when previous state is no longer needed. Do not downgrade UUID stores to a prefix-only reader.

  In-memory session and topic stores accept existing Project/Topic snapshots without creating replacement identities. The CLI uses this to bind delegation to the actual parent run, conversation, project and tenant. Child artifacts now live beneath the owning Project's `subagents/sessions` tree, without another generated Project layer. Scripts inspecting the old nested subagent layout must follow the new paths for new children; historical artifacts remain in place. Completed parent runs release their delegated children and bookkeeping. Tasks default to the actual invoking run instead of `run_namzu-cli`.

  CLI state selectors, session maps and transcript export require UUIDs; export skips the reserved emergency-snapshot directory. Emergency-to-checkpoint projection uses the snapshot's existing UUID. The CLI always selects the checkout-root binding, even when an older directory-specific Project exists. Historical records are left in place and are not merged. Durable `drain` now requires an authoritative persisted Session and takes its Topic from that record; checkpoint-only hosts must persist the Session metadata before draining.

## 7.2.0

### Minor Changes

- 4c31053: The coding CLI now runs sandbox-aware tools against the canonical project directory by default, and project changes survive individual turn and child-run teardown. Set `sandbox.workspace` to `ephemeral` to retain the previous disposable per-run workspace behavior.

  The SDK now honours `SandboxCreateConfig.workingDirectory` in `LocalSandboxProvider`, carries run-level sandbox workspace policy through `runAgent`, reactive, supervisor, and delegated-agent entry points, and requires providers to advertise `working-directory` support before receiving a host project path. Custom providers used with `sandbox.workspace: 'working-directory'` must add that mode to `workspaceModes`; omit the workspace mode to retain ephemeral behavior. `PipelineAgent` refuses this setting because arbitrary developer callbacks cannot be confined by the tool sandbox.

  The optional sandbox package now advertises its construction-time container and guest layouts as ephemeral-only instead of accepting a per-run host directory it cannot mount.

## 7.1.0

### Minor Changes

- 84d202d: Honor `SandboxExecOptions.signal` in the framed microVM backend through a
  reserve-before-admission and idempotent cancellation protocol. Remote execution
  now preserves streamed output and terminal signal/truncation metadata, refuses
  malformed or trailing terminal frames, and confirms process-group quiescence
  before a cancelled sandbox can be reused.

  Reject delayed or partial data after the framed terminator, route the public
  request-shaped microVM transport method through the same ownership controller,
  evict terminal history before refusing live capacity, and retire rather than
  signal a numeric process-group id after its leader exits. Teardown calls are
  coalesced and Docker retirement now reports success only when removal succeeds;
  credential-proxy cleanup still runs on removal failure.

  Reserve every command on current HTTP and framed peers, including commands
  without a caller signal. Explicitly detected older peers keep legacy no-signal
  execution; an ambiguous legacy result or unconfirmed cancellation fences the
  handle and retires the whole container, container group, or microVM.

- 8943b5b: HTTP-container sandbox commands now honour `SandboxExecOptions.signal` through
  an acknowledged execution lease and a separately bounded cancellation request.
  Rebuild local worker images and publish a new standby-pool profile revision
  before passing a signal; older workers are refused instead of leaving the
  remote command running behind an aborted request. Calls without a signal keep
  the legacy one-request protocol, and the framed microVM backend remains
  unchanged. Stalled result observation is bounded, unconfirmed termination
  retires the worker, and confirmed termination with incomplete output is
  reported distinctly.

## 7.0.0

### Major Changes

- 9709f6b: Make `readyTimeoutMs` a real worker-readiness deadline across the Docker,
  standby-container, and microVM backends. In-flight health requests, IP polling,
  connect retries, handshakes, framed reads, and retry delays now fit inside the
  remaining total budget. A readiness failure attempts remote teardown for at
  most one additional second, aborting HTTP transports and killing a held Docker
  cleanup child before returning the original readiness error.

  Docker and userspace-kernel container configs now expose and forward
  `readyTimeoutMs` and `readyPollIntervalMs`, with defaults of 30 seconds and 100
  milliseconds. Standby-container readiness now shares one timeout across IP
  publication and worker health instead of granting each phase a fresh full
  budget.

  This is a major change because zero, negative, fractional, non-finite, and
  platform-timer-overflow readiness values previously type-checked and reached
  backend work. They now fail during provider construction. Migrate those values
  to positive safe-integer milliseconds no greater than `2_147_483_647`.

### Minor Changes

- fd5fcea: Bound sandbox lifecycle ownership across run cancellation and teardown.

  Sandbox creation now receives run cancellation and the run's remaining wall-clock timeout, cannot publish a handle after either boundary wins, and releases any handle that arrives late. A setup that ignores its signal therefore settles the run with `stopReason: 'timeout'` instead of pinning it forever. Teardown receives a fresh signal and waits for 30 seconds by default without allowing an implementation that ignores cancellation to pin the run. Set `sandboxTeardownTimeoutMs: 0` on SDK runs or agents to retain the former unbounded teardown wait. Custom providers should honor `SandboxCreateConfig.signal` and `SandboxDestroyOptions.signal`; remote allocation protocols still need a client-owned reconciliation key or fleet reaper for a resource committed behind a lost response.

  The CLI exposes the same compatibility control as `sandbox.teardownTimeoutMs` and carries it to live turns, delegated child agents, and durable resumes. Children and resumed runs now use the session's sandbox provider instead of silently executing through the host boundary; set `sandbox.enabled: false` only when host execution is intentional.

## 6.1.0

### Minor Changes

- 03e363c: Declare the Node floor these packages already had, and export a type `TelemetryConfig` already required.

  **`engines.node: ">=20.0.0"`.** Only `@namzu/cli` declared one; the other fourteen published without any, so npm could not warn a consumer installing onto an unsupported runtime — they got a crash at some later import instead. The floor is not new: `@namzu/cli` has declared it since it shipped and `install.sh` has enforced it since it existed. This makes the other fourteen say the same thing.

  If you install with `engine-strict=true` on Node 18, an install that previously emitted nothing will now fail. Upgrade to Node 20 or newer, which the code already assumed. Everyone else sees no change, or an `EBADENGINE` warning that replaces a later crash.

  Worth stating plainly: CI verifies Node 22 and 24. The 20 floor is a declared minimum, not a tested one.

  **`SpanProcessorLike` is now exported from `@namzu/telemetry`.** `TelemetryConfig.spanProcessors` takes `readonly SpanProcessorLike[]`, and the type had no export — a field on the public surface whose type was not on it, so a host supplying the value had to inline the shape or reach for `any`.

## 6.0.1

### Patch Changes

- b2c005c: Make each README an npm package page rather than the package's manual.

  `@namzu/sdk`'s README was a twenty-four-section architecture tour, 45 KB of it; the others ran to several hundred lines each. That is the right shape for a single-package repository, where the README _is_ the documentation, and the wrong one here — it duplicated a `docs/` tree that already existed, and nothing checked that the two agreed.

  Each README is now what a reader needs in the first minute: what the package is, install with its Node requirement, one working example, and links. The long-form material moved into `docs/` whole — `docs/sdk/architecture.md`, `docs/cli/reference.md`, `docs/packages/<name>.md` — where the doc gates cover it.

  Two documentation defects fell out of the move, both in `@namzu/telemetry`'s session-export example, and both had been shipping: the config field is `redactors` and takes a list, not `redactor` taking one; and `secretRedactor` is a factory that has to be called. The required `destination` field was missing from the example entirely. They surfaced because a README is gated by nothing and `docs/` is compiled against the built SDK.

  No API change.

## 6.0.0

### Major Changes

- 7425f11: The sandbox worker no longer hands its own configuration to the code it contains

  Every command the agent runs was spawned with `{ ...process.env, ...body.env }` — the worker's **entire** environment, copied into every child by construction, on every call, and visible in a bare `env` in any shell transcript.

  That is a stronger exposure than "untrusted code could read `/proc/self/environ` if it thought to look". It is active propagation: the agent does not have to go looking.

  What rode along: `NAMZU_SANDBOX_WORKSPACE`, `NAMZU_SANDBOX_READ_ROOTS` and `NAMZU_SANDBOX_WRITE_ROOTS` — **the confinement layout itself, handed to the code being confined** — plus every other worker setting. The boundary announced its own shape to the thing it was drawn around.

  Variables prefixed `NAMZU_SANDBOX_` are now stripped from the inherited environment.

  **Stripping by prefix rather than by an allowlist of known-safe names is the load-bearing choice**, and it is the difference between this working and this quietly breaking egress:

  - `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are set on the container **on purpose**, so tooling inside routes through the egress boundary. An allowlist assembled from first principles drops them, and every proxied workload silently stops being proxied — which looks exactly like the policy working.
  - A host's own `options.env` arrives on the same channel and is meant to reach commands. Once both are in `process.env` it is indistinguishable from the worker's config; the prefix is the only thing that tells them apart.

  `body.env` is applied **after** the strip and is not filtered. Inheritance is implicit and gets the default; an explicit per-call value is a caller deciding, including one that deliberately sets a prefixed name.

  **What changes for you.** A command that read `NAMZU_SANDBOX_WORKSPACE`, `NAMZU_SANDBOX_READ_ROOTS` or `NAMZU_SANDBOX_WRITE_ROOTS` out of its own environment no longer sees them. Pass the value explicitly — `exec`'s `env`, or the provider's `options.env` under a name of your own — if a workload genuinely needs it. The workspace root is also the command's `cwd`, which is how most callers were getting it already.

  `major` because the environment a spawned command observes is behaviour a consumer can depend on, even though nothing in the type surface changed.

### Patch Changes

- 7aaa35d: Strings that were asserted into ids now go through the checked constructors, and three defects the assertions were hiding are fixed.

  **A docker sandbox's id had the wrong prefix.** `SandboxId` is `` `sbx_${string}` ``; `@namzu/sandbox`'s docker backend minted `sandbox_...` and an `as SandboxId` was the only reason that compiled. Every docker sandbox in the tree carried an id its own type says is impossible — the ACI backend already minted `sbx_`. Both now mint through `asSandboxId`, which is the call that would have caught it. **The container name derives from this** (`namzu-sandbox-${id}`), so a container started by this release is named differently from one an older build started. Nothing matches on the old spelling — teardown computes the name from the id it just minted, in the same process — but it is visible in `docker ps`, and any external tooling that pattern-matched `namzu-sandbox-sandbox_` needs updating.

  **A corrupt migration marker was honoured instead of refused.** `readMarker`'s shape check validated the envelope — `version`, `at`, and that `migratedThreads` is an array — and never looked inside the array. `{"migratedThreads":[null]}` therefore parsed cleanly and produced an entry whose `newProjectId` was `undefined` wearing a `ProjectId` annotation, which then reached a path join. Each element is now checked, and a bad one returns `null` — which is exactly what this function already promised to do about corruption, so the caller re-runs the migration rather than trusting it.

  **`namzu drain` accepted a mistyped scope flag.** `--tenant`, `--project` and `--session` were asserted straight into their id types, so `--tenant prj_a` reached the store and listed nothing — and "no runs" is the same output as a scope that really is empty, which made the typo invisible. Each flag is now prefix-checked, and the refusal names the prefix it wanted, in the same operator-readable shape the command's other refusals use.

  **Model-authored ids are checked before they become store keys.** `read_memory`, `task_update` and the RAG tool took an id straight from the model's tool input and asserted it. A malformed one read back as "not found", telling the model its record had disappeared rather than that it named the wrong thing. All three now refuse with `InvalidIdError`, whose message says which prefix was expected.

  Nothing here changes an exported type, a signature or a default. Sites where a cast is still correct — a value already guarded by an explicit prefix check, an id minted by a service outside this repo, a sentinel the type cannot express — keep the cast and now carry the reason next to it.

- 701bd02: Bring the worker and guest agent under the linter, and document what they already do

  `biome.json` restricted `files.include` to `src/**/*.ts` and the lint script ran `biome check src/`. Two independent exclusions of the same directories, so `worker/server.js` and `agent/agent.cjs` were checked by nothing — including the worker, which is the HTTP surface that executes commands inside the container and has no type checking either, being plain CommonJS.

  Turning it on immediately found dead code: an unused `readNdjson` helper in the worker's own test file. The rest were `useOptionalChain` rewrites in crash handlers, applied and reviewed one at a time — `err && err.stack ? err.stack : err` and `err?.stack ? err.stack : err` take the same branch for every input, including a non-`Error` throw.

  `noConsole` is off for these two directories. They are standalone processes, not modules this package imports, and stdout is their only channel: the host's readiness path and the test harness both wait on the worker's `listening on` line, and the crash handlers exist so an unhandled rejection is diagnosable rather than a silent exit. A logger abstraction would mean a dependency in files that deliberately have none. (The reason lives here and in the commit rather than beside the setting, because `biome.json` is strict JSON and rejects both comments and unknown keys.)

  Two documentation debts from earlier changes are cleared in the same pass:

  - The README's `--cap-drop=ALL` bullet carried only one of its two reasons. It also stops an `--internal` network's egress denial from being undone by a single `ip route add`, which is refused only because `NET_ADMIN` is absent.
  - The README said nothing about the environment a spawned command sees, which changed materially when the worker stopped passing on its own configuration. It now says what is stripped, what is inherited and why the proxy variables and `options.env` must be.

  No behaviour change.

## 5.0.0

### Major Changes

- a208ba8: The docker backend's default configuration could not create a sandbox, and the test that would have caught it had never run

  `create()` failed on the documented defaults — `network: 'none'`, `hostReachability: 'host-port'` — with `index of untyped nil` thrown out of a `docker inspect` template, reported as "the container exited immediately". The container was alive and well. Docker binds a published port to the container's address by NAT, so a container with no route out has no address to bind to and nothing is published; measured against Docker 29.6, `--network none --publish 127.0.0.1::2024` is _accepted_ and `NetworkSettings.Ports` comes back `{"2024/tcp":[]}`. An `--internal` network behaves the same way.

  `deny-all` had the same defect from the other side. It answered `--network none`, which reads as the strictest possible answer and removes the interface the worker is reached on — so it denied the way _in_ along with the way out, in both reachability modes.

  **Why no one noticed.** `packages/sandbox/vitest.config.ts` excludes `**/*.smoke.test.ts` from every run it governs, including the `test:smoke` run that exists to run them; naming the files as CLI arguments does not re-include them, because positional arguments filter what discovery already found. With `--passWithNoTests`, `pnpm sandbox:smoke` printed `No test files found, exiting with code 0` and the workflow went green — after building a Debian image with a browser and an office suite in it to run nothing. The suite's own fail-fast guard for a misconfigured CI could not fire either: it lives inside a file that was never loaded.

  **What changes for you.**

  - The smoke suite has its own config and no `--passWithNoTests`, so an empty run is now a failure.
  - `create()` checks the container's network against the daemon before starting anything, and refuses with the reason. **The `network` default of `'none'` is one of the pairings it refuses** — name a bridge to reach the worker by host port, or set `hostReachability: 'container-network'`.
  - `deny-all` now keeps the configured network and **requires it to be one created with `docker network create --internal`**, verified rather than trusted. That is a real boundary: outbound gets `Network unreachable` from the kernel, not from an environment variable a workload may decline to read, while sibling containers still reach the worker by name.
  - Consequently **`deny-all` over a published host port is refused as impossible**, not unsupported: a published port needs a route out and `deny-all` needs none. Closing that means moving the worker's control channel off TCP, which is tracked separately.
  - `resolveNetwork` no longer returns `'none'` for `deny-all`. `assertNetworkCarriesThePolicy` and `isInternalNetwork` are exported alongside it.

### Patch Changes

- 3e591c7: Record why the capability drop is load-bearing for egress denial

  Comment only; no behaviour change.

  `deny-all` is now enforced by the container's network being `--internal`, and it was worth measuring what that is actually worth. A container on such a network has no default route — but `ip route add default via <sibling>` is refused with `Operation not permitted` under docker's **default** capability set, before `--cap-drop=ALL` is applied at all. `NET_ADMIN` is what would lift that.

  So the internal network removes the route and the capability drop removes the ability to put one back. Both are needed, and `HARDENING_ARGS` previously justified the drop only on unrelated grounds (`CAP_DAC_OVERRIDE` walking past read-only binds) — a rationale that would survive softening the flag, while this one would not.

  Also recorded: given `NET_ADMIN` and a manually installed route, a dual-homed sibling _does_ forward the packet (`net.ipv4.ip_forward` is `1` inside a container). No connection establishes because nothing masquerades the internal subnet, but the docblock says plainly that this is not a security property — one-way egress is enough for exfiltration, and what was measured is a failed handshake, not a dropped packet.

## 4.0.0

### Major Changes

- d33bfdd: The standby-pool backend refuses to claim a container group on a public address

  Omitting `subnetId` meant the platform assigned a public address, and the backend claimed the group and dialled it without comment. The worker answering there has no authentication of any kind — `worker/server.js` states "Authn: none" in its own docblock — so an unauthenticated execute endpoint was reachable from the internet, chosen by a caller who had never heard of a field.

  The backend now refuses that combination. Two ways forward, and the error names both:

  - **`subnetId`** — inject the group into a private network. This is the production answer, and the file already recommended it.
  - **`allowPublicAddress: true`** — a new option, off by default, for a benchmark where you mean it.

  **This is `major` and it will stop a deployment that works today.** If you run this backend with no `subnetId`, the next claim throws instead of succeeding. That is deliberate: the alternative is a warning on a path that otherwise succeeds, which is read once and never again.

  The trust-model docblock used to end "Caller decides". Nothing asked them — omitting a field chose the public address silently, which is not a decision. That sentence has been corrected rather than deleted, so a reader who saw the old one learns what changed.

### Minor Changes

- 3f44f0d: A command running in a sandbox now reports progress while it runs

  Both halves of this existed and neither was connected to the other.

  Every container worker streams its output a chunk at a time — the wire has always carried `stdout_delta` and `stderr_delta` events — and every backend concatenated those chunks into a string and returned it when the process exited. Separately, `ToolContext.report` exists precisely to answer "is it still working?", is supplied per call by the executor, emits a `tool_progress` event, and is mapped onto the event stream for live consumers. It had **no caller anywhere in the tree**.

  So a command that ran for eight minutes said nothing for eight minutes, over a transport that had been reporting the whole time.

  **New:** `SandboxExecOptions.onOutput`, called as output arrives. Optional and additive — a backend that cannot stream never calls it, and `SandboxExecResult.stdout` still carries the complete output either way, so a caller that ignores it behaves exactly as before. Wired through the two container backends that carry the streaming worker protocol.

  **The `bash` builtin now uses it**, sending the last non-empty line of each chunk to `context.report`. A progress slot renders one line and replaces it, so sending a whole chunk would put a wall of text in a space that shows one line of it.

  Progress is ephemeral by design — `tool_progress` is excluded from the durable transcript so a tool reporting every file it compiles cannot write thousands of lines into the record. The model is still given `result.stdout`; this is a status signal, not a second copy of the output.

### Patch Changes

- 1cb8cc9: The package description no longer claims an authentication this proxy does not have

  `package.json#description` described the container tier as an "HTTP worker + JWT-authenticated egress proxy". The egress proxy has no inbound authentication of any kind — no token, no JWT, no check. The only occurrence of `proxy-authorization` in `src/egress/proxy.ts` is in the list of hop-by-hop headers it deletes, so the header a client would authenticate with is explicitly stripped.

  This mattered more than an ordinary comment would, because a package description is the text on the registry page — where somebody decides whether this package is safe to depend on, before they have any source to read.

  The description now says what the proxy actually is: loopback-bound, deciding by resolved address rather than by hostname, and brokering outbound credentials so a token never enters the sandbox. Those are the controls it has, and they are the ones worth knowing about.

  No behaviour changes.

## 3.0.0

### Major Changes

- cfadac7: The egress boundary now decides by resolved address, not only by hostname

  `EgressProxy` allowed or refused on the client-supplied **name**, and nothing
  in the package resolved or inspected an address. An allowlisted name whose DNS
  the caller controls — or that simply has an inward-pointing record — resolved
  to loopback, to the private network the sandbox host sits on, or to the
  link-local address cloud metadata services answer on, and the proxy connected.

  On the plain-HTTP path the brokered credential is stamped onto the outbound
  headers **before** the request goes out, so the credential-brokering design
  that is the proxy's whole reason for existing was the delivery mechanism: the
  token reached whatever the name resolved to. `BrokeredCredential.host` exists
  to stop exactly that, and it could not while its scope was a name.

  Both paths now screen the address. Refused, whatever the allowlist says:
  loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local
  (`169.254.0.0/16` — the metadata block), shared address space
  (`100.64.0.0/10`), unspecified, multicast and reserved on v4; `::1`,
  `fc00::/7`, `fe80::/10` and `ff00::/8` on v6; and a v4 address wearing a v6
  spelling in any of its forms, since a v4-only screen is a known way through
  this kind of filter.

  **This denies configurations that worked before, which is why it is major.**
  A sandbox whose allowlist names a host on a private network — a registry, an
  artifact cache, a service on the host's own LAN — starts getting `403` with a
  reason naming the address kind. That is the intended behaviour, and the remedy
  is per host:

  ```ts
  createSandboxProvider({
    backend: {
      tier: "container",
      image: "namzu/sandbox:latest",
      allowInwardFor: [".internal.example", "registry.corp"],
    },
    layout,
  });
  ```

  Matched by the allowlist's own rules, so `.internal.example` covers
  subdomains. There is deliberately no switch that turns the screen off: one
  would hand every other allowlisted name the same reach, which is the hole the
  screen exists to close. `EgressProxyOptions.allowInwardFor` is the same knob
  when constructing `EgressProxy` directly.

  One limit stated rather than implied: on the `CONNECT` path this bounds where
  the tunnel terminates and nothing more. The bytes inside it are opaque to the
  proxy, including the name the caller puts in its own TLS handshake, so a
  tunnel to an allowlisted host is not a guarantee that only allowlisted traffic
  crosses it.

## 2.0.3

### Patch Changes

- 48d9d67: Published tarballs no longer contain test files.

  `files: ["dist", "src", ...]` reads as "the build output and the sources" and
  means "everything the compiler emitted and everything in the tree", so every
  compiled test, its declaration, and both source maps shipped to the registry —
  and for the twelve packages that also ship `src`, the raw test sources went with
  them.

  Measured on the versions currently published:

  | package      | files       | of which tests | unpacked           |
  | ------------ | ----------- | -------------- | ------------------ |
  | `@namzu/sdk` | 3879 → 2239 | 1640 (42%)     | 12.73 MB → 6.81 MB |
  | `@namzu/cli` | 462 → 282   | 180 (39%)      | 1.21 MB → 0.73 MB  |

  Nothing you can import changes. Every package restricts `exports` to `"."`, so
  Node refused a deep subpath into those files already — they were weight in the
  tarball and nothing else. Hence `patch`: there is no consumer-visible surface
  here, only less to download.

  The exclusions are at the packaging layer, not the compiler. Adding `exclude`
  to `tsconfig.json` would have kept tests out of `dist` and also dropped them
  from `tsc --noEmit`, silently ending type-checking of the entire test suite —
  trading a packaging defect for a much worse one.

## 2.0.2

### Patch Changes

- ee1aa38: Remove references that pointed readers at a directory they can never open.

  Agent working memory in this repository is gitignored, and several published
  artifacts cited paths inside it. None of them resolved for anyone but the
  maintainer, and four cited session folders that no longer exist at all.

  What a consumer sees change:

  - `@namzu/sandbox` raised `Sandbox backend 'x' is not implemented yet. Track
progress in vendor/namzu/docs.local/sessions/ses_004-...` — a runtime error
    instructing the reader to open a path that is not in the package, not in the
    repository, and not on the internet. It now names what does ship instead.
  - `@namzu/computer-use`'s README linked to an adapter-pattern document under a
    directory that does not exist in any checkout. It now links to the two
    published pages that actually carry the adapter contract, the capability
    protocol, and the platform command matrix.
  - `@namzu/cli`'s README linked to a session folder on the code host that
    returns 404, to explain the doctor's protocol/runtime split. The split is now
    explained in the sentence itself.
  - `@namzu/sdk` source comments cited design documents by path. They cite the
    session by name instead, which is what the reference was ever worth.

  No API, type, or behaviour change. The `@namzu/sandbox` message text is the
  only runtime string affected, and nothing asserts on it.

## 2.0.1

### Patch Changes

- 4be54ca: Three sandbox and delegation gaps, all of the same kind: something declared,
  threaded through types, and never driven.

  **`SandboxExecOptions.signal` now works — on the backend where it can.** The
  option was declared, documented and exported, with a docstring stating that
  without it "a Stop could only ever abandon the _wait_ — the sandboxed process
  kept running after the host believed the run had been cancelled". Every
  backend dropped it, so that is exactly what happened. The local sandbox now
  merges the caller's signal with the call's own deadline and hands the result to
  `spawn`, so the child actually dies; a cancelled run is no longer reported as
  `timedOut`, because a run someone stopped did not run too long, and telling the
  model otherwise invites a retry with a bigger budget.

  The remote backends still ignore it, now explicitly and with the reason in the
  source. Their wire has no cancel op, so aborting the request would abandon the
  wait while the command kept running — the original failure, wearing the
  appearance of a fix. `SandboxExecOptions.signal` documents which backends
  honour it.

  **`ls` respects the sandbox.** It read the host through `node:fs` and named
  `context.sandbox` nowhere, in the one builtin whose whole job is telling the
  model what exists — so under a container or microVM backend the model's picture
  of the filesystem was the host's. Its paths were host-relative too, while
  `read`, `grep` and `glob` all resolve inside the sandbox, so an ls-to-read
  handoff either failed or opened a different file than the one listed. `glob`
  had the identical defect, was fixed, and its fix notes that "every sibling
  builtin already remembers this branch"; this was the sibling that did not.

  One behaviour difference worth knowing: inside a sandbox, directories are
  derived from file paths, because `listFiles` reports files. An empty directory
  is invisible there.

  **The `Agent` tool's header described a design that no longer exists.** It told
  readers to prefer `Agent` because `create_task` was a non-blocking trio driven
  by notification callbacks. `create_task` blocks and returns the worker's output
  as its own result, and `continue_task` / `cancel_task` are not registered at
  all. The two tools are separated by how much of the coordinator surface they
  bring, not by timing.

## 2.0.0

### Major Changes

- 935b8f3: **Breaking:** `@namzu/sandbox` declares only the backends it has.

  Four of the shapes this package offered could type-check and then throw: a `process` tier, a `passthrough` tier, and two adapters to third-party managed schedulers, none of which was ever written. Each demanded required configuration for a call that was never made — the `self-hosted` microvm arm went further and required three fields belonging to a local-daemon path that does not exist, while the two fields the working path needs were optional. So the only configuration that ran had to supply three values nothing reads, and omitting the two that matter compiled its way to a runtime throw.

  `SandboxTier` is now `container | microvm`. `MicroVMBackendConfig` is one shape whose `orchestratorEndpoint` and `getToken` are required. `SandboxBackendNotImplementedError` stays exported and thrown: a JS host that invents a tier gets a named refusal rather than a provider that confines nothing.

  The `sandbox.platform` health check now asks the provider what this host enforces instead of answering from a table keyed on the OS name. That table had drifted both ways — it called the Linux probe unimplemented long after the provider began probing real flags, and it told a Windows operator that sandboxing is "not supported", which is true of the in-process tier and silent about the container tier that runs there. Every non-passing result now names the missing controls and what to do about them.

  `SANDBOX_ISOLATION_CONTROLS` is exported as a value from `@namzu/sdk`. It was reachable only through `export type *`, so importing it type-checked and then failed on the first line of a built binary.

### Minor Changes

- 935b8f3: The two gaps that were deferred as needing their own design session.

  **A question raised inside a tool is now durable, and the answer reaches
  the tool that asked.** `ask_user_question` parked through the raw handler
  under a synthetic `cp_question_<toolUseId>` id that was never written
  anywhere. The checkpoint did not exist: nothing on disk said a human owed
  this run an answer, the pending-checkpoint lookup could never return it,
  and a remote host could not even _observe_ the question except through the
  in-process callback. Kill the process while somebody is looking at the card
  and the answer could never be applied — the restore path stripped the whole
  assistant turn, discarding work that sibling tools in the same batch had
  already finished, and re-billed the turn.

  The park is now a real checkpoint, with `user_question_asked` /
  `user_question_answered` on the event stream, `question.asked` /
  `question.answered` on the SSE wire, and an `input-required` A2A status —
  the same surfaces a tool-review park has always had.

  The re-entry contract was the deferred half, and it turned out to reuse
  machinery that already exists. A question checkpoint is written
  mid-execution, so it holds the assistant turn with its `tool_use` blocks
  unanswered — the same shape a tool-review park leaves. Re-executing that
  batch is _how_ the asking tool gets re-entered; a carried-answer registry
  is what makes the re-entry return the recorded answer instead of parking a
  second time; and every sibling that already completed is answered from the
  transcript by the crash-resume recovery, so nothing runs twice. An answer
  that does not name a call in this turn is refused rather than delivered to
  whichever tool now holds that slot.

  **The egress policy has a boundary to be enforced at.** Two of its four
  shapes were honourable nowhere: the container backend refused a host
  allowlist outright because it had nothing to filter through, so `deny-all`
  and `allow-all` were the whole spectrum — all or nothing.

  `EgressProxy` enforces the other two. Matching has exactly two forms —
  exact host, and `.example.com` for a domain and its subdomains — and
  substring is deliberately not one of them: `host.includes(entry)` would
  admit `example.com.attacker.net`, and plain suffix matching would admit
  `notexample.com`. A policy that cannot be read denies, because an allowlist
  that fails open is not an allowlist. A request addressed to the proxy
  itself is refused rather than forwarded — found by a test that hung instead
  of failing, which is exactly the shape that failure takes in production.

  `Sandbox.setNetworkPolicy` narrows or widens a **live** sandbox, so "clone
  with a token, then drop to deny-all before running untrusted build scripts"
  is expressible; it was not, because the policy was frozen at provider
  construction. A backend that cannot enforce it throws.

  And `brokeredCredentials` settles where the token lives. Any credential the
  agent needed to reach an allowed host had to be inside the sandbox, in the
  environment, readable by the untrusted code it is meant to be isolated from
  — via `/proc/self/environ`, or via a prompt injection that exfiltrates it
  over the very egress the policy permits. The real value is now held
  host-side and applied at the boundary, scoped per host: a credential
  attached to every request is a credential handed to whichever host the
  agent was talked into contacting.

  One limit, stated rather than hidden: a credential cannot be injected into
  a CONNECT tunnel, because reading those bytes would mean terminating TLS
  with a CA the sandbox trusts — a strictly larger risk than the one being
  mitigated. A workload that needs brokering speaks plain HTTP to the proxy
  and lets it upgrade upstream. The allowlist is enforced on CONNECT either
  way, since the target names the host in clear text.

- 935b8f3: Two blast-radius controls that were accepted and silently dropped.

  **The standby-pool backend discarded every per-sandbox control.** Its create
  function took its options parameter underscore-prefixed and never read it,
  and the request body it assembled carried no resources, no environment
  variables and no network policy — while the provider faithfully assembled
  all of them first. A host that set `deny-all` and a 512 MB cap got full
  outbound network, no memory cap and no process cap, with no error and no
  warning, from the same call shape that **is** enforced on the sibling
  container backend. Switching backends silently removed the controls.

  The claim API rejects every property override except a config map, so these
  genuinely cannot ride through per sandbox — which makes refusing the honest
  fix rather than a missing feature. It now throws, naming every field it
  cannot honour rather than the first, and saying where the limits do belong
  (the container group profile the pool is built from). namzu already held
  this norm next door, with the rationale in that backend's own comment: a
  policy accepted and quietly ignored is worse than one that is refused.

  **`allow-all` and `resolver` encoded identically on the microVM backend.**
  Both resolved to an omitted allowlist, so one encoding carried two opposite
  intentions — and the `resolve()` callback that produces a tenant-scoped list
  was never invoked anywhere in the repo. Whichever way the orchestrator reads
  an omitted field, one of the two was always mis-enforced, and the one that
  failed **open** was the one whose entire purpose is restriction.

  Each variant now has its own encoding: `allow-all` omits, `deny-all` sends
  an explicitly empty list, `static` forwards its hosts, and `resolver` calls
  `resolve()` and forwards the result — including an empty result, which is a
  real deny-all and not an absence. The switch is exhaustive, so a new variant
  fails to compile rather than falling through to unrestricted, and a resolver
  that throws propagates instead of degrading to open.

  The README's backend-by-policy table was wrong in both directions and is now
  accurate. Neither backend had a test directory; both do now.

### Patch Changes

- 935b8f3: Four defects an adversarial audit confirmed

  **A task could be created and then never found again.** `DiskTaskStore` writes under the run that created it and read only under the store's default run, so every lookup missed as soon as the two differed — the normal case, since the task tools are built with the live run id while a long-lived host constructs the store once with a fixed default. `create` succeeded, `list` succeeded, and `update`, `delete`, `claim` and every dependency link answered "not found" for a task the caller could see. The in-memory store keys by task id alone, which is why nothing caught it.

  **A sub-agent's token reservation was never returned.** The debit at spawn reserves headroom so siblings cannot each be promised the same tokens, and nothing credited back the unused part — so a pool shrank by the full allocation on every spawn no matter what the child used. At a half-pool fraction, ten delegations left a parent with a thousandth of its budget and the next spawn was refused for a budget that had barely been spent. The debit also ran before provisioning, so a spawn rejected for capacity still burned its allocation — the one state change the comment there promised would not happen.

  **A failed sandbox create leaked a proxy holding real credentials.** The egress proxy starts before the container and its only close was in `destroy()`, which a create that never returned can never reach. Every failure in between left a listening server on loopback stamping credential headers, plus a retained event-loop handle, one per retry.

  **A remembered approval could overrule the operator.** The grant check ran before the verification gate and returned, so a remembered approval skipped the gate entirely — and because a tool-scoped grant matches any arguments, approving one harmless invocation authorised every other one, past a rule written to stop exactly that. The gate now runs first, and a grant can satisfy a review but never a denial.

- 935b8f3: Stop dropping tool-failure status on Bedrock, and stop accepting a sandbox
  egress policy this backend cannot enforce.

  - **Bedrock** flattened every failed tool result into an ordinary success.
    The executor computed `isError`, the SSE and A2A bridges carried it, and
    the driver dropped it — even though Converse has a first-class
    `toolResult.status`. The model's trained tool-failure recovery path keys
    off that field, so namzu was relying on prose formatting to convey "that
    call failed".

    Scope note: the five OpenAI-shaped drivers are NOT affected, because
    Chat Completions has no error field on a tool message at all. The error
    reaches those models inside the result text, which is the only channel
    the protocol has.

  - **Docker sandbox** accepted `EgressPolicy` and silently ignored it. A
    host that set `deny-all` believed the container had no network and it had
    whatever `network` was configured. A security control that is accepted
    and ignored is worse than one that does not exist. Now: `deny-all` maps
    to `--network none` (which Docker enforces natively), `allow-all` keeps
    the configured network, and `static` / `resolver` **throw** — this
    backend has no proxy to filter hosts through, and downgrading a
    restrictive policy to "allow everything" is exactly the failure worth
    refusing.

  - **Docker sandbox** containers now run with `--cap-drop=ALL` and
    `--security-opt=no-new-privileges`, plus an opt-in `runAsUser`.
    `CAP_DAC_OVERRIDE` alone walks past the read-only bind mounts the layout
    sets up, and without `no-new-privileges` a setuid binary in the image
    re-escalates.

- 935b8f3: Five places where namzu gave up, or claimed to recover, too early.

  **A transient failure now pauses instead of failing.** A 503 that survived
  every in-turn recovery — retry with jitter, the one-shot compaction relief,
  mid-stream salvage — settled the run as `failed`, identically to a bad API
  key. The host could not tell them apart, and recovering meant knowing about
  checkpoints and driving replay itself. The state was never the problem:
  checkpoints are written every iteration by default and the failed run is
  persisted with full messages. Only the settle and the signal were missing.

  A retryable failure with a checkpoint to resume from now emits `run_paused`
  naming that checkpoint, leaves the span OK rather than ERROR, and sets
  `stopReason: 'paused'`. Both conditions are required — pausing on a
  permanent error would invite a resume that cannot work, and pausing with
  nowhere to resume from produces a run nobody can ever pick up.

  **A forced compaction pass can no longer decline to do anything.** A forced
  pass runs because the provider _rejected_ the prompt as too long, and two
  things let it treat that as advisory. It re-applied the chars/4 estimate
  after clearing stale tool results — the estimate the provider had just
  refuted — and returned early if that said the context was fine. And relief
  reported success on ANY positive shed, so clearing one short result counted
  and the retry burned a whole model call to be told the same thing. The
  early return is now force-gated, and a shed has to clear a floor (a
  fraction of the prompt, at least a couple of thousand characters) to count.

  Separately, the relief latch is per **stuck point**, not per run. It exists
  to stop a second overflow immediately after a successful compaction from
  looping; as a run-scoped flag it meant one relief at iteration 3 disarmed
  the mechanism for the rest of the run, leaving iteration 40 to die with
  obvious moves left. It is now cleared by a turn that actually succeeded.

  **An eval case can no longer hang the suite.** `executeCase` was a bare
  await, so a `run` closure that never settled blocked its worker and
  `runExperiment` never returned — no report, no partial results, nothing to
  read. `ExperimentConfig.timeoutMs` bounds a case and hands `run` an
  `AbortSignal` as a third argument; a timed-out case is reported and the
  suite continues, exactly like a case that threw, with its real elapsed time
  rather than zero. Unset means no deadline, which is today's behaviour. The
  documented path already inherits deadlines from the runtime it drives; this
  covers what those cannot see — a closure that does not go through
  `query()`, and a mid-iteration provider stall.

  **A malformed content block is named, not smuggled.** One driver built an
  image block by calling `String()` on whatever `data` and `mediaType`
  happened to be, behind only a truthiness check — so a non-string `data`
  became the literal `"[object Object]"` as the base64 payload, and the wire
  rejected the whole request with nothing naming the block at fault. That is
  reachable: a remote tool result is cast without validation on the way in.
  It now type- and media-type-guards and degrades to a named placeholder,
  matching the sibling driver that already did, and without inlining the
  payload it refused to send.

  **Failures have somewhere to grow remediation.** A stale API key surfaced
  as whatever prose the vendor SDK happened to write: no id to grep in logs,
  no instruction on what to change, and no growth point — a newly-observed
  failure shape could only be given curated copy by editing the classifier.
  `explainError` adds an ordered, id-keyed rule layer matching on
  **structural** signals (code, status, an explicit hint) rather than
  volatile vendor prose. `run_failed` carries the result as `explanation`;
  `withHint(err, '…')` lets a throw site attach what only it knows, and
  outranks every generic rule. It returns `null` when no rule claims the
  failure — inventing advice for something uncharacterised is worse than
  saying nothing, because it sends the reader somewhere specific and wrong.
  The container backend's readiness, port-mapping and worker-fetch failures
  now carry hints.

- 935b8f3: Close every open code-scanning finding

  **Breaking:** `LocalExecutionContext.executeCommand` no longer interprets its arguments as shell syntax. `shell` defaulted to `true`, and spawning with a shell re-joins the command and its argument array into a single `sh -c` string — so every metacharacter inside an argument became syntax. An `args` array reads argv-safe and was not. The default is now `false`; `shell: true` remains available where a caller genuinely wants a pipeline. A consumer passing `"ls -la"` as one command string, or relying on glob expansion without asking for a shell, must now pass `shell: true`.

  **A sandbox timeout is bounded, and an out-of-range one is refused.** The bash tool's `timeout` argument is a number the model writes, with no ceiling of its own, and it reached both sandbox transports unmodified — so a single call could pin a container or a guest for as long as the platform's timer honours. Both transports now refuse a non-finite, non-positive or over-thirty-minute request rather than clamping it: running under a deadline the caller never chose, and never learns about, is the "accepted and silently not applied" failure this codebase treats as worse than not offering the control at all.

  **Seven quadratic-backtracking regexes are now linear scans**, each on a path an attacker can reach: shell output the agent captured, a tenant-supplied connector URL, a host-supplied workspace root, a model completion, and three endpoint strings that cross the same trust boundary. The worst measured over thirty seconds on a single pathological input, on a shared event loop. Three of the seven were not flagged by the scanner — the same pattern, the same boundary — and were fixed with the rest rather than left to be rediscovered.

## 1.1.0

### Minor Changes

- ff1e013: Add an additive control-plane mTLS dial to the Firecracker backend.

  `FirecrackerBackendInternalConfig` gains an optional `controlPlaneMtls`
  (`{ ca; cert; key; servername? }`, the SAME shape as the relay's `mtls`). When
  present, the orchestrator control-plane calls — `POST /sandboxes`,
  `DELETE /sandboxes/{id}:delete` — dial over a `node:https` request that presents
  the client cert and verifies the orchestrator's server cert against the injected
  CA (`rejectUnauthorized: true`, `minVersion: TLSv1.3`), INSTEAD of the plain
  global `fetch`. This secures the control plane when `orchestratorEndpoint` is an
  `https://` URL reached over the PUBLIC internet (the non-VNet-integrated
  caller→FC-host hop), where the shared-secret bearer alone would be exposed on
  the wire.

  The change is purely additive and opt-in: with no `controlPlaneMtls` injected,
  the EXISTING plain-`fetch` control-plane path runs byte-for-byte unchanged (the
  single-host live proofs + local dev). The shared-secret bearer is still sent in
  both modes — mTLS is defense in depth on top, not a replacement. `node:https` is
  used rather than a `fetch` + undici dispatcher because the package declares no
  undici dependency; `node:https` is always importable and adds nothing. The cert
  material is injected by the consumer's runtime (mirrors `getToken` and the relay
  `mtls`), so the package still reads no keys from disk and stays Azure-SDK free.

- 208d415: Add an `mtls` arm to the Firecracker agent transport for the cross-host
  client-proxy bridge.

  `SandboxAgentHandle` gains a third variant —
  `{ kind: 'mtls'; host; port; sandboxId; tls: { ca; cert; key; servername? } }` —
  alongside the existing `unix` and `vsock` arms. When the orchestrator runs on a
  different host from the caller (the owned-fleet production path), the host-local
  `v.sock` is unreachable over the network, so the dialer instead `tls.connect()`s
  to a per-FC-host mTLS relay, writes a `SANDBOX <sandboxId>\n` preamble, and then
  runs the IDENTICAL length-framed NDJSON loop. The relay terminates mTLS and
  bridges to the jailed `v.sock` (issuing the guest `CONNECT 1024` handshake
  itself), so one inbound mTLS connection maps to one fresh local `v.sock`
  connect — preserving the resume-survival property of opening a fresh connection
  per request.

  The change is purely additive: the `unix` and `vsock` arms and all framing,
  heartbeat, and reconnect-on-resume code are byte-for-byte unchanged (single-host
  deployments keep using `vsock`). The TLS material is injected by the consumer
  (never returned by the orchestrator), keeping the package free of any key
  management.

- 74a1198: Add the owned-Firecracker microVM backend (`microvm:self-hosted`) and its
  host-side vsock transport.

  The `MicroVMBackendConfig` `self-hosted` arm gains the owned-platform seam:
  `orchestratorEndpoint` + `getToken` (the ACI `getArmToken` closure pattern, so
  the package keeps zero Azure-SDK deps) route to a new `backends/firecracker/`
  backend instead of throwing `SandboxBackendNotImplementedError`; `template`
  selects the golden snapshot revision and `agentVsockPort` /
  `readyTimeoutMs` / `readyPollIntervalMs` tune the agent dial. The legacy local
  `firecracker-containerd` shape (the three image fields alone) still throws.

  The backend is a sibling of `docker/` and `aci-standby-pool/` and a
  remote-copy backend like ACI (workspace seeded by archive-sync over the control
  channel, no host bind-mounts). It speaks the SAME NDJSON exec-stream + base64
  file-IO wire as the docker/ACI HTTP worker — only the transport differs:

  - One wire contract, factored into `backends/firecracker/protocol.ts`
    (`ExecRequest`, the `stdout_delta`/`stderr_delta`/`result`/`error` `ExecEvent`
    union, `ReadFileRequest`/`WriteFileRequest` + responses, the
    `ExecResultAccumulator` and `parseExecLine` the docker loop inlines today).
  - Two transports: HTTP for docker/ACI (UNCHANGED), and a NEW framed-over-vsock
    transport for FC (`backends/firecracker/transport.ts`), because across an FC
    snapshot resume a TCP control channel is dead-on-arrival while the vsock
    LISTEN socket survives (FC `snapshot-support.md`). Node `fetch` cannot dial
    AF_VSOCK, so the dialer, length-framing, heartbeat, and the
    reconnect-on-resume hardening (per-attempt connect/handshake timeout + retry
    budget to survive the FC #4713 `TRANSPORT_RESET`-not-delivered hang) are new.

  New public exports from `@namzu/sandbox`: `VsockAgentTransport`,
  `SandboxAgentHandle`, `VsockTransportOptions`, `FirecrackerBackendInternalConfig`,
  `OrchestratorTokenProvider`. The in-VM agent source (`agent/agent.cjs`, a vsock
  server reusing the worker spawn/jail + NDJSON shapes verbatim with the mandatory
  pre-ready entropy reseed) ships in the repo as a golden-rootfs build input,
  mirroring how `worker/server.js` is baked into the docker image — it is not a
  published runtime dependency.

### Patch Changes

- 0d1fb7b: Harden file intake and ACI readiness failure handling.

  The built-in read tool now guides Office and PDF packages through
  extractor tooling instead of treating binary document containers as
  UTF-8 text. The ACI Standby Pool backend now deletes a claimed
  container group when IP or worker readiness polling fails before a
  Sandbox handle is returned.

## 1.0.0

### Major Changes

- 8fd9349: feat(sandbox)!: Anthropic-style multi-mount container sandbox layout

  Adds a declarative `ContainerSandboxLayout` shape that maps onto
  Anthropic's container architecture (Claude container blueprint,
  Code Interpreter, "skills"). The `Container` prefix is load-bearing
  — this layout is specific to the container tier; future microVM /
  process tiers will carry their own layout types when their adapters
  land. Layout is supplied at provider construction — not per
  `provider.create()` call — so the type system catches missing-layout
  mistakes at compile time:

  ```ts
  import {
    createSandboxProvider,
    SANDBOX_DEFAULT_OUTPUTS_PATH, // re-exported from @namzu/sdk
  } from "@namzu/sandbox";

  const provider = createSandboxProvider({
    backend: { tier: "container", image: "namzu-worker:latest" },
    layout: {
      outputs: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/outputs",
        },
      },
      uploads: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/uploads",
        },
      },
      skills: [
        {
          id: "pdf-tools",
          source: { type: "hostDir", hostPath: "/opt/skills/pdf-tools" },
        },
      ],
    },
  });
  ```

  Each mount carries a discriminated `ContainerSandboxMountSource`.
  The single variant today is `{ type: 'hostDir'; hostPath: string }`;
  future variants (squashfs skill bundles, managed volumes attached
  to a container backend) land additively as minor bumps without
  reshaping the consumer call site.

  Layout fields and their defaults:

  - `outputs` — RW. Default `/mnt/user-data/outputs`. **Required**.
  - `uploads` — RO. Default `/mnt/user-data/uploads`.
  - `toolResults` — RO. Default `/mnt/user-data/tool_results`.
  - `skills` — RO list, default `/mnt/skills/<id>` per entry.
  - `transcripts` — RO. Default `/mnt/transcripts`.

  The defaults are exported as constants from `@namzu/sdk`'s root
  barrel (`SANDBOX_DEFAULT_OUTPUTS_PATH`,
  `SANDBOX_DEFAULT_UPLOADS_PATH`, `SANDBOX_DEFAULT_TOOL_RESULTS_PATH`,
  `SANDBOX_DEFAULT_TRANSCRIPTS_PATH`, `SANDBOX_DEFAULT_SKILLS_PARENT`)
  and re-exported from `@namzu/sandbox`, so prompt-template generators
  and the backend agree on a single source of truth. Both import
  paths (`@namzu/sdk` and `@namzu/sandbox`) are pinned by tests.

  There is intentionally **no `scratchpad` field**: the
  container-internal RW area (`/home/<imageUser>`) is image-bake
  responsibility, not a runtime knob.

  **Validation** runs synchronously inside `createSandboxProvider` and
  collects every violation in one
  `ContainerSandboxLayoutValidationError.reasons[]`:

  - `outputs` must be present.
  - Skill IDs match `/^[a-zA-Z0-9_.-]+$/`, and `id.includes('..')` is
    rejected (path-traversal guard — covers `..`, `foo..bar`,
    `..foo`, `foo..`). Isolated dots (`pdf-tools.v2`) pass.
  - Skill IDs are unique.
  - Resolved `containerPath`s are unique across every mount slot.

  **Error transport.** `ContainerSandboxLayoutValidationError`
  carries a `cause` field (Error native), `toJSON()` keeps `reasons`
  (and `cause` when set), and a new helper
  `serializeSandboxError(err: unknown): SerializedSandboxError`
  returns a plain object that survives `structuredClone`,
  `postMessage`, and `JSON.stringify` round-trips uniformly. The
  helper is **cycle-safe** — a `WeakSet`-threaded recursion detects
  self-cycles (`a.cause = a`), two-node cycles (`a.cause = b;
b.cause = a`), and longer loops, replacing the offending node with
  a `{ name: 'CircularReference', message: '[circular]' }` sentinel
  rather than overflowing the stack. The helper is also
  **transport-safe** — non-Error causes (Function, Symbol, BigInt,
  NaN, ±Infinity, undefined, null, primitives, plain objects) are
  converted to a typed envelope by `serializeNonErrorCause` BEFORE
  they enter the wire shape, so values that `JSON.stringify` drops
  silently or `structuredClone` throws on never appear.
  `SerializedSandboxError.cause` is strictly typed
  `SerializedSandboxError | undefined`. Use the helper at any
  worker / IPC / log-shipper boundary; cloning the Error subclass
  itself is not supported.

  **Breaking changes** — the legacy single-mount paradigm is removed:

  - `SandboxCreateConfig.hostWorkspaceDir` is removed. Pass the host
    path on `layout.outputs.source.hostPath` at provider construction.
  - `ContainerBackendConfig.workspaceMount` is removed. Pass the
    in-container path on `layout.outputs.containerPath`.
  - `SandboxProviderConfig` is now a discriminated union: the
    container variant requires `layout: ContainerSandboxLayout`, the
    other variants do not carry the field. Constructing a docker
    provider without a layout fails at compile time.
  - `SandboxCreateConfig.layout` does NOT exist; layout is
    factory-baked. The SDK runtime cannot accidentally call a
    container provider without a layout.
  - The docker backend no longer allocates host directories
    (`mkdtemp`) or removes them on `destroy()`. Every bind source is
    consumer-owned. This also fixes an `EACCES: permission denied,
mkdir '/Users'` crash that hit sibling-container deployments
    (Vandal Cowork).
  - The worker no longer reads `NAMZU_SANDBOX_LAYOUT` (it never
    branched on the env, only logged it; size grew with the skill
    list). Only `NAMZU_SANDBOX_WORKSPACE` is forwarded today.

  The reference Dockerfile pre-creates **only the parent directories**
  `/mnt`, `/mnt/user-data`, `/mnt/skills` — root-owned, mode 0555.
  Leaf paths (`outputs/`, `uploads/`, `tool_results/`, `transcripts/`,
  `<skill-id>/`) are intentionally NOT pre-created. When a bind is
  attached the docker daemon creates the leaf as the bind target;
  when not attached, the leaf does not exist — the model gets ENOENT
  instead of an empty writable dir that looks "mounted but uploaded
  nothing".

  `pnpm sandbox:smoke` (alias for `pnpm --filter @namzu/sandbox
test:smoke`) runs an opt-in docker integration test exercising the
  leaf-permission contract against a real docker daemon. Excluded
  from the default `pnpm test`; gated by a dedicated
  `.github/workflows/sandbox-smoke.yml` workflow that builds the
  reference image and runs the smoke test on PR / push when the
  sandbox surface changes. On CI (`process.env.CI === 'true'`), the
  smoke test fails fast if docker / the image are absent rather than
  silently skipping.

  `@namzu/sdk` exports `ContainerSandboxLayout`,
  `ContainerSandboxLayoutMount`, `ContainerSandboxMountSource`,
  `ContainerSandboxSkillMount`, `ResolvedContainerSandboxLayout`,
  and the five `SANDBOX_DEFAULT_*_PATH` constants from its root
  barrel. `@namzu/sandbox` re-exports those names plus
  `ContainerSandboxLayoutValidationError`, `serializeSandboxError`,
  and the `SerializedSandboxError` shape. The packed-tarball shape
  is verified by `.github/scripts/verify-consumer-install.sh`'s
  `@namzu/sandbox public-surface fixture`, which installs the
  package from a tarball into a clean project and asserts every
  documented constant + runtime export comes back via both
  `@namzu/sandbox` and `@namzu/sdk` import paths. `@namzu/sandbox`
  is also added to `ci.yml`'s `publint` and ATTW (Are The Types
  Wrong) gates.

### Minor Changes

- 04551a8: feat(sandbox): `container:docker` backend implementation

  P3.1 — first concrete backend lands. `createSandboxProvider({ backend: { tier: 'container', runtime: 'docker', image } })` now returns a working `SandboxProvider`:

  - Spawns one Docker container per `Sandbox` instance via the `docker` CLI (no node-docker SDK dep — keeps the package thin).
  - Container runs the small HTTP worker shipped under `packages/sandbox/worker/server.js`. The host adapter talks to it on `127.0.0.1:<random-port>`.
  - Worker exposes `/healthz` (liveness), `/execute` (NDJSON-streamed command run), `/read-file`, `/write-file`. All `Sandbox` interface methods route through these.
  - Container goes away on `Sandbox.destroy()` (`docker rm -f`).
  - Workspace bind-mount under `/tmp/namzu-sandbox-<id>-*` cleaned up on destroy.
  - Resource caps from `SandboxBackendOptions` map to Docker flags: `memoryLimitMb` → `--memory`, `maxProcesses` → `--pids-limit`. Default network is `none` (egress proxy plumbing is P3.2).

  Reference Dockerfile (`packages/sandbox/worker/Dockerfile`) ships with a comprehensive pre-installed toolchain so a greenfield namzu deployment "just works" against the typical agent workload:

  - **Office IO**: openpyxl, xlsxwriter, python-docx, python-pptx, pypdf, reportlab, pdfplumber, pymupdf, pdf2image, docx2pdf.
  - **Rendering**: weasyprint, pydyf, markdown, jinja2, beautifulsoup4, lxml, html5lib.
  - **Data**: pandas, polars, numpy, pyarrow, duckdb, sqlalchemy.
  - **Charting**: matplotlib, plotly, seaborn, kaleido.
  - **ML / stats**: scikit-learn, statsmodels, scipy.
  - **OCR / image**: pytesseract, Pillow, opencv-python-headless.
  - **OR / planning**: ortools, pulp, simpy, networkx, workalendar.
  - **HTTP**: requests, httpx, aiohttp.
  - **System tools**: LibreOffice, pandoc, Ghostscript, qpdf, poppler-utils, tesseract (eng+tur), ImageMagick, exiftool, optipng, jpegoptim, graphviz, Chromium (+ chromium-driver), ripgrep, jq, yq, tree, htop.
  - **Node toolchain**: `@mermaid-js/mermaid-cli`, xlsx, docx, pptxgenjs, pdf-lib, sharp, markdown-it, dompurify, jsdom.
  - **Fonts**: Noto (Latin + CJK + emoji + symbol), Liberation, DejaVu, FreeFont — Turkish-friendly.
  - **Distro**: Debian Bookworm slim, not Alpine — manylinux wheel coverage matters for the doc-gen path; compass-platform hit musl issues on the same workload.

  Hosts that want a leaner image build their own and reference it via `ContainerBackendConfig.image`. The fat default exists so the agent isn't told to use a tool that doesn't exist (the prompt-vs-runtime drift class of bugs Codex flagged repeatedly in the Vandal Cowork iterations).

  Trust model: container is the trust boundary; worker listens on loopback inside its own netns; outbound network defaults to `none` until the egress proxy lands in P3.2. Worker runs as non-root (`namzu:1001`) inside the container; host mounts `/workspace` writable to that uid.

- 663f504: feat(sandbox): new package — pluggable SandboxProvider for @namzu/sdk

  Introduces a new workspace package `@namzu/sandbox` that wraps the
  `SandboxProvider` shape `@namzu/sdk` already declares with concrete
  backends. Sandbox is intentionally split off the core SDK because:

  - Native dependencies (`bubblewrap` binary, seccomp filter generation,
    Docker SDK, parent-proxy machinery) shouldn't pollute every namzu
    consumer.
  - Anthropic itself ships their sandbox runtime as a separate package
    (`@anthropic-ai/sandbox-runtime`) for the same reason.
  - Hosts that don't need isolation (tests, trusted environments) can
    skip installing it.

  This commit is the **public-surface skeleton** — the package is
  declared, the contract is fixed, but no backend is implemented yet.
  Calling `createSandboxProvider({ backend })` throws
  `SandboxBackendNotImplementedError` for every backend tag. Backends
  arrive in subsequent commits per the
  `ses_004-native-agentic-runtime-and-sandbox` design session:

  - **P3.1** — `process` backend (Anthropic sandbox-runtime adapter).
  - **P3.2** — `EgressPolicy` plumbing with the proxy daemon.
  - **P3.3** — `container` backend (compass-platform pattern).

  The exported surface freezes:

  - `SandboxBackendKind = 'process' | 'container' | 'passthrough'`
  - `EgressPolicy` (deny-all / allow-all / static / resolver)
  - `SandboxBackend` and `SandboxBackendOptions`
  - `SandboxProviderConfig` and `createSandboxProvider`
  - `SandboxBackendNotImplementedError`

- 274bcfa: feat(sandbox)!: tiered backend taxonomy aligned with 2026 industrial standard

  Restructures the public surface from a flat backend-tag list into a
  four-tier taxonomy that mirrors how production agent platforms
  actually deploy code-execution sandboxes:

  - `process` — Claude Code-style host-process isolation
    (bubblewrap on Linux, Seatbelt on macOS, via Anthropic's
    `@anthropic-ai/sandbox-runtime`). For agents that run on the
    developer's own machine.
  - `container` — OCI container per task. Two runtime options:
    `docker` (default, universal local-dev fallback; what
    Northflank/Railway/Render/Compass-platform/GitHub Actions
    runners ship) and `runsc` (Google gVisor, trusted-tenant tier;
    what OpenAI Code Interpreter and Modal Labs ship).
  - `microvm` — Firecracker microVM per task, three concrete
    services: `e2b` (managed, ~150ms cold-start via snapshot
    restore), `fly-machines` (managed, closer to bare-metal), and
    `self-hosted` (`firecracker-containerd` on KVM-enabled Linux for
    hosts that need to own the scheduler).
  - `passthrough` — no isolation; for tests and explicitly trusted
    environments.

  Each tier carries a tier-specific config shape (discriminated union
  on `tier`); picking a tier picks the shape automatically via TS
  narrowing. Industrial precedent for every choice is cited in the
  package README:

  - Adversarial multi-tenant → Firecracker microVMs (AWS Lambda /
    Fargate, Fly Machines, Replit, E2B, Daytona — Fly's
    "Sandboxing and Workload Isolation" post and the original
    Firecracker NSDI '20 paper are the canonical refs).
  - Trusted-tenant → gVisor (GKE Sandbox, Modal, OpenAI Code
    Interpreter — `gvisor.dev/docs/architecture_guide/security` is
    the reference).
  - Single-user developer machine → bubblewrap / Seatbelt
    (Anthropic Claude Code — `anthropic-experimental/sandbox-runtime`).
  - Single-tenant or co-trusted → plain Docker + seccomp default
    profile.

  We deliberately do NOT build our own Firecracker scheduler — that
  is E2B's and Fly's entire product, and writing our own would be a
  years-long detour. The `microvm` tier adapts to theirs and
  reserves `self-hosted` for compliance/air-gap deployments.

  `EgressPolicy.resolver` is now parameterless
  (`() => Promise<string[]>`). Per Codex's stop-time review, the
  prior shape took a `EgressResolveContext` with `tenantId` /
  `runId` / `agentId` fields the SDK runtime had no way to populate,
  so the resolver context was permanently unreachable. Hosts that
  need per-tenant policies bake the tenant into the closure that
  constructs the provider — exactly how compass-platform's
  JWT-minting flow already works.

  Same reason for dropping `tenantId` / `runId` / `agentId` from
  `SandboxBackendOptions`: a contract the runtime can't fulfill is
  worse than not having it.

  **Breaking** for consumers of the still-pre-1.0 surface introduced
  in the previous skeleton commit (no implementations existed yet,
  so realistic migration cost is zero).

  Phase plan unchanged in structure but renumbered for clarity:
  P3.1 ships `container:docker` first (works locally and in any
  cloud), P3.2 the egress proxy, P3.3 the `microvm` managed adapters,
  P3.4 the `process` tier, P3.5 the adversarial-multi-tenant tier.

### Patch Changes

- 8022011: fix(sandbox): docker backend lifecycle leak + worker symlink escape

  Two issues Codex stop-time review caught on the just-shipped
  `container:docker` backend (#32):

  **HIGH — container lifecycle leak.** `spawnDockerSandbox`'s create
  path had no rollback on failure. If `docker run` succeeded but
  `/healthz` polling timed out (slow image, kernel under pressure,
  network-namespace setup hiccup), the temp workspace under `/tmp/`
  plus the running container were both orphaned. The
  `reservePort()` pattern also had a TOCTOU race: this process
  allocated a host port, closed the listening socket, then passed
  the number to `docker run --publish 127.0.0.1:PORT:…`, leaving a
  window where another process could bind the same port.

  Fixed:

  - `spawnDockerSandbox` now wraps create in `try/catch`. The catch
    arm runs `cleanupOnFailure()` which `docker rm -f`s the
    container if it started and removes `hostWorkspace` if it was
    created. Both are tracked via a flag/var captured in the outer
    scope.
  - Switched from pre-reserve-then-publish to letting Docker
    allocate via `--publish 127.0.0.1::WORKER_PORT`. The mapped
    host port is read back via `docker inspect --format
'{{(index ...).HostPort}}'`. No TOCTOU window.

  **MEDIUM — symlink escape in worker.** `resolveWithinWorkspace()`
  in the worker's `/read-file` and `/write-file` handlers checked
  the lexical path string but `fs.readFile` / `fs.writeFile`
  follow symlinks. A symlink inside `/workspace` pointing to
  `/etc/passwd` (or anywhere outside the bind-mount) bypassed the
  boundary.

  Fixed: added `realpathWithinWorkspace()` which `realpath`s both
  the workspace root and the requested target, then verifies the
  resolved real path is still inside the workspace. For writes
  where the target may not exist yet, the parent directory's
  realpath is checked instead. Both handlers now resolve through
  the new helper before touching the file.

- 63e44f7: Worker `handleExecute` no longer crashes the per-task container when a
  single request body is rejected by `resolveWithinWorkspace` (e.g. a host
  path forwarded as `cwd`) or by the workspace `mkdir`. Each fallible step
  now returns a typed `400` (or a terminal NDJSON `error` event for
  post-headers failures) and the worker stays alive for the next call —
  prior behaviour was an unhandled rejection on the `http.createServer`
  callback, which on Node ≥ 15 exits the process and gives every
  subsequent SDK call the bare `fetch failed` from `UND_ERR_SOCKET`.

  The docker backend's host-side `execViaWorker` and `writeFile` fetches
  now surface `error.cause.code` / `cause.message` instead of the
  stripped `fetch failed`. The bash builtin no longer forwards
  `context.workingDirectory` (a host-side path that has no meaning
  inside the sandbox container) as `cwd`; tools that need a sub-cwd
  inside the sandbox can be added later via an explicit
  `SandboxExecOptions` field.

  The SDK's iteration aggregator now derives
  `ChatCompletionResponse.toolCalls[i].function.arguments` from each
  bucket's parsed input rather than the raw `argsBuf` buffer. When a
  provider stream truncates with `stop_reason: "max_tokens"` mid-
  `input_json_delta`, downstream `JSON.parse` in
  `runtime/query/executor.ts:executeSingle` no longer rejects with the
  generic "Invalid JSON in tool arguments" — the tool runs against the
  empty parsed object and the input zod schema produces a readable
  "<field> is required" error instead.

- Updated dependencies [542f057]
- Updated dependencies [df09910]
- Updated dependencies [140bcc0]
- Updated dependencies [ea21863]
- Updated dependencies [38c4b62]
- Updated dependencies [265150b]
- Updated dependencies [a1c6694]
- Updated dependencies [52af97e]
- Updated dependencies [a71422a]
- Updated dependencies [d6b5bc1]
- Updated dependencies [8fd9349]
- Updated dependencies [63e44f7]
- Updated dependencies [63b4885]
- Updated dependencies [38c4b62]
- Updated dependencies [6b74cd0]
- Updated dependencies [d86b161]
  - @namzu/sdk@1.0.0
