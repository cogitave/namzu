---
type: Guide
title: Kubernetes sandboxes
description: Claim VM-isolated sandboxes from an agent-sandbox warm pool on any Kubernetes cluster — the config shape, the pristine-claim rule that keeps the acquire sub-second, the per-instance agent credential, which Sandbox capabilities it serves and which it deliberately omits, the acquire-time privilege probe, the lease that keeps a long run's pod alive, persistent block-disk workspaces with suspend and resume, egress policy translation and verify-not-trust.
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
with the abandoned one), `openTerminal` and `openTcpConnection` — and one
deliberate exception: a command whose cancellation the guest could not confirm
is never retried. Its outcome is unknown by definition, and re-running it
against a disk that followed the pod is exactly what "do not automatically
retry" exists to prevent.

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
| `writeFile`, `readFile` | Implemented | Base64 over the framed protocol, jailed to the guest workspace. A body larger than one frame is [written in parts](#writing-a-file-larger-than-one-frame). |
| `listFiles` | Implemented | `find -printf '%p\t%s\n'`, parsed line by line; a root that does not exist is an empty list. |
| `walkFiles` | Implemented | Bounded, lazy discovery through the SDK's own `walkFilesViaExec` over `exec` — see [bounded search](#bounded-search-and-the-glob-and-grep-builtins). |
| `openTerminal` | Implemented | A real PTY owned by the guest. `destroy()` kills and awaits every terminal it returned, which is what makes offering it compliant at all. |
| `openTcpConnection` | Implemented | Guest loopback only. |
| `destroy` | Implemented | DELETEs the object this backend created, which cascades to the Pod, Service and Sandbox. Idempotent; an object already gone counts as released. |
| `setNetworkPolicy` | **Omitted** | Egress here is a `NetworkPolicy` attached to the pool's `SandboxTemplate`; there is no per-running-pod knob. The SDK's contract says a backend that cannot enforce one must omit it rather than accept it and quietly not apply it. |
| `spawnDetached` | **Omitted** | The guest agent has no op that starts a process and hands it back running. A host that needs background jobs is told no. |

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
`Sandbox`, plus `suspend()`, `resume()`, `refresh()`, a `suspended` flag and a
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

**A workspace id is a name, not a lock.** Nothing stops two host processes from
adopting the same running workspace; each gets its own handle over the same
pod, and either one's `destroy()` suspends the pod the other is executing in.
That coordination is the caller's, and this backend does not pretend to it —
but a handle can at least [find out](#a-handle-notices-a-suspend-it-did-not-perform)
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
[stopped answering](#nothing-but-an-explicit-delete-deletes), and the cleanup after a
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
| `deleteKubernetesWorkspace(config, workspaceId, { signal })` | One `DELETE` of `namzu-ws-<id>` | Never adopts, never resumes — the deterministic name is enough to address the object |
| `suspendKubernetesWorkspace(config, workspaceId, { signal })` | The `operatingMode: Suspended` patch, then the pod wait | Never adopts, opens no session, reaps no terminals it does not own |

`listKubernetesWorkspaces` returns a `KubernetesWorkspaceSummary` per
workspace — `workspaceId`, `operatingMode`, `template`, `createdAt` and
`operatingModeChangedAt` — in the API server's own order. `operatingMode` is
`spec.operatingMode` verbatim and not "is a pod running": a `Running`
workspace whose pod is being created, or has just crashed, reads `Running`.

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

### Nothing but an explicit delete deletes

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
cancellation window is not a reason to erase a month of a caller's files.

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
`create`/`get`/`list`/`patch`/`delete` on `sandboxes`, `get` on
`sandboxtemplates`, `get`/`list` on `pods`, and — only
when `config.egress` is set — `get` on `networkpolicies` (`networking.k8s.io`)
or, under `engine: 'cilium'`, `get` on `ciliumnetworkpolicies` (`cilium.io`).
No consumer role is published upstream. A `403` surfaces as an error naming
the verb and the resource and never the token.
[Workspaces](#persistent-workspaces) add exactly one verb to that list:
`list` on `sandboxes`, which
[`listKubernetesWorkspaces`](#managing-workspaces-without-waking-them) needs
to read the collection. Every other read in this backend is a `GET` by a name
it already knows, and the rest of what a workspace uses —
`create`/`get`/`patch`/`delete` on `sandboxes`, `get` on `sandboxtemplates`,
`get`/`list` on `pods` — the task path already required.

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
overlay's own header comment), and five scripts under `k8s/scripts/` that
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
