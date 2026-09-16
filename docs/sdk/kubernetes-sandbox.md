---
type: Guide
title: Kubernetes sandboxes
description: Claim VM-isolated sandboxes from an agent-sandbox warm pool on any Kubernetes cluster — the config shape, the pristine-claim rule that keeps the acquire sub-second, the per-instance agent credential, which Sandbox capabilities it serves and which it deliberately omits, the acquire-time privilege probe, the lease that keeps a long run's pod alive, egress policy translation and verify-not-trust.
resource: packages/sandbox/src/backends/kubernetes/index.ts
tags: [sdk, sandbox, kubernetes, kata, warm-pool]
status: draft
generated: { by: human:bahadirarda, at: 2026-09-16T00:00:00Z }
---

# Kubernetes sandboxes

`@namzu/sandbox` can acquire a sandbox from a Kubernetes cluster running the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller
(v1.0.2). Sandboxes are claimed out of a `SandboxWarmPool`, which is how the
acquire stays inside a second, and the pod runs under whatever `RuntimeClass`
the cluster's `SandboxTemplate` names — a Kata class makes the boundary a
hardware-virtualized guest rather than a namespace.

Acquire, readiness, address resolution, the execution surface, teardown and
egress translation/verification are implemented. Persistent workspaces
(suspend/resume with a block-mode disk) and the cluster manifests are not —
see [what is not here yet](#what-is-not-here-yet).

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
| `readyPollIntervalMs` | `50` | A pool bind lands in ~120 ms; a half-second poll would sleep through the budget. |
| `readyTimeoutMs` | `60000` | Whole clock from create to an addressed, Ready sandbox — and then, a second time, the budget the [privilege probe](#the-privilege-probe) may spend on the guest, capped at 15 seconds. A `create()` that goes wrong in both halves therefore takes up to this **plus** `min(this, 15s)`: 75 seconds at the default, 1 second if you set it to 500 ms. |
| `claimTtlSeconds` | `3600` | Wall-clock lifetime written into every created object, and the amount each [lease renewal](#the-lease) pushes it forward. |
| `onLeaseRenewalError` | unset | Where a failed lease renewal is reported. Changes no behaviour; see [the lease](#the-lease). |
| `runtimeClassName` | unset | Pool-less path only — see [refusals](#what-it-refuses). |

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
exactly `warmPoolRef` and `lifecycle` and nothing else.

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
| `writeFile`, `readFile` | Implemented | Base64 over the framed protocol, jailed to the guest workspace. See the size limit below. |
| `listFiles` | Implemented | `find -printf '%p\t%s\n'`, parsed line by line; a root that does not exist is an empty list. |
| `openTerminal` | Implemented | A real PTY owned by the guest. `destroy()` kills and awaits every terminal it returned, which is what makes offering it compliant at all. |
| `openTcpConnection` | Implemented | Guest loopback only. |
| `destroy` | Implemented | DELETEs the object this backend created, which cascades to the Pod, Service and Sandbox. Idempotent; an object already gone counts as released. |
| `setNetworkPolicy` | **Omitted** | Egress here is a `NetworkPolicy` attached to the pool's `SandboxTemplate`; there is no per-running-pod knob. The SDK's contract says a backend that cannot enforce one must omit it rather than accept it and quietly not apply it. |
| `spawnDetached` | **Omitted** | The guest agent has no op that starts a process and hands it back running. A host that needs background jobs is told no. |
| `walkFiles` | **Omitted** | Not in this batch. A host requiring bounded search refuses an absent method, which is the honest answer today. |

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

### The write-file size limit

Because every request dials a fresh connection, each request is also that
connection's first frame — the one the guest has not authenticated yet, since
the credential rides inside the envelope. It is therefore bounded by the
guest's pre-auth frame ceiling (`NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES`,
8 MiB by default) on **every** call, not once on first use. A `writeFile`
whose base64 body would exceed it throws `AgentPreauthFrameTooLargeError`
(exported from `@namzu/sandbox`) **before** dialing, naming the limit.
Roughly: bodies above ~5.9 MiB raw do not fit. Chunking a large body across
frames is not implemented; raise the deployment's ceiling or split the write.

## Running the conformance suite

The table above is a claim about the `Sandbox` contract, and until this batch
nothing checked that claim against more than one backend. `defineSandboxConformance`
(`packages/sandbox/src/testing/sandbox-conformance.ts`) is a suite any `Sandbox`
implementation can be run against — `exec`'s exit codes and streamed output,
the `AbortSignal` contract (the process is genuinely terminated, never a
resolved result that looks like an unaborted success), a `writeFile`/`readFile`
round trip including binary content, `listFiles`, `openTerminal` ownership on
`destroy()`, `openTcpConnection` to guest loopback and its refusal of a
non-loopback host, destroy idempotence, and every call failing once destroyed.
`openTerminal` and `openTcpConnection` are optional on the SDK's own contract,
so a factory whose sandbox omits either capability skips that section rather
than failing it.

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

Both shipped backends run it today, against the same kind of fixture this
page's other tests use: a real `agent/agent.cjs` on a loopback socket, no
cluster and no microVM. Passing against two independently-implemented
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

The image's entrypoint is expected to end with
`exec setpriv --reuid --regid --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- node agent.cjs`.
Nothing in the agent knows about that, and nothing on the host can see it —
which is why it is asked, not assumed.

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
- A failed renewal is **reported to `onLeaseRenewalError` and retried on the
  next tick**, half a TTL before anything expires. A transient API error does
  not retire a working sandbox. (`@namzu/sandbox` owns no logger and reads
  none from module scope, which is why the diagnostic is handed to the host
  rather than printed.)
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
concept anywhere in the resource. Of the four `EgressPolicy` kinds:

| Kind | Under `engine: 'core'` (default) | Under `engine: 'cilium'` |
|---|---|---|
| `deny-all` | A `NetworkPolicy` allowing only the cluster's own DNS (UDP/TCP 53 to `kube-system`) and nothing else. | Same — `engine` only changes the outcome for `static`/`resolver`. |
| `allow-all` | A `NetworkPolicy` with one unrestricted egress rule. | Same. |
| `static` / `resolver` | **Refused at construction**, before any API call: core `NetworkPolicy` cannot express a hostname allowlist at all. | A `CiliumNetworkPolicy` with a `toFQDNs` entry for every allowed host, preceded by the DNS-visibility rule Cilium's own `toFQDNs` examples require. |

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
created the ServiceAccount token this backend runs with. Instead, the first
`create()` after construction (never `createSandboxProvider` itself, which
still contacts nothing) `GET`s the object named by `networkPolicyName`
(default `${sandboxTemplateName}-egress`) and asserts its `podSelector` /
`endpointSelector`, `policyTypes` and `egress` rules match the translation
exactly. A missing object or a mismatched one fails that `create()` with a
named error identifying which field is wrong, and no sandbox is claimed —
this check never trusts that an object with the right name does what config
says. It runs once per backend, not once per `create()`; a failed attempt is
not cached, so fixing the cluster and calling `create()` again retries it.

## RBAC

The ServiceAccount the host runs as needs, in the sandbox namespace:
`create`/`get`/`patch`/`delete` on `sandboxclaims`,
`create`/`get`/`patch`/`delete` on `sandboxes`, `get` on `sandboxtemplates`,
`get`/`list` on `pods`, and — only
when `config.egress` is set — `get` on `networkpolicies` (`networking.k8s.io`)
or, under `engine: 'cilium'`, `get` on `ciliumnetworkpolicies` (`cilium.io`).
No consumer role is published upstream. A `403` surfaces as an error naming
the verb and the resource and never the token.

## What is not here yet

This batch delivers the config type, both acquire paths, readiness, address
resolution, the execution surface, the privilege probe, the lease, teardown
and egress translation/verification. Still to come, each in its own change:

- **Workspace lifecycle.** Suspend, resume, and a persistent block-mode disk.
- **Cluster manifests.** The image, the `RuntimeClass`, `SandboxTemplate`,
  `SandboxWarmPool`, `NetworkPolicy` and RBAC the above assumes.
