---
type: Guide
title: Container-tier egress
description: What the container tier's egress allowlist is enforced by, the internal-network topology that makes it a boundary rather than a proxy environment variable, the two images a deployer has to build, the exact reach a sandbox has afterwards, and the parts of the arrangement that are stated rather than measured.
resource: packages/sandbox/src/backends/docker/index.ts
tags: [sdk, sandbox, docker, egress, security]
status: draft
generated: { by: human:bahadirarda, at: 2026-09-18T00:00:00Z }
---

# Container-tier egress

`container:docker` enforces a host-allowlist `EgressPolicy` with
`EgressProxy` — the resolver-then-address boundary in
`packages/sandbox/src/egress/proxy.ts`, which decides by resolved address
rather than by name. That boundary has always worked for traffic that goes
through it. Until #398, what decided whether traffic went through it was
`HTTP_PROXY` and nothing else.

This page is what changed, what the sandbox can reach afterwards, and what a
deployer has to do.

## The defect this closes

`resolveNetwork` returned the configured network whenever a proxy was present,
so the container kept ordinary bridge networking with full outbound
reachability. The only thing pointing traffic at the boundary was
`--env HTTP_PROXY=…`, `http_proxy`, `HTTPS_PROXY`, `https_proxy` and
`NO_PROXY`, reached through `--add-host namzu-egress:host-gateway` because the
proxy ran **in the process that created the sandbox**, on the host's loopback.

An environment variable is a request, not a boundary. Anything inside the
container that opens a socket directly — a Go or Rust binary that does not read
proxy env, `curl --noproxy '*'`, a raw `net.Socket`, a DNS-over-TCP client —
reached the network with the allowlist unconsulted. Untrusted code is precisely
the caller least likely to honour a convention.

The tier was also asymmetric with the rest of the estate, which holds the
opposite position: `deny-all` is kernel-enforced by an `--internal` network
(`assertNetworkCarriesThePolicy`), the Firecracker backend translates a policy
into per-VM nftables rules, and the kubernetes backend refuses a policy it
cannot express rather than emitting `HTTP_PROXY` in its place.

## The topology

The proxy is now a **container of its own**, and the sandbox is on a network
with no route out.

| Container | Networks | How it is started |
|---|---|---|
| `namzu-egress-<sandbox-id>` | upstream (`egressProxyUpstreamNetwork`, default `bridge`), then the internal network | `docker run --network <upstream>` followed by `docker network connect --alias namzu-egress <internal>` |
| `namzu-sandbox-<sandbox-id>` | the internal network only | `docker run --network <config.network>` |

Four consequences, each of them the point rather than a side effect:

- **The sandbox has no default route.** An `--internal` network gives a
  container a subnet and no way off it. Measured against Docker 29.6: `ip route`
  inside such a container lists its own subnet and nothing else, and
  `wget http://1.1.1.1` fails with `Network unreachable` — the kernel refusing,
  not a proxy variable a workload may decline to read.
- **It cannot put the route back.** `--cap-drop=ALL` removes `NET_ADMIN`, which
  is what `ip route add default via …` needs. This is the second, independent
  load `HARDENING_ARGS` carries and the reason it is not softened by a re-add
  list; `HARDENING_ARGS` itself records the measurement.
- **The proxy is reachable by name with no alias file.** It is a container on
  the sandbox's own network, so docker's embedded DNS resolves its
  `namzu-egress` alias. `--add-host` and `host-gateway` are gone from the
  sandbox's argv, and a test pins their absence.
- **`HTTP_PROXY` and friends stay.** They now *direct* traffic rather than
  permit it: a tool that honours them sends its request to the boundary, and a
  tool that ignores them has nowhere to send anything.

The proxy's own container gets the same baseline the sandbox does —
`--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--ipc private`,
`--read-only` over a `/tmp` tmpfs — because it is the process standing between
untrusted code and the internet.

## What a deployer has to do

An allowlist policy on this backend now needs three things, and `create()`
refuses without them rather than starting a sandbox under a policy nothing
enforces.

1. **An internal network.** `docker network create --internal <name>`, named in
   `network`. A policy of `static` or `resolver` on a network that is not
   internal is refused; the network's own `Internal` flag is read back from the
   daemon, never inferred from its name.
2. **`hostReachability: 'container-network'`.** This is a consequence of the
   boundary, not a preference: docker publishes a port by NAT to the
   container's address, and a container with no route out has no address to
   bind to. `create()` refuses the combination and names the mode to move to.
3. **Two images, both built by hand.** Nothing in this repository pushes an
   image; the reference sandbox image is built from `worker/Dockerfile` and the
   proxy image from `egress-proxy/Dockerfile`, and the tag of each is named in
   the config (`image`, `egressProxyImage`).

```bash
pnpm --filter @namzu/sandbox build
docker build -f packages/sandbox/worker/Dockerfile       -t namzu-sandbox:latest  packages/sandbox
docker build -f packages/sandbox/egress-proxy/Dockerfile -t namzu-egress-proxy:latest packages/sandbox
```

The proxy image is a second image rather than a reuse of the sandbox's, and the
reason is deployment-shaped: the sandbox image is a string this backend cannot
read, so there is no way to know whether it contains the proxy module — and the
bind-mount alternative breaks exactly on the remote-daemon deployment
(`hostReachability: 'container-network'` exists for the case where the SDK is
itself a container), because the path it would bind is on the SDK's filesystem
and the daemon cannot see it. `.github/workflows/sandbox-smoke.yml` builds both
images on a runner that has a daemon, so the Dockerfiles are known to build.

`deny-all` and `allow-all` need none of this beyond the internal network
`deny-all` already required.

Two more things are refused rather than started: `egressProxyUpstreamNetwork`
set to `'none'`, and set to the internal network itself — either leaves the
proxy with no default route, which is a boundary in front of nothing while the
only way the sandbox's traffic reaches the internet points at it.

An aborted `create()` removes the proxy too. That is worth stating because it
is a container holding credentials with a route to the internet, and
`destroy()` is unreachable when `create()` never returned a handle; the
acquisition timeout in the SDK's sandbox lifecycle is enough to reach it.

A `setNetworkPolicy()` whose replacement is still starting when the sandbox is
torn down does not leave that replacement behind, even though the teardown has
run by the time the replacement comes up: it fails with the sandbox's own
retirement rather than reporting a policy change on a sandbox that no longer
exists. The removal is issued after the container exists and does not travel on
the caller's signal, which is what closes that ordering rather than narrowing
it.

That last property is NOT claimed of the ordinary teardown, and the difference
matters to anyone reading this as "the proxy is always removed". A `destroy()`
whose own `signal` was already aborted issues no `rm -f` at all — not for the
proxy, and not for the sandbox either. `Sandbox.destroy` binds an
implementation to stop its teardown transport and settle promptly when it
aborts, and this backend does: the whole container set is left running, not
just the credential-bearing one. That is the caller's instruction rather than a
failure of the removal paths above.

## What the sandbox can still reach, and what it cannot

Argued from the flags rather than from an expectation:

- **Cannot** reach any host on the internet. No default route, and `NET_ADMIN`
  dropped so none can be added.
- **Cannot** reach another network's containers. Docker's isolation rules drop
  traffic from an internal bridge to any other bridge, and there is no route to
  the other bridge in its table.
- **Can** reach `namzu-egress:<port>` — the proxy container, on its own subnet.
  That is the destination the design is built around.
- **Can also reach everything else on that same internal network.** The
  internal network is a subnet, not a point-to-point link: a second sandbox on
  it, a second sandbox's proxy, and anything else a host attaches there are all
  reachable — and a sandbox's proxy listens on every interface inside its own
  container, so it answers whoever asks. A host that puts more than one
  sandbox's containers on one internal network has put them in reach of each
  other and of each other's credential-stamping proxy. Give each sandbox (or
  each trust domain) its own internal network when that matters.
- **Can** reach the docker host's own IP on the internal bridge, and any
  service of the host's bound to it. The internal network removes the route
  OUT; it does not remove the host, which owns the bridge and terminates
  on-link traffic locally. Anything a host binds to every interface is on the
  sandbox's subnet. Loopback-bound services are not.

## What the boundary does not cover

Stated here for the same reason the proxy's own `CONNECT` comment states its
limit — a reader should not infer more than is true.

- **Domain fronting still defeats a hostname allowlist.** The proxy allowlists
  the name in the `CONNECT` line and never inspects the tunnel. This is
  unchanged by any of the above and is why the proxy decides by resolved
  address (#385) rather than by name alone.
- **A brokered credential now lives in two places it did not before**: the
  proxy container's environment, and the `docker inspect` output that shows it.
  It was previously held only by the process that created the sandbox. It still
  never enters the SANDBOX — that is the line the threat model draws, and a
  sandbox has no way to read another container's environment — but anything
  with access to the docker daemon can read it, so treat daemon access as
  credential access. On the way there it is handed to the `docker` CLI process
  through that process's ENVIRONMENT rather than its argv, deliberately: an
  argv is world-readable on Linux (`/proc/<pid>/cmdline`), which would have
  published every credential value to every local user on the docker host for
  as long as the client ran, while a process environment is readable only by
  the user that owns it. A host that runs the sandbox SDK as one user and
  shares the machine with untrusted local users should still prefer not to use
  credential brokering on it.
- **Brokered credentials are stamped on only where a proxy is running**, which
  is a property of the policy rather than of the field: `static` and `resolver`
  start the proxy container, `deny-all` and `allow-all` start none, so
  credentials set beside either of the last two are never applied — the requests
  leave unauthenticated rather than refused. The microVM and kubernetes tiers
  enforce egress by other means and have no proxy at all, which is why
  `brokeredCredentials` is a field on the container tier's
  `ContainerBackendConfig` rather than on the cross-tier provider config:
  declared where it could never be honoured, it would silently do nothing. On
  the container tier, `createSandboxProvider` forwards it to the backend that
  builds the proxy, at both of that function's `buildDockerBackend` call sites,
  so a host that constructs its provider the documented way reaches credential
  brokering without building the backend directly.
  `src/egress/__tests__/exemption-reaches-the-backend.test.ts` pins the
  forwarding, and the internal configuration it reaches is pinned as the proxy
  container's environment by `src/backends/docker/__tests__/egress-topology.test.ts`.
- **A `resolver` policy is resolved at `create()` and at each
  `setNetworkPolicy()`**, not per request. The container has no channel back to
  the host's resolver, and a channel it could reach is one the sandbox could
  reach too — which would let the sandbox ask for its own allowlist to be
  widened. A rotating resolver is honoured at those two moments and not in
  between.
- **`setNetworkPolicy()` replaces the proxy container.** The policy is written
  into the container's environment at start. The window between removing the
  old container and the new one being up has no proxy in it, so it fails
  CLOSED: requests made in that instant are refused, not permitted.
- **The proxy listens on every interface inside its own container**, so
  anything else on its upstream network can reach it — and it enforces its
  allowlist for whoever asks and stamps brokered credentials on what it
  forwards. `egressProxyUpstreamNetwork` defaults to docker's `bridge`, which
  is shared; name a dedicated network on a daemon that runs other containers.

## What is not measured here

**No test in this repository starts a container.** There is no docker daemon in
the test environment, so this change is verified at the argv and plan level and
by unit tests on the entrypoint's parsing — the same tier of evidence the
container-hardening work (#378) reports. What is pinned:

- `src/backends/docker/__tests__/hardening.test.ts` pins the sandbox's whole
  argv, including that `--add-host` and `host-gateway` appear nowhere in it.
- `src/backends/docker/__tests__/egress-topology.test.ts` pins the proxy's
  `docker run` argv and its `docker network connect` argv, and drives `create()`
  through a fake `docker` binary to assert the order the two containers are
  started in, the network each joins, and that `destroy()` removes both. That
  fake daemon keeps a registry of the containers it has committed, so "removed"
  means the container is gone rather than that an `rm` was typed. Four of its
  cases hold the daemon at a chosen point and abort there — during the proxy's
  `docker run`, during its attach, after it is up, and inside the replacement's
  `docker run` during a live policy swap, which is torn down while that
  replacement is starting — and assert that no container is left running. Each
  of those four was confirmed to fail against the shape it replaces. Two further
  cases drive the two failure paths of a live policy swap — the replacement's
  `run` failing, and its attach failing — and assert the rollback removal and
  the containers left; the first fails against the shape it replaces, and the
  second does NOT: the swap hands that start no signal, so the pre-change
  spelling of that catch behaved identically there. It is kept as a regression
  pin rather than reported as a probe.
- `src/backends/docker/__tests__/hardening.test.ts` feeds
  `egressProxyContainerConfig`'s own output to `parseProxyConfig`, the parser the
  container runs, so the two ends of that boundary are pinned against each
  other rather than each against its own idea of the shape.
- `egress-proxy/__tests__/server.test.js` starts the container's entrypoint as
  a subprocess and asserts that a readable configuration comes up and that
  every unreadable one exits non-zero.
- `egress-proxy/__tests__/dockerfile.test.ts` checks the textual invariants the
  image depends on, including that the module is copied to where the entrypoint
  resolves it.

What a daemon would add is the one fact none of those can: that a container
built this way comes up. `sandbox-smoke.yml` builds both images, and a smoke
case exercising the topology end to end is the thing this page would gain next.
