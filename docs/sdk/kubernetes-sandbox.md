---
type: Guide
title: Kubernetes sandboxes
description: Claim VM-isolated sandboxes from an agent-sandbox warm pool on any Kubernetes cluster — the config shape, the pristine-claim rule that keeps the acquire sub-second, the per-instance agent credential, which Sandbox capabilities it serves and which it deliberately omits, the acquire-time privilege probe, the lease that keeps a long run's pod alive, persistent block-disk workspaces with suspend and resume, quiescing a guest before a capture, egress policy translation and verify-not-trust across every policy that selects the sandbox pods (including the no-network and public-internet kinds), and the default-on ingress check that refuses a sandbox whose agent port no applied policy closes.
resource: packages/sandbox/src/backends/kubernetes/index.ts
tags: [sdk, sandbox, kubernetes, kata, warm-pool]
status: draft
generated: { by: human:bahadirarda, at: 2026-09-17T00:00:00Z }
---

# Kubernetes sandboxes

`@namzu/sandbox` can acquire a sandbox from a Kubernetes cluster running the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller
(v1.0.2). Sandboxes are claimed out of a `SandboxWarmPool`, which is how the
acquire stays inside a second, and the pod runs under whatever `RuntimeClass`
the cluster's `SandboxTemplate` names — a Kata class makes the boundary a
hardware-virtualized guest rather than a namespace.

Acquire, readiness, address resolution, the execution surface, teardown,
egress translation/verification and [persistent workspaces](#persistent-workspaces)
are all implemented, and so are the cluster artifacts — the image, its
entrypoint, the manifests and the acceptance scripts — under
[`packages/sandbox/k8s/`](#deployment).

## Configure a provider

```ts
import { createSandboxProvider } from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'kubernetes',
    namespace: 'namzu-sandboxes',
    access: { inCluster: true },
    sandboxTemplateName: 'namzu-task',
    warmPoolName: 'namzu-task-pool',
  },
})
```

The tier is `microvm` because `SandboxTier` names the strength of the boundary,
not the orchestrator behind it. It is also why this backend needs no
`ContainerSandboxLayout`: like the Firecracker backend, it ships files over the
guest agent rather than bind-mounting a host directory.

`access` has two arms and no third. `{ inCluster: true }` reads the projected
ServiceAccount volume and the kubelet's `KUBERNETES_SERVICE_HOST` /
`KUBERNETES_SERVICE_PORT`, and is resolved while the provider is being built —
configuring it outside a pod fails during wiring rather than on the first
`create()`. Everything else supplies its own credential:

```ts
import { createSandboxProvider } from '@namzu/sandbox'
import type { KubernetesClusterAccess } from '@namzu/sandbox'

const access: KubernetesClusterAccess = {
  server: 'https://cluster.example:6443',
  ca: process.env.CLUSTER_CA_PEM,
  getToken: async () => await mintClusterToken(),
}

const provider = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'kubernetes',
    namespace: 'namzu-sandboxes',
    access,
    sandboxTemplateName: 'namzu-task',
    warmPoolName: 'namzu-task-pool',
    claimTtlSeconds: 1_800,
  },
})

declare function mintClusterToken(): Promise<string>
```

`getToken` is called on every API request, so a rotating token survives a
long-lived host. There is no kubeconfig support in the package and none is
planned: context merging and exec-credential plugins (`kubelogin`, `gcloud`,
`aws-iam-authenticator`) live in the host that already owns them, which is how
this package still declares no runtime dependencies at all. When `ca` is
supplied the client dials through `node:https` instead of `fetch`, for the same
reason the Firecracker backend does.

| Field | Default | Notes |
|---|---|---|
| `namespace` | — | Claims, sandboxes and pods all live here. |
| `sandboxTemplateName` | — | Read only on the pool-less path (see below). |
| `warmPoolName` | unset | Unset means every create is a cold `Sandbox`. |
| `agentPort` | `1024` | The guest agent's TCP port — same number it uses over vsock on the Firecracker tier. |
| `agentAddress` | `'service'` | Which address the agent is dialed at. `'pod-ip'` is for a host outside the cluster — see [where the host runs decides the address](#where-the-host-runs-decides-the-address). |
| `readyPollIntervalMs` | `50` | A pool bind lands in ~120 ms; a half-second poll would sleep through the budget. |
| `readyTimeoutMs` | `60000` | Whole clock from create to an addressed, Ready sandbox — and then, a second time, the budget the [privilege probe](#the-privilege-probe) may spend on the guest, capped at 15 seconds. A `create()` that goes wrong in both halves therefore takes up to this **plus** `min(this, 15s)`: 75 seconds at the default, 1 second if you set it to 500 ms. |
| `claimTtlSeconds` | `3600` | Wall-clock lifetime written into every created object, and the amount each [lease renewal](#the-lease) pushes it forward. |
| `onLeaseRenewalError` | unset | Where a failed lease renewal is reported. Changes no behaviour; see [the lease](#the-lease). |
| `runtimeClassName` | unset | Pool-less path only — see [refusals](#what-it-refuses). |
| `egress` | unset | Outbound policy this backend translates and verifies. Unset verifies nothing outbound. Setting it verifies the named object **and** every policy selecting the sandbox pods; `verify: 'named-object-only'` is the opt-out — see [Egress](#egress). |
| `ingress` | unset, **which means verify** | Whether the agent port's inbound boundary is proved before a sandbox is created. `'unverified'` is the explicit opt-out — see [Ingress](#ingress). |
| `apiRequestTimeoutMs` | `30000` | How long one API request may take, end to end. Minimum `1000`; **no value disables it** — see [the two bounds this backend sets itself](#the-two-bounds-this-backend-sets-itself). |
| `streamHeartbeatMs` | `15000` | Liveness heartbeat interval on `openTerminal` and `openTcpConnection` streams. `0` sends none, which is how every release before this one behaved. |

### Where the host runs decides the address

A sandbox has two addresses and they fail in opposite places, so the choice is
a fact about the HOST rather than about the cluster.

`agentAddress: 'service'`, the default, dials
`<sandbox>.<namespace>.svc.cluster.local` — the Sandbox's `status.serviceFQDN`.
That name outlives the pod behind it: a workspace that is suspended and
resumed comes back as a new pod with a new IP under the same name, and the
transport re-resolves the name on every call, so nothing has to be updated.
Only the cluster's own DNS answers it. **Correct exactly when the host itself
runs inside the cluster.**

`agentAddress: 'pod-ip'` dials the bound pod's IP:

```ts
import { createSandboxProvider } from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'kubernetes',
    namespace: 'namzu-sandboxes',
    access: { server: 'https://cluster.example:6443', getToken },
    sandboxTemplateName: 'namzu-task',
    warmPoolName: 'namzu-task-pool',
    agentAddress: 'pod-ip',
  },
})

declare function getToken(): Promise<string>
```

For a host **outside** the cluster: a peered VNet, an operator on a node, a CI
runner with a route to the pod network. It needs no cluster resolver at all,
and it needs two things from the deployment that `'service'` does not:

- **A pod network routable from the host.** A cluster whose pod CIDR is
  reachable only inside the cluster (an overlay with no route out, most managed
  clusters' default) cannot serve this mode, and the failure is a connect
  timeout rather than a name that does not resolve.
- **A `NetworkPolicy` admitting the host's own address range** on `agentPort`.
  The [network policy is the primary boundary](#the-agent-credential) on that
  port; a host dialing from outside the pod network is not selected by a policy
  written in terms of pods, so its range has to be admitted explicitly. Nothing
  else about the boundary changes: same per-instance bind token, same
  acquire-time [privilege probe](#the-privilege-probe), same
  [egress verification](#verify-never-trust). It needs **no new RBAC verb**:
  the pod IP is read from the pod `GET` the bind token already required.

**A pod IP dies with its pod, and the backend covers that in two places.**
The address is read from the same `GET` that reads the pod's uid — never from
the Sandbox's own `status.podIPs`, which can describe the pod a resume is
replacing — so the address and the bind token always come from one pod. Every
[resume](#resume-changes-the-address-and-the-token) re-reads both. And a dial
that fails at CONNECT (`ECONNREFUSED`, `EHOSTUNREACH`, a connect timeout) makes
the handle re-read the live pod exactly once: a different uid means the
controller replaced the pod — an eviction, a drained node — so the handle
follows the new address and the new token and the call is retried, which is
safe precisely because nothing reached the guest — the test for that is where
the failure came from, the dial, and not which `errno` it carried. A pod that
is unchanged leaves the original error standing rather than replacing it with
a second one. The re-read is worth one sentence of budgeting: a call that ends
up following a replaced pod pays for two dials, the failed one's own
connect-retry budget included, before it returns.

**`exec()` cannot read its own failure, so it watches its dials instead.**
The shared execution controller bounds a control request at 2 s by racing it
against a timer, and a dial's own connect timer is 5 s — so the failure shape
characteristic of this mode is aborted by the bound before it has failed at
all. A pod IP that has been released drops the SYN or waits out ARP rather
than refusing it, and what the caller would otherwise be handed is the bound's
bare `… reservation exceeded 2000ms`, with the dial's failure discarded rather
than wrapped: nothing left to classify, and the re-read above unreachable for
the one operation commands actually use. `exec` and `listFiles` therefore
record what their dials DID — a connect was attempted, and none of them handed
back a socket — which is the same "nothing reached the guest" guarantee read
from the other end, because the `tcp` dial resolves only on the socket's own
`connect` event. That is what the optional `VsockTransportOptions.onDialAttempt`
hook exists for; unset, as it is everywhere else, it changes nothing.

That is every operation on the [sandbox surface](#the-sandbox-surface) that
dials the guest — `exec` and `listFiles`, `readFile`, `writeFile` (a body
[written in parts](#writing-a-file-larger-than-one-frame) included, where the
retry starts a fresh sequence under a new temporary name and so cannot collide
with the abandoned one), `openTerminal` and `openTcpConnection` — and two
deliberate exceptions. A command whose cancellation the guest could not confirm
is never retried. Its outcome is unknown by definition, and re-running it
against a disk that followed the pod is exactly what "do not automatically
retry" exists to prevent. And a
[`readFileStream`](#reading-a-file-larger-than-one-frame) is rebound only
around its FIRST chunk: the retry is safe because nothing reached the guest,
and once a chunk has been handed to the caller that is no longer true — a
re-dial mid-stream would restart the file from its beginning and the consumer,
which cannot give the bytes back, would silently concatenate a duplicate
prefix.

**A pod is live before it is addressed, and that wait belongs to the readiness
budget.** A pod is created `Pending` and has no `status.podIP` until the CNI
has attached it — a window every pod passes through, and one both paths that
bind a pod see it inside: an acquire, and a resume, which binds its
replacement pod long before that pod is Ready because the Sandbox's `Ready`
condition stays True across the transition. Under `'pod-ip'` a live pod with
no address yet is therefore "not yet" rather than a refusal: the pod is
re-read until the address arrives or `readyTimeoutMs` runs out, on the same
clock as everything else on the path, and only then refused — naming the pod
that never got an address. Only an expired clock is reported that way: an API
server that fails during the wait, or a Sandbox deleted underneath it, is
reported as itself, because "the CNI never gave the pod an address" is the
wrong thing to send an operator to look at. Under `'service'` the pod is read
exactly once, as it always was; that mode needs nothing from the pod but its
uid.

**The DNS-shaped failure names itself.** A host outside the cluster left on the
default fails every call at name resolution — readiness and the privilege probe
included, so `create()` rejects on its readiness budget and used to describe a
timeout. When a dial of a Service FQDN fails with `ENOTFOUND` or `EAI_AGAIN`
the error is now a `KubernetesAgentAddressUnresolvableError` naming the FQDN,
saying that only cluster DNS answers it, and pointing at `agentAddress:
'pod-ip'`. An `ENOTFOUND` also ends the dial's connect-retry budget
immediately instead of spending it: the resolver has answered definitively
that the name is not a name here, the address came off a Sandbox that reported
Ready so its Service exists and its record is published, and re-asking the
same resolver the same question for half a minute only guarantees that the
privilege probe's own deadline expires first — which is precisely how the
diagnosis used to be replaced by a timeout. An `EAI_AGAIN` is not treated that
way: it means "temporary failure in name resolution", which inside the cluster
is a CoreDNS restart or a conntrack race, and riding over exactly that is what
the retry budget is for. It keeps the whole budget, and is still named this
way if the budget runs out.

Not live-validated against a cluster. The kind test bed's pod IPs are not
routable from the development host, which is the same condition the mode
exists for; everything above is covered by tests against a fake API server and
the real guest agent over loopback, and the in-cluster e2e runner keeps using
`'service'`.

## The two bounds this backend sets itself

Everything else on this page is bounded by something the caller passed. These
two are not, because in both cases the caller has nothing to pass.

### `apiRequestTimeoutMs` — a request the API server never answers

Every API request carries a 30-second bound of its own, on top of whatever
`AbortSignal` the caller supplied. It covers resolving the token, connecting,
and reading the reply, on both transports (`fetch` and `node:https`), and when
it expires the request rejects with `KubernetesApiTimeoutError` — a named
class carrying the verb, the resource path and the bound that expired, and
never the bearer token. A caller's own abort behaves exactly as it always did.

The bound lives in the client rather than at each call site, so it covers the
workspace verbs, the task path, and anything added later, with no wiring. It
exists because **a signal is not enough**: `signal` is optional on every one of
these calls, and several of them are *single-flight* promises that run under
whichever caller arrived first and never consult a later one's signal. A
workspace `suspend()` is one. A plain `destroy()` joins it; a `resume()` queues
behind it; and while it is in flight the handle's state is `suspending`, so
every data-plane call is already refused. One signal-less call against an API
server that accepted a request and never answered therefore pinned the whole
handle — and a host calling `destroy()` on the way out hung until it was
killed.

A timeout cannot tell whether the request was applied, and nothing here
pretends otherwise. The paths that send one already cope: `suspend()` restores
the state it saw and sends its idempotent patch again, a create `POST` that
timed out but did land is adopted through the 409 path, and a `DELETE` that had
already applied counts as done.

**There is no disabling value.** `apiRequestTimeoutMs: 0` is refused at
construction, and so is anything below `1000`. A cluster whose API server is
genuinely slower than 30 seconds raises the number; an unanswered request is
not a configuration this backend supports.

### `streamHeartbeatMs` — a stream whose peer went away

Once `openTerminal` or `openTcpConnection` reports ready, the transport clears
its read-idle timer, and that is correct: an interactive shell may sit silent
for hours and a read timer would kill a healthy one. Nothing took its place, so
a peer that vanished **without a FIN or an RST** — a lost node, a partition, a
middlebox that drops idle state — left `exited` and `closed` unresolved on the
host and the shell's process group alive in the guest until the pod stopped.

Each stream now trades a `{ "type": "heartbeat" }` frame every 15 seconds.
Three consecutive intervals with nothing at all from the other side end the
stream: on the host `exited` resolves with `exitCode: -1` (what a closed socket
already produces) and `closed` resolves; in the guest the same cleanup a closed
socket runs — SIGKILL the terminal's process group, destroy the loopback
connection. Both sides count **bytes**, so anything arriving proves the peer is
there — a heartbeat, a data frame, or part of one that is still arriving.
Silence while a side has paused reading for backpressure is not counted, in
either direction: that side chose it and the bytes are waiting in the kernel.

Each side polls at a quarter of the interval rather than at it, so a dead
stream is noticed within those three intervals plus at most one more tick —
45 seconds plus up to 3.75 more at the default. Size an operator-facing
timeout against the longer number.

**It is negotiated, per stream, and off unless both peers asked.** The open
request carries the interval; an agent that implements heartbeats echoes the
value it will use back in its `ready` event and only then starts sending, and
the host only starts once that echo arrived. That echo is a number from the
pod and the host times its own watchdog with it, so the host honours it only
between 100 ms and four times what it asked for; the agent in this repository
clamps to the same 100 ms floor before echoing, so an honest echo is never
altered. An agent built before this change ignores the unknown field and
echoes nothing, so the host behaves exactly as it does today — and, because an
older *host* ends a stream with an error on any frame type it does not know,
such a host is never sent one. The guest
advertises `stream-heartbeat` in its `healthz` `features`; the guest wire
protocol version is unchanged, so no host and no image has to roll with this.

The Firecracker tier is untouched. `VsockTransportOptions.heartbeatMs` is
undefined by default and only this backend opts in — a default on the shared
transport would force-close an existing Firecracker consumer's quiet-but-alive
terminal after 45 seconds, which is a changed default for a tier that asked for
nothing.

**What a heartbeat does and does not prove.** It proves the peer's process was
running its event loop within the last interval and that the path between the
two is still carrying bytes. It does not prove the shell is healthy, that the
disk is writable, or that a command in flight will finish — and a heartbeat that
stops is not proof that the guest is gone, only that this connection stopped
carrying frames. TCP keepalive is enabled on both ends of the routed connection
as well, but it proves strictly less: only that the peer's *kernel* answers, and
it stops at the first middlebox that terminates TCP.

## Two acquire paths

With `warmPoolName` set, `create()` POSTs a `SandboxClaim` at that pool and the
controller binds an already-running sandbox out of it. Without it, `create()`
POSTs a `Sandbox` directly. The second path is necessitated rather than
offered: `SandboxClaim.spec.warmPoolRef` is a required field, so a pool-less
claim does not exist in the API. It is also the slow path — it pays a full pod
start — and it is the only path that reads `sandboxTemplateName`, because
`Sandbox.spec` has no `templateRef` and the pod spec has to be copied across by
the client.

### The claim is pristine, and that is the whole trick

A `SandboxClaim` may carry `spec.env` and `spec.volumeClaimTemplates`. This
backend sets neither, ever. A claim that sets either is forced to cold-start
upstream instead of adopting a pool sandbox — it still works, it just stops
being fast, so nothing fails and only the latency shows it. The POSTed body is
asserted on the wire in
`backends/kubernetes/__tests__/acquire-warm-and-cold.test.ts` to contain
exactly `warmPoolRef` and `lifecycle` and nothing else — plus, when
[`claimLabels`](#a-crashed-hosts-claims-labels-release-and-capacity) is
configured, `metadata.labels`. That is the only field a caller can add to
this body at all, and it never reaches `additionalPodMetadata`: a claim's own
labels and a Sandbox's pod labels are different objects, and this backend
keeps them that way.

### The bound sandbox is not named after the claim

A pool sandbox keeps the generated name the pool gave it when a claim adopts
it; only a cold-started one takes the claim's name. The backend reads the bound
identity back out of `status.sandbox` and uses that name as the sandbox `id`,
so an id in a log line is also a `kubectl get sandbox` argument. A backend that
derived the name from its own claim would address the right pod on every cold
start and the wrong one on every warm bind.

### Nothing is left behind

Every created object carries an absolute expiry (`shutdownTime`, one hour by
default) plus `shutdownPolicy: Delete`, so a host that dies mid-run costs the
cluster one expiry instead of a leaked sandbox. `ttlSecondsAfterFinished` is
deliberately **not** used for this: upstream starts that timer from the
`Finished` condition, which a crashed host never reaches.

On top of that, every failure on the create path — a readiness deadline, an
API error mid-poll, caller cancellation — deletes the object it created on a
separate short budget before the create promise rejects. A cleanup that reports
the object already gone is treated as success.

`shutdownTime`/`claimTtlSeconds` is the **backstop**, not the recovery
mechanism: it bounds a leak by the wall clock, on a timer measured in an hour
by default, which is a long time to hold warm-pool capacity a crashed host
will never come back for. [`releaseKubernetesTaskSandboxes`](#a-crashed-hosts-claims-labels-release-and-capacity)
below is the mechanism — a restarted host can reclaim its predecessor's
claims within seconds of coming up, rather than waiting out the backstop.

### A crashed host's claims: labels, release, and capacity

A claim's own name is client-generated per acquire (`generateSandboxId()`),
so nothing about a `SandboxClaim` says which host process created it. A host
process killed by a deploy, an OOM or a lost node leaves every claim it holds
running until `claimTtlSeconds` reaps it — the backstop above — and its
replacement has no way to find, let alone release, its predecessor's claims
before then. `claimLabels`, `releaseKubernetesTaskSandboxes` and
`readKubernetesTaskCapacity` are additive surface for exactly that gap; a host
that sets none of it sees no change at all.

```ts
import {
  createSandboxProvider,
  readKubernetesTaskCapacity,
  releaseKubernetesTaskSandboxes,
} from '@namzu/sandbox'

const cluster = {
  tier: 'microvm',
  service: 'kubernetes',
  namespace: 'namzu-sandboxes',
  access: { inCluster: true },
  sandboxTemplateName: 'namzu-task',
  warmPoolName: 'namzu-task-pool',
} as const

// On startup, before admitting new work: find and release whatever a
// crashed predecessor left behind, by this host's own instance id.
const previousHostId = process.env.NAMZU_PREVIOUS_HOST_INSTANCE_ID
if (previousHostId !== undefined) {
  const { deleted } = await releaseKubernetesTaskSandboxes(cluster, {
    labelSelector: `sandbox.namzu.ai/host-instance=${previousHostId}`,
  })
  if (deleted > 0) console.log(`released ${deleted} claim(s) a crashed predecessor left running`)
}

// Every claim this process creates from here on carries its own identity.
const hostId = process.env.NAMZU_HOST_INSTANCE_ID ?? 'unknown'
const provider = createSandboxProvider({
  backend: { ...cluster, claimLabels: { 'sandbox.namzu.ai/host-instance': hostId } },
})

// Before admitting more work than the pool can currently back.
const capacity = await readKubernetesTaskCapacity(cluster)
if (capacity.activeClaims >= capacity.warmPool.desired) {
  console.log('pool is fully claimed; new work will cold-start')
}
```

| Surface | What it does | What it never does |
|---|---|---|
| `claimLabels?: Record<string, string>` (backend config) | Written onto every `SandboxClaim` this backend POSTs, `metadata.labels` only | Never reaches `additionalPodMetadata` — a running Sandbox's pod labels, and any `NetworkPolicy` selecting by them, are unaffected |
| `releaseKubernetesTaskSandboxes(config, { labelSelector, signal })` | `LIST`s claims by `labelSelector`, `DELETE`s each, returns `{ deleted, names }` | Deletes claims only — the controller's own ownerReferences take the bound Sandbox, Pod and Service down behind each one |
| `readKubernetesTaskCapacity(config, { signal })` | Three `GET`s — the named `SandboxWarmPool`, the claims collection, the pods collection — into `{ warmPool: { ready, desired }, activeClaims, pendingPods }` | No writes; requires `warmPoolName` (there is no pool to report on for a pool-less backend) |

`labelSelector` is **required** on `releaseKubernetesTaskSandboxes`, and
refused — before a single request goes out — if it is absent or empty. A
release that fell back to matching every claim, or every claim of the
template, would delete a live fleet's work the moment a caller passed one by
mistake. There is no default selector, and none is planned.

`activeClaims` counts every `SandboxClaim` in the namespace whose
`spec.warmPoolRef.name` matches the configured pool — a field the API itself
guarantees, rather than a label a caller might not have set. `pendingPods` is
every `Pod` in the namespace currently in phase `Pending`, across both the
warm and pool-less paths — a coarse signal of in-flight scale-up the
ready-replica count alone does not carry.

### What an acquire refuses with

Every refusal `create()` can diagnose arrives as a **`KubernetesAcquireError`**
(exported from `@namzu/sandbox`) carrying a `reason`, a `retryable` flag and
the original failure as its `cause`. A host deciding between "try another
cluster", "fail the run" and "page somebody" reads the field rather than
matching a message any release is free to reword.

| `reason` | What happened | `retryable` |
|---|---|---|
| `api-unreachable` | The API server could not be reached, or kept answering with a status that means *not now* — a connect failure, a 429, a 5xx | `true` |
| `api-timeout` | Requests were accepted and never answered, until [`apiRequestTimeoutMs`](#apirequesttimeoutms--a-request-the-api-server-never-answers) gave up on them | `true` |
| `forbidden` | 401 or 403. This host's ServiceAccount cannot do this — see [RBAC](#rbac) | `false` |
| `claim-rejected` | The controller **refused** the claim and said why. `controllerReason` and `controllerMessage` carry its own words | `false` |
| `capacity` | The pod exists and cannot be placed: `PodScheduled=False` with reason `Unschedulable` | `true` |
| `image-pull` | The pod was placed and its container image will not pull | `false` |
| `not-ready` | None of the above: the budget expired with the cluster reporting nothing wrong — a slow cold start, a webhook, a CNI that never attached the pod | `true` |

`retryable` describes **this acquire being worth attempting again**, not
anything having already been retried. It is not a promise: a `capacity`
refusal is retryable and stays refused until the cluster has room.

```ts
import { KubernetesAcquireError, createSandboxProvider } from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'kubernetes',
    namespace: 'namzu-sandboxes',
    access: { inCluster: true },
    sandboxTemplateName: 'namzu-task',
    warmPoolName: 'namzu-task-pool',
  },
})

try {
  await provider.create({ workingDirectory: '/workspace' })
} catch (error) {
  if (error instanceof KubernetesAcquireError && error.reason === 'claim-rejected') {
    // The controller's own diagnosis, e.g. `WarmPoolNotFound`.
    console.error(`the cluster refused the claim: ${String(error.controllerReason)}`)
  } else if (error instanceof KubernetesAcquireError && error.retryable) {
    console.warn(`transient (${error.reason}); another attempt may succeed`)
  } else {
    throw error
  }
}
```

**A refusal this list cannot honestly describe is not filed under the least
wrong reason.** A malformed template, a 400 from an admission webhook, a
controller that reported `Ready` and named no sandbox: those travel out as
themselves. Everything the API client throws is now a class too —
`KubernetesApiError` (carrying `status`, `retryAfterMs`, and a `transport` of
`'connect'` or `'status'`), `KubernetesCredentialError`,
`KubernetesAlreadyGoneError` and `KubernetesConflictError` — and all four are
exported from the package root, as are `ReadinessPollTimeout` and the three
egress refusals.

**A refused claim no longer waits out the clock.** The controller publishes its
decision as `status.conditions[Ready]` with `status: False` and a reason, and
four of those reasons mean *decided* rather than *not yet*:
`WarmPoolNotFound`, `TemplateNotFound`, `InvalidMetadata` and
`EnvVarsInjectionRejected`. Meeting one ends the acquire on the **first** read
instead of after the full `readyTimeoutMs` (60 s by default). Measured against
agent-sandbox v1.0.2 on Kubernetes v1.37.0: a claim naming a warm pool that
does not exist is refused in **233 ms** against a 60 000 ms budget, with the
claim deleted behind it. Any other reason — `DependenciesNotReady` while a cold
start runs, or a reason a future controller invents — falls through to the
deadline exactly as before. The list is a closed set of strings read off a live
controller, and an unrecognised reason is never guessed at: too few entries
costs a doomed acquire its budget, which is what every earlier release did, and
a wrong extra entry would refuse an acquire that was going to succeed.

**A transient API failure is retried, and that makes a doomed `create()`
slower.** A readiness `GET` that fails with a connect error, an
`apiRequestTimeoutMs` expiry, a 429 or a 5xx is repeated **inside the readiness
deadline**, honouring the server's `Retry-After` — which may only slow the poll
down, never speed it past `readyPollIntervalMs`. One clock: a retry spends the
budget rather than extending it, so `create()` still cannot outlive the timeout
its caller chose, but a `create()` against a failing API server that used to
reject in milliseconds now rejects after the full `readyTimeoutMs`. A host with
its own outer timeout will notice.

**The create POST is never retried.** It is not idempotent, and a POST whose
answer never arrived may already have committed — which is why cleanup deletes
the client-owned name whatever happened. Only the readiness poll repeats
anything.

**The `capacity` and `image-pull` diagnoses cost the healthy path nothing.**
They come from **one** pod `GET`, made only after the budget has already run
out and before the cleanup `DELETE` (the pod goes away with the object). A
diagnosis that cannot be made simply is not made, and the refusal keeps
`not-ready`. Nothing on the successful path reads a pod it did not read before.

**What the cluster said outranks what the failures suggest.** A saturated
cluster produces both at once — a pod nothing can schedule, and an API server
shedding load — so when a pod condition and a retried API failure both describe
one refusal, the pod condition decides. It is something the API server
published about this pod moments earlier; the retried failure is at most what
the poll was still meeting. The poll also forgets a failure it recovered from,
so a `create()` that met one 429 early and then ran out of budget on a healthy
cold start reports `not-ready`, not `api-unreachable`. Only when no diagnosis
can be made — the pod read fails too, or the pod has nothing to say — does the
API failure name the reason.

**Fail-fast belongs to the claim path.** The four terminal reasons are
`SandboxClaim` conditions, so they apply only when `warmPoolName` is set. A
directly created `Sandbox` that sits at `Ready=False` still waits out
`readyTimeoutMs` whatever reason it carries. The pod diagnosis is made on both
paths: a pool-less `Sandbox` is backed by a pod of its own name.

## The agent credential

The per-instance token the transport presents to the guest agent is the backing
pod's own `metadata.uid`. The host learns it with one `GET` after readiness;
the guest learns it through the downward API as `NAMZU_AGENT_BIND_TOKEN`. That
costs one round trip and no claim mutation, which is what keeps the claim
pristine — minting a token and injecting it as claim-level `env` would have
made every acquire a cold start.

In v1.0.2 the backing pod is named after its Sandbox, so the fast path is a
`GET` by that name. That is an observation of a released controller rather than
a documented guarantee, so a 404 there falls back to listing pods by
`Sandbox.status.selector`. A sandbox whose pod uid cannot be read at all is
refused rather than returned with no credential.

The primary boundary is still the network: a `NetworkPolicy` restricting the
agent port to the host's own pods. The bind token is defence in depth against a
co-tenant that satisfies that selector. It is **not** a boundary against the
sandbox's own workload — after deprivileging, the agent and the workload share
a uid — which is exactly why it must be per-instance and must never be a shared
secret baked into the pool's template.

That boundary is now checked rather than assumed. Until it was, nothing in this
backend confirmed a policy existed, and a deployment that skipped
`k8s/manifests/networkpolicy.yaml` ran with the port open to the whole cluster
while three pieces of shipped text said otherwise. See [Ingress](#ingress).

## The sandbox surface

`create()` returns a `Sandbox` served over the guest agent (`agent/agent.cjs`,
the same guest the Firecracker tier bakes into its golden image) on the pod
network. Every call dials a fresh TCP connection to the sandbox's
`serviceFQDN` — a name, re-resolved every time, so a pod that comes back at a
new address costs nothing extra — and presents the pod-uid bind token in the
request envelope.

| `Sandbox` member | Here | Why |
|---|---|---|
| `id` | The cluster's own name for the bound Sandbox | An id in a log line is also a `kubectl get sandbox` argument. |
| `status` | `ready` / `busy` / `destroyed` | `busy` while a command is in flight. Both ways a sandbox ends read as `destroyed` — see below. |
| `rootDir`, `environment` | The caller's working directory; `linux-namespace` | The enum is the host-facing worker shape, not the isolation technology. |
| `exec` | Implemented | Through the shared reserve-before-admission controller, so an `AbortSignal` terminates the guest process and the peer confirms it — never abandons the wait. |
| `writeFile` | Implemented | Base64 over the framed protocol, jailed to the guest workspace. A body larger than one frame is [written in parts](#writing-a-file-larger-than-one-frame). |
| `readFile` | Implemented | Base64 over the framed protocol, jailed to the guest workspace. Takes an optional `{ offset, length, signal }`; a whole-file read is served by the streamed op, so it is not bounded by one frame. See [reading a file larger than one frame](#reading-a-file-larger-than-one-frame). |
| `readFileStream` | Implemented | The same read as chunks, so neither the pod nor this process holds the file. See [reading a file larger than one frame](#reading-a-file-larger-than-one-frame). |
| `listFiles` | Implemented | `find -printf '%p\t%s\n'`, parsed line by line; a root that does not exist is an empty list. |
| `walkFiles` | Implemented | Bounded, lazy discovery through the SDK's own `walkFilesViaExec` over `exec` — see [bounded search](#bounded-search-and-the-glob-and-grep-builtins). |
| `openTerminal` | Implemented | A real PTY owned by the guest. `destroy()` kills and awaits every terminal it returned, which is what makes offering it compliant at all. Its teardown reaches [the whole session](#a-terminal-or-a-program-can-outlive-the-host-process), not only `script`'s process group. On a workspace it also takes `sessionId`/`persistent`. |
| `openTcpConnection` | Implemented | Guest loopback only. |
| `destroy` | Implemented | DELETEs the object this backend created, which cascades to the Pod, Service and Sandbox. Idempotent; an object already gone counts as released. |
| `setNetworkPolicy` | **Omitted** | Egress here is a `NetworkPolicy` attached to the pool's `SandboxTemplate`; there is no per-running-pod knob. The SDK's contract says a backend that cannot enforce one must omit it rather than accept it and quietly not apply it. |
| `spawnDetached` | **Omitted** | It returns a host `ChildProcess`, which cannot cross a process boundary, so it stays omitted rather than half-implemented. A workspace's [`startDetached`](#a-terminal-or-a-program-can-outlive-the-host-process) is the thing that does exist: it returns a NAME another host process can come back with. |

A confirmed `exec` cancellation resolves with the terminal signal/exit code
the shared `RemoteExecutionController` observed, exactly as the Firecracker
tier's own `exec` does — the same contract, the same controller, a different
transport underneath it.

**Mitigated by `tini` in the shipped image:** if a cancelled command left a
background job running (a shell `... &`), that job's process orphans on
`SIGKILL` and reparents to whatever is the container's PID 1. Without a
subreaper there — `agent.cjs` itself has no `waitpid()` for a process it
never spawned directly — the orphan is never reaped, stays a zombie
indefinitely, and `waitForGroupExit`'s liveness check can never observe the
group as gone, running the cancellation out the full cancel-confirm window
and retiring the sandbox instead of confirming. `k8s/entrypoint.sh`'s final
`exec` now runs `tini` as PID 1 (as the already-deprivileged user, with
`agent.cjs` as its child) specifically to reap that orphan and forward
`SIGTERM`, which closes this gap in the shipped image. **A host building its
own image from `agent.cjs` and `entrypoint.sh` directly, rather than from
`k8s/Dockerfile`, must keep a subreaper as PID 1 itself** — nothing on the
host can see whether an image did, which is exactly why the privilege probe
above verifies capabilities rather than trusting them, though it has no
equivalent check for a missing subreaper. Root-caused with in-cluster
`/proc` evidence in `research/k8s-sandbox/kind-e2e-results.md` ("Defect 2",
`## 2026-09-16`).

### Two ways a sandbox ends

`SandboxStatus` has four members and this backend adds none, so a destroyed
sandbox and one the cluster removed both report `destroyed`. They are told
apart by the error a later call throws:

- `KubernetesSandboxDestroyedError` — this host called `destroy()`.
- `KubernetesSandboxGoneError` — the object no longer exists on the cluster.
  Its [lease renewal](#the-lease) found it already deleted: it expired, an
  operator deleted it, or the controller reaped it.

Both name the operation that was refused, so a log line with no stack still
says which call it was.

### Writing a file larger than one frame

Because every request dials a fresh connection, each request is also that
connection's first frame — the one the guest has not authenticated yet, since
the credential rides inside the envelope. It is therefore bounded by the
guest's pre-auth frame ceiling (`NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES`,
8 MiB by default) on **every** call, not once on first use. A `write-file`
carries its whole body base64-encoded inside that one envelope, so about
5.9 MiB of raw content is all a single frame holds.

That used to be the ceiling on a **file**, and `writeFile` refused anything
above it. It is now only the ceiling on a **frame**. A body that does not fit
one is split into parts that each do:

1. The host picks a temporary **sibling** of the target —
   `.namzu-write-<uuid>-<name>.part` beside it — so the path passes the same
   workspace jail the target does and the finishing rename stays within one
   directory on one filesystem.
2. Each part is one ordinary `write-file` request whose `path` is the TEMP
   file and whose `part` object names the byte `offset` it starts at. The
   guest refuses the part unless that offset equals the temp file's current
   size, so a part that went missing, arrived twice or arrived out of order
   is refused rather than written in the wrong place.
3. The last part carries `final: true` and `renameTo: <target>`, and the
   guest finishes with an atomic `rename`.

What that buys is worth stating as guarantees, because they are what a
caller seeding a repository archive into a workspace needs:

- **A reader never sees a half-written file.** The target changes exactly
  once, in the final rename.
- **A failed write is a write that did not happen.** A sequence that dies at
  part 3 of 9 leaves the target exactly as it was, including not existing.
  That holds for a part the guest accepted and could not finish writing,
  too: a `pwrite` that crosses the volume's free space or the process's
  `RLIMIT_FSIZE` returns a SHORT count and no error at all, and renaming a
  truncated temp file onto the target would destroy the contents the rename
  exists to protect. So the guest compares both the count the syscall
  returned and the temp file's own size against what the part claimed, and
  refuses the part (`write_part_short_write`) rather than renaming — the
  case that matters is the last part, because an earlier one is caught by
  the next part's offset check.
- **An abandoned sequence cleans up after itself.** An `AbortSignal` or a
  transport failure mid-way removes the temp file and rejects. Best effort
  by design: the reason a sequence failed is often that the guest is
  unreachable, and a cleanup that threw would replace the caller's real
  error with one about tidying up. A part file left behind is named
  `.namzu-write-…` for exactly that reason. One window in a cancellation
  cannot be closed from here: a signal that fires after the final part's
  rename has landed but before its reply is read rejects the call although
  the target **was** written. Nothing can narrow that — by the time the
  rename returns the write has happened — so a caller that cancels and then
  needs to know which it got reads the target back.
- **Parts go out sequentially, on fresh connections.** That is what the
  offset check assumes, and it keeps the guest's pre-auth connection pool
  holding one of this caller's sockets at a time.

**The guest opts in.** `agent.cjs` advertises `features:
['write-file-parts']` in its `healthz` reply, and the host sends a part only
to a guest that did. An agent that predates the part protocol would ignore
the `part` field and read that part's content as a whole file, so it is
never sent one: an oversized body against such a guest still throws
`AgentPreauthFrameTooLargeError` (exported from `@namzu/sandbox`) before
dialing, and the message now names the missing feature as the reason. The
guest wire protocol version is deliberately **unchanged** — `part` is an
optional field on an op that already existed, so no host and no image has to
roll together with this release.

Two optional knobs on `VsockTransportOptions` (which
`KubernetesTransportOptions` extends) govern the host side:

| Option | Default | What it does |
|---|---|---|
| `maxWriteFileBytes` | 1 GiB | The largest body this transport accepts at all, checked before the route is chosen so it bounds a single-frame write too. Above it, `AgentWriteFileTooLargeError` names the bound. Nothing about the wire stops a caller handing over a body larger than the guest's disk; this is the bound that says no first, by a number the caller chose, rather than an out-of-memory or an `ENOSPC` halfway through a sequence. |
| `writeFilePartBytes` | the largest a frame admits | Raw bytes per part, clamped down to what one frame can carry. Setting it also lowers the size at which a body is split at all, which is how the suites exercise a multi-part write without allocating one. Leave it unset in production. |

A body that already fits one frame is unaffected by any of this: the same
single request, byte for byte, with no capability probe. `maxWriteFileBytes`
is the one thing that applies to it as well, because it bounds what a caller
may write rather than how the bytes travel — a host that sets it below one
frame's worth gets the cap it asked for.

One thing a slow link makes harder. The guest retires a connection that has
not authenticated within `NAMZU_AGENT_PREAUTH_DEADLINE_MS` (10 s from accept,
reset by nothing), and each part is its own connection carrying the
credential in the same frame — so every part has to arrive inside that
window, where a single-frame write had to arrive inside it once. On a pod
network that is never close. On a slow or congested link, a deployment that
sees parts time out lowers `writeFilePartBytes` until each part clears it; no
threshold is quoted here because none has been measured on such a link.

Nothing on the Firecracker path changed either. Its `unix`/`vsock`/`mtls`
arms authenticate nothing, so they never paid the pre-auth price and are
bounded by the guest's global frame ceiling (`NAMZU_AGENT_MAX_FRAME_BYTES`,
256 MiB) instead — a ~189 MiB file. The part protocol is the same code on
the same transport, so a body past even that is now split there too.

### Reading a file larger than one frame

The read side had the mirror-image problem, and a worse one, because nothing
about it was a refusal: it simply cost more the bigger the file got, until it
stopped working.

The old `read-file` loaded the whole file, base64-encoded it into one JSON
object and wrote that object as one frame. While the frame was being built,
the file buffer, the base64 string, the JSON string and two frame buffers all
existed at once — about **7.7x the file** in the pod, in the same container
the workload runs in. Measured here against the shipped agent over loopback
TCP (`VmHWM` of the agent's own process; under the shipped image `tini` is
PID 1, so `/proc/1` measures the init and not the agent), a 64 MiB read grew
the agent by **405 MiB**, against the workspace template's `512Mi` limit. And
a file of about **384 MiB or more could not be read at all**: its base64
string is longer than V8 lets a JavaScript string be
(`Cannot create a string longer than 0x1fffffe8 characters`).

Reads now have two shapes beside the old one, and the guest opts into both
together:

- **A slice.** `readFile(path, { offset, length })` sends `offset`/`length` on
  the same `read-file` op, and the guest `pread`s at that position instead of
  loading the file. The reply carries the **whole file's** `sizeBytes`
  alongside the slice, which is how a caller stepping through a file knows
  where it ends, and a range that runs past the end returns the bytes that
  exist rather than failing. One slice is one reply frame, so it is capped:
  above `NAMZU_AGENT_READ_FILE_RANGE_BYTES` (1 MiB by default) the guest
  **refuses** rather than shortening — a caller that asked for 4 MiB, got
  1 MiB and was told nothing would read the short answer as the end of its
  range. An `offset` with no `length` is an unbounded tail, so the host sends
  it to the stream instead.
- **A stream.** `readFileStream(path, options?)` returns an
  `AsyncIterable<Buffer>`. A new authenticated `read-file-stream` op opens the
  fd once and sends, in order, one `meta` frame carrying `sizeBytes`, then
  base64 `data` frames, then `end`, then the zero-length terminator — the same
  terminated-stream shape `execute` uses. The guest reuses one read buffer and
  waits for the socket to drain before reading the next chunk, so its peak
  stops tracking the file's size: measured over loopback, a 1 GiB read grew
  the agent by **12 MiB** at the 256 KiB default chunk. The host pauses the
  socket once 4 MiB of decoded chunks are waiting for a slow consumer, so a
  consumer that stops pulling stops the transfer rather than filling this
  process's heap with the file.

**A whole-file `readFile(path)` is built on the stream**, against a guest that
advertises the capability, so existing callers lose the ceiling without a code
change: the 384 MiB wall is gone and a 256 MiB read completes inside twice its
own size on the host. It still returns one `Buffer` — that is what the method
is — and the bytes are copied into a single allocation sized from the `meta`
frame rather than collected and concatenated, because concatenating needs
every chunk to still exist at the moment the whole is built and so costs twice
the file. A caller that must not hold even one copy iterates `readFileStream`.

**The guest opts in, and a host that does not hear it changes nothing.**
`agent.cjs` advertises `read-file-stream` in its `healthz` reply, beside
`write-file-parts`. One string covers both new shapes, because they ship in
the same file and no guest can have one without the other. Against a guest
that does not advertise it, `readFile(path)` takes the unchanged single-frame
path with its unchanged ceiling, and a ranged read or a `readFileStream`
**throws** `AgentReadFileStreamUnsupportedError` (exported from
`@namzu/sandbox`) before dialing. The refusal is the point: such an agent
ignores `offset`/`length` and answers with the whole file, and handing that
back as the caller's slice would be a wrong answer wearing the shape of a
right one. The guest wire protocol version is deliberately **unchanged** —
`offset`/`length` are optional fields on an op that already existed and
`read-file-stream` is a new op nobody is obliged to call.

Both new shapes resolve their path through the same `resolveReadablePath` +
`realpathWithinWorkspace` jail the old op used, in the same order: `..` and a
symlink that leaves the workspace are refused on all three.

**A `KubernetesWorkspace` has both too**, and that is where they matter most:
draining a large output file before a `suspend()` or a `destroy()` is the use
a long-lived workspace exists for. `readFile`'s options are forwarded to the
guest rather than dropped — a workspace that swallowed them would answer a
256-byte request with the whole file, which the SDK's contract calls a wrong
answer rather than a degraded one — and `readFileStream` is narrowed to
**present** on the interface, because the pod behind a workspace runs this
repository's agent. Both are admitted like every other data-plane call: a
suspended workspace throws `KubernetesWorkspaceSuspendedError` where the
caller wrote the call, and a workspace suspended part-way through a stream
ends the iteration with that error rather than with a bare closed socket.

Four guest details worth stating, because a whole-file read is now served by
the stream and because a slice is a shape this op never had:

- **A regular file whose `stat` reports no size** — the procfs/sysfs shape,
  which an operator reaches only by naming such a root in
  `NAMZU_SANDBOX_READ_ROOTS` — is read to EOF rather than answered as empty, on
  **both** new shapes. Its length is discoverable only by reading, so a whole
  read reads it the way the old op did and a **ranged** read reads it once to
  get a true size for the range and the reply's `sizeBytes` — otherwise every
  number a range is made of would come from the zero `stat` gave, and the
  caller would be told the file is empty. A file whose size `stat` knows is
  never materialised by either.
- **A range must ask for `base64`.** A `utf8` slice taken at an arbitrary
  offset can begin or end inside a multi-byte character, so the guest refuses
  one with `read_file_range_requires_base64`; the host only ever asks for
  base64. The whole-file shape still serves `utf8`, because its boundaries are
  the file's own.
- **The stream serves regular files only.** It refuses anything else with
  `read_file_stream_not_a_regular_file` — a directory, and also a fifo or a
  device node, which `fs.readFile` used to attempt. Inside a workspace only
  `NAMZU_SANDBOX_READ_ROOTS` can put one within reach, but a host that reads
  such a path whole against a feature-advertising guest now gets that refusal
  rather than a read that may never return.
- **A file that shrinks under the open fd fails the read.** The guest's `end`
  frame says what it sent and the `meta` frame said what it promised; the host
  compares them and rejects the call, where the single-frame path would have
  handed back whatever the file had become. Failing is the point — a truncated
  file returned as a whole one is the silent corruption a streamed read must
  not introduce.

Two guest-side knobs, both environment variables on the pod:

| Variable | Default | What it does |
|---|---|---|
| `NAMZU_AGENT_READ_FILE_RANGE_BYTES` | 1 MiB | The largest slice one ranged `read-file` may answer with. A larger range is refused, naming this variable; a whole file goes through the stream instead. Never applies to a whole-file read. |
| `NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES` | 256 KiB | Raw bytes per `data` frame. The measurement above chose the default: 1 MiB chunks held a 1 GiB read about 10 MiB above the 64 MiB it is budgeted, and the smaller chunk costs roughly 40% more wall time for a gigabyte. A deployment that would rather have the throughput raises it and pays in resident bytes. |

Two limits this does **not** remove. `request()` still reads exactly one reply
frame, which is why the single-frame path keeps its ceiling and why the stream
is a separate op rather than a bigger frame. And `exec` is still not a way to
move a large file out: its stdout deltas are UTF-8-decoded in the guest, so
raw binary is corrupted unless the caller base64-encodes it there first.

### Bounded search, and the `glob` and `grep` builtins

`walkFiles` is the method the SDK's `glob` and `grep` builtins refuse a
sandbox for not having, and both are in the default builtin set. A host that
registers them and moves from the Firecracker or docker backend to this one
used to lose both tools with no change on its own side, and the message it
got named the method rather than the fix. That is what this implements.

It adds no wire op. `walkFiles` is the SDK's own `walkFilesViaExec` running
the SDK's walk program as `node -e` inside the guest, streaming one JSONL
record per match back over an ordinary `execute` — the same enumerator the
Firecracker and docker backends use, so all three answer a search identically
for one tree. The guest image is `node:22-bookworm-slim` and the agent is
itself node, so node on the guest's `PATH` is a precondition of the agent
existing rather than a new requirement: `k8s/Dockerfile` needed no change.

It is an execution, with everything that follows from that:

- It counts as busy for the WHOLE walk — from the first entry to the last,
  never flapping between yields — because one execution is held for the
  duration rather than one per entry.
- `options.signal` and the consumer's own `iterator.return()` (breaking out of
  a `for await`) abort that execution, which sends the guest a
  `cancel-execution` and kills the walk's process group. Stopping after five
  entries leaves nothing running in the pod.
- A cancellation the guest cannot confirm retires the sandbox exactly as a
  failed `exec` cancel does. There is no second rule for walks.

On a **workspace** it passes the same admission gate every other data-plane
call passes, once, when the consumer asks for the first entry: a suspended
workspace refuses a walk exactly as it refuses `readFile` — same error class,
same `noticedBy: 'admission'`, this operation's own name — and nothing is
dialed. Admission is not re-checked per entry. A suspend that lands *during* a
walk therefore fails it the way the transport failed, and this handle learns
it was suspended elsewhere on its next data-plane call, which is where that
one-shot diagnosis lives for every operation on the handle.

An exhausted examined-entry budget raises an error carrying
`ERR_FILE_WALK_LIMIT`. It is never a short list: a caller handed six of twelve
files with no signal reads it as "that is all there is".

## Running the conformance suite

The table above is a claim about the `Sandbox` contract, and until this batch
nothing checked that claim against more than one backend. `defineSandboxConformance`
(`packages/sandbox/src/testing/sandbox-conformance.ts`) is a suite any `Sandbox`
implementation can be run against — `exec`'s exit codes and streamed output,
the `AbortSignal` contract (the process is genuinely terminated, never a
resolved result that looks like an unaborted success), a `writeFile`/`readFile`
round trip including binary content **and a body larger than one wire frame**,
`listFiles`, bounded `walkFiles` discovery (`maxEntries`, `maxDepth`,
`includeHidden`, a missing root, symlinks not followed, and
`ERR_FILE_WALK_LIMIT` on an exhausted budget), several `exec` calls at once on
one sandbox with no cross-talk between their results, an `exec` whose
`timeout` produces a timed-out result and really terminates the command,
`openTerminal` ownership on `destroy()`, `openTcpConnection` to guest loopback
and its refusal of a non-loopback host, destroy idempotence, and every call
failing once destroyed.
`openTerminal`, `openTcpConnection` and `walkFiles` are optional on the SDK's
own contract, so a factory whose sandbox omits any of them skips that section
rather than failing it.

Two further cases — a 9 MiB read (above the frame ceiling on **both** sides of
the wire, unlike the 7 MiB write case, which a reply frame is not measured
against at all) and an explicit byte range — are gated on
`supportsRangedAndStreamedReads`, and they deliberately did **not** raise
`SANDBOX_CONTRACT_VERSION` any further. Raising it for them would assert that
every backend the suite runs against implements ranged and streamed reads, and
one cannot be asserted: the Firecracker tier's guest lives in a golden rootfs
image that is **not** built from this repository — nothing here builds one,
`packages/sandbox/package.json#files` does not ship `agent/`, and the package
README documents the image as something the operator builds and canaries on
their own schedule. A deployment therefore runs whatever agent its last image
build baked in. That is the difference from the three sections that did raise
the number: none of those needs a guest feature that did not already exist.
The three suites in this repository all run `agent/agent.cjs` out of the
working tree — the two vitest ones directly, the live-cluster one through the
image `k8s/Dockerfile` copies it into — so all three set the flag `true`.
Every other backend gets the two cases as skips titled with the reason,
counted in its runner's own totals.

The `openTcpConnection` positive case starts its listener INSIDE the guest,
through `openTerminal` (`node -e`, reporting the port it bound on its own
stdout, by default) — never on the orchestrator/test process's own loopback,
which only ever proves anything for a backend whose "guest" happens to share
that loopback with the process running the suite. `guestCanRunNode` and
`guestListenerCommand`, both optional on `SandboxConformanceOptions`, let a
backend whose guest cannot run a listener that way skip the case with a
stated reason (its own title) instead of failing it, or supply its own
listener command. Confirmed against a live cluster, not only the two
loopback fixtures below: see `research/k8s-sandbox/kind-e2e-results.md`'s
2026-09-16 addendum, where the case failed with `connect ECONNREFUSED`
before this and passes now that the acquired pod is where the target
actually lives.

It ships in `@namzu/sandbox`, not `@namzu/sdk/testing` — this package has no
`testing` subpath of its own yet, and this batch does not add one. Within the
monorepo a backend's own test file imports it by relative path, the same way
`backends/kubernetes/__tests__/conformance.test.ts` and
`backends/firecracker/__tests__/conformance.test.ts` do:

```ts sketch
import { defineSandboxConformance } from '../../../testing/sandbox-conformance.js'
import { describe, expect, it } from 'vitest'

defineSandboxConformance({
  describe,
  it,
  expect,
  label: 'my-backend',
  // Called once per case — no case may depend on another's writes, aborts
  // or destroys.
  makeSandbox: async () => ({
    sandbox: await myBackend.create({ workingDirectory: someTempDir }),
    dispose: async () => {
      /* close whatever fixtures `makeSandbox` stood up */
    },
  }),
})
```

`SANDBOX_CONTRACT_VERSION` is `3`, raised from `2` by three added sections —
`walkFiles`, several `exec` calls at once on one sandbox, and an `exec` whose
`timeout` produces a timed-out result. The suite's label carries it, so a
failure names the revision it is asserting. None of the three needs a guest
feature that did not already exist: `walkFiles` is optional on `Sandbox` and
skips where a backend omits it, and `timeout`/`timedOut` have been on the
shared contract and in `agent.cjs` since protocol v2 — so raising the number
strands no already-deployed guest image.

Both shipped backends run it today, against the same kind of fixture this
page's other tests use: a real `agent/agent.cjs` on a loopback socket, no
cluster and no microVM. Worth naming about the large-body case, because
where it runs and where it bites differ: the kubernetes fixture dials the
`tcp` arm, so 7 MiB of content is past the pre-auth ceiling there and the
case genuinely exercises [the part protocol](#writing-a-file-larger-than-one-frame).
The Firecracker fixture dials a `unix` socket, which authenticates nothing
and admits a frame up to 256 MiB, so the same case passes there on the
single-frame path. It is the same `writeFile` on the same transport either
way — the Firecracker backend's own `tcp` arm, were a deployment to use one,
takes the part path from the same code the kubernetes backend does, and
`backends/kubernetes/__tests__/write-file-parts.test.ts` is what holds that
code to the contract directly. Passing against two independently-implemented
backends is the point — a suite only ever run against the backend it was
written next to is bespoke tests wearing a contract's name, not a contract.
The suite carries its own negative test
(`packages/sandbox/src/testing/__tests__/conformance-fails-a-broken-sandbox.test.ts`):
a deliberately wrong `Sandbox` that resolves `exec` after abort, that leaves a
terminal running on `destroy()`, or that hands back corrupted bytes from
`readFile`, and each must fail the suite by name.

## The privilege probe

`create()` does not resolve until the guest has REPORTED, and this backend has
checked, that it is deprivileged. Immediately after readiness, the backend runs
`cat /proc/self/status` through the sandbox's own `exec` and refuses unless
**all four** capability masks are zero and `NoNewPrivs` is 1:

```
CapInh: 0000000000000000
CapPrm: 0000000000000000
CapEff: 0000000000000000
CapBnd: 0000000000000000
NoNewPrivs: 1
```

Checking `CapEff` alone would be a true-looking answer: an ordinary
unprivileged process shows `CapEff: 0000000000000000` whether or not its
bounding set was ever dropped, so a container running as uid 0 with every
capability still available would pass. `CapBnd` is the mask that says a
capability can never be regained.

`execute` is the op used, not `read-file`: the guest resolves every read
against its workspace root and so cannot reach `/proc` at all, and widening
that to make one diagnostic work would hand every caller of `readFile` a
window into the guest's process tree.

**Every failure is a refusal**, and the error text says which kind, because a
minimal image with no `cat` on `PATH` must be diagnosable as exactly that and
not read as a hardening failure:

| Situation | `KubernetesPrivilegeProbeError.reason` | Says |
|---|---|---|
| The command could not run, or exited non-zero | `probe-failed` | "the privilege probe could not run … a diagnostic failure, not a privilege failure" |
| It ran, but the output does not parse | `unreadable-output` | which field was missing or unreadable |
| It ran, it parsed, the guest has capabilities | `privileged` | every offending mask, by name and value |

A refusal destroys the instance before `create()` rejects, so no caller ever
holds a handle to an under-hardened sandbox. **There is no configuration that
turns this off** — the value of checking on every acquire rather than once by
hand is precisely that it cannot be forgotten.

The image's entrypoint is expected to end with either
`exec setpriv --reuid --regid --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- tini -- node agent.cjs`
(a pod whose `securityContext` started its container as root) or
`exec setpriv --no-new-privs -- tini -- node agent.cjs` (a pod started
non-root, where the flags above would simply fail — `--clear-groups` needs
`CAP_SETGID`, `--bounding-set` needs `CAP_SETPCAP`, neither of which a
non-root start has). Nothing in the agent knows about either branch, and
nothing on the host can see which one ran — which is why the probe asks,
rather than assumes, either way.

### Each shipped template's `securityContext`

The two `SandboxTemplate`s this backend ships (`k8s/manifests/`) do not carry
the same shape, because only one of them ever needs root:

| Template | `securityContext` | Why |
|---|---|---|
| `sandboxtemplate-task.yaml` | `runAsUser: 1001`, `runAsGroup: 1001`, `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities: { drop: [ALL] }`, `seccompProfile: { type: RuntimeDefault }` | Sets no `NAMZU_WORKSPACE_DEVICE`, so `entrypoint.sh`'s format/mount branch never runs — the pod needs no root and no capability at any point in its life. This is the container-level shape of the Pod Security Standards `restricted` profile. The uid/gid **must** match the image's `AGENT_UID`/`AGENT_GID` (1001 as shipped). |
| `sandboxtemplate-workspace.yaml` | `privileged: true` | Names a raw block device and needs `CAP_SYS_ADMIN` to `blkid`/`mkfs.ext4`/`mount` it, as root, before `entrypoint.sh` drops every capability itself. Kubernetes runs a `privileged` container unconfined regardless of any `seccompProfile` named alongside it, so this template requests none. |

The `manifests/kind-overlay/` patches follow the same rule, not the same
template: `patch-task-no-runtimeclass.yaml` takes the task template's
restricted shape, and so does `patch-workspace-filesystem-pvc.yaml` — its PVC
is `Filesystem`-mode and mounted ready by kubelet, so it sets no device
either and starts non-root exactly like a task pod, even though it patches
the *workspace* template.

Either way, `entrypoint.sh` decides which branch to run from the container's
**actual** uid (`id -u`), not from which template it believes it is — so a
hand-edited manifest that names a device on a non-root pod is refused with a
clear message (a device without `CAP_SYS_ADMIN` cannot be formatted or
mounted; see `k8s/entrypoint.sh`) instead of silently serving an unformatted
directory.

**HOME for the guest agent and its children.** `setpriv --reuid=/--regid=` (the exec both branches end with, above) changes
only the running process's credentials — it never touches the environment —
so without an explicit export `HOME` stays whatever it was before the drop.
On the root path that is `/root`, a directory #469 already verified the
de-privileged agent uid cannot use: LibreOffice without
`-env:UserInstallation`, `pip install --user`, npm's cache, and the
fontconfig and matplotlib caches all write under `HOME` and all failed
against it. `entrypoint.sh` resolves and exports a writable `HOME` (plus
`USER`, `LOGNAME`, `XDG_CACHE_HOME` and `XDG_CONFIG_HOME`) before EITHER exec
site, and `agent.cjs`'s pre-existing `childEnvironment` — unchanged — carries
it into every `execute` and terminal child, since none of the five is
prefixed `NAMZU_AGENT_`/`NAMZU_SANDBOX_`.

Resolution order, decided once per boot and shared by both branches:

1. **`getent passwd "$AGENT_UID"` field 6.** The shipped image's own
   `useradd --create-home` (`k8s/Dockerfile`) already creates this directory
   (`/home/namzu` as built) owned by the agent uid, so this is the common
   case — and `USER`/`LOGNAME` come from the same passwd entry's login name.
   A missing `getent` (a slimmed derived image), a uid with no passwd entry,
   an entry naming a directory under `$NAMZU_WORKSPACE_ROOT`, or one this
   uid still cannot be made to own, is a **fallback trigger, not a
   failure** — the expected shape for a custom `NAMZU_AGENT_UID` or a
   stripped passwd db, not something the pod refuses to start over.
   Usability is decided by adopting the directory (`mkdir -p`, then `chown`
   it to the agent uid/gid — exactly how `$WORKSPACE_ROOT` is chowned in the
   device branch — then reading the result back), never by POSIX `-w`: on
   the root path the script is still root when it runs this check, and `-w`
   succeeds for root on a directory the agent uid cannot write to at all —
   precisely the case this exists to catch.
2. **`/tmp/namzu-home-$AGENT_UID`**, created fresh, mode `0700`, owned by
   the agent uid, with `USER`/`LOGNAME` set to `namzu`. Deliberately never
   under `$NAMZU_WORKSPACE_ROOT` — a home there would appear in every
   `listFiles`/`walkFiles` call and every archive the workspace produces.

Only if both fail does the pod refuse to start — nothing past that point
works without a writable `HOME` anyway. `getent` itself is deliberately NOT
among the tools `entrypoint.sh` requires up front: its absence describes a
slimmed derived image, not a broken one.

**A derived image that changes `AGENT_UID`** (or `NODE_VERSION`, or anything
else upstream of the base image's own user database) must either ship a
passwd entry for that uid naming a directory it can own, or accept the
`/tmp` fallback — both are handled the same way, automatically. A derived
image that depended on `HOME=/root` (the only thing running as root before
this fix could have relied on) must set `HOME` itself after its own
`FROM`, since the entrypoint's resolution now runs unconditionally on every
boot and always wins.

`k8s/scripts/capability-check.mjs` prints `$HOME`, whether it exists, and
whether a probe write succeeded, in the same informational style as the
`Seccomp` line and the set-id file count above: printed and counted, never
failing the check itself.

**Seccomp on a VM runtime.** `sandboxtemplate-task.yaml`'s `RuntimeDefault`
profile is a REQUEST, not a guarantee that the guest kernel enforces it: under
a Kata `RuntimeClass`, whether a profile reaches the guest depends on the
runtime's own configuration (Kata's `disable_guest_seccomp`, for one). A
guest reporting `Seccomp: 0` in `/proc/self/status` (what
`k8s/scripts/capability-check.mjs` prints, alongside the capability masks) is
therefore not on its own evidence the profile was ignored — check the
runtime's configuration before concluding that. The privilege probe reads
only the four capability masks and `NoNewPrivs`, deliberately: refusing on
`Seccomp: 0` would reject clusters the VM boundary already isolates, for a
value the probe cannot attribute to "misconfigured template" versus
"runtime doesn't map this through" from inside the guest alone.

What it is **not**: a boundary against a hostile guest. The probe asks the
agent to report its own `/proc/self/status`, so an agent that has already been
compromised can answer with zeros. It catches the failure that actually
happens — an image built from an older entrypoint, a `RuntimeClass` change, a
hand-edited `SandboxTemplate`, all of which produce a sandbox that works
perfectly and is not deprivileged. The boundary itself is the VM and the
`NetworkPolicy`.

### The probe runs on a clock

A pod whose agent has wedged — out of memory, an event loop the workload
blocked — still accepts the TCP connection and then says nothing, which is an
ordinary cluster event rather than an exotic one. The probe therefore has a
deadline of its own: `min(readyTimeoutMs, 15s)`, because `readyTimeoutMs` has
already expired bounding the control plane by the time the probe starts, and
because the number the caller chose to describe an acquire is the right size
for one `cat` of a pseudo-file. An expiry is a refusal like any other — the
instance is destroyed, `create()` rejects with a `probe-failed`
`KubernetesPrivilegeProbeError` — and it says the guest did not answer, rather
than blaming a `cat` that is not missing. Without it the probe would inherit
the execution controller's generic defaults (a five-minute observation, then a
cancel-confirm and a drain) and a one-minute acquire budget would become a
six-minute hang.

## The lease

The absolute `shutdownTime` acquire stamps is the leak guard, and unrenewed
it is also a deadline on the RUN: a session outliving `claimTtlSeconds` would
have its pod deleted underneath it, mid command, with nothing to attribute the
failure to. So the handle renews its own lease.

Every half TTL (jittered ±10%, so a fleet acquired in the same second does not
PATCH in lockstep) the handle merge-PATCHes the expiry a full TTL into the
future — `spec.lifecycle.shutdownTime` on a claim, `spec.shutdownTime` on a
directly created Sandbox. `shutdownPolicy: Delete` is untouched: it is a merge
patch, and only the expiry moves.

- `destroy()` stops the loop, so a released sandbox stops being renewed.
- A failed renewal is **reported to `onLeaseRenewalError` and retried on a
  capped exponential backoff** — one second, doubling, capped at whichever is
  smaller of thirty seconds or a twentieth of the TTL — not on the next
  half-TTL tick. Waiting a full half-TTL to retry a failure would make one
  blip at the wrong moment a coin flip against the object's own
  `shutdownTime`, since both land roughly a TTL after the last success; the
  short backoff instead gets many attempts inside the window that actually
  matters. A success resets the backoff and returns the loop to the normal
  half-TTL cadence. A transient API error does not retire a working sandbox.
  (`@namzu/sandbox` owns no logger and reads none from module scope, which is
  why the diagnostic is handed to the host rather than printed.)
- **Each PATCH runs under its own deadline** — a quarter of the interval,
  capped at 30 seconds — and an expiry is reported and retried like any other
  failure. A renewal that HANGS, rather than fails, is the one outcome the
  loop could not otherwise survive: the next tick is scheduled only after the
  current one settles, so an API server that accepts the connection and never
  answers would park the loop forever and let the lease expire in silence.
- A renewal that finds the object already deleted (404/410) stops the loop and
  marks the handle gone; every later call throws
  `KubernetesSandboxGoneError`.
- The timer is `unref`'d, so a host process that has finished its work exits
  instead of lingering behind a handle nobody destroyed, and the sandbox then
  expires on the cluster's clock. Note what that does **not** cover: inside a
  host that keeps running — a server, say — a handle that is dropped without
  `destroy()` keeps its closure and its timer alive and renews the object
  indefinitely. `destroy()` is load-bearing for cleanup in a way it was not
  before the lease existed.

This is what makes `patch` on `sandboxclaims`/`sandboxes` a required RBAC
verb — see [RBAC](#rbac).

## Persistent workspaces

A task sandbox is claimed, used and deleted inside one run. A **workspace** is
the other object: created once under a name the caller chooses, suspended when
nobody is using it, resumed days later with yesterday's dependency cache still
on its disk, and deleted only when someone says so.

```ts
import { createKubernetesWorkspace } from '@namzu/sandbox'

const workspace = await createKubernetesWorkspace(
  {
    tier: 'microvm',
    service: 'kubernetes',
    namespace: 'namzu-sandboxes',
    access: { inCluster: true },
    // A workspace template: a podTemplate PLUS a block-mode disk.
    sandboxTemplateName: 'namzu-workspace',
  },
  { workspaceId: 'acme-checkout-7', workingDirectory: '/workspace' },
)

await workspace.exec('pnpm', ['install'])
await workspace.suspend() // the pod goes away; the disk does not
await workspace.resume() // a new pod, a new address, a new agent token
await workspace.destroy() // suspends — the disk survives
await workspace.destroy({ deleteDisk: true }) // deletes the Sandbox and the disk
```

`createKubernetesWorkspace` returns a `KubernetesWorkspace`: the SDK's
`Sandbox`, plus `suspend()`, `resume()`, `refresh()`, a `suspended` flag, the
[`templateRevision`/`templateCurrent`](#a-resume-can-bring-the-current-pod-template-with-it)
pair that says whether it is still on the template it was built from, and a
`destroy()` that takes `deleteDisk`. Listing, deleting and suspending a
workspace [without opening one](#managing-workspaces-without-waking-them) are
verbs of their own, because none of them needs a guest. Those live on a type exported from `@namzu/sandbox`
and **not** on the SDK's `Sandbox` — they are backend capabilities, and
putting them on the shared contract would make every other backend answer for
a lifecycle it does not have.

It is a separate verb from `createSandboxProvider` on purpose: a
`SandboxProvider` promises an ephemeral sandbox per run
(`workspaceModes: ['ephemeral']`), and a workspace is the opposite promise.
`warmPoolName` is ignored here.

### Calling it twice reattaches

The Sandbox is named `namzu-ws-<workspaceId>`, deterministically, which is the
only way a second host process — or the same one tomorrow — finds the
workspace again. A create that collides with an existing object of that name
adopts it (and resumes it, if it was suspended) rather than failing.

A `workspaceId` that is not already a legal DNS-1123 label is **refused**
rather than lowercased, stripped or hashed: sanitising maps two ids onto one
name, and two callers who believe they have separate workspaces would be
sharing one disk.

**What is adopted is checked against the configuration, not against the
caller's intention.** A create POSTs its own body and knows what is in it; an
adopt is handed an object whose shape another process — or last month's
config — decided. Three things about it have to agree before it is woken:

| Checked on the standing object | Refused with |
|---|---|
| A block disk, claimed through `volumeDevices`, exactly as on a template | `KubernetesWorkspaceDiskError` |
| `spec.podTemplate.metadata.labels['sandbox.namzu.ai/template']` is the template this call builds from | `KubernetesWorkspaceMismatchError`, `field: 'sandboxTemplateName'` |
| `spec.podTemplate.spec.runtimeClassName` is the configured `runtimeClassName`, when one is configured | `KubernetesWorkspaceMismatchError`, `field: 'runtimeClassName'` |

The label check runs whether or not `config.egress` is set, because that label
is what an [egress policy](#egress-covers-a-workspace-too)'s `podSelector`
matches: adopting an object built from another template would hand back a pod
the policy this call just verified does not select, having reported the
boundary as verified. The RuntimeClass check is there because that is the VM
boundary and nothing downstream can watch it go missing — the [privilege
probe](#the-privilege-probe) reads `/proc/self/status` inside the guest and
passes identically under a Kata class and under `runc`.

Neither is repaired by patching the standing object. Its disk may hold a month
of the caller's files, and rewriting a live workspace's `podTemplate` to fit a
new configuration is a larger decision than reattaching to it, so the error
names the two honest exits instead: point the workspace at the template it was
built from, or delete the `Sandbox` — which takes its disk with it — and
create it again.

That stays true by default, and a caller who has decided to make it now says
so explicitly: `createKubernetesWorkspace(config, { refreshPodTemplate: true })`
rewrites `spec.podTemplate` on a workspace it finds **suspended**, in the same
patch that wakes it, and keeps the disk — see [a resume can bring the current
pod template with it](#a-resume-can-bring-the-current-pod-template-with-it).
The `runtimeClassName` row above is the one refusal that option lifts, and
only for a call whose patch actually lands, because that patch is what writes
the configured class. The template row is never lifted: a refresh rewrites a
workspace's pod spec, it never moves the workspace to another template.

**What lifting that row means, said plainly:** with `refreshPodTemplate`, a
workspace can be moved between runtimes by an edit — to `config` or to the
template — with nothing refusing it. The check above exists because the
RuntimeClass is the VM boundary and the privilege probe passes identically on
either side of it; a refresh replaces the refusal with an explicit decision,
and the decision is the caller's. A deployment that must never drop to a
shared kernel should pin `runtimeClassName` in `config` — the overlay writes
that value over whatever the template says — and treat a change to it as the
boundary change it is.

**A workspace id is a name, not a lock — unless you give it one.** Nothing
stops two host processes from adopting the same running workspace; each gets
its own handle over the same pod, and either one's `destroy()` suspends the
pod the other is executing in. Deciding which process may do that is the
host's, and always was — what this backend adds is a way to make that decision
*stick* on the cluster, so the write a superseded process sends is refused
rather than applied. That is the [holder
epoch](#a-holder-epoch-fences-every-lifecycle-write), and it is opt-in: a call
that passes none sends exactly the requests it always sent. Independently of
it, a handle can [find out](#a-handle-notices-a-suspend-it-did-not-perform)
that somebody else suspended its workspace, rather than reporting
`suspended: false` over a pod that is gone.

**An adopt can land mid-transition, and waits rather than failing.** The
second process to reach a workspace arrives at a moment the first one did not
choose:

- a `suspend()` that ended in `KubernetesWorkspaceSuspendTimeoutError` — the
  patch landed and the guest is riding out its
  `terminationGracePeriodSeconds`;
- two host processes coming up on one workspace during a rollout;
- a host restarting inside the previous pod's termination grace period.

In each of those the only pod standing under the name carries a
`deletionTimestamp`, which is never bound to — its uid is the agent's bind
token, and the pod's replacement refuses it — and that replacement has not
been created yet. So an adopt that finds the object `Suspended`, **or** finds
its pod already terminating, polls for the new pod under the same
`readyTimeoutMs` budget the [resume path](#resume-changes-the-address-and-the-token)
polls under, and binds it when it appears. A budget that runs out names the
pod that was still terminating instead of reporting a generic missing uid.

An adopt of an object that was Running with a healthy pod behaves as a create
does: nothing is being replaced, so a pod that cannot be read is reported at
once rather than waited out for the whole budget.

**`origin` says how the handle was obtained**, because the two adopted values
mean a pod this process did not start:

| `origin` | What the call found | What is still there |
|---|---|---|
| `created` | Nothing of that name; it POSTed the `Sandbox` | Nothing — a fresh pod and an empty disk |
| `adopted-running` | An object of that name already `Running` | The disk, and whatever is still running inside the pod — but no terminal |
| `resumed` | An object of that name `Suspended`; it patched back to `Running` | The disk only: the pod is brand new |

No terminal survives either adopted value. The guest agent kills a terminal's
process group the moment its connection closes, and a dead host's connections
closed with it — so a host reattaching to a workspace another process left
running gets a pod whose background work may still be going and whose
interactive sessions are all gone. A detached command started with `exec` is
the part that can outlive its host.

`origin` is fixed for the handle's life. It answers what this call walked
into, not what state the workspace is in now, which is what `suspended` is
for; a later `suspend()`/`resume()` cycle does not rewrite it.

### The disk is fixed at creation, and must be `Block`

`Sandbox.spec.volumeClaimTemplates` is CEL-immutable ("volumeClaimTemplates is
immutable"), and a `SandboxClaim` carrying `spec.volumeClaimTemplates` is
forced to cold-start instead of adopting a pool sandbox. So the disk has to be
in the spec from creation, a workspace is always a `Sandbox` POSTed directly,
and the appealing middle road — claim a warm diskless sandbox and attach a
disk to it later — **is not expressible in this API at all**. Resizing is out
of scope for the same reason.

The `SandboxTemplate` a workspace is built from must declare at least one
`volumeClaimTemplates` entry, every entry must be `volumeMode: Block`, and
every entry must be claimed by a container through `volumeDevices` (never
`volumeMounts`). Anything else throws `KubernetesWorkspaceDiskError` **before
anything is created**, because every shape it refuses otherwise works:

| Template | What happens without the refusal |
|---|---|
| No `volumeClaimTemplates` | A healthy sandbox whose files vanish on the first suspend. |
| `volumeMode: Filesystem` | Under a VM-isolating RuntimeClass the PVC reaches the guest over a host/guest filesystem passthrough (virtio-fs), paying a round trip per file operation. Nothing fails — a dependency-tree walk or a `git status` over a large checkout is simply several times slower, which no functional test can see. |
| `Block` with no `volumeDevices` | The PVC is provisioned and attached to nothing. |
| `Block` through `volumeMounts` | The kubelet refuses the pod. |

The rule is **every** entry, not merely the one holding the workspace: nothing
in the API says which `volumeClaimTemplates` entry is the disk, so a
`Filesystem` scratch or config PVC declared beside the block one is refused
too — and since `volumeClaimTemplates` is immutable it could not be added
later either. A workspace template is all-block, or it is not a workspace
template.

The controller wires the disk by the entry's own name, StatefulSet style: it
creates the PVC as `<entry name>-<sandbox name>` and matches it against the
container's `volumeDevices`, so the copied podTemplate needs no `volumes:`
entry. The image's entrypoint formats the raw device once and mounts it — see
[deployment](#deployment) for where that entrypoint lives
(`packages/sandbox/k8s/entrypoint.sh`).

### A workspace carries no lease

Every task sandbox carries `shutdownTime` + `shutdownPolicy: Delete`, and its
handle [renews that expiry](#the-lease) for as long as it lives. A workspace
carries **neither**, and its handle runs no renewal loop. An expiry on a
workspace is a timer that deletes the caller's files, and a renewal loop makes
keeping them conditional on a host process staying up — exactly backwards for
an object whose purpose is to outlive the host. A workspace goes away when
`destroy({ deleteDisk: true })` says so, and not before. Nothing reaps an
abandoned one, which is the trade: the leak is deliberate and named.

### Resume changes the address and the token

`suspend()` merge-PATCHes `spec.operatingMode: Suspended` — that, and the
`sandbox.namzu.ai/operating-mode-changed-at` annotation the
[inventory](#managing-workspaces-without-waking-them) reads, and nothing else
— and resolves only once the pod has actually stopped, not
once the patch is accepted. The controller deletes only the Pod and reconciles
PVCs unconditionally on every pass, so the disk survives with the same UID. A
guest whose PID 1 ignores `SIGTERM` rides out its
`terminationGracePeriodSeconds` first, which is most of how long a suspend
takes; the wait is bounded by `readyTimeoutMs`, and a pod that outlives it
rejects with `KubernetesWorkspaceSuspendTimeoutError`, naming both that knob
and the image behaviour.

Both of those failures leave the workspace in the state that is TRUE rather
than the one that was asked for — see [a state is recorded when the cluster
confirms it](#a-state-is-recorded-when-the-cluster-confirms-it):

- A patch the API server **refuses** changed nothing, so nothing changes here
  either: the pod is still running, the handle still serves calls, and the
  next `suspend()` sends the patch again.
- A patch that landed and a pod that **outlived the wait** leaves the
  workspace admitting no call — the pod is going away and a dial would hang —
  but does not record the suspend as finished. `suspended` reads `true`,
  `resume()` still works, and the next `suspend()` patches and waits again
  rather than returning on a wait this one lost. A suspend is a promise that
  the disk is quiesced, and a handle that made it on a draining guest would
  let the next caller resume, or delete, a workspace mid-write.

A suspend is still the only thing that makes the disk quiet **after** the pod
is gone, but it is no longer the only way to make it quiet at all:
[`quiesce()`](#quiescing-the-guest-before-a-capture) stops every process in the
guest while the agent is still there to read through, and
`suspend({ quiesce: true })` does that before it patches.

**The pod is the only thing that wait believes.** Not the Sandbox's own
`Suspended` condition — upstream's `sandbox_types.go` says the controller
"does not currently remove this condition when the Sandbox is resumed, so a
stale Suspended condition may linger", which would make every suspend after
the first return instantly on last time's answer. And not a `deletionTimestamp`
either: that appears the moment the DELETE is accepted, while the guest is
still running and still writing. Gone, or in a terminal phase — those are the
two states that mean the disk is quiesced.

A call already in flight when `suspend()` is called is not cancelled: it fails
at the transport when its pod goes away, rather than with the named suspended
error, which covers calls admitted from the suspend onwards.

`resume()` PATCHes it back, waits for a ready pod, and then **rebuilds
everything**: a resumed pod keeps the sandbox's name and gets a new uid and a
new IP, so the address is re-resolved and the bind token re-read, and the
transport is rebuilt from both. Nothing from before the suspend is reused.

How much of the address actually moves depends on the mode. Every Sandbox this
backend creates carries `service: true`, and the Service outlives the pod, so
under the default `agentAddress: 'service'` the address is the same string
before and after — the pod behind it, and the token, are what changed. Under
[`'pod-ip'`](#where-the-host-runs-decides-the-address) the IP moves every time,
and is re-read from the same `GET` the new token comes from. The handle
re-resolves either way; an operator debugging a resume should expect the token
to be new, the FQDN not to be, and a pod IP to be.

The pod read skips any pod carrying a `deletionTimestamp` or in a terminal
phase. For as long as the outgoing pod is still terminating, a `GET` by name
can answer with it rather than with the new pod, and a list by the sandbox's
selector can return it beside the new one — binding to its uid produces a
token the new agent refuses, reported as a flat `unauthorized` with nothing
pointing at the race.

**A resume reads `spec.operatingMode` before it patches.** A workspace this
handle believes is asleep may already have been brought back by another
process whose pod is serving its terminals right now, and patching `Running`
over `Running` would change nothing on the cluster while making this call the
apparent author of a mode change it did not make — which is what decides
whether a start that then fails may [put the pod back to
sleep](#nothing-but-an-explicit-delete-deletes). It also keeps
`sandbox.namzu.ai/operating-mode-changed-at` honest: the annotation says when
the mode last *changed*, and a no-op patch would restamp it. A resume that
finds the workspace already awake sends no patch and binds the pod that is
there.

**`Ready` is not a transition signal, so the uid is polled rather than read
once.** The controller does not take the condition down for a resume any more
than it takes `Suspended` down, so the first poll after the Running patch can
come back Ready while the only pod under that name is still the pre-suspend
one — no `deletionTimestamp` yet, phase `Running`, and therefore perfectly
live by every test above. The resume keeps reading, under the same
`readyTimeoutMs` budget as everything else on the path, until it sees a live
pod whose uid is **different** from the one the last suspend PATCH retired; a
budget that runs out while the old pod is still the only answer fails the
resume and says so, rather than binding a token that will be refused later.

The pod a resume excludes is the one a suspend patch that **landed** took
away, which includes the suspend whose pod outlived its own wait: the
controller was asked for that deletion either way, so a resume issued next
arrives mid-drain, finds no live pod of that name at all, and has to keep
reading rather than fail on the first answer. Every patch that lands is
recorded that way — an explicit `suspend()`, a suspension
[another process performed](#a-handle-notices-a-suspend-it-did-not-perform),
and the cleanup after a create or resume that failed [having woken the
workspace itself](#nothing-but-an-explicit-delete-deletes), which swallows its
own failure so the primary error stays primary and therefore records only when
the request actually came back.
A pod nobody asked the controller to remove has no replacement to wait for, so
excluding it would time out a resume whose workspace was perfectly usable.

The [privilege probe](#the-privilege-probe) runs again on every resume. A
resumed pod is a new pod, possibly from a re-pulled image, and "it was
deprivileged last week" is not a check.

**The pod it brings up is built from the `Sandbox`'s own `spec.podTemplate`**,
which is the copy taken when the workspace was created — not from the
`SandboxTemplate` as it stands today. A resume that should pick up a template
edit says so: see [a resume can bring the current pod template with
it](#a-resume-can-bring-the-current-pod-template-with-it).

Between the two, every call — `exec`, `readFile`, `readFileStream`,
`writeFile`, `listFiles`, `openTerminal`, `openTcpConnection` — throws
`KubernetesWorkspaceSuspendedError` and **issues no dial**. The Service outlives the pod, so the address still
resolves; a dial would hang on a connect timeout that names nothing.

`status` reports `destroyed` while suspended, because `SandboxStatus` has four
members and none of them is "suspended", and `destroyed` is the only one
meaning "cannot serve a call". The `suspended` flag is what tells the
recoverable state from the final one.

### A resume can bring the current pod template with it

A `Sandbox` carries its own copy of `spec.podTemplate`, taken once in the
create `POST`, and agent-sandbox builds every replacement pod from that copy
rather than from the `SandboxTemplate`. So a workspace kept for weeks runs the
pod spec it had when it was created: a new image tag, a memory limit, a
`terminationGracePeriodSeconds` or an env entry reaches only workspaces
created after the edit.

The sharp version of that is a release which changes the agent's wire
protocol. The guest agent is baked into the image, every session start runs
the [privilege probe](#the-privilege-probe) through an `exec`, and the shared
execution controller refuses a reservation whose `protocolVersion` is not the
host's — so every adopt and every resume of a workspace pinning the old image
fails, and before this the only exit was `destroy({ deleteDisk: true })`,
which takes the disk.

`refreshPodTemplate` is the opt-in that writes the template as it stands now
onto a workspace as it wakes:

```ts
import { type KubernetesBackendConfig, createKubernetesWorkspace } from '@namzu/sandbox'

const config: KubernetesBackendConfig = {
  tier: 'microvm',
  service: 'kubernetes',
  namespace: 'namzu-sandboxes',
  access: { inCluster: true },
  sandboxTemplateName: 'namzu-workspace',
}

// From a host that restarted and holds no handle: adopt by name, and wake it
// onto the template as it stands now.
const workspace = await createKubernetesWorkspace(config, {
  workspaceId: 'design-review',
  workingDirectory: '/workspace',
  refreshPodTemplate: true,
})

// From a handle that has one already.
await workspace.suspend()
await workspace.resume({ refreshPodTemplate: true })

workspace.templateCurrent // true: the bound pod is on the template above
```

**Only on a Suspended → Running transition**, and the patch is what enforces
that rather than the read before it:

| | |
|---|---|
| `test` | `/spec/operatingMode` is `"Suspended"` |
| `add` | the annotations: `sandbox.namzu.ai/operating-mode-changed-at`, `sandbox.namzu.ai/pod-template-hash`, and the [holder epoch](#a-holder-epoch-fences-every-lifecycle-write) when the call carries one |
| `add` | `/spec/podTemplate` — the template's, with the template label and the configured `runtimeClassName` overlaid, exactly as a create builds it |
| `add` | `/spec/operatingMode`: `"Running"` |

One request, `application/json-patch+json`. **A JSON Patch rather than the
merge patch every other lifecycle write sends**, because a merge patch
recurses into maps: a `nodeSelector` entry the template dropped would survive
on the object, and the pod would keep a constraint nobody can see in the
template any more. And when an epoch is configured, its `test` rides in **this
same body** — two conditions, one write, no window between them.

**One thing here is upstream's behaviour, not this backend's, and has not been
re-measured in this repository:** that the controller builds the replacement
pod from `spec.podTemplate` as this patch rewrites it. What is measured is the
object left on the cluster for it to read. The `test` bounds the cost of that
premise being wrong — a refresh that does not reach the pod is a missed
refresh, never a wrong write — but `templateRevision` and `templateCurrent`
below would then describe the object rather than the running pod, so read them
as a reason to schedule a suspend and a resume, not as a report on a process.

**Never on a Running Sandbox.** agent-sandbox v1.0.2 does not rewrite a pod
that already exists, so patching a Running object would leave its spec
describing a pod it is not running. There are two ways to arrive at one and
both bind the pod that is there, unchanged: an adopt that finds the object
Running, and a `test` that loses to another process's resume in the moment
between this call's read and its patch. The second is not an error — the
workspace is awake, which is what was asked for — and it is not retried
either: a mode clause that is no longer true is an outcome. A call that loses
that race still **waits** for the winner's pod under `readyTimeoutMs`, exactly
as its own resume would have: the object was observed suspended, so a pod is
on its way in whoever asked for it, and a read that finds none is "not yet"
rather than fatal.

**The disk is never in the patch.** `spec.volumeClaimTemplates` is
CEL-immutable and is not sent, so the PVC and its uid are untouched. Which
makes the disks the one part of a template a refresh cannot apply, and two
checks run before anything is sent — both refusing with
`KubernetesWorkspaceDiskError` and leaving the workspace `Suspended`:

* The refreshed pod template still claims **this workspace's** disk through
  `volumeDevices`. A template that renamed or dropped it would come up healthy
  with the disk attached to nothing, and the only symptom would be that
  yesterday's files are gone.
* The template declares **no disk this workspace does not have**. Adding a
  second `volumeClaimTemplates` entry with its matching `volumeDevices` entry
  is the ordinary way to give a workspace another disk, and such a template is
  perfectly valid — a workspace created from it today gets both disks. Written
  onto a workspace that already exists it would claim a device node backed by
  no PVC, the controller could not build a pod at all, and the caller would
  see a `readyTimeoutMs` bind timeout naming nothing. Give an existing
  workspace another disk by creating a new one from the new template and
  migrating the data.

Editing an existing entry's *other* fields — its size, its storage class, its
`volumeMode` — is not refused and does not apply: the disk that entry
describes is the disk that is already attached.

**Two fields say whether a workspace is on the current template.** Every
`Sandbox` this backend creates records what it was built from, in
`sandbox.namzu.ai/pod-template-hash` — a `sha256:` over the pod template after
the overlays, stamped by the create `POST` itself and rewritten by the refresh
patch:

| | |
|---|---|
| `workspace.templateRevision` | The hash the bound object carries, or `undefined` for a workspace created before this existed |
| `workspace.templateCurrent` | Whether that hash matches the `SandboxTemplate` this handle read |

A workspace with no recorded revision reads `templateCurrent: false`: unknown
is not current. The template is read when the handle is opened and again on
every refresh, so a plain `resume()` leaves `templateCurrent` answering against
the last template this handle read rather than paying a `GET` for one nothing
is going to be compared to. The pair is there so a host can schedule a suspend
and a resume at a moment of its choosing, instead of discovering the drift
when a release makes the stored image fail every start.

**Without the option, nothing changes.** `resume()` sends the same single
merge patch it always sent, an adopt behaves exactly as it always did, and
both refusals above apply as they always did. The epoch annotation and this
one are the only things a create body gained.

**No new RBAC**: the shipped `Role` already grants `patch` on `sandboxes` and
`get` on `sandboxtemplates`.

### Managing workspaces without waking them

`createKubernetesWorkspace` adopts **and** resumes. That is right for a host
about to use a workspace and wrong for every operation that is about the
object rather than the guest: taking an inventory through it starts a pod for
every suspended workspace it looks at, and deleting a month-old one means
waking it up to tell it to go away. So the three operations that never need a
guest reach the object without opening it:

```ts
import {
  deleteKubernetesWorkspace,
  listKubernetesWorkspaces,
  suspendKubernetesWorkspace,
} from '@namzu/sandbox'

const cluster = {
  tier: 'microvm',
  service: 'kubernetes',
  namespace: 'namzu-sandboxes',
  access: { inCluster: true },
  sandboxTemplateName: 'namzu-workspace',
} as const

const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
for (const workspace of await listKubernetesWorkspaces(cluster)) {
  if (workspace.operatingMode !== 'Suspended') continue
  const asleepSince = workspace.operatingModeChangedAt
  if (asleepSince === undefined || Date.parse(asleepSince) > cutoff) continue
  await deleteKubernetesWorkspace(cluster, workspace.workspaceId)
}
```

None of the three creates a pod, dials an agent or resumes anything.

| Verb | What it sends | What it never does |
|---|---|---|
| `listKubernetesWorkspaces(config, { signal })` | One `GET` of the `sandboxes` collection | No `PATCH`, no `DELETE`, no pod read: a suspended workspace is still suspended afterwards |
| `deleteKubernetesWorkspace(config, workspaceId, { signal, epoch })` | One `DELETE` of `namzu-ws-<id>` | Never adopts, never resumes — the deterministic name is enough to address the object |
| `suspendKubernetesWorkspace(config, workspaceId, { signal, epoch })` | The `operatingMode: Suspended` patch, then the pod wait | Never adopts, opens no session, reaps no terminals it does not own |

Both writing verbs take an optional [holder
epoch](#a-holder-epoch-fences-every-lifecycle-write), which is where a
retention pass most wants one: the job that deletes a month-old workspace is
exactly the caller most likely to be acting on a decision it made before
somebody reopened the workspace, and a `DELETE` is the one write nothing
brings back. `listKubernetesWorkspaces` sends no write, so it has nothing for
an epoch to condition; it **reports** each workspace's stored epoch instead.

`listKubernetesWorkspaces` returns a `KubernetesWorkspaceSummary` per
workspace — `workspaceId`, `operatingMode`, `template`, `createdAt`,
`operatingModeChangedAt` and `holderEpoch` — in the API server's own order.
`operatingMode` is `spec.operatingMode` verbatim and not "is a pod running": a
`Running` workspace whose pod is being created, or has just crashed, reads
`Running`. `holderEpoch` is `0` on a workspace nobody has fenced, because that
is what every write compares against, and is **absent** only when the
annotation is present and unreadable.

**What counts as a workspace** is two of this backend's own marks together:
the `namzu-ws-` name prefix, which is the only thing that makes a
`workspaceId` recoverable from a `Sandbox` at all, and the
`sandbox.namzu.ai/template` label on `spec.podTemplate`. Task sandboxes carry
the label and not the prefix; an object wearing the prefix without the label
was not built here and is left alone. The filtering happens in the client
rather than as a `labelSelector` on the request because that label is a **pod**
label — the one an egress `NetworkPolicy` matches — and a `labelSelector` on
the sandboxes collection matches the `Sandbox`'s own `metadata.labels`, which
this backend has never written. Stamping a second copy up there to enable a
server-side selector would leave every workspace created before that change
invisible, and those are exactly the ones a retention pass is looking for.

**`operatingModeChangedAt` is an annotation this backend stamps**,
`sandbox.namzu.ai/operating-mode-changed-at`, written by the suspend and
resume patches with the host's clock at the moment each was sent. Nothing
already on the object answers the question: the controller's own `Suspended`
condition lingers `True` across a resume — upstream's `sandbox_types.go` says
it "does not currently remove this condition when the Sandbox is resumed" — so
neither its presence nor its `lastTransitionTime` says when the mode last
changed, and `Ready`'s timestamp moves for every pod that comes and goes, a
crash-restart included. A workspace whose mode has never changed since it was
created carries no annotation and is reported **without** one rather than
defaulted to `createdAt`, because a retention rule has to tell "never
suspended" from "suspended a month ago".

`deleteKubernetesWorkspace` gives the same two guarantees
`destroy({ deleteDisk: true })` does: an object already gone counts as
deleted, that being the state `DELETE` was asking for, and a `DELETE` that
fails **rejects and stays retryable** — nothing records the workspace as
deleted on a request that did not land. It is not gated on the workspace being
suspended; deleting a running one takes its pod with it, which is what
deleting a workspace means. A caller that wants the disk quiesced first calls
`suspendKubernetesWorkspace` and then this.

`suspendKubernetesWorkspace` resolves only once the pod is **gone or in a
terminal phase**, for the same reason the handle's `suspend()` does: the patch
being accepted says only that the controller has been asked. A pod that
outlives `readyTimeoutMs` rejects with
`KubernetesWorkspaceSuspendTimeoutError` and leaves the object as the patch
left it. A workspace that does not exist rejects rather than resolving —
unlike a `DELETE`, this asks for a state that cannot be reached.

All three take a `workspaceId`, not a `Sandbox` name, and refuse an id that
could not be one before sending anything.

### A handle notices a suspend it did not perform

A workspace id is a name, not a lock, so the process that suspends a workspace
is often not the one holding a handle to it. That handle's state is a record
of what **its** process did, and left alone it would go on reporting
`suspended: false` with no pod behind it.

Since [no failure path suspends a workspace it did not
wake](#nothing-but-an-explicit-delete-deletes), an explicit verb somebody
typed — `suspend()`, `destroy()`, `suspendKubernetesWorkspace` — is now
essentially the only way a workspace gets suspended out from under a handle.
That makes this notice a report of another caller's decision rather than of an
accident. Apart, that is, from the [read-then-patch
window](#nothing-but-an-explicit-delete-deletes) that decides authorship: a
`Running` patch the API server did not refuse counts as this call's own wake,
so a concurrent writer between the read and the patch can still make one
process the apparent author of a wake it did not perform — and a start that
then fails suspends on the strength of it. A [holder
epoch](#a-holder-epoch-fences-every-lifecycle-write) closes that window too,
because the cleanup patch is then conditional on the same epoch the start
carried.

Two things correct it, and both re-read `spec.operatingMode` rather than
guessing:

- **`refresh()`**, on demand and before anything has failed. A workspace
  another process suspended reports `suspended: true` afterwards, and
  `resume()` brings it back on the same disk.
- **The re-read after a failed call.** The failure a foreign suspend produces
  names nothing on its own: the pod is gone, so the dial is refused against an
  address that still resolves — the Service outlives the pod — or, if a
  replacement is already up, its agent answers a flat `unauthorized` because
  this handle is presenting the retired pod's uid. So a call that fails while
  the handle believes it is running re-reads the object **once**, and if it
  really is `Suspended` the caller gets `KubernetesWorkspaceSuspendedError`
  with the transport failure on `cause` instead.

`KubernetesWorkspaceSuspendedError.noticedBy` tells the two apart:
`'admission'` means the handle knew and nothing was dialed, `'transport'`
means the call went out, failed, and the re-read found the suspension.

The re-read is a diagnostic and behaves like one. It runs at most once per
failed call, never on a call that succeeded, and never speculatively; it does
not use the caller's `AbortSignal`, which is quite possibly what ended the
call; and a re-read that itself fails hands back the caller's own error rather
than replacing it with a second one about the API server. A workspace that
reads `Running` leaves everything exactly as it was — including the failure,
which travels out untouched.

**A foreign suspend is recorded as unconfirmed.** What was observed is the
object's mode, not the pod stopping, and the other process's wait may have run
out — so this handle's own `suspend()` still sends its patch and waits for the
pod rather than returning on what the re-read saw. `refresh()` notices a
suspension and nothing else: a workspace that reads `Running` while this
handle is suspended is not taken back, because coming back means binding a new
pod, reading its token and probing it, which is what `resume()` is. A
workspace somebody deleted rejects with the client's already-gone error and
changes nothing on the handle.

### A holder epoch fences every lifecycle write

A host that drives one workspace from more than one process — during a rollout
overlap, after a restart, or when a scheduled job runs beside a request
handler — usually already keeps a monotonic **holder epoch** in its own
database. That fences what the host does itself and nothing else: "check my
epoch, then call `suspend()`" is check-then-act, the write that follows is a
separate request, and the API server accepts it. Three races fit in that gap:

- a **late suspend** stops the new holder's pod;
- a **late `destroy({ deleteDisk: true })`** takes the disk, and nothing
  brings a disk back;
- a **late adopt** wakes a workspace that was just suspended.

Passing the epoch into this package closes all three, because the condition
then travels in the same request as the write:

```ts
import {
  KubernetesWorkspacePreconditionError,
  createKubernetesWorkspace,
} from '@namzu/sandbox'

const cluster = {
  tier: 'microvm',
  service: 'kubernetes',
  namespace: 'namzu-sandboxes',
  access: { inCluster: true },
  sandboxTemplateName: 'namzu-workspace',
} as const

// `epoch` is the host's own number, raised whenever authority moves.
const workspace = await createKubernetesWorkspace(cluster, {
  workspaceId: 'ada-main',
  workingDirectory: '/workspace',
  epoch: 5,
})

try {
  await workspace.suspend()
} catch (error) {
  if (error instanceof KubernetesWorkspacePreconditionError) {
    // Another process holds this workspace now. Nothing was changed on the
    // cluster, and nothing was changed on this handle either.
    console.warn(`held at epoch ${String(error.storedEpoch)}, not ${String(error.epoch)}`)
  } else {
    throw error
  }
}
```

**The rule.** The epoch lives in an annotation on the `Sandbox` itself,
`sandbox.namzu.ai/holder-epoch`, holding a decimal integer. A write carrying
epoch `e` applies when the stored epoch is `<= e`, and stores `e` in the same
request; a stored epoch above `e` refuses it. A workspace with no annotation
reads as **0**, so every workspace created before this release accepts its
first epoch-carrying write.

**Where an epoch is accepted**, and what each one fences:

| Call | The write it conditions |
|---|---|
| `createKubernetesWorkspace(config, { …, epoch })` | The `POST` stamps it. On adopt it is checked **before** any resume patch, like the adopt's other refusals — and then written even when the object was already `Running`, where nothing used to be sent at all |
| `workspace.suspend({ epoch })` | The `operatingMode: Suspended` patch |
| `workspace.resume({ epoch })` | The `Running` patch — and on a workspace that is already running, a stamp-only write, where nothing used to be sent |
| `workspace.destroy({ epoch, deleteDisk })` | The suspend patch, or the `DELETE` |
| `suspendKubernetesWorkspace` / `deleteKubernetesWorkspace` | The same two, from a process holding no handle |

A handle **keeps** the epoch it was opened or last resumed with and writes
under it whenever a call passes none — including the cleanup patch a failed
start sends, which is the write nobody looks at and the one most likely to
take a pod away from a holder that arrived while the start was running.

**One request per write, never check-then-act.** A fenced `PATCH` goes up as
`application/json-patch+json` (RFC 6902) instead of the merge patch: it
`test`s the value it just read and then writes, in one body, so nothing can
fit between the condition and the mutation. The pointer to the annotation is
`/metadata/annotations/sandbox.namzu.ai~1holder-epoch` — `/` is `~1` in a JSON
Pointer. A `DELETE` has no patch body, so its condition is
`preconditions.resourceVersion` on the version whose epoch was read, which the
API server refuses with `409` naming both versions.

**A refused write changes nothing** — not on the cluster, and not on the
handle. `KubernetesWorkspacePreconditionError` carries `operation`,
`workspaceId`, `sandboxName`, `epoch` and `storedEpoch`, and the refusal is
decided **before** `suspend()` reaps the handle's terminals or `destroy()`
tears its session down, so a superseded holder does not take its own caller's
sessions away over a write that never applied.

**No epoch, no change.** A call that passes none sends exactly the requests it
sent before this existed, `application/merge-patch+json` and all. An unfenced
write is not a write with epoch 0: it carries no condition at all, so it still
applies to a workspace held at 7. Opting in is a decision, and not opting in
puts you exactly where you were.

**How this squares with "no watch, no informers, no resourceVersion
tracking".** That invariant, stated at the top of
`backends/kubernetes/k8s-client.ts`, still holds. The condition is the
**annotation**, read off a `GET` this backend already makes and tested inside
the very next write. `resourceVersion` appears in exactly two places and never
outlives the call that read it: as the fallback `test` for an object that
carries no annotation yet — the migration case, which fires once per workspace
and never again — and as a fenced `DELETE`'s precondition. Nothing is stored
across calls, nothing is streamed, and no cursor is kept. That distinction
also decides what a controller status write does: it moves `resourceVersion`
without touching the annotation, so under the steady-state annotation test it
is simply not a condition the write is interested in, and under the one-time
`resourceVersion` test it costs a single re-read and retry rather than a
refusal.

**What the API server tells you, and what it does not.** Measured against a
real API server (v1.37.0) and the agent-sandbox `Sandbox` CRD: a JSON Patch
whose `test` does not hold answers **422 `Invalid`** with the message *"the
server rejected our request due to an error in our request"* — and a patch
that is simply malformed answers with the identical status, reason and
message. The server does not name the operation that failed. So the host does
not pretend to read it off the reply: an unapplied patch becomes
`KubernetesPatchNotAppliedError` ("the patch did not apply and nothing
changed"), and the backend then **re-reads the object**. If the value it
tested has moved, it lost a race and retries under the fresh reading, refusing
if the new stored epoch has overtaken it; if nothing moved, the body is wrong
rather than late and the error stands rather than being retried.

**No new RBAC.** The `patch` verb covers every patch type, and the shipped
`Role` already grants `patch` and `delete` on `sandboxes`.

### A command can outlive the connection watching it

An ordinary `exec()` is tied to the one connection that started it. If that
socket resets the host cancels the command to reconcile, and if the cancel
cannot be confirmed within eight seconds the handle used to retire the pod —
so a network blip could cost a workspace every open terminal and everything
in flight. If the host **process** exits instead, nothing cancels: the command
runs on, its output was written only to a closed socket and kept nowhere, and
the only op that returned its record terminated it to hand it over.

A workspace command can now be started so that losing the connection is not
losing the command:

```ts
import {
  KubernetesExecutionDetachedError,
  createKubernetesWorkspace,
} from '@namzu/sandbox'

const cluster = {
  tier: 'microvm',
  service: 'kubernetes',
  namespace: 'namzu-sandboxes',
  access: { inCluster: true },
  sandboxTemplateName: 'namzu-workspace',
} as const

const workspace = await createKubernetesWorkspace(cluster, {
  workspaceId: 'acme-checkout-7',
  workingDirectory: '/workspace',
})

const executionId = 'exec_1f2e3d4c-5b6a-4c8d-9e0f-112233445566'
const shuttingDown = new AbortController()
try {
  const result = await workspace.exec('pnpm', ['test'], {
    executionId,
    detach: true,
    detachSignal: shuttingDown.signal,
  })
  console.log(result.exitCode)
} catch (error) {
  if (!(error instanceof KubernetesExecutionDetachedError)) throw error
  // The command is still running. Another process picks it up by id.
  console.log(error.executionId, error.outputOffset)
}
```

**What the guest keeps.** A command started this way writes its output into a
retained log as well as onto the wire: one ordered, size-bounded log of stdout
and stderr in a single byte-offset space, so a reader resumes with one number
and sees the interleaving the command actually produced. A command started
without `executionId` or `detach` retains nothing and sends exactly the wire
request it always sent.

**The offsets are the guest's, never the host's arithmetic.** Every output
frame of a retained command carries the byte range it occupies in that log, on
the exec stream and on an attach alike, and the host resumes from what it was
told rather than from anything it counted. It has to: output crosses the wire
as decoded text, and a chunk that ends inside a multi-byte character does not
decode to its own byte length, so a cursor counted from the text drifts ahead
of the log the first time a command prints something that is not ASCII across
a read boundary. A drifted cursor either skips bytes nobody reports or names
an offset the guest never had.

**Reattaching.** When the exec connection fails, the handle attaches to the
same execution from the last offset it received and goes on reading. Only
getting back is bounded — by `reattachWindowMs`, 30 s by default — and the
bound is disarmed the moment an attach succeeds, so a long command being read
successfully is never given up on. If the window runs out, `exec()` rejects
with `KubernetesExecutionDetachedError`, carrying the `executionId` and the
`outputOffset` a later reader resumes from. **Nothing on this path sends a
cancel to reconcile.** That is the behaviour being replaced: a lost connection
now costs the workspace nothing at all — no patch, no suspend, no pod.

**Reading a command you did not start.** `attachExecution(executionId, {
fromOffset, onOutput, onGap, signal })` resolves to the same `SandboxExecResult`
the starting call would have returned. It never signals the command: aborting
its `signal` stops reading and rejects with the detached error, and closing the
connection changes nothing in the guest. Every attach inside the retention
window returns the same result.

**Ending one.** `cancelExecution(executionId)` runs the confirmed-cancel path
from any process holding the id, and resolves only when the guest has confirmed
the process group is gone. A cancellation it could not confirm rejects with
`RemoteCancellationUnknownError` — and, unlike the path this replaces, retires
nothing: the workspace, its pod and its disk are left exactly as they are.
`SandboxExecOptions.signal` keeps its contract and runs this same path;
`detachSignal` is its opposite and ends only the watching.

One divergence from the shared exec contract is deliberate and lives here: on
a detached command, a cancel that could not be confirmed is reported as
`KubernetesExecutionDetachedError` — the id and the offset to come back with —
rather than `RemoteCancellationUnknownError`. The unknown-cancellation error is
what retires a workspace, and not retiring one is the whole reason this path
exists. The command's fate is still unknown; the caller finds out by attaching.

A detached command also does not make the handle `busy`: `workspace.status`
reads `'ready'` while one is in flight, because the detach path runs outside
the execution accounting whose failure rule retires a workspace. An ordinary
`exec()` still reports `'busy'`, and `suspended` is unaffected by either.

**A gap is reported, never skipped.** If a reader asks for output the guest has
already evicted, the attach answers with the number of bytes lost: `onGap`
receives the count, and the returned result carries `stdoutTruncated` and
`stderrTruncated` — both of them, because the retained log is one interleaved
space and the loss cannot be attributed to either stream. Output is never
quietly shortened into something that looks complete.

**Starting the same id twice runs the command once.** Reserving an id the guest
still holds reports what it holds instead of minting a second reservation, so
the second call attaches to the command that exists rather than starting
another. That guarantee ends in exactly two places, and the guest cannot
pretend otherwise: when the record is pruned at the end of its retention
window, and when the pod is replaced — a resume, an eviction, a node drain —
which takes the whole registry with it. After either, the same id is a fresh
reservation and the command runs again.

**What it costs the guest, and the knobs.** Retained output is heap in the same
512Mi the workload shares, so it is bounded twice: per execution, and by how
many executions may retain at once. All four variables live in the workspace
template's `env` block at their defaults.

| Variable | Default | What it bounds |
|---|---|---|
| `NAMZU_AGENT_EXECUTION_LOG_BYTES` | `1048576` (1 MiB) | Retained output per execution; the oldest bytes are evicted first and the loss is reported as a gap. |
| `NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS` | `32` | How many executions may retain at once. Finished executions give up their output first (keeping their result); a guest already retaining this many LIVE commands refuses the next detached one before it starts a process. |
| `NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS` | `600000` (10 min) | How long a detached command's record and log outlive it. Every other execution keeps the 60 s `NAMZU_AGENT_EXECUTION_TERMINAL_TTL_MS` window it always had. |
| `NAMZU_SANDBOX_MAX_TIMEOUT_MS` | `1800000` (30 min) | The ceiling on the caller's own `timeout`. |

**The timeout ceiling is the operator's.** `timeoutMs` traces back to a
model-authored tool argument, so the guest caps it — and it refuses a request
above the cap rather than silently shortening it, because a caller that asked
for four hours and quietly got thirty minutes would believe its command was
protected for four. The cap was a constant while every ownership limit beside
it was an environment variable; it now reads `NAMZU_SANDBOX_MAX_TIMEOUT_MS`,
the same variable the container worker has always read for the same limit, and
the refusal names it. The default is unchanged, so an unconfigured deployment
refuses exactly what it always refused.

**The guest has to advertise it.** `healthz` answers with
`features: ["write-file-parts", "execution-attach"]`, and a host that asks for
a detachable command against an image without the second string is refused
with `KubernetesExecutionAttachUnsupportedError` **before** the command is
admitted — rather than running one whose output nothing keeps. The guest wire
protocol version is unchanged: the caller-chosen `executionId`, the
`retainOutput` flag and the `attach-execution` op are all additive, so no host
and no image has to roll together with this release.

**Where it does not live.** None of this is on the SDK's `Sandbox`.
`SandboxExecOptions` is untouched, so every other backend's exec contract —
and the Firecracker tier's — is exactly what it was; the options type here
only widens what a Kubernetes workspace's own `exec()` accepts.

### A terminal or a program can outlive the host process

A workspace is built to outlive the host process — it carries no lease for
exactly that reason, and a second process reattaches to it by name. Until this
release the processes *inside* it did not.

- A terminal belonged to the framed connection that opened it. When the host
  process went away — a deploy, a crash, an OOM kill — its sockets closed and
  every terminal it had opened was torn down.
- **The teardown did not reach what it claimed to.** The agent's comment said
  its process-group kill "reaches the shell and every descendant". It did not:
  util-linux `script` starts the shell in a **new session**, so the kill
  reached `script` alone. `script`, the shell and the foreground job then died
  of the PTY hanging up, but a job backgrounded with `&` was never signalled.
  It kept running with no terminal, holding its port, reachable by no op, until
  the pod stopped.
- Replay lived in the host process: output that arrived with nobody listening
  was buffered on the host, so a new host process had no buffer and no way to
  name the terminal.
- Nothing could run outside a terminal at all. `exec` caps at 30 minutes and
  kills the process group when the timeout fires.

The guest now keeps a **session registry**: programs it is running that are
not bound to the connection that started them. A second host process finds
them by name and picks up where the first one left off.

```ts
import { createKubernetesWorkspace } from '@namzu/sandbox'

const cluster = {
  tier: 'microvm',
  service: 'kubernetes',
  namespace: 'namzu-sandboxes',
  access: { inCluster: true },
  sandboxTemplateName: 'namzu-workspace',
} as const

// --- the host process that starts them ---
const host = await createKubernetesWorkspace(cluster, {
  workspaceId: 'acme-checkout-7',
  workingDirectory: '/workspace',
})

// A shell that belongs to the pod, not to this socket.
await host.openTerminal({
  sessionId: 'editor-shell',
  persistent: true,
  size: { cols: 120, rows: 40 },
})

// A preview server with no terminal at all.
await host.startDetached({
  sessionId: 'preview',
  command: 'node',
  args: ['server.js'],
})

// --- the host process that replaces it, after a deploy ---
const successor = await createKubernetesWorkspace(cluster, {
  workspaceId: 'acme-checkout-7',
  workingDirectory: '/workspace',
})

for (const session of await successor.listSessions()) {
  console.log(session.sessionId, session.kind, session.state, session.nextOffset)
}

const shell = await successor.attachTerminal('editor-shell', { fromOffset: 0 })
shell.onData((chunk) => process.stdout.write(chunk))
shell.write('git status\n')

const output = await successor.readSession('preview', { fromOffset: 0 })
console.log(output.chunk, output.nextOffset, output.droppedBytes, output.status)

await successor.killSession('preview')
```

**A closed connection is a detach, and sends no signal of any kind.** A
persistent session ends when its program exits, when `killSession` ends it,
when a [`quiesce()`](#quiescing-the-guest-before-a-capture) stops everything in
the guest, or when the pod stops — and nothing else. On such a terminal `exited` **rejects**
with `AgentSessionDetachedError` when the attachment ends and the program does
not, because resolving it would report an exit that never happened; the error
carries the byte offset to come back at. A plain `openTerminal` — no
`sessionId`, no `persistent` — is unchanged in every other respect, down to
the wire request it sends.

**Output keeps flowing with nobody attached.** The guest reads a session's
output into a ring buffer whether or not anyone is reading it, so a program
with no reader never blocks on a full PTY. That ring is the **same
`OutputLog`** a [detached execution](#a-command-can-outlive-the-connection-watching-it)
uses: one ordered, size-bounded log of stdout and stderr in a single
monotonically increasing byte-offset space. Eviction advances its start offset
and a read from before that is answered with a `droppedBytes` count. A gap is
reported; output is never quietly shortened into something that looks
complete. Every frame carries its own byte range, so a reattach never derives
an offset from decoded text.

**One attachment per session.** A second attach ends the first by name, so two
host processes cannot interleave keystrokes into one shell. The loser is an
observer: its stream ends, and the shell it was reading is untouched. A
`readSession` is **not** an attachment: it replays what it was asked for and
ends, taking nothing from the live reader and signalling nothing, so a host
polling a shell's tail does not end the terminal it is polling.

**A signal is coerced to the terminal set, whichever connection sent it.**
`killSession(id, { signal })` and `TerminalSession.kill(signal)` accept
`SIGTERM`, `SIGKILL`, `SIGINT` and `SIGHUP`; anything else becomes `SIGTERM`
(`killSession` defaults to `SIGKILL`, a terminal's own `kill` to `SIGTERM`).
The rule is applied in one place, so a frame means the same thing on the
connection that opened a terminal and on a later attachment to it — a session
wedged in `T` by a `SIGSTOP` from one of the two would be reachable by nothing
but `SIGKILL` and reported as still running.

**A kill reaches the whole session — and so does a non-persistent terminal's
teardown.** Both signal every process still in the kernel session the shell was
started in, found through `/proc`, not only the process group the agent
spawned. A job backgrounded inside a terminal therefore no longer outlives it.
**This is the one behaviour change that is not opt-in**, it is what the old
comment already promised, and a host that was relying on the leak — starting a
dev server with `&` inside a terminal and expecting it to survive — must move
it to `startDetached`, which is the verb for a program that outlives its
caller. What no signal can follow is a process that called `setsid` for itself:
it has left the session, and nothing short of a PID namespace or a cgroup
reaches it.

**The registry is the pod's memory.** It is never written to disk. After
`suspend()` and `resume()` — a new pod, a fresh agent — `listSessions()` is
empty, and so it is after any eviction, node drain or restart. Nothing here
makes a program survive the pod; it makes a program survive the *host*.

**`spawnDetached` stays absent.** The SDK's version returns a host
`ChildProcess` synchronously, which cannot cross a process boundary, and its
consumer keeps jobs in an in-memory map inside one host process. `startDetached`
is a differently-named verb because it does a different thing: it returns a
name, and the name is what a redeployed host comes back with. `readSession`
answers in the SDK's `BackgroundJobOutput` shape — `chunk`, `nextOffset`,
`droppedBytes`, `status`, `exitCode` — because it answers the same question for
the same kind of consumer.

**What it costs the guest, and the knobs.** A session's ring is heap in the
same 512Mi the workload shares, so it is bounded twice, exactly as retained
execution output is. All three are in the shipped workspace template's `env`
block at their defaults.

| Variable | Default | What it bounds |
|---|---|---|
| `NAMZU_AGENT_MAX_SESSIONS` | `16` | How many sessions may exist at once. Exited ones are given up first; a guest already holding this many LIVE sessions refuses the next one before it starts a process. |
| `NAMZU_AGENT_SESSION_LOG_BYTES` | `1048576` (1 MiB) | Retained output per session. The oldest bytes go first and the loss is reported as `droppedBytes`. |
| `NAMZU_AGENT_SESSION_TERMINAL_TTL_MS` | `600000` (10 min) | How long an exited session's record and output outlive its program, so a redeployed host can still read the tail and the exit status. Expiry is checked when the next session op arrives rather than on a timer, so a record can outlast its window in a pod nobody is talking to — `NAMZU_AGENT_MAX_SESSIONS` is what bounds that. |

**The guest has to advertise it.** `healthz` answers with `features: ["write-file-parts",
"execution-attach", "stream-heartbeat", "read-file-stream", "sessions", "quiesce"]`, and a host asking for any
session verb against an image without the last string is refused with
`KubernetesSessionsUnsupportedError` — **never** downgraded to a
connection-bound terminal, which would look like it worked until the rollout it
exists for. The guest wire protocol version is unchanged: `sessionId`,
`persistent` and the four new ops (`attach-session`, `start-detached`,
`list-sessions`, `kill-session`) are all additive, so no host and no image has
to roll together with this release.

**Where it lives.** All of it is on `KubernetesWorkspace`, not on the SDK's
`Sandbox`. `OpenTerminalOptions` and `TerminalSession` are untouched, so every
other backend — the Firecracker tier included — is exactly what it was.

### Quiescing the guest before a capture

`suspend()` is a promise that [the disk is quiesced](#the-disk-is-fixed-at-creation-and-must-be-block),
and until this release that promise was only ever kept **after** the pod had
stopped — by which time there is no agent left to read the disk through. A
host that wanted a capture it could trust had nowhere to stand:

- `suspend()` kills the terminals **this handle** returned and then patches. A
  terminal another host process opened, and an `exec` already running, are not
  its to kill and both survived into the drain.
- In the guest, a terminal teardown signals what that terminal owns and an
  `exec` cancel signals that execution's own group. A program that moved into a
  session of its own — `setsid`, a daemon that double-forks, anything a shell
  left behind — is in neither, and was reachable by **no op at all**.
- When the pod stops, `tini` forwards `SIGTERM` to the agent and the agent
  exits. Nothing signals the rest of the container first.

`quiesce()` is that place to stand. It stops every process the guest is
running and **leaves the agent up**, so the very next call reads a filesystem
nobody is writing to.

```ts
import { createKubernetesWorkspace } from '@namzu/sandbox'

const cluster = {
  tier: 'microvm',
  service: 'kubernetes',
  namespace: 'namzu-sandboxes',
  access: { inCluster: true },
  sandboxTemplateName: 'namzu-workspace',
} as const

const workspace = await createKubernetesWorkspace(cluster, {
  workspaceId: 'acme-checkout-7',
  workingDirectory: '/workspace',
})

// Everything stops. The agent does not.
const report = await workspace.quiesce({ graceMs: 2_000 })
for (const stopped of report.stopped) {
  console.log(stopped.pid, stopped.command, stopped.signal)
}

// So this reads a disk nobody is writing under.
const capture = await workspace.readFile('out/state.db')
console.log(capture.byteLength, report.scope, report.rounds)

// Or ask the suspend to do it: the patch goes out only once the guest is quiet.
await workspace.suspend({ quiesce: true })
```

**What the guest does, in the order it does it.**

1. **Every running execution is marked before anything is signalled.** This is
   the whole subtlety. An execution's close handler waits for its process group
   only when the execution carries a termination cause; without one, a group
   leader that dies before the rest of its group makes the handler give up and
   **fence the agent** — after which every op but `healthz` and
   `cancel-execution` is refused and the capture the quiesce was performed for
   can no longer run. Marking first is what stops a quiesce from defeating
   itself.
2. **It scans `/proc`, not its own children.** An orphan is reparented to PID 1
   and is no longer the agent's child, so the agent's own bookkeeping cannot
   see it.
3. **PID 1 and the agent are skipped**, and so is anything else in the agent's
   own kernel session — in a pod that is `tini` and the agent, and nothing else
   ever joins it. A zombie counts as stopped: it has closed its files.
4. **It signals in rounds**: `SIGTERM`, wait `graceMs`, `SIGKILL` whatever is
   left, then scan again. The loop ends on a pass that finds nothing, which is
   what catches a process forked while a pass was in flight — and what makes a
   second `quiesce()` straight after the first answer with an empty list.
5. **A process still present after `SIGKILL` fails the call** with
   `KubernetesQuiesceUnconfirmedError`, naming its pid. It never resolves
   optimistically: a host about to take a capture has to be able to tell
   "everything stopped" from "something would not stop".

**While it runs, work that would start a process is refused** —
`reserve-execution`, `execute`, `terminal`, `attach-execution`,
`attach-session`, `start-detached` and `kill-session` all answer
`quiesce_in_progress` until it settles, and so does a second `quiesce`. `healthz`, `cancel-execution`,
`list-sessions`, `read-file`, `read-file-stream`, `write-file` and
`tcp-connect` are **not** refused: being able to read is the point.

**What it costs.** Everything running. An open terminal receives its exit, a
running `exec` resolves with the signal in its result (it does **not** reject),
and a session in the registry is reported `exited` with its signal rather than
detached — so `listSessions()` after a quiesce does not claim a program that no
longer exists is still running. An interactive shell ignores `SIGTERM`, so a
terminal is always ended by the escalation: every quiesce with one open spends
a full `graceMs` round before it can finish, and that pause is the design
rather than a hang.

**`graceMs` is not `terminationGracePeriodSeconds`.** They are different
clocks with different budgets. `graceMs` bounds one round's `SIGTERM` window
inside an op the host called **while the pod is still running and still
serving**; the pod's grace period bounds how long the kubelet waits after the
pod has been asked to stop. `graceMs` defaults to 1000ms and is refused at or
above the guest's own cancel-confirmation timeout
(`NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS`, 5000ms), because a marked
execution's close handler stops waiting at that bound and an escalation
landing after it would fence the agent.

**How wide the scan is allowed to be, and why the report says which.** The general
scan covers the guest's whole PID namespace, which in a pod as this repo ships
it is the container and nothing else — a pod that turns on
`shareProcessNamespace`, or that somebody has attached an ephemeral debug
container to, puts its other containers' processes in that same namespace, and
a quiesce there stops those too. The agent performs it only when it is the init of that
namespace or was started by it — the shape `k8s/entrypoint.sh` gives it, where
`tini` is PID 1 and starts the agent. An agent that is neither (embedded in
another process, or loaded into a test runner, where `/proc` is a whole
machine's) narrows itself to the kernel sessions its own registries own and
**says so**: `report.scope` is `'owned-sessions'` instead of
`'pid-namespace'`, and that scope can miss exactly the process this op exists
for. `NAMZU_AGENT_QUIESCE_SCOPE=owned-sessions` narrows it deliberately; there
is no value that forces the general scan on, because the deployment where that
would be wrong is the one where somebody would be tempted to set it.

`quiesce()` hands its caller the report, so that caller can read the scope.
`suspend({ quiesce: true })` answers `void`, so it is told instead:
`KubernetesWorkspaceOptions.onQuiesceNarrowed` receives the report whenever the
guest narrowed itself, just before the patch goes out. The sibling of
`onQuiesceUnsupported`, for the same reason — the one path that cannot read the
report must not be the one that silently under-delivers.

**A suspend already in flight cannot be joined into a quiesce.** Concurrent
`suspend()` calls share one transition: the second caller awaits the first
rather than patching again, under the first caller's `signal` and `epoch`.
`quiesce` is the one request that is not shared that way, because it is a
promise about the guest rather than an authority to write — and a transition
on its way to patching cannot be sent back to stop anything, since nothing is
admitted once its state leaves `running`. So a
`suspend({ quiesce: true })` arriving while a suspend WITHOUT one is in flight
is **rejected** with `KubernetesQuiesceUnconfirmedError`
(`reason: 'suspend_already_in_flight'`), having sent nothing and stopped
nothing, instead of being handed a resolved suspend it would trust a capture
on. A caller whose request the transition in flight already satisfies — a plain
`suspend()`, or another `suspend({ quiesce })` while one is running — joins it
as before, and one quiesce is performed between them.

**`suspend({ quiesce: true })` and `destroy({ quiesce: true })`** run it
[after this handle's terminals are reaped and before the `Suspended` patch](#a-state-is-recorded-when-the-cluster-confirms-it).
It cannot run any later: the moment the state leaves `running`, no call is
admitted and there is no pod to ask through. A quiesce that **cannot be
confirmed rejects and sends no patch** — the workspace stays running, admits
calls and keeps the state that is true — which is the same rule this verb
keeps everywhere else. `destroy({ deleteDisk: true })` ignores the option: the
disk it would be quiescing is about to be deleted with everything on it. The
standalone [`suspendKubernetesWorkspace`](#managing-workspaces-without-waking-them)
**refuses** it instead of ignoring it — that verb reaches the workspace through
the API server alone and never dials the agent, so there is nothing there to
stop a process with, and a caller that passed the flag is about to trust a
capture.

The option lives on `KubernetesWorkspaceSuspendOptions` (what `suspend()` and
the standalone verb take) and on `KubernetesWorkspaceDestroyOptions`, not on
the shared `KubernetesWorkspaceTransitionOptions`: `resume()`, `refresh()`,
`listKubernetesWorkspaces` and `deleteKubernetesWorkspace` send no patch a
quiesce could precede, so they do not accept the flag rather than accepting it
and dropping it.

**An image whose agent predates the op.** `healthz` advertises `quiesce`, and
a host only ever sends the op to a guest that did. An explicit `quiesce()`
against an image without it is refused with
`KubernetesQuiesceUnsupportedError` rather than answered with an empty list,
which would read exactly like a guest that had nothing to stop. A
`suspend({ quiesce: true })` against that same image is the one place that
degrades instead: refusing would make the option unusable against every pod
built before this release, so the suspend goes ahead as it always did and
`KubernetesWorkspaceOptions.onQuiesceUnsupported` is told — this package owns
no logger, so the diagnostic goes to the host that has one. The gap is
reported, never hidden.

**What no test here can prove.** The scan and the signalling are proved
against the real `agent/agent.cjs` running in a PID namespace of its own
(`unshare --user --pid --fork --mount-proc`), which is Linux-generic and needs
no cluster — but on a host that forbids unprivileged user namespaces those
cases do not run at all, and the narrowed-scope cases that do run prove
something weaker. Nothing here has been measured under Kata, where the guest
kernel is the microVM's rather than the node's.

### Egress covers a workspace too

`config.egress` is not a provider-only knob. `createKubernetesWorkspace` runs
the same steps [`createSandboxProvider` runs](#egress): a hostname allowlist
with no FQDN-capable `engine` declared is refused synchronously, before a
single request; the `NetworkPolicy` (or `CiliumNetworkPolicy`) an operator was
supposed to apply is `GET` and matched against the translation; and every
policy selecting the pod this call is about to create is enumerated and
refused if it lets out more than the translation does. All of it before
anything is created, and on the adopt path before any resume patch — a
workspace whose egress stopped being bounded is refused asleep rather than
woken up to be refused. A missing, drifted or over-wide policy fails the call
and no workspace is created — the network boundary on a long-lived sandbox is
the policy, not the agent's bind token.

**It is verified against the template the workspace is built from**, which is
`options.sandboxTemplateName` when given and `config.sandboxTemplateName`
otherwise. That template's name is the label this backend stamps on the pod
and the label the policy's `podSelector` has to match, so a deployment with a
separate workspace template needs its own policy object for it — named
`<workspace template>-egress` by default, or whatever `networkPolicyName`
says. The task template's policy does not select a workspace pod.

Unlike the provider's once-per-backend check, these run on every
`createKubernetesWorkspace` call — neither memo outlives the call — because
creating a workspace is a rare, explicit act with nothing to amortise, and a
policy deleted or widened since the last call has to be noticed.

### There is no delete-compute-keep-disk verb

The API has `operatingMode` and it has `DELETE`. Nothing in between. So:

- `destroy()` and `destroy({ deleteDisk: false })` **suspend** and leave the
  object standing. This is the default because `destroy()` is what a `finally`
  block calls, and a `finally` block must not be able to erase a month of a
  caller's work. The handle stays usable: it reports `status: 'destroyed'` and
  `suspended: true`, and `resume()` brings it back. A default `destroy()` is a
  suspend in every respect, that one included.
- `destroy({ deleteDisk: true })` DELETEs the `Sandbox`, which cascades to the
  Pod, the Service and the PVC through `ownerReferences`. Nothing brings the
  files back. A DELETE that fails **rejects and stays retryable**: the session
  it tore down on the way is gone, so the workspace reads `suspended: true`,
  admits nothing, and is one `resume()` away from serving again or one
  `destroy({ deleteDisk: true })` away from being deleted — both, because
  neither the delete nor a suspend reached the cluster. An object already gone
  counts as deleted, that being the state DELETE was asking for.
- The two compose, in either order: a plain `destroy()` on a workspace that
  `destroy({ deleteDisk: true })` already removed is a **no-op**, not an
  error, because `destroy()` is the verb a `finally` block calls and what it
  asks for has happened. An explicit `suspend()` on a deleted workspace still
  throws — it asks for something that cannot be done, rather than for a state
  that already holds.

### A state is recorded when the cluster confirms it

`suspend()` and `destroy()` are both idempotent, and both are idempotent by
early-returning on a recorded state. That makes the moment the state is
recorded the whole correctness question, because that early return is what
every later call reads:

| Recorded | When |
|---|---|
| suspended | the `operatingMode: Suspended` patch landed AND the pod was observed stopped |
| deleted | the DELETE resolved, or reported the object already gone |

Recording either on the way out — before the request that causes it lands —
turns a failed request into a permanent silent success. A `destroy({
deleteDisk: true })` whose DELETE 500s would throw once and answer every retry
"already deleted", leaving the `Sandbox`, its pod and its PVC standing with
nothing left that would remove them; a `suspend()` whose patch 500s would
leave a pod running, and billing, behind a handle that says it is asleep. So a
request that fails leaves the state it found, and the caller can retry.

Concurrency is covered the other way round, with a **single flight per verb**:
a second `suspend()` or `destroy()` arriving while one is in progress awaits
that one rather than sending a second request into the window the deferred
record opens. `destroy()` with no options shares the suspend's flight, because
it is a suspend. The shared request runs under the **first** caller's
`signal`; a later caller's `AbortSignal` is not consulted, and an abort by the
first rejects everyone waiting on it. That is what sharing one request means,
and a caller who needs its own cancellation scope needs its own transition.

### Nothing but an explicit delete deletes

No failure path in the workspace code ever deletes, and none of them takes a
pod away that this call did not ask the cluster for.

**A start that fails suspends only what it woke.** A create that fails after
its own `POST`, and an adopt or `resume()` whose `Running` patch took the
object out of `Suspended`, send the `operatingMode: Suspended` patch and
rethrow — leaving the disk untouched under the same deterministic name. That
half exists for the inverse hazard: a workspace this call woke and then failed
to start would otherwise be left `Running` with a pod nobody is using, burning
a node until somebody notices. **The cost is a named leak**: a create that
fails after the POST leaves one suspended `Sandbox` and its PVC standing, and
nothing reaps them. They are found again under the same `namzu-ws-<id>` name
and go away on `destroy({ deleteDisk: true })`. Deleting the object instead is
not on offer even there, because two processes can be coming up on one name at
once and the one that got the `201` deleting its "own" object would take the
disk of the one that adopted it.

Every other start failure sends **nothing**. An adopt of an object that was
already `Running`, and a `resume()` that finds another process has already
brought the workspace back, moved no mode and have none to put back. The
failures that reach them are not the workspace's: a caller's `signal` aborting
during readiness, one 5xx or 429 on a Sandbox or pod GET (the client does not
retry), a privilege probe that overran its own deadline. Patching `Suspended`
on those made the controller delete a pod the *first* process was executing
in — every terminal, dev server and running command in it — because a
*second* process failed to come up. A workspace id is a name and not a lock by
design, so that second process is the normal case: a restart, or a second
revision during a rollout.

`onStartFailure` is the knob, on `KubernetesWorkspaceOptions` (the handle's
default) and on `KubernetesWorkspaceTransitionOptions` (one `resume()`):

| Value | What a failed start writes |
|---|---|
| `'suspend-if-woken'` (default) | The `Suspended` patch, and only when this call POSTed the object or woke it |
| `'leave'` | Nothing, on any start failure, without exception — for a host that keeps its own holder record and sweeps idle workspaces itself |

The read that decides "did this call wake it" and the patch that follows are
two requests, so another process can change the object between them. With a
[holder epoch](#a-holder-epoch-fences-every-lifecycle-write) the window is
closed at the write itself: the cleanup patch carries the same epoch the
transition carried, so a holder that arrived while the start was running
refuses it and the pod it is using stays up. The refusal is swallowed like any
other cleanup failure and the primary error still reaches the caller. Without
an epoch the window is open exactly as before, and a patch the API server did
not refuse is treated as this call's own.

Writing nothing to the cluster is not the same as changing nothing about the
**handle**. A start that fails leaves this handle with no session either way,
so after a failed `resume()` that sent no patch `workspace.suspended` reads
`true` while `spec.operatingMode` is still `Running` and somebody else's pod
is serving out of it. That flag is this handle's own state, never a claim
about the cluster, and `refresh()` will not clear it — `refresh()` reports a
suspension *somebody else* performed, and this was not one. Another `resume()`
is the way back. On the create path it is not observable at all: a create that
fails returns no handle.

**An unconfirmed cancellation keeps the pod.** When an execution's
cancellation cannot be confirmed — the guest wedged, the pod partitioned, the
`cancel-execution` window closing with no answer — a command of unknown state
is left in that pod, and the shared execution controller's rule is that the
pod stops being reusable and is **retired**. A task sandbox is retired by being
DELETEd, correctly: the object is disposable and its disk is scratch. On a
workspace the equivalent was the `Suspended` patch, and it is the same defect
one size smaller: eight seconds of network loss under one `exec()` took the
pod away from every holder. So on a workspace nothing is written at all.

What happens instead:

- the `exec()` still rejects with `RemoteCancellationUnknownError`;
- it carries `retirement: { accepted: false, reason: 'workspace-kept' }` —
  `reason` is what stops a host reading it as a patch that was attempted and
  failed, and `error` is absent because nothing was attempted;
- the handle is **not** retired: `suspended` stays `false` and the next call is
  admitted;
- one bounded `healthz` goes out over a fresh connection, and its result is
  reported to `onCancellationUnconfirmed({ error, agent })`.

`agent` is the fact the error cannot carry, and the reason the probe is not
the transport's boolean `healthz()` — that answers `false` both for a fenced
agent and for one that never replied:

| `agent` | What it means | What a host does |
|---|---|---|
| `'ok'` | The agent answered and is serving normally | Nothing; the command may still be running, and the workspace is fine |
| `'retiring'` | The agent has **fenced itself**: it could not confirm a process group was gone, and refuses every op but `healthz` and `cancel-execution` until the pod is replaced | `suspend()` then `resume()` — when the host is ready for the live sessions in that pod to go down |
| `'unreachable'` | No answer at all: the pod is gone, the network is out, or the address stopped resolving | Nothing; the next call finds out, and a foreign suspend is [reported as one](#a-handle-notices-a-suspend-it-did-not-perform) |

A host that wants the old behaviour calls `suspend()` from that callback. One
that wants it only for a genuinely wedged pod calls it when `agent` is
`'retiring'`.

**A fenced agent is named rather than described as a wire fault.** A second
holder's next `exec()` on a pod whose agent has fenced itself meets
`agent_retiring` on the reservation. Unmapped it is parsed as a reservation
and rejected as `RemoteProtocolError: remote sandbox returned an invalid
execution reservation` — a message about a wire shape, for a pod telling the
truth about itself. It is `KubernetesAgentRetiringError` here, it names
`suspend()` and `resume()` in the order they have to be called, and it does
**not** retire the handle: the Firecracker tier maps the same refusal to
`RemoteCancellationUnknownError`, which is right for a disposable microVM and
would take a workspace's pod away.

What "does not retire the handle" means is that nothing was written and the
workspace is still `Running` — not that the next call will work. The fence is
the guest's own and it gates every op but `healthz` and `cancel-execution`, so
`readFile`, `writeFile`, `openTerminal` and `openTcpConnection` meet it too,
under whatever error shape their own paths make of an answered refusal. Only a
new pod clears it. The error says so, and names the verbs that replace the pod
on both tiers this transport serves — `suspend()` then `resume()` on a
workspace, `destroy()` and a fresh `create()` on a task sandbox, which has no
other lifecycle verb.

Only a caller naming a disk removes one. There are exactly two ways to —
`destroy({ deleteDisk: true })` and
[`deleteKubernetesWorkspace`](#managing-workspaces-without-waking-them) — and
both have to be typed: no failure path, no `finally` and no default reaches
either.

## What it refuses

`SandboxBackendOptions` carries per-sandbox controls this backend cannot apply,
and it refuses them by name rather than accepting and dropping them:

- `env`, `memoryLimitMb`, `maxProcesses` — these would have to ride on the
  claim, and a claim that carries them cold-starts. They belong on the
  `SandboxTemplate` the pool is built from.
- `egress` — this is a PER-CREATE override, and egress here is a
  `NetworkPolicy` attached to that template, which cannot be rewritten per
  running sandbox. The container tier's habit of emitting proxy environment
  variables as a substitute is not repeated. The backend-wide policy every
  sandbox gets is a separate, config-level knob — see [Egress](#egress) below.

`runtimeClassName` together with `warmPoolName` is refused at construction: a
pooled sandbox is already running under the `RuntimeClass` its template named,
and a claim cannot change it, so accepting it would quietly drop the choice of
VM boundary.

## Egress

`config.egress` is optional and, unlike `SandboxBackendOptions.egress` above,
applies to every sandbox this backend produces — because the enforcement
point is one `NetworkPolicy` object, not something a per-`create()` call could
rewrite:

```ts
import { createSandboxProvider } from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'kubernetes',
    namespace: 'namzu-sandboxes',
    access: { inCluster: true },
    sandboxTemplateName: 'namzu-task',
    warmPoolName: 'namzu-task-pool',
    egress: {
      policy: { kind: 'deny-all' },
      // networkPolicyName defaults to `${sandboxTemplateName}-egress`.
      // engine defaults to 'core'.
    },
  },
})
```

### What core `NetworkPolicy` can express, and what it cannot

Core Kubernetes `NetworkPolicy` has exactly three ways to name a destination —
`ipBlock` (CIDR), `podSelector`, `namespaceSelector` — and no hostname or FQDN
concept anywhere in the resource. Of the six kinds `policy` takes:

| Kind | Under `engine: 'core'` (default) | Under `engine: 'cilium'` |
|---|---|---|
| `deny-all` | A `NetworkPolicy` allowing only the cluster's own DNS (UDP/TCP 53 to `kube-system`) and nothing else. | Same — `engine` only changes the outcome for `static`/`resolver`. |
| `no-network` | A `NetworkPolicy` with `policyTypes: ['Egress']` and **no rule at all**. Nothing leaves the pod, the cluster resolver included. | Same. |
| `public-internet` | A `NetworkPolicy` allowing DNS to the resolver's own pods, plus `0.0.0.0/0` and `::/0` minus the ranges that are not the public internet. | Same. |
| `allow-all` | A `NetworkPolicy` with one unrestricted egress rule. | Same. |
| `static` / `resolver` | **Refused at construction**, before any API call: core `NetworkPolicy` cannot express a hostname allowlist at all. | A `CiliumNetworkPolicy` with a `toFQDNs` entry for every allowed host, preceded by the DNS-visibility rule Cilium's own `toFQDNs` examples require. |

`no-network` and `public-internet` are Kubernetes-only: they live on
`KubernetesEgressConfig.policy`, and the tier-wide `EgressPolicy` union is
unchanged, because no other backend can enforce either one.

```ts
import type { KubernetesEgressConfig } from '@namzu/sandbox'

const nothingOut: KubernetesEgressConfig = { policy: { kind: 'no-network' } }

const outButNotSideways: KubernetesEgressConfig = {
  policy: {
    kind: 'public-internet',
    // Added to the built-in carve-outs, never replacing them.
    exceptCidrs: ['203.0.113.0/24'],
  },
}
```

#### `deny-all` is not "no network", and is not being changed into one

`deny-all` emits a rule allowing UDP/TCP 53 to `kube-system`, and a cluster
resolver forwards outside names upstream — so a `deny-all` sandbox keeps a
channel out through DNS. That is why `no-network` exists as a separate kind
rather than as a tightening of `deny-all`: verification of the named object is
an exact match, so changing what `deny-all` emits would stop every
already-applied policy from verifying and fail every `create()` on every
deployment until an operator re-applied it. **`deny-all` and `allow-all` emit
byte-for-byte what they always have**, and a test pins both manifests by deep
equality before anything else in that file is asserted.

**A `no-network` sandbox has no resolver.** The guest agent needs none — the
host dials in — but a workload that resolves anything fails, which is the
point. Nothing carves out a name or a port: `policyTypes: ['Egress']` with an
empty rule list is the API's own spelling of "sends nothing".

#### What `public-internet` carves out, and why

`0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918 —
the cluster network, the node network and every other sandbox pod),
`100.64.0.0/10` (RFC 6598 carrier-grade NAT, which several managed offerings
hand to pods or nodes), `169.254.0.0/16` (link-local, and with it the
`169.254.169.254` instance-metadata address), `127.0.0.0/8` and
`168.63.129.16/32` (one cloud's platform endpoint). Plus `::/0` except
`fc00::/7`, `fe80::/10` and `::1/128`. `exceptCidrs` adds to that list and is
routed to the block of its own address family; an entry that is not a CIDR is
refused at construction with `KubernetesEgressPolicyConfigError` rather than
emitted into a manifest the API server would reject on apply.

The refusal is a limitation stated plainly, not a footnote: **do not read
`engine: 'cilium'` as this package adding Cilium support in general** — it is
one translation for one CNI's CRD, chosen because Cilium is the FQDN-capable
engine this batch verified a shape against. A cluster running a different
FQDN-capable engine (e.g. Calico) needs its own translation before it can take
a `static`/`resolver` policy through this config; declaring `engine: 'cilium'`
against a cluster that does not run Cilium applies a manifest nothing
enforces.

**This backend never emits `HTTP_PROXY`/`HTTPS_PROXY` as a substitute.** Those
variables are advisory — a process that ignores them is not bounded by
them — and the container tier's still-open gap in that shape is not repeated
here behind a Kubernetes-looking manifest.

### Narrowing a `static`/`resolver` allowlist: ports, DNS names, TLS server names

Unnarrowed, a `static`/`resolver` allowlist under `engine: 'cilium'` allows
**addresses, not hostnames**: `toFQDNs` allows whatever a name resolved to,
which can be one address shared by many unrelated sites (a CDN); it allows
**any port** on that address, because the translation sets no `toPorts`; and
it allows **any name to resolve** at all, because the DNS-visibility rule
carries `rules.dns: [{ matchPattern: '*' }]` — DNS itself is an open channel
out. `KubernetesEgressConfig.ciliumNarrowing` closes each of those, opt-in and
independently:

```ts
import type { KubernetesEgressConfig } from '@namzu/sandbox'

const narrowed: KubernetesEgressConfig = {
  engine: 'cilium',
  policy: { kind: 'static', allowedHosts: ['github.com'] },
  ciliumNarrowing: {
    // Ports: a default list plus a per-host override, emitted as `toPorts`
    // on each host's OWN `toFQDNs` rule (unnarrowed, every host shares one
    // rule with no ports at all; any option here switches to one rule per
    // host).
    hostPorts: { 'github.com': [443, 22] },
    // TLS server names: `serverNames: [<host>]` on the host's TLS ports
    // (default `[443]`, override with `tlsPorts`) — needs Cilium's L7 proxy.
    // A host with no `ports`/`hostPorts` entry is limited to its TLS ports
    // rather than left open, because `serverNames` needs a port to attach to.
    tlsServerNames: true,
    // DNS names: an exact `matchName` per host, plus the host under every
    // search suffix, replacing `matchPattern: '*'`. `true` uses the defaults
    // below; pass an object to override `namespace`/`clusterDomain` or add
    // more suffixes (kubelet appends the node's own, which this backend
    // cannot see).
    dnsNames: true,
  },
}
```

emits, for `github.com` in namespace `namzu-sandboxes`:

```yaml
egress:
  - toEndpoints:
      - matchLabels: { "k8s:io.kubernetes.pod.namespace": kube-system, "k8s:k8s-app": kube-dns }
    toPorts:
      - ports: [{ port: "53", protocol: ANY }]
        rules:
          dns:
            - matchName: github.com
            - matchName: github.com.namzu-sandboxes.svc.cluster.local
            - matchName: github.com.svc.cluster.local
            - matchName: github.com.cluster.local
  - toFQDNs: [{ matchName: github.com }]
    toPorts:
      - ports: [{ port: "443", protocol: TCP }]
        serverNames: [github.com]
      - ports: [{ port: "22", protocol: TCP }]
```

**Unset (every field), the translation is byte-for-byte what it always was** —
a test pins that with a deep-equality comparison — so an already-applied
policy keeps verifying after upgrading to a release carrying this option.
Setting `ciliumNarrowing` on a `deny-all`/`no-network`/`allow-all`/
`public-internet` policy, or under `engine: 'core'`, throws
`KubernetesEgressNarrowingUnsupportedError` synchronously, both from
`buildKubernetesBackend` and from `createKubernetesWorkspace`, before any
request — narrowing options only mean something next to a hostname allowlist
enforced by Cilium. `ports`/`hostPorts`/`tlsPorts` entries outside `1-65535`,
and an empty `dnsNames.clusterDomain` or search suffix, are refused the same
way with `KubernetesEgressPolicyConfigError` rather than emitted into a
manifest the API server would reject on apply.

**Verification needs no separate statement of these fields**: `spec.egress` is
compared to the translation exactly, the same deep-equal check described
below, so a `toPorts`, `serverNames` or narrowed DNS entry the applied object
is missing throws `KubernetesEgressPolicyMismatchError` naming it. The union
check (below) is extended the same way it always compares ports on every
other peer kind: a second `CiliumNetworkPolicy` naming an allowed host with a
wider port set, or with no `toPorts` at all, is read as `widens-egress` even
though the host name itself is on the allowlist.

**Delete the shipped kube-dns rule when DNS-name narrowing is on — and the
union check now refuses the create if you don't.** Cilium's own precedence
rule says that when an L4 rule and a similar L4 rule carrying L7 rules both
select a pod, the L7 portion of the LATTER has no effect. The narrowed
`CiliumNetworkPolicy`'s DNS-visibility rule carries an L7 restriction (the
exact `matchName` list above); `packages/sandbox/k8s/manifests/
networkpolicy.yaml` and both `sandboxtemplate-*.yaml` templates' managed
`networkPolicy` ship a plain, L4-only kube-dns rule selecting the same pods on
the same port. Left in place, that plain rule cancels the narrowing: every
name resolves again regardless of the configured allowlist. Both shipped
files say so, at the rule itself, and name exactly what to delete — see
`packages/sandbox/k8s/README.md`'s egress section. Port and TLS-server-name
narrowing have no such interaction and need no manifest edit.

That plain rule reaches the exact same peer and port the narrowed
`CiliumNetworkPolicy` itself allows for DNS, so reachability alone cannot
tell the two apart — `EgressAllowance.dnsNarrowedTo` is the field that can:
under the default `egress.verify: 'union'`, `coreEgressRuleVerdict` and
`ciliumEgressRuleVerdict` both check, before their ordinary peer/port
comparison, whether a rule reaching the cluster resolver on the DNS port
narrows WHICH names it resolves to a set at least as small as
`ciliumNarrowing.dnsNames`'s own — a plain `NetworkPolicy` never can (core has
no L7 concept at all), and a second `CiliumNetworkPolicy` only counts if its
own `toPorts[].rules.dns` names a subset of the same list. Either way, a rule
that fails that test is `policy-widens-egress`, named in the refusal, and
`createKubernetesWorkspace`/the provider's `create()` fails rather than
creating a sandbox whose DNS-name allowlist a leftover manifest rule quietly
defeats. `egress.verify: 'named-object-only'` skips this check along with the
rest of the union read — that deployment still has to delete the rule by
hand, and gets no refusal if it forgets.

**What this narrows and what it does not.** `serverNames` matches the TLS
Client Hello's SNI value, which is visible before the handshake completes —
it does not see the HTTP `Host` header inside an established TLS connection,
and it enforces nothing on a non-TLS port (`22` in the example above is
filtered by address and port only, exactly like the unnarrowed translation).
DNS-name narrowing bounds what the sandbox's OWN lookups through the cluster
resolver may ask for; it does not stop a workload that already knows an IP
address from dialing it directly if that address is otherwise reachable
(`toFQDNs` still gates the connection itself). None of the three options is
probed by any script this repository ships — see "What no egress test here
can prove" below.

### The label every translated policy selects by

Every Sandbox this backend creates carries the label
`sandbox.namzu.ai/template: <sandboxTemplateName>` on its pod, and the
translated `NetworkPolicy`'s `podSelector` (or, under `engine: 'cilium'`, the
`CiliumNetworkPolicy`'s `endpointSelector`) matches that label. This backend
adds the label itself for a Sandbox it creates directly — agent-sandbox's own
controller-owned `agents.x-k8s.io/sandbox-template-ref-hash` label is written
only on a Sandbox **adopted** out of a `SandboxWarmPool`, never on one this
backend POSTs directly.

**A `SandboxTemplate` a `SandboxWarmPool` is built from must carry the same
label on its own `podTemplate.metadata.labels`** (value = that template's own
name), or a pooled sandbox's pod will not match the translated policy at all —
this backend has no path to add the label to a pool's pods after the fact.
`packages/sandbox/k8s/manifests/sandboxtemplate-task.yaml` (a later change)
carries it; a hand-written `SandboxTemplate` must add it too.

### Verify, never trust

This backend never CREATES the `NetworkPolicy` (or `CiliumNetworkPolicy`) —
like the docker backend's network, egress here is operator-applied so the
network boundary gets reviewed by whoever has cluster-admin, not by whatever
created the ServiceAccount token this backend runs with. What it does instead
is two checks, and setting `config.egress` now runs both.

**One: the named object, exactly.** The first `create()` after construction
(never `createSandboxProvider` itself, which still contacts nothing) `GET`s the
object named by `networkPolicyName` (default `${sandboxTemplateName}-egress`)
and asserts its `podSelector` / `endpointSelector`, `policyTypes` and `egress`
rules match the translation **exactly**. A missing object fails with
`KubernetesEgressPolicyNotAppliedError`, a drifted one with
`KubernetesEgressPolicyMismatchError` naming the field, and no sandbox is
claimed. It runs once per backend, not once per `create()`; a failed attempt is
not cached, so fixing the cluster and calling `create()` again retries it.

**Two: every policy that selects the pod.** A name proves an object exists. It
does not prove that object is the only thing deciding what leaves the pod — and
the API server **unions** every policy selecting a pod, so traffic leaves if
*any* of them allows it. So the check also `LIST`s the namespace's
`NetworkPolicy` objects (and, under `engine: 'cilium'`, that CNI's policy CRD
too), evaluates each selector against the pod's **real labels**, and refuses
with `KubernetesEgressPolicyUnionError` when:

- any selecting policy allows a destination the translation does not — under
  `no-network`, that is *any* egress rule at all (`refusal:
  'policy-widens-egress'`);
- nothing selecting the pod puts it in egress default-deny, so the translation
  bounds nothing it sends (`refusal: 'no-enforcing-policy'`); this is skipped
  under `allow-all`, which asks for no boundary;
- a policy, a peer or a port cannot be read at all — a named container port, an
  unreadable selector, or a collection this Role may not `list` (`refusal:
  'not-evaluable'`).

The refusal names the pod's labels and **every policy examined with a verdict
each** (`within`, `widens-egress`, `does-not-select`, `not-egress-scoped`,
`not-evaluable`), so "why does my policy not count?" is answered by the line
saying it did not select these labels. A pass is cached per label set for **at
most five minutes** — not for the backend's lifetime, so a widening policy
applied at 10:00 is noticed without restarting the host — and a failure is
never cached.

**The template-managed policy counts like any other.** A `SandboxTemplate` that
sets `networkPolicy` has it translated by the agent-sandbox controller into a
policy of the controller's own, and a template that omits the block gets the
controller's default (`0.0.0.0/0` minus RFC 1918 and `169.254/16`) **instead**.
Neither is a baseline underneath anything: dropping `networkPolicy` from a
template opens the internet while the named egress object still verifies
perfectly. That is the hole this second check closes, and the shipped
`k8s/manifests/sandboxtemplate-task.yaml` comment that claimed otherwise is
corrected in the same change.

**Whose subset is decided conservatively.** A second policy passes only when
the check can *show* it is inside the translation — a narrower CIDR inside an
allowed block whose carve-outs it also carves out, or a selector with every
constraint the translation places plus more. Anything it cannot place inside
refuses. That is deliberate: the alternative is a checker that reports "close
enough" about a network boundary.

```ts
import type { KubernetesEgressConfig } from '@namzu/sandbox'

// Restores exactly the single-object check of every release before this one:
// one GET of one named object, memoized for the backend's lifetime, and no
// enumeration at all. For a deployment whose other policies a namespaced Role
// cannot read, or which accepts the union it has.
const singleObject: KubernetesEgressConfig = {
  policy: { kind: 'deny-all' },
  verify: 'named-object-only',
}
```

[`createKubernetesWorkspace`](#egress-covers-a-workspace-too) runs both checks
with its own timing — every call, against its own template's policy — because a
workspace never passes through the provider.

### What no egress test here can prove

That the cluster **enforces** the policies it accepted. The stock local `kind`
cluster accepts every `NetworkPolicy` and enforces none of them, and it runs no
Cilium data plane at all, so an "it was blocked" probe there passes for the
wrong reason and no result from it is evidence. Everything above is proved
against a fake API server: the emitted manifests, the union verdicts one shape
per case, the cache and its expiry, and that a refusal leaves no claim and no
`Sandbox` behind.

`k8s/scripts/egress-check.mjs` is the live check, and it is the only thing that
speaks to enforcement: it creates a sandbox under the configured kind and dials
from inside the guest — a public address, the instance-metadata address, the
platform endpoint, a private address, optionally the API server's service IP,
and another sandbox pod. Two positive controls run first (a TCP dial of the
pod's own agent port on loopback, which no policy governs, and a resolution of
`localhost`) and the script refuses to report any real probe if either control
fails, so a broken prober can never read as a perfect boundary. On a
non-enforcing cluster it reports FAIL, which is the intended outcome.

**The `static`/`resolver` hostname allowlist is not probed by anything, narrowed
or not.** It is enforced at L7 by one CNI's own agent; nothing in this repo has
measured that a narrowed `toPorts`, `serverNames` or DNS-name restriction is
actually enforced by a real Cilium data plane, and this page does not claim
it. Confirming that needs a real Cilium cluster and a positive control (a name
that IS on the allowlist still resolving and connecting) alongside the
negative one — a `cilium policy trace` or BPF policy dump showing the narrowed
rule is the one in force is the strongest evidence, because a probe that
merely reports "blocked" cannot tell a working narrowing from a broken guest.

## Ingress

**`packages/sandbox/k8s/manifests/networkpolicy.yaml` is required.** Every
create — `provider.create()` and `createKubernetesWorkspace` alike — proves
that an applied policy actually closes `agentPort` on the pod it is about to
hand back, and refuses by name when none does.

The field is absent in the normal case, because absent means verify. These are
the only two other spellings:

```ts
import { createSandboxProvider } from '@namzu/sandbox'

// Enumerate that CNI's own policy CRD as well as core NetworkPolicy. `engine`
// defaults to `egress.engine` when one is configured, and to 'core' otherwise.
const cilium = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'kubernetes',
    namespace: 'namzu-sandboxes',
    access: { inCluster: true },
    sandboxTemplateName: 'namzu-task',
    ingress: { engine: 'cilium' },
  },
})

// Read no policy at all: this deployment closes the port somewhere a
// namespaced Role cannot see, and says so on purpose.
const optedOut = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'kubernetes',
    namespace: 'namzu-sandboxes',
    access: { inCluster: true },
    sandboxTemplateName: 'namzu-task',
    ingress: 'unverified',
  },
})
```

`engine` decides which resources get **enumerated**, so declare
`ingress: { engine: 'cilium' }` on a cluster whose policies are
`CiliumNetworkPolicy` objects even when `egress` is unset and there is nothing
else to configure. At `'core'` the check reads core `NetworkPolicy` only —
never the wrong list, but on such a cluster an incomplete one, and a
`CiliumNetworkPolicy` standing the agent port open is then a policy it never
examined. A `CiliumClusterwideNetworkPolicy` is out of scope either way: it is
cluster-scoped, a namespaced `Role` cannot read it, and a deployment whose
boundary lives there wants `ingress: 'unverified'`.

### Why this is on by default

Two shipped comments call the policy the boundary on the agent port, and the
guest agent's own source says the same. Nothing verified one existed. Measured
on a managed cluster running a policy-capable CNI: pods this backend POSTed had
enforcement on **egress only**, and TCP 1024 answered from a pod in another
namespace, a pod on another node, an unlabelled pod in the sandbox namespace
and host-network pods — with zero policy drops. Warm-pool pods, which carry a
label the controller writes, correctly dropped every SYN.

The reason it looked covered is the shape the templates still carry. A
`SandboxTemplate`'s inline `networkPolicy` block is translated by the
agent-sandbox controller into a policy selecting
`agents.x-k8s.io/sandbox-template-ref-hash` — a label written **only** onto a
Sandbox adopted out of a `SandboxWarmPool`. Every workspace and every pool-less
task sandbox is POSTed directly and never gets it, so for those pods the inline
block selects nothing. `networkpolicy.yaml` is the object that does select them,
by `sandbox.namzu.ai/template` **existing**, and it was verified by nothing.

An opt-in check would have been read by the deployments that already closed the
port and skipped by the ones that had not, so it fails closed with a named
opt-out — the same way [egress](#egress) refuses rather than degrades.

### What passes

Two conditions, because [`NetworkPolicy` objects union](#egress): a connection
is allowed if **any** policy selecting the pod allows it, and a pod no
ingress-enforcing policy selects is allowed everything.

1. At least one policy that **default-denies ingress** selects the pod. For a
   core `NetworkPolicy` that means `policyTypes` includes `Ingress` (an absent
   `policyTypes` is defaulted by the API server and always does); for a
   `CiliumNetworkPolicy` it means the rule carries an `ingress` section **and**
   does not carry `enableDefaultDeny: { ingress: false }`, which since Cilium
   1.16 makes a rule allow without isolating the endpoint — it closes nothing,
   so it cannot be the policy that covers the port. What such a rule admits is
   still read, and still opens the port: allowing is the half it does do — and
   for the same reason a rule there this check cannot read is undecidable and
   refuses, rather than being filed under the policy that closes nothing.
2. **No** policy selecting the pod admits a wide-open peer on the agent port.
   One open rule opens the port however many closed ones sit beside it.

A rule counts as open when its ports cover the agent port (TCP, an absent or
empty `ports`, a matching number, or an `endPort` range spanning it) **and** its
source is unbounded:

| Resource | Wide-open source |
|---|---|
| `NetworkPolicy` | `from` absent or empty; a peer with `namespaceSelector: {}` and no narrowing `podSelector`; an `ipBlock` of `0.0.0.0/0` or `::/0` (an `except` list does not narrow it into something closed) |
| `CiliumNetworkPolicy` | `fromEntities` containing `all`, `cluster` or `world`; `fromCIDR`/`fromCIDRSet` of `0.0.0.0/0` or `::/0`; a rule with `toPorts` and no `from…` selector at all, which that CRD reads as every source |

A bare `podSelector: {}` peer — every pod in the sandbox namespace — is
deliberately **not** called wide open, and neither is its Cilium spelling,
`fromEndpoints: [{}]`. Each is broad, and each is still a constraint; refusing
them would refuse the legitimate deployment whose host runs beside its
sandboxes, and a check that fires on a correct policy is a check somebody
switches off.

Selection is decided from the pod's **real labels**, never a policy name: for a
directly created Sandbox, the labels the create body stamps — known before the
POST, so a refusal leaves no Sandbox and no PVC behind — and for a claimed one,
the bound pod's own `metadata.labels`, read off the same object the bind token
comes from. A GET of a policy by name would prove the object exists and not
that its selector still matches these pods.

### What it will not guess

A policy it cannot evaluate — a selector operator this check does not
implement, a `CiliumNetworkPolicy` selector keyed by a label source that is not
a pod label (`reserved:` most of all, since that is the source an operator is
most likely to have written; `k8s:` and `any:` are the two it can map), a named
container port it cannot resolve to a number — refuses the create rather than
being assumed open or closed.

So does a field that arrives as something the schema does not declare: a
`spec.ingress` that is not a list of rules, a `podSelector` that is not a
selector, a `fromCIDR` that is a string rather than a list of them. None of
those is read as its empty value, because reading an unreadable `spec.ingress`
as "no rules" would report the agent port closed on the strength of a field
nobody could parse — the same shape of claim this check was written to end. A
validating API server does not serve such objects, which is exactly why the
rule is written down rather than left to be noticed.

A `403` on the list (the Role is missing `list`) and a `404` on the Cilium
collection under `engine: 'cilium'` (the CRD is not installed) refuse too, and
the refusal then names the collection it could not read rather than describing
a namespace nobody enumerated — and says that no policy was read at all only
when none was. Every one of these says what to grant or what to declare.

Three limits are real and do **not** refuse, because refusing on them would
refuse correct deployments. Read a pass with them in mind:

- **Before the POST only the labels the create body stamps exist.** The
  agent-sandbox controller writes its own afterwards —
  `agents.x-k8s.io/sandbox-name-hash`, and the ref-hash on a pooled bind — and
  a check that runs before the object exists cannot see them. For COVERAGE that
  is fail-closed: a policy selecting a controller-written label does not count,
  so the create is refused rather than admitted. For an OPENING it is not — a
  wide-open rule whose `podSelector` keys on one of those labels reads as
  `does-not-select` and is never counted against the pod. The claim path has no
  such gap: it reads the bound pod's own labels off the live object.
- **A `podSelector: {}` peer passes**, as the table above says. It admits every
  pod in the sandbox namespace, other sandboxes included, so a pass means the
  port is shut to the cluster at large — not that only the host can reach it.
- **The wide-open CIDRs are exactly `0.0.0.0/0` and `::/0`.** An `ipBlock` of
  `0.0.0.0/1`, of `10.0.0.0/8` or of the cluster's own pod CIDR reads as narrow
  and passes, however much it admits in practice.

### The refusal

`KubernetesIngressPolicyError`, exported from `@namzu/sandbox` and catchable by
class. It carries `refusal` (`'no-covering-policy'`, `'port-open'` or
`'not-evaluable'`), the pod's labels, the agent port and **every policy
examined** with a verdict each — that list is the debugging session, because
the answer to "why does my policy not count?" is the line saying it did not
select these labels. It is distinct from every other refusal a create can
raise, so an open agent port is never confused with an unenforceable egress
policy.

It also carries `unread`: the policy collections that could **not** be
enumerated, each with the path, whether the API server refused the read
(`'forbidden'`) or served no such collection (`'absent'`), and the reason. An
empty `examined` means two different things and nothing else tells them apart —
the namespace holds no policy, which is a fact about the cluster, or none was
read, which is a fact about this check — so the message says "the namespace
holds no policy of the kinds read" only when a list actually came back empty,
and names granting the missing verb rather than applying a policy when it never
got to look. Whatever WAS read is still reported: a `404` on the Cilium
collection after the core list came back still lists those core policies with
their verdicts, and the sentence naming the fix says the read was partial
rather than that nothing was read.

### `ingress: 'unverified'`

Reads no policy and issues no request. It is the supported answer for a
deployment whose boundary lives somewhere a namespaced `Role` cannot see — a
cluster-scoped policy, a service mesh's own authorization layer, a cloud
security group — and it is a claim a deployment makes on purpose rather than a
default it inherits. It is a legitimate configuration, not a code smell.

### When it runs, and what it costs

`provider.create()` runs it before the POST for a direct Sandbox, and after the
bind for a claim (where a refusal releases the claim through the same cleanup a
failed privilege probe uses). The result is cached **per label set**, not once
per backend: a pooled sandbox's labels come off the pool's template and a
pool-less one's off config, so a single memo would answer for a pod it never
examined. A failed attempt is not cached.

`createKubernetesWorkspace` re-checks on **every** call, before the POST, which
also means before the adopt path's resume patch: a workspace whose port stopped
being covered is refused asleep rather than woken up to be refused.

The cost is one `list` per label set against the API server the create is
already talking to, and it is spent from the **same** `readyTimeoutMs` budget
as the rest of that create — there is no second clock. A create already close
to its deadline can therefore expire on the policy list rather than on the
bind; on the claim path that releases the claim, as any other failure there
does. A deployment that sees this is a deployment whose `readyTimeoutMs` was
already too tight for its API server.

### This backend never creates the policy

Same rule the [egress](#verify-never-trust) path documents: operators apply the
boundary so it gets reviewed by whoever has cluster-admin, not by whatever
created the ServiceAccount token this backend runs with.

### What no test here can prove

That the cluster **enforces** the policy it accepted. That is a CNI property.
The stock local `kind` cluster accepts every `NetworkPolicy` and enforces none
of them, so a "the port is closed" probe there passes for the wrong reason, and
no result from it is evidence. `k8s/scripts/ingress-check.mjs` is the live
check: it creates a workspace, then dials its agent port **from inside a second
sandbox** — a pod outside the host selector — and passes only if that
connection fails. It runs a positive control first (the same probe program
against a port that must be open) and refuses to report the real probe at all
if the control comes back closed, so a broken probe can never be read as a
closed port. On a non-enforcing cluster it reports FAIL, which is the intended
outcome rather than a defect.

## RBAC

The ServiceAccount the host runs as needs, in the sandbox namespace:
`create`/`get`/`list`/`patch`/`delete` on `sandboxclaims`,
`create`/`get`/`list`/`patch`/`delete` on `sandboxes`, `get` on
`sandboxtemplates`, `get` on `sandboxwarmpools`, `get`/`list` on `pods`,
`list` on `networkpolicies` (`networking.k8s.io`) — which the default-on
[ingress check](#ingress) issues before every create, and which the [egress
union check](#verify-never-trust) issues too whenever `config.egress` is set —
and `get` on the same resource, for the egress named-object check, also only
when `config.egress` is set. Under `engine: 'cilium'` on either check, the
same two verbs on `ciliumnetworkpolicies` (`cilium.io`). `list` rather than
`get` is what both enumerating checks need, because each has to read every
policy in the namespace and evaluate its selector; a `get` by name would prove
an object exists and not that it selects these pods. Without `list`, a
deployment that sets `config.egress` fails every create with a
`not-evaluable` refusal naming the missing grant — `egress.verify:
'named-object-only'` is the supported answer for a host that cannot be
granted it. No consumer role is published upstream. A `403` surfaces as an
error naming the verb and the resource and never the token.
[Workspaces](#persistent-workspaces) add exactly one verb to that list:
`list` on `sandboxes`, which
[`listKubernetesWorkspaces`](#managing-workspaces-without-waking-them) needs
to read the collection. Every other read in this backend is a `GET` by a name
it already knows, and the rest of what a workspace uses —
`create`/`get`/`patch`/`delete` on `sandboxes`, `get` on `sandboxtemplates`,
`get`/`list` on `pods` — the task path already required.

`list` on `sandboxclaims` is the task path's own crash-recovery verb:
[`releaseKubernetesTaskSandboxes`](#a-crashed-hosts-claims-labels-release-and-capacity)
has to find a predecessor's claims by label before it can delete them, and
`readKubernetesTaskCapacity` counts every claim bound to the configured pool.
A deployment that does not re-apply `k8s/manifests/rbac.yaml` after taking
this change gets a `403` the first time either function runs — never from
`create()`, which never lists the collection. `get` on `sandboxwarmpools` is,
as of this change, a backend need rather than only a diagnostic script's: it
is what `readKubernetesTaskCapacity` reads for `warmPool.ready`/`.desired`.

## Deployment

The cluster artifacts the rest of this page assumes are under
`packages/sandbox/k8s/` (never published — the package's `files` array
packs only `dist` and `src`; `npm pack --dry-run` from `packages/sandbox`
confirms it): the guest image (`k8s/Dockerfile`, `k8s/entrypoint.sh` — a
workspace pod's root start formats and mounts its raw block device, then
`exec`s into `setpriv`, which drops every capability and execs `tini` — the
container's real PID 1 and subreaper — which in turn runs the guest agent as
its child; a task pod skips the format/mount branch entirely, starting
non-root at the pod level already — see [the privilege probe
section](#each-shipped-templates-securitycontext) for the two shapes; the
format decision itself trusts only `blkid`'s exit status — 2, "no filesystem
found", confirmed by a raw read of the device — never treating a missing or
failing `blkid` as "the disk is empty". The image also carries no set-id
(setuid/setgid) binary: `k8s/Dockerfile`'s `RUN find / -xdev -perm /6000
-type f -exec chmod ug-s {} +` strips the bit from every one Debian's
`util-linux`/`e2fsprogs` ship — `su`, `mount`, `umount`, `passwd`, `chsh`,
`chfn`, `gpasswd`, `newgrp`, `chage`, `expiry`, `/usr/sbin/unix_chkpwd` —
defence in depth for a process that ever runs non-root without
`--no-new-privs` set some other way, though nothing here depends on it. A
task image that `FROM`s this one and layers its own packages on top must
repeat that exact `find`/`chmod` step after its own installs, since a
package it adds can reintroduce a setuid/setgid binary this image already
cleared), the `RuntimeClass` / `SandboxTemplate` / `SandboxWarmPool` /
`NetworkPolicy` / RBAC manifests (`k8s/manifests/`, plus a `kind-overlay/`
for local development — explicitly **not** a security boundary, see that
overlay's own header comment), and six scripts under `k8s/scripts/` that
each measure one acceptance criterion below against a live cluster and print
a `[PASS]`/`[FAIL]` line plus the measured number
(`k8s/scripts/capability-check.mjs` additionally prints the guest's
`Seccomp` value and its set-id file count, informationally — see above).
`k8s/README.md` has the full apply order and the RuntimeClass confirmation
step — its registered name has drifted between published sources and must be
read off `kubectl get runtimeclass`, never trusted from a file in this repo.

### Acceptance numbers

To be gathered on a Kata cluster. Every row below is currently unfilled;
the script named is what fills it in, and `k8s/README.md` says how to run
each one.

| Criterion | Script | Target | Measured | Date | Cluster |
|---|---|---|---|---|---|
| 1. The Sandbox contract passes against a live sandbox | `k8s/scripts/contract-suite.mjs` | every case passes | — | — | — |
| 2. Warm-pool acquire latency | `k8s/scripts/acquire-p50.mjs` | p50 < 1s | — | — | — |
| 3. A workspace's disk survives suspend/resume | `k8s/scripts/suspend-resume.mjs` | pass | — | — | — |
| 4. Small-file IO on the block PVC vs. host ext4 | `k8s/scripts/io-compare.mjs` | ≤ 1.5x | — | — | — |
| 5. The guest is genuinely deprivileged | `k8s/scripts/capability-check.mjs` | pass | — | — | — |
| 6. The agent port is shut to a pod that is not the host | `k8s/scripts/ingress-check.mjs` | the probe fails to connect | — | — | — |
| 7. Egress is bounded by the configured kind | `k8s/scripts/egress-check.mjs` | every "must be closed" probe fails to connect, and `public-internet` reaches a public address | — | — | — |

Rows 6 and 7 need a cluster whose CNI enforces `NetworkPolicy`. On one that
does not — the stock local `kind` cluster — both scripts report FAIL by
design; see [Ingress](#what-no-test-here-can-prove) and
[Egress](#what-no-egress-test-here-can-prove). Row 7 also needs
`config.egress` set to the kind being probed, and it does not cover the
`static`/`resolver` hostname allowlist, which is enforced at L7 by one CNI's
own agent and which nothing here has measured.
