---
type: Guide
title: Kubernetes sandboxes
description: Claim VM-isolated sandboxes from an agent-sandbox warm pool on any Kubernetes cluster — the config shape, the pristine-claim rule that keeps the acquire sub-second, the per-instance agent credential, egress policy translation and verify-not-trust, and what this first batch does not carry yet.
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

**This page describes a first batch.** Acquire, readiness, address resolution,
teardown and egress translation/verification are implemented. The execution
surface is not: see [what is not here yet](#what-is-not-here-yet) before
wiring this into a host.

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
| `readyTimeoutMs` | `60000` | Whole clock from create to an addressed, Ready sandbox. |
| `claimTtlSeconds` | `3600` | Wall-clock lifetime written into every created object. |
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
`create`/`get`/`delete` on `sandboxclaims`, `create`/`get`/`delete` on
`sandboxes`, `get` on `sandboxtemplates`, `get`/`list` on `pods`, and — only
when `config.egress` is set — `get` on `networkpolicies` (`networking.k8s.io`)
or, under `engine: 'cilium'`, `get` on `ciliumnetworkpolicies` (`cilium.io`).
No consumer role is published upstream. A `403` surfaces as an error naming
the verb and the resource and never the token.

## What is not here yet

This batch delivers the config type, both acquire paths, readiness, address
resolution, teardown and egress translation/verification. Still to come, each
in its own change:

- **The execution surface.** `exec`, `readFile`, `writeFile` and `listFiles`
  currently throw `KubernetesAgentTransportPendingError`, which names the
  missing transport rather than failing as an absent method. `destroy()` is
  real today.
- **Workspace lifecycle.** Suspend, resume, and a persistent block-mode disk.
- **Cluster manifests.** The image, the `RuntimeClass`, `SandboxTemplate`,
  `SandboxWarmPool`, `NetworkPolicy` and RBAC the above assumes.
