---
type: Guide
title: Kubernetes sandboxes
description: Claim VM-isolated sandboxes from an agent-sandbox warm pool on any Kubernetes cluster — the config shape, the pristine-claim rule that keeps the acquire sub-second, the per-instance agent credential, which Sandbox capabilities it serves and which it deliberately omits, the acquire-time privilege probe, the lease that keeps a long run's pod alive, persistent block-disk workspaces with suspend and resume, egress policy translation and verify-not-trust.
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
`exec setpriv --reuid --regid --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- tini -- node agent.cjs`.
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
`Sandbox`, plus `suspend()`, `resume()`, a `suspended` flag and a `destroy()`
that takes `deleteDisk`. Those live on a type exported from `@namzu/sandbox`
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

**A workspace id is a name, not a lock.** Nothing stops two host processes from
adopting the same running workspace; each gets its own handle over the same
pod, and either one's `destroy()` suspends the pod the other is executing in.
That coordination is the caller's, and this backend does not pretend to it.

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

`suspend()` merge-PATCHes `spec.operatingMode: Suspended` — that exact body
and nothing else — and resolves only once the pod has actually stopped, not
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

How much of the address actually moves depends on the Service. Every Sandbox
this backend creates carries `service: true`, and the Service outlives the pod,
so when the resolved address is `status.serviceFQDN` it is the same string
before and after — the pod behind it, and the token, are what changed. A pod
IP, which is what is left when there is no `serviceFQDN`, changes every time.
The handle re-resolves either way, because it cannot know in advance which of
the two it will be handed; an operator debugging a resume should expect the
token to be new and the FQDN not to be.

The pod read skips any pod carrying a `deletionTimestamp` or in a terminal
phase. For as long as the outgoing pod is still terminating, a `GET` by name
can answer with it rather than with the new pod, and a list by the sandbox's
selector can return it beside the new one — binding to its uid produces a
token the new agent refuses, reported as a flat `unauthorized` with nothing
pointing at the race.

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
recorded that way — an explicit `suspend()`, the retirement of a pod that
[stopped answering](#nothing-but-deletedisk-deletes), and the cleanup after a
failed create or resume, which swallows its own failure so the primary error
stays primary and therefore records only when the request actually came back.
A pod nobody asked the controller to remove has no replacement to wait for, so
excluding it would time out a resume whose workspace was perfectly usable.

The [privilege probe](#the-privilege-probe) runs again on every resume. A
resumed pod is a new pod, possibly from a re-pulled image, and "it was
deprivileged last week" is not a check.

Between the two, every call — `exec`, `readFile`, `writeFile`, `listFiles`,
`openTerminal`, `openTcpConnection` — throws `KubernetesWorkspaceSuspendedError`
and **issues no dial**. The Service outlives the pod, so the address still
resolves; a dial would hang on a connect timeout that names nothing.

`status` reports `destroyed` while suspended, because `SandboxStatus` has four
members and none of them is "suspended", and `destroyed` is the only one
meaning "cannot serve a call". The `suspended` flag is what tells the
recoverable state from the final one.

### Egress covers a workspace too

`config.egress` is not a provider-only knob. `createKubernetesWorkspace` runs
the same two steps [`createSandboxProvider` runs](#egress): a hostname
allowlist with no FQDN-capable `engine` declared is refused synchronously,
before a single request, and the `NetworkPolicy` (or `CiliumNetworkPolicy`) an
operator was supposed to apply is `GET` and matched against the translation
before anything is created. A missing or drifted policy fails the call and no
workspace is created — the network boundary on a long-lived sandbox is the
policy, not the agent's bind token.

**It is verified against the template the workspace is built from**, which is
`options.sandboxTemplateName` when given and `config.sandboxTemplateName`
otherwise. That template's name is the label this backend stamps on the pod
and the label the policy's `podSelector` has to match, so a deployment with a
separate workspace template needs its own policy object for it — named
`<workspace template>-egress` by default, or whatever `networkPolicyName`
says. The task template's policy does not select a workspace pod.

Unlike the provider's once-per-backend check, this one runs on every
`createKubernetesWorkspace` call: creating a workspace is a rare, explicit act
and there is nothing to amortise.

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

### Nothing but `deleteDisk` deletes

No failure path in the workspace code ever deletes. A create or a resume that
fails after the object exists — a readiness timeout, a probe refusal —
suspends it and rethrows, leaving the disk untouched for the caller to come
back to under the same deterministic name. That holds even when the failing
call is the one that POSTed the object and its disk is therefore empty,
because two processes can be coming up on one name at once and the one that
got the `201` deleting its "own" object would take the disk of the one that
adopted it. **The cost is a second named leak**: a create that fails after the
POST leaves one suspended `Sandbox` and its PVC standing, and — like an
abandoned workspace — nothing reaps them. Both are found again under the same
`namzu-ws-<id>` name, and both go away on `destroy({ deleteDisk: true })`.

That covers the path nobody calls, too. When an execution's cancellation
cannot be confirmed — the guest wedged, the pod partitioned, the
`cancel-execution` window closing with no answer — a command of unknown state
is left in that pod, and the shared execution controller's rule is that the
pod stops being reusable and is **retired**. A task sandbox is retired by
being DELETEd, correctly: the object is disposable and its disk is scratch. A
workspace is retired by the same `operatingMode: Suspended` patch `suspend()`
sends. The `exec()` still rejects, carrying `retirement: { accepted: true }`
once that patch lands (and `accepted: false`, with the error, when it does
not); the workspace then reads `suspended: true`, admits nothing, and
`resume()` brings up a fresh pod on the same disk. An eight-second
cancellation window is not a reason to erase a month of a caller's files, and
`destroy({ deleteDisk: true })` stays the only thing in this backend that
removes a disk.

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
[`createKubernetesWorkspace`](#egress-covers-a-workspace-too) runs the same
check with its own timing — every call, against its own template's policy —
because a workspace never passes through the provider.

## RBAC

The ServiceAccount the host runs as needs, in the sandbox namespace:
`create`/`get`/`patch`/`delete` on `sandboxclaims`,
`create`/`get`/`patch`/`delete` on `sandboxes`, `get` on `sandboxtemplates`,
`get`/`list` on `pods`, and — only
when `config.egress` is set — `get` on `networkpolicies` (`networking.k8s.io`)
or, under `engine: 'cilium'`, `get` on `ciliumnetworkpolicies` (`cilium.io`).
No consumer role is published upstream. A `403` surfaces as an error naming
the verb and the resource and never the token.
[Workspaces](#persistent-workspaces) need nothing beyond this list: they use
`create`/`get`/`patch`/`delete` on `sandboxes`, `get` on `sandboxtemplates`
and `get`/`list` on `pods`, which the task path already required.

## Deployment

The cluster artifacts the rest of this page assumes are under
`packages/sandbox/k8s/` (never published — the package's `files` array
packs only `dist` and `src`; `npm pack --dry-run` from `packages/sandbox`
confirms it): the guest image (`k8s/Dockerfile`, `k8s/entrypoint.sh` — root
formats and mounts a workspace's raw block device, then `exec`s into
`setpriv`, which drops every capability and execs `tini` — the container's
real PID 1 and subreaper — which in turn runs the guest agent as its
child), the
`RuntimeClass` / `SandboxTemplate` / `SandboxWarmPool` / `NetworkPolicy` /
RBAC manifests (`k8s/manifests/`, plus a `kind-overlay/` for local
development — explicitly **not** a security boundary, see that overlay's
own header comment), and five scripts under `k8s/scripts/` that each
measure one acceptance criterion below against a live cluster and print a
`[PASS]`/`[FAIL]` line plus the measured number. `k8s/README.md` has the
full apply order and the RuntimeClass confirmation step — its registered
name has drifted between published sources and must be read off
`kubectl get runtimeclass`, never trusted from a file in this repo.

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
