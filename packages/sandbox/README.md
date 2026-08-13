# @namzu/sandbox

Pluggable containment for [`@namzu/sdk`](../sdk). Two tiers, one
`SandboxProvider` surface: swapping the trust boundary is a config
change, not an integration rewrite.

## Tiers

| Tier | Trust boundary | Use it when | Cold start |
|---|---|---|---|
| `container` (`docker`) | Kernel namespaces + seccomp, tmpfs workdir, no network unless asked | The model is yours and the user is your customer | 0.5–2s |
| `container` (`runsc`) | A userspace kernel serves the guest's syscalls | Same tenancy, stronger boundary, commodity Linux without nested virtualization | container start + ~100ms |
| `container` (`aci-standby-pool`) | The managed provider's isolation host | You cannot reach a container daemon, and a ~1.5s claim is acceptable | ~1.5s from a warm pool |
| `microvm` (`self-hosted`) | Hardware virtualization | The prompt itself is the attacker | <300ms, resuming a snapshot |

Every shape above is implemented. That is worth stating because it
used not to be: this package once advertised four tiers and six
backends, and four of those shapes type-checked and then threw. A
configuration that compiles and cannot run teaches the reader the
wrong thing about what is here, so the ones that were never built
are gone rather than pending.

## Choosing a tier

The question is not which tier is strongest, it is **who you are
defending against**.

- **The prompt is the attacker** — untrusted input reaching code
  execution, or tenants who must not reach each other. Take the
  hardware boundary: a guest kernel per task is the only mainstream
  primitive whose escape surface is the hypervisor rather than a
  shared kernel, and snapshot-resume makes starting one cost
  milliseconds rather than seconds.
- **The tenant is trusted, the code is not** — your own model, your
  own users, arbitrary tool calls. A userspace kernel is the good
  trade: near-zero cold start on commodity Linux, at the cost that a
  bug in that kernel is a tenant escape where a hypervisor bug
  usually is not.
- **Single tenant, or tenants who already trust each other** —
  namespaces and a seccomp profile are adequate, and they run
  everywhere with no special runtime.
- **One operator on their own machine** — the threat is the agent
  reading `~/.ssh`, not tenant A reading tenant B. That is the SDK's
  local sandbox provider, not this package.

namzu does not build a microVM scheduler. Starting guests fast and
safely is an entire product on its own, and the boundary a guest
gives is the same whoever started it — so the microvm tier is an
interface to a scheduler, and the one it speaks to is namzu's own.

## Cloud portability

The interface carries no cloud in it. The container tier over a
local daemon runs anywhere; the managed-pool runtime and the microvm
tier need infrastructure the host chooses. Picking a stronger
boundary may imply picking different infrastructure — that is the
host's call, not the SDK's.

## Egress allowlist policy

Every backend accepts the same `EgressPolicy` shape, but they do **not**
all enforce every variant, and a backend that cannot enforce one now
throws instead of quietly ignoring it:

| Backend | `deny-all` | `allow-all` | `static` | `resolver` |
|---|---|---|---|---|
| `container:docker` | enforced on an `--internal` network, and **throws** under `hostReachability: 'host-port'` | enforced | **throws** — no proxy to filter through | **throws** |
| `container:standby-pool` | **throws** | **throws** | **throws** | **throws** |
| `microvm:firecracker` | enforced (empty allowlist) | enforced (no allowlist) | enforced | enforced — `resolve()` is called and its result forwarded |

### The network has to be able to carry the policy

`network` and `hostReachability` are not independent of the egress policy,
and pairing them wrongly used to produce a container nobody could reach:

| You want | `network` | `hostReachability` |
|---|---|---|
| no egress, enforced | a network created `--internal` | `container-network` |
| egress, restricted by allowlist | a bridge, plus an egress proxy | either |
| egress, unrestricted | a bridge | either |

Docker binds a published port to the container's address by NAT, so a
container with no route out has no address to bind to and **nothing is
published** — that holds for `--network none` and for an `--internal`
network alike. `deny-all` needs exactly such a network. The two
requirements are opposites, so *no egress plus a published host port* is
impossible rather than unsupported; closing that means moving the worker's
control channel off TCP.

`create()` checks both against the daemon and refuses with the reason.
Note that the `network` default of `'none'` is one of the pairings it
refuses.

Two rows of the table above carry the same lesson from opposite directions.

The docker row used to accept a restrictive policy and silently grant the
configured network, which is worse than not supporting the feature: the
host believes it is protected and stops looking. Refusing loudly is the
only honest option for a control the backend cannot implement.

The standby-pool row is the same failure found later. Its claim API rejects
every property override except a config map, so a memory cap, a process
cap, environment variables and an egress policy have nowhere to ride
through — and all four were accepted and dropped. Set them on the container
group profile the pool is built from; the backend now refuses them per
sandbox rather than pretending.

The firecracker `resolver` column is a third variant of it. `allow-all` and
`resolver` both used to encode as an omitted allowlist, so one encoding
carried two opposite intentions and the callback that produces the
tenant-scoped list was never called anywhere. Whichever way the
orchestrator reads an omitted field, one of the two was always
mis-enforced — and the one that failed **open** was the one whose entire
purpose is restriction. Each variant now has its own encoding: `allow-all`
omits, `deny-all` sends an explicitly empty list, `resolver` sends what
`resolve()` returned.

The shape itself:

```ts
type EgressPolicy =
  | { kind: 'deny-all' }                                              // default
  | { kind: 'allow-all' }                                             // tests only
  | { kind: 'static'; allowedHosts: readonly string[] }
  | { kind: 'resolver'; resolve: () => Promise<readonly string[]> }
```

The `resolver` shape is **parameterless on purpose**. Hosts that
need per-tenant policies bake the tenant identity into the closure
that constructs the provider — exactly how compass-platform's
JWT-minting flow already works (the server knows the tenant when
it issues the JWT, the allowlist claim is baked in there). This
avoids the "where does the resolver get its context from"
plumbing problem; the host owns the closure, the SDK runtime
doesn't have to forward identity through `provider.create`.

## Container confinement (`container:docker`)

Every container is launched with:

- `--cap-drop=ALL` — two independent reasons, and the second is easy to lose.
  `CAP_DAC_OVERRIDE` alone walks past the read-only bind mounts the layout
  sets up, so the default capability set makes the mount layout advisory
  rather than enforced. Separately, an `--internal` network denies egress by
  giving the container no route out — and restoring one is a single
  `ip route add`, refused only because `NET_ADMIN` is absent. The network
  removes the route; this flag removes the ability to put it back.
- `--security-opt=no-new-privileges` — without it a setuid binary in the
  image re-escalates after the drop.
- the configured network, which defaults to `none` (see the egress table
  above, and the network note below it).

There is deliberately **no re-add list** for capabilities. A workload that
genuinely needs one should say so somewhere a reviewer sees it, not inherit
it from a default.

`runAsUser` (`--user`) is opt-in rather than defaulted, because the correct
uid depends on the image's own filesystem ownership and forcing one breaks
every image that expects root at startup. Set it whenever the image
supports a non-root user — a container running as root is one bind-mount
misconfiguration away from writing the host.

### The environment a command runs in

The worker strips every variable prefixed `NAMZU_SANDBOX_` before spawning
a command. Those are its own configuration — the workspace root and both
root lists among them — and passing them on handed the confinement layout
to the code being confined.

Everything else is inherited, which is deliberate and not an oversight:

- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are set on the container so
  tooling inside routes through the egress boundary. A workload that never
  received them would stop being proxied, which looks exactly like the
  policy working.
- Anything you passed as `options.env` is meant to reach commands, and once
  it is in the worker's environment the prefix is the only thing separating
  it from the worker's own settings.

Per-call `env` is applied after the strip and is **not** filtered, so a
caller that deliberately sets a prefixed name still gets it. If a workload
needs the workspace root, note that it is also the command's `cwd`.

## Status

Every backend this package declares is implemented, and
`createSandboxProvider` refuses anything else BY NAME at construction
rather than handing back a provider that confines nothing — so a
mistake surfaces while the host is wiring, not mid-run.

## Usage

```ts
import { createSandboxProvider } from '@namzu/sandbox'

// A container per task, on a local daemon. Runs anywhere.
const contained = createSandboxProvider({
  backend: { tier: 'container', runtime: 'docker', image: 'namzu-worker:latest' },
  layout,
  defaultEgress: { kind: 'static', allowedHosts: ['api.example.com'] },
})

// A guest per task, when the prompt itself is the attacker. The
// allowlist is resolved per tenant, so the boundary is not fixed at
// construction.
const virtualized = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'self-hosted',
    orchestratorEndpoint: 'https://sandbox-control.internal',
    getToken: async () => mintOrchestratorBearer(),
    template: 'golden-rev-7',
  },
  defaultEgress: {
    kind: 'resolver',
    resolve: async () => fetchAllowlistForTenant(tenantId),
  },
})

// Wire into drainQuery / agent run config:
//   sandboxProvider: contained
```

## The egress boundary

An egress policy could be *declared* long before it could be *enforced*.
Only two of its four shapes were honourable anywhere: this backend refused
a host allowlist outright because it had nothing to filter through, and
only the microVM backend forwarded one. `deny-all` and `allow-all` were
the whole spectrum a container-tier sandbox could express — all or nothing.

`EgressProxy` is the boundary the other two shapes are enforced at. When a
policy is `static` or `resolver`, the backend starts one on host loopback
and points the container at it through `HTTP_PROXY` / `HTTPS_PROXY` (both
spellings, because tooling is split between them and a workload reading
only the missing one would bypass the boundary while looking like the
policy worked).

Matching has exactly two forms, and substring is deliberately not one of
them:

| Entry | Matches |
| --- | --- |
| `api.example.com` | that host only |
| `.example.com` | that domain and any subdomain |

`host.includes(entry)` is the obvious implementation and it is a hole: an
entry of `example.com` would admit `example.com.attacker.net`, a domain
the attacker owns. Plain suffix matching has the same hole without the
leading dot — `notexample.com` ends with `example.com` — which is why the
wildcard form requires it. Comparison ignores case and a trailing dot,
because DNS does and an allowlist that did not would be bypassable by
typing the host differently.

A policy that cannot be read **denies**. An allowlist that fails open is
not an allowlist.

### Where the name goes, not just what it is called

An allowlist entry names a host. **DNS decides where that host is**, and the
caller may control it — so an allowlisted name is a permitted *spelling*
until something has looked at the address behind it. `api.example.com` with
an `A` record pointing at `169.254.169.254` is the instance metadata service
wearing a permitted name, and on the plain-HTTP path the brokered credential
goes on the request *before* it is sent. Without an address check the
credential-brokering design is the delivery mechanism.

So the boundary refuses these, whatever the allowlist says:

| Refused | v4 | v6 |
| --- | --- | --- |
| loopback | `127.0.0.0/8` | `::1` |
| private | `10/8`, `172.16/12`, `192.168/16` | `fc00::/7` unique-local |
| link-local (metadata) | `169.254.0.0/16` | `fe80::/10` |
| carrier / shared | `100.64.0.0/10` | — |
| unspecified, multicast, reserved | `0/8`, `224/4`, `240/4` | `::`, `ff00::/8` |

A v4 address written as IPv6 — `::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`,
or the same thing written out in full — is the same address and is refused
the same way. A v4-only screen passes all three, which is a known way through
this kind of filter rather than an oversight.

**The screening happens inside the resolution the socket performs**, not
before it. Resolve-check-then-connect leaves the socket free to resolve a
second time, and the second answer is the one that decides where the bytes
go — so a name that alternates records walks through a check that passed a
moment earlier. Every address in the record set is screened, not just the one
that would have been used, because a set mixing a public address with an
inward one is the ordinary shape of this and screening only the winner makes
the outcome depend on resolver ordering. The host stays the **name** on the
request, so SNI and certificate validation still check the name the allowlist
approved.

### When the private address is the point

Some deployments genuinely proxy to a service on a private network. Name it:

```ts
allowInwardFor: ['.internal.example'],
```

Per host, matched by the same rules as the allowlist. There is deliberately
no switch that turns the screen off — one would hand every other allowlisted
name the same reach, which is the hole the screen exists to close.

A refusal says which kind of address it was (`loopback`, `link-local`,
`private`), because those are different mistakes with different fixes, and it
reaches `onDenied` as well as the requester.

**On the tunnel path this bounds the destination and nothing more.** The
allowlist reads the name in the `CONNECT` line — the only part of that
exchange ever in clear text — and the address screen makes that a real bound
on where the tunnel terminates. What travels inside it afterwards is opaque
to this process, including the name the caller puts in its own TLS handshake.
A tunnel to an allowlisted host is not a guarantee that only allowlisted
traffic crosses it.

### Changing the policy while the sandbox runs

`sandbox.setNetworkPolicy({ allowedHosts })` narrows or widens a live
sandbox. The shape this exists for — "clone with a token, then drop to
deny-all before running anything the repository contains" — was not
expressible at all: the policy was frozen at provider construction, so a
host had to build a second provider and a second sandbox and copy the work
across.

A backend that cannot enforce it **throws**. A network policy accepted and
not applied is worse than one never offered: the caller stops looking, and
the run proceeds believing it is confined.

### Credentials that never enter the sandbox

Any token the agent needed to reach an allowed host had to be inside the
container, in the environment — readable by the untrusted code it is meant
to be isolated from, via `/proc/self/environ`, or via a prompt injection
that exfiltrates it over the very egress the policy permits.

`brokeredCredentials` holds the real value host-side and stamps it on at
the boundary, scoped per host:

```ts
brokeredCredentials: [
  { host: 'api.example.com', header: 'authorization', value: process.env.TOKEN! },
]
```

Per host, not globally: a credential attached to every request is a
credential handed to whichever host the agent was talked into contacting.

One honest limit. A credential **cannot** be injected into a CONNECT
tunnel — by the time those bytes reach the proxy they are encrypted, and
reading them would mean terminating TLS with a CA the sandbox trusts, which
would let the proxy read every byte the agent sends anywhere. That is a
strictly larger risk than the one being mitigated, so it is not built. A
workload that needs brokering speaks plain HTTP to the proxy and lets it
upgrade to HTTPS upstream. The allowlist is still enforced on CONNECT,
because the target names the host in clear text — and so is the address
screen, so a permitted name cannot be a route inward.
