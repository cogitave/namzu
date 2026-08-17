<!-- okf
type: Reference
title: "@namzu/sandbox"
description: >-
  Container and microVM containment for @namzu/sdk. Runs a task inside one OCI
  container or one hardware-virtualized guest behind the kernel's own
  SandboxProvider interface, with an egress boundary that decides by resolved
  address. Separate so the kernel holds no opinion about the trust boundary.
tags: [readme, package, sandbox, containment, egress]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/sandbox</h1>

**Containment for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk): one container or one guest per task, chosen by configuration.**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)
[![npm](https://img.shields.io/npm/v/@namzu/sandbox.svg?label=%40namzu%2Fsandbox)](https://www.npmjs.com/package/@namzu/sandbox)

[Install](#install) · [Tiers](#two-tiers-four-backends) · [Wire it up](#wire-it-up) · [The image](#the-container-image) · [Mounts](#the-mount-layout) · [Egress](#the-egress-boundary) · [Confinement](#what-every-container-is-launched-with) · [Exports](#exports)

</div>

---

## What this is

`@namzu/sdk` declares the `SandboxProvider` shape and ships one implementation
of it: a local provider that confines an agent to the operator's own machine.
That is the right boundary when the threat is the agent reading `~/.ssh`. It is
not a boundary between tenants, and it is not a boundary against a prompt that
is itself hostile.

This package implements the same interface with backends that put a kernel or a
hypervisor in the way. Swapping the trust boundary is a change to the object you
pass `createSandboxProvider`, not an integration rewrite: the sandbox the kernel
receives has the same `exec` / `readFile` / `writeFile` / `listFiles` surface
whichever backend produced it.

Every backend named below is implemented. That is worth saying because it used
not to be — a `process` tier, a `passthrough` tier and two adapters to
third-party schedulers were declared here and never written, so four of the
shapes this package offered could only type-check and then throw. They are gone
rather than pending.

## Install

```bash
pnpm add @namzu/sandbox @namzu/sdk
```

`@namzu/sdk` (>=1.0.0) is a peer dependency. This package has **no runtime
dependencies of its own**: the container tier drives the `docker` CLI through
`node:child_process`, the egress boundary is `node:http`, `node:https` and
`node:net`, and the microVM tier speaks HTTP to an orchestrator and a framed
protocol to a guest agent. Credentials arrive as closures you supply, so no
cloud SDK is pulled in behind your back.

## Two tiers, four backends

A tier is the kind of boundary. A backend is the mechanism that produces one.

| Backend | What the boundary is | Reach for it when |
|---|---|---|
| `container`, `runtime: 'docker'` | Kernel namespaces and cgroups, plus whatever seccomp profile the daemon applies by default — this package sets none of its own. Runs anywhere a daemon does. | The tenant is trusted and the code is not: your own model, your own users, arbitrary tool calls. |
| `container`, `runtime: 'runsc'` | A userspace kernel serves the guest's syscalls. Needs that runtime registered on the daemon, which means Linux. | Same tenancy, a stronger boundary, and you would rather not run virtualization machinery. |
| `container`, `runtime: 'aci-standby-pool'` | A managed provider's isolation host, claimed pre-warmed from a standby pool. See [its own section](#the-standby-pool-backend) — it is real, and it is narrower than the other three. | You cannot reach a container daemon at all. |
| `microvm`, `service: 'self-hosted'` | Hardware virtualization. One guest kernel per task, resumed copy-on-write from a golden snapshot by an orchestrator you run. | The prompt itself is the attacker, or tenants must not be able to reach each other. |

The question is not which tier is strongest, it is **who you are defending
against**. A guest per task is the only mainstream primitive whose escape
surface is the hypervisor rather than a shared kernel; a userspace kernel is the
good middle trade, at the cost that a bug in that kernel is a tenant escape
where a hypervisor bug usually is not; namespaces are adequate for tenants who
already trust each other and run everywhere with no special runtime. One
operator on their own laptop wants none of these — that is the SDK's local
sandbox provider.

namzu does not build a microVM scheduler. Starting guests quickly and safely is
an entire product, and the boundary a guest gives is the same whoever started
it. So the `microvm` tier is an **interface to** a scheduler, and the one it
speaks to is namzu's own control plane.

The interface carries no cloud in it. The container tier over a local daemon
runs anywhere; the microVM tier needs infrastructure you choose and operate.
Picking a stronger boundary can imply picking different infrastructure — that is
the host's call, not the kernel's.

## Wire it up

A container per task, on a local daemon:

```ts
import { createSandboxProvider } from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: {
    tier: 'container',
    runtime: 'docker',
    image: 'namzu-sandbox:latest',
    network: 'namzu-tasks',
    labels: { 'example.task-id': taskId },
  },
  layout: {
    outputs: { source: { type: 'hostDir', hostPath: `/srv/tasks/${taskId}/outputs` } },
    uploads: { source: { type: 'hostDir', hostPath: `/srv/tasks/${taskId}/uploads` } },
  },
  defaultEgress: { kind: 'static', allowedHosts: ['api.example.com'] },
  defaultMemoryLimitMb: 1024,
  defaultMaxProcesses: 128,
})
```

A guest per task, when the prompt itself is the attacker. The allowlist is
resolved per run, so the boundary is not fixed at construction:

```ts
import { createSandboxProvider } from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'self-hosted',
    orchestratorEndpoint: 'https://sandbox-control.internal',
    getToken: async () => await mintOrchestratorBearer(),
    template: 'golden-rev-7',
  },
  defaultEgress: {
    kind: 'resolver',
    resolve: async () => await fetchAllowlistForTenant(tenantId),
  },
})
```

Either object goes to the kernel as `sandboxProvider` — the field is on
`QueryParams` (so `query` and `drainQuery` take it) and on
`ReactiveAgentConfig`. The kernel calls `provider.create()` before the iteration
loop and `sandbox.destroy()` when the run ends.

**The layout is bound at construction, not per call**, and the type enforces it:
a container-tier config without one does not compile. Layouts are per task —
different host paths for different runs — so a host that runs many tasks
constructs one provider per task, in the same closure that knows the paths.

| Provider config | Meaning |
|---|---|
| `backend` | The tier and its concrete settings; the tables below. |
| `layout` | Required for the container tier. Not part of the microVM shape at all — that tier seeds its workspace over the control channel, so there is nothing to bind. |
| `defaultEgress` | Applied to every sandbox this provider creates. There is no per-call egress override. |
| `defaultMemoryLimitMb`, `defaultMaxProcesses` | `--memory` and `--pids-limit` on the container tier; forwarded in the create request on the microVM tier. Used only when the kernel's own per-run value is absent. |
| `defaultTimeoutMs` | Forwarded to the microVM orchestrator. The container tier does not read it — a per-command deadline goes on `SandboxExecOptions.timeout` instead, which the worker enforces. |

| `ContainerBackendConfig` | Default | Notes |
|---|---|---|
| `image` | — | Required. Must run the worker; see below. |
| `runtime` | daemon default | `'docker'` or `'runsc'`. |
| `network` | `'none'` | The docker network to attach. **The default is one of the pairings `create()` refuses** — see the network table under egress. |
| `hostReachability` | `'host-port'` | `'container-network'` when the consumer is itself a container reaching a sibling by name. |
| `allowInwardFor` | — | Allowlisted hosts permitted to resolve to a private address anyway. |
| `labels` | — | `--label key=value` pairs, so out-of-band reapers can find the container. A key that is empty or contains `=` is refused. |

| `MicroVMBackendConfig` | Default | Notes |
|---|---|---|
| `orchestratorEndpoint` | — | Required. Control-plane base URL. |
| `getToken` | — | Required. Called on every control-plane request, so a long sandbox survives rotation. |
| `template` | orchestrator's | Golden snapshot revision to resume from. |
| `agentSnapshot` | — | `{ orgId, agentId, version }` — resume this agent's captured snapshot instead of a fresh golden boot. |
| `agentVsockPort` | `1024` | Guest port the in-VM agent listens on. |
| `readyTimeoutMs`, `readyPollIntervalMs` | `60_000`, `250` | How long `create()` waits for the guest's own health check to answer, and how often it asks. The orchestrator's 2xx is not the clock — it returns before the guest is running. |
| `mtls` | — | Client material for a network-mode agent handle; merged onto the handle the orchestrator returns. |
| `controlPlaneMtls` | — | Client material for the control-plane calls themselves, for when the endpoint is reached over the public internet. The bearer is still sent. |

Both mTLS blocks are `{ ca, cert, key, servername? }` and are **injected by
you**, never read from disk or fetched here — the same boundary `getToken` draws.

`createSandboxProvider` refuses an unrecognised backend **by name**, at
construction, with `SandboxBackendNotImplementedError`. An untyped host that
invents a tier gets a refusal while it is wiring, not a provider that confines
nothing.

## The container image

`image` must name an image whose entrypoint runs the sandbox worker: an HTTP
server on port **2024** serving

- `GET /healthz` — `create()` polls this and does not return until it answers,
- `POST /execute` — a request per command, answered with an NDJSON stream of
  `stdout_delta`, `stderr_delta` and a final `result` event,
- `POST /read-file` and `POST /write-file` — base64 bodies.

The worker reads `NAMZU_SANDBOX_WORKSPACE`, `NAMZU_SANDBOX_READ_ROOTS` and
`NAMZU_SANDBOX_WRITE_ROOTS`, which the backend sets from the layout, and refuses
a path outside those roots — lexically first, then again against the resolved
`realpath`, so a symlink inside the workspace cannot point out of it.

Three behaviours of the worker are worth knowing before you build an image
against it. A per-command `timeoutMs` above 30 minutes
(`NAMZU_SANDBOX_MAX_TIMEOUT_MS`) is **refused, not clamped** — running under a
deadline the caller did not ask for is the shape this codebase treats as worse
than refusing. It exits by itself after 5 idle minutes
(`NAMZU_SANDBOX_IDLE_TIMEOUT_MS`, `0` disables), so a container orphaned by a
host crash still goes away. And `listFiles` is implemented by running `find`
with `-printf`, so the image needs a `find` that has it.

**It authenticates nobody**, and it binds every interface by default because a
consumer that is itself a container has to reach it by container name over a
shared bridge. So the boundary is the network the container is attached to, not
the bind address, and an image of this kind must never sit on a network the
world can route to.

The worker and a reference image live in this repository under `worker/`. They
are **not** in the published npm tarball, which carries `dist/` and `src/` only:
build the image from the repository, or write your own against the endpoints
above.

## The mount layout

A container needs one place the user will see and several the user will not, and
the difference has to be legible to the model from the path alone.

| Mount | Mode | Default container path |
|---|---|---|
| `outputs` (**required**) | rw | `/mnt/user-data/outputs` |
| `scratch` | rw | `/mnt/user-data/scratch` |
| `uploads` | ro | `/mnt/user-data/uploads` |
| `toolResults` | ro | `/mnt/user-data/tool_results` |
| `transcripts` | ro | `/mnt/transcripts` |
| `skills[]` | ro | `/mnt/skills/<id>` |

`outputs.containerPath` is the workspace root and the sandbox's `rootDir`. Only
`outputs` and `scratch` are writable; the read-only mounts stay out of the write
roots so an agent's `write` cannot clobber files the host considers immutable.

`scratch` is a sibling of `outputs` rather than a child, and it is meant to stay
one on the host side too: a deliverables collector scans the outputs directory,
so giving `scratch` a host path outside that tree is what makes it invisible to
the user. The agent needs somewhere to think out loud that is not the answer.

Every source is `{ type: 'hostDir', hostPath }` for the docker and `runsc`
runtimes. The layout is validated once, at construction, and
`ContainerSandboxLayoutValidationError` carries **every** violation in one pass —
a missing `outputs`, a skill id outside `[A-Za-z0-9_.-]` or containing `..`, a
duplicate skill id, two mounts claiming the same container path. Fixing one
problem per run is a loop worth not having.

There is no scratchpad knob beyond `scratch`, and no way to declare the
container's own home directory: no backend bind-mounts it, and a field the
runtime cannot honour is worse than an absent one.

## The egress boundary

```ts
type EgressPolicy =
  | { kind: 'deny-all' }
  | { kind: 'allow-all' }                                            // tests only
  | { kind: 'static'; allowedHosts: readonly string[] }
  | { kind: 'resolver'; resolve: () => Promise<readonly string[]> }
```

**Omitting `defaultEgress` is not `deny-all`.** No policy reaches the backend at
all: the container keeps whatever network you named, and the microVM
orchestrator receives no allowlist, which it reads as unrestricted. If you want
nothing to leave, say so.

Every backend takes the same shape and they do **not** all enforce every
variant. A backend that cannot enforce one throws rather than accepting it
quietly:

| Backend | `deny-all` | `allow-all` | `static` | `resolver` |
|---|---|---|---|---|
| `container:docker`, `container:runsc` | Enforced by an `--internal` network, checked against the daemon rather than trusted. Impossible under `hostReachability: 'host-port'`, and refused. | The configured network, unfiltered. | Enforced at a loopback egress proxy the backend starts and tears down with the sandbox. | Same, and `resolve()` is called per request so a rotating allowlist is honoured. |
| `container:aci-standby-pool` | Refused | Refused | Refused | Refused |
| `microvm:self-hosted` | An explicitly empty allowlist is forwarded | No allowlist is forwarded | The allowlist is forwarded | `resolve()` is called and its result forwarded |

Three rows, three versions of the same lesson.

The container rows once accepted a restrictive policy and silently granted the
configured network, which is worse than not supporting the feature: the host
believes it is protected and stops looking. The standby-pool row is the same
failure found later — its claim API rejects every property override except a
config map, so an egress policy, a memory cap, a process cap and environment
variables had nowhere to ride through, and all four were accepted and dropped.
Set them on the container group profile the pool is built from. The microVM row
is a third variant: `allow-all` and `resolver` both used to encode as an omitted
allowlist, so one encoding carried two opposite intentions and the callback that
produces the tenant-scoped list was never called anywhere. Whichever way the
orchestrator reads an omitted field, one of the two was always mis-enforced —
and the one that failed **open** was the one whose entire purpose is restriction.

### The network has to be able to carry the policy

`network` and `hostReachability` are not independent of the egress policy, and
pairing them wrongly used to produce a container nobody could reach:

| You want | `network` | `hostReachability` |
|---|---|---|
| no egress, enforced | a network created `--internal` | `container-network` |
| egress, restricted by allowlist | a bridge, plus the egress proxy | either |
| egress, unrestricted | a bridge | either |

Docker binds a published port to the container's address by NAT, so a container
with no route out has no address to bind to and **nothing is published** — that
holds for `--network none` and for an `--internal` network alike. `deny-all`
needs exactly such a network. The two requirements are opposites, so *no egress
plus a published host port* is impossible rather than unsupported; closing it
means moving the worker's control channel off TCP.

`create()` checks both against the daemon and refuses with the reason before
starting anything. The `network` default of `'none'` is one of the pairings it
refuses.

### What the allowlist matches

Two forms, and substring is deliberately not one of them:

| Entry | Matches |
|---|---|
| `api.example.com` | that host only |
| `.example.com` | that domain and any subdomain, the apex included |

`host.includes(entry)` is the obvious implementation and it is a hole: an entry
of `example.com` would admit `example.com.attacker.net`, a domain the attacker
owns. Plain suffix matching has the same hole without the leading dot —
`notexample.com` ends with `example.com` — which is why the wildcard form
requires it. Comparison ignores case and a trailing dot, because DNS does and an
allowlist that did not would be bypassable by typing the host differently.

A policy that cannot be read **denies**: a `resolve()` that throws is a policy
nobody could read, and an allowlist that fails open is not an allowlist.

### Where the name goes, not just what it is called

An allowlist entry names a host. **DNS decides where that host goes**, and the
caller may control it — so an allowlisted name is a permitted *spelling* until
something has looked at the address behind it. A permitted name with an `A`
record pointing at `169.254.169.254` is the instance metadata service wearing
it, and on the plain-HTTP path a brokered credential goes on the request before
it is sent. Without an address check the brokering design is the delivery
mechanism.

So the boundary refuses these, whatever the allowlist says:

| Refused | IPv4 | IPv6 |
|---|---|---|
| loopback | `127.0.0.0/8` | `::1` |
| private / unique-local | `10/8`, `172.16/12`, `192.168/16` | `fc00::/7` |
| link-local (metadata) | `169.254.0.0/16` | `fe80::/10` |
| shared address space | `100.64.0.0/10` | — |
| benchmarking | `198.18.0.0/15` | — |
| this-host, multicast, reserved | `0/8`, `224/4`, `240/4` | `::`, `ff00::/8` |

A v4 address written as IPv6 — `::ffff:169.254.169.254`, its hexadecimal
spelling, or the deprecated v4-compatible form — is the same address and is
refused the same way. A v4-only screen passes all of them, which is a known way
through this kind of filter rather than an oversight. Prefixes are matched as
numbers and not as text, because `fd::1` is an ordinary global address that
`/^f[cd]/` would have deleted a slice of the internet for.

**The screening happens inside the resolution the socket performs**, not before
it. Resolve-check-then-connect leaves the socket free to resolve a second time,
and the second answer is the one that decides where the bytes go — so a name
that alternates records walks through a check that passed a moment earlier.
Every address in the record set is screened, not only the one that would have
been used, because a set mixing a public address with an inward one is the
ordinary shape of this and screening the winner alone makes the outcome depend
on resolver ordering. The request keeps the **name**, so SNI and certificate
validation still check what the allowlist approved.

### When the private address is the point

Some deployments genuinely proxy to a service on a private network. Name it:

```ts
allowInwardFor: ['.internal.example'],
```

Per host, matched by the allowlist's own rules. There is deliberately no switch
that turns the screen off — one would hand every other allowlisted name the same
reach, which is the hole the screen exists to close. A refusal says which kind of
address it was, because `loopback`, `link-local` and `private` are different
mistakes with different fixes.

**On the tunnel path this bounds the destination and nothing more.** The
allowlist reads the name in the `CONNECT` line — the only part of that exchange
ever in clear text — and the address screen makes that a real bound on where the
tunnel terminates. What travels inside it afterwards is opaque to this process,
including the name the caller puts in its own TLS handshake. A tunnel to an
allowlisted host is not a guarantee that only allowlisted traffic crosses it.

### Changing the policy while a sandbox runs

```ts
await sandbox.setNetworkPolicy?.({ allowedHosts: [] })
```

Narrows or widens a live sandbox — the shape this exists for is "clone with a
token, then drop to deny-all before running anything the repository contains",
which was previously not expressible at all: the policy was frozen at provider
construction, so a host had to build a second provider and a second sandbox and
copy the work across.

The method is optional on the `Sandbox` contract and is **implemented by the
docker and `runsc` runtimes only**, and there only when the policy in force
started an egress proxy; without one the container's network was fixed at
creation and there is nothing to narrow, so the call throws. A policy accepted
and not applied is worse than one never offered: the caller stops looking, and
the run proceeds believing it is confined.

### Credentials that never enter the sandbox

Any token the agent needs to reach an allowed host would otherwise have to be
inside the container, in the environment — readable by the untrusted code it is
meant to be isolated from, via `/proc/self/environ`, or via a prompt injection
that exfiltrates it over the very egress the policy permits.

The proxy holds the real value host-side and stamps it on at the boundary,
scoped per host: a credential attached to every request is a credential handed
to whichever host the agent was talked into contacting.

```ts
import { EgressProxy } from '@namzu/sandbox'

const proxy = await new EgressProxy({
  allowedHosts: async () => ['api.example.com'],
  credentials: [
    { host: 'api.example.com', header: 'authorization', value: process.env.API_TOKEN ?? '' },
  ],
  onDenied: (host, reason) => log.warn({ host, reason }, 'egress denied'),
}).listen()

// proxy.url is 'http://127.0.0.1:<port>' — loopback only, on purpose.
await proxy.close()
```

`EgressProxy` is exported and can be run directly, and **today that is the only
way to broker a credential**: the container backend reads a brokered-credential
list from its internal config, and `createSandboxProvider` has never had a field
that fills it. The proxy the provider starts for you enforces the allowlist and
the address screen; it carries no credentials.

The container reaches that proxy by an added host alias resolving to the docker
host gateway, with `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` set in both
spellings so tooling inside routes through it whichever one it reads.

One honest limit, wherever it runs. A credential **cannot** be injected into a
CONNECT tunnel — by the time those bytes reach the proxy they are encrypted, and
reading them would mean terminating TLS with a CA the sandbox trusts, which
would let the proxy read every byte the agent sends anywhere. That is a strictly
larger risk than the one being mitigated, so it is not built. A workload that
needs brokering speaks plain HTTP to the proxy and lets it upgrade to HTTPS
upstream, which is the default.

## What every container is launched with

- `--cap-drop=ALL`, and it carries two independent loads. `CAP_DAC_OVERRIDE`
  alone walks past the read-only bind mounts the layout sets up, which would
  make the whole mount layout advisory. Separately, an `--internal` network
  denies egress by giving the container no route out — and restoring one is a
  single `ip route add`, refused only because `NET_ADMIN` is absent. The network
  removes the route; this flag removes the ability to put it back.
- `--security-opt=no-new-privileges`, without which a setuid binary in the image
  re-escalates after the drop.
- The configured network, and the layout's mounts with `rw` or `ro` as the table
  above says.
- `--memory` and `--pids-limit`, when a memory or process cap was configured.

There is deliberately **no re-add list** for capabilities. A workload that
genuinely needs one should say so somewhere a reviewer sees it rather than
inherit it from a default.

`--user` is a different case, and the honest statement is narrower than "there
is none". The backend can pass one, but no field on `ContainerBackendConfig`
fills it, so nothing reachable through `createSandboxProvider` sets it — the
container runs as whatever user the image declares. Forcing a uid here would
break every image that expects root at startup, and the correct value depends on
the image's own filesystem ownership. Build the image to run as a non-root user.

### The environment a command runs in

The worker strips every variable prefixed `NAMZU_SANDBOX_` before spawning a
command. Those are its own configuration — the workspace root and both root
lists among them — and passing them on handed the confinement layout to the code
being confined.

Everything else is inherited, which is deliberate:

- The proxy variables above are set on the container on purpose. A workload that
  read only the missing spelling would stop being proxied, which looks exactly
  like the policy working.
- Anything you passed as the sandbox's `env` is meant to reach commands, and
  once it is in the worker's environment the prefix is the only thing separating
  it from the worker's own settings.

Per-command `env` is applied after the strip and is **not** filtered, so a caller
who deliberately sets a prefixed name still gets it. A workload that needs the
workspace root can read it as the command's `cwd`.

## The standby-pool backend

The fourth backend, dispatched on `runtime: 'aci-standby-pool'`, claims a
pre-warmed container group from an Azure standby pool instead of running a local
daemon. It is implemented, and it is what to use when you cannot reach a
container daemon at all. Three things to know before you plan around it:

- **The provider config type does not admit its shape.** `SandboxProviderConfig`
  is a union of the container and microVM shapes, so `ACIStandbyPoolBackendConfig`
  reaches the dispatcher only through a cast. Treat it as unreleased surface.
- **`subnetId` is required through this package.** Without a subnet the platform
  assigns a public address, and the worker answering there authenticates nobody;
  the backend refuses to claim rather than put an unauthenticated execute
  endpoint on the internet. Its internal config has an explicit
  `allowPublicAddress` opt-out for benchmarks, and no public field fills that
  either — so through `createSandboxProvider` the subnet is not optional.
- **Mount sources are `azureFileShare` or `inImage`, never `hostDir`** — there is
  no host filesystem to bind. A warm claim in particular has to use `inImage`:
  the pool's claim API rejects a `volumes[]` override, so the container's own
  filesystem carries the run and the host walks the outputs back out through the
  worker before `destroy()`.

Per-sandbox egress, memory caps, process caps and environment variables are
refused here, as the table above says.

## What is not honoured

Two gaps, written down rather than implied away, because both would otherwise
look like features that work.

`SandboxExecOptions.signal` is accepted and **not** forwarded by either tier.
Neither wire has a cancel operation: aborting the request here would abandon the
wait while the command kept running inside the container or the guest, which is
verbatim the failure that option exists to prevent — except it would then look
honoured. A per-command `timeout` is enforced, by the worker on the container
tier and by the guest agent on the microVM tier; both refuse a value above their
30-minute ceiling rather than silently running under a shorter one.

`Sandbox.openTerminal` is not implemented by any backend in this package. The
contract's rule is that a backend which cannot open a real pseudo-terminal must
throw rather than hand back a pipe, and leaving the optional method absent is
how that reads here.

## Exports

```ts
import {
  createSandboxProvider,
  EgressProxy,
  isHostAllowed,
  splitAuthority,
  serializeSandboxError,
  ContainerSandboxLayoutValidationError,
  SandboxBackendNotImplementedError,
  VsockAgentTransport,
  SANDBOX_DEFAULT_OUTPUTS_PATH,
  SANDBOX_DEFAULT_UPLOADS_PATH,
  SANDBOX_DEFAULT_TOOL_RESULTS_PATH,
  SANDBOX_DEFAULT_TRANSCRIPTS_PATH,
  SANDBOX_DEFAULT_SKILLS_PARENT,
} from '@namzu/sandbox'
```

`isHostAllowed` and `splitAuthority` are the allowlist matcher and the
authority parser, exported so a host can apply the same rules its sandbox will
apply rather than reimplement them slightly differently.

`serializeSandboxError` turns any error this package raises — and its whole
`cause` chain — into a plain object that is safe through `JSON.stringify`,
`structuredClone` and `postMessage` alike, with cycles replaced by a sentinel
and `ContainerSandboxLayoutValidationError`'s `reasons` preserved. `Error`
subclasses survive none of those channels on their own, which is how a
supervisor architecture loses the one field that said what was wrong.

The path constants are exported so a prompt template can say "write outputs to
`${SANDBOX_DEFAULT_OUTPUTS_PATH}`" instead of hard-coding a string in two places
that drift apart. `VsockAgentTransport` and the layout types are re-exported for
hosts that wire the microVM control path themselves.

## License

FSL-1.1-MIT, converting to MIT two years after each release. Same as
`@namzu/sdk`.
