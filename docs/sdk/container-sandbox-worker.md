---
type: Reference
title: The container sandbox worker's credential
description: The per-instance bearer token the container backend mints and the worker requires on every route but /healthz, the startup refusals that make an unanswerable credential impossible, the named escape and what it gives up, and why the standby pool — whose claim API does admit a per-claim config map — still does not carry this credential, with the change that would close it.
resource: packages/sandbox/worker/server.js
tags: [sdk, sandbox, container, docker, authentication, worker]
status: stable
generated: { by: process:claude-code, at: 2026-09-18T00:00:00Z }
---

# The container sandbox worker's credential

The `container:docker` backend runs one container per sandbox and talks to
`packages/sandbox/worker/server.js` over HTTP. That worker served `/healthz`,
`/execute`, `/executions/reserve`, `/cancel`, `/read-file` and `/write-file`
with no authentication of any kind: any peer that could route to the container
could run a command inside it and read and write its files. The design note in
the worker said so, and rested the boundary on the network the container is
attached to — a property of a deployment, not of the file, and one that the
standby-pool path does not guarantee when a claim takes a public address.

Every route but `GET /healthz` now requires
`Authorization: Bearer <NAMZU_SANDBOX_TOKEN>`, and a worker that has no token
refuses to listen on anything routable.

## The credential

The token is **minted per instance, by whoever starts the container**, and
read by the worker at startup:

- **Minted at `create()`.** `spawnDockerSandbox` generates 32 random bytes
  (`randomBytes(32).toString('base64url')`) per sandbox. Not per process, and
  never per image: an image-level secret is shared by every container ever
  built from it, is readable by anything that can pull the image, and is
  rotated by rebuilding and redeploying every deployment.
- **Carried in the docker CLI's environment**, not in its argv, as
  `NAMZU_SANDBOX_TOKEN`. It shares a *destination* with three variables that
  already exist — `NAMZU_SANDBOX_WORKSPACE`, `_READ_ROOTS` and `_WRITE_ROOTS`
  all end up in the container's environment through the same `--env` mechanism
  — and it shares nothing else with them. Those three are rendered **in the
  argv**, `--env K=V`, values and all; this one is rendered valueless
  (`--env NAMZU_SANDBOX_TOKEN`), which is docker's form for "take the value
  from the environment of the CLI process". That is the whole difference, and
  it is the point: `ps` on the host shows an argv to every user, and
  `/proc/<pid>/environ` is readable only by the same user and root. It is
  rendered last among the `--env` flags, because Docker applies repeated ones
  in order and the last wins — a host that separately sets the same name would
  otherwise produce a container that rejects every call its own client makes.
  A non-zero `docker run` renders its argv with every `--env` value redacted,
  in all four spellings of the flag, so the failure message a host logs
  carries the keys and never the secrets.
- **Not persisted as a file, a label or an image layer.** It is not written
  anywhere, and nothing that outlives the sandbox holds it.
- **Where it IS readable, said plainly.** The container's own config, so
  `docker inspect <name>` shows it for the container's life, to anyone who can
  already talk to the daemon — the same authority that can `docker exec` into
  the sandbox. And the worker's own `/proc` inside the container, to a
  workload that shares its uid. Neither is a reason to share the credential
  between instances or to let it outlive one, which is why it is per-instance
  and dies with the container.
- **Dead with the container.** Nothing revokes it, because the only process
  that would accept it is removed with the sandbox — and with it the container
  config that still held it.

The client sends it on every request it makes — `HttpWorkerClient` for
`reserve`, `cancel` and `execute`, and the backend's own `read-file` and
`write-file` calls, which are direct `fetch`es rather than client methods and
therefore carry the header separately.

## What the worker enforces

| Route | Without the token |
|---|---|
| `GET /healthz` | `200` — liveness and the protocol version, and nothing else |
| `POST /execute`, `/executions/reserve`, `/cancel`, `/read-file`, `/write-file` | `401 {"error":"unauthorized"}` |
| Anything else, including a route that does not exist | `401`, not `404` |

The gate is the first thing in the router, ahead of every dispatch and ahead of
the retiring-worker check. That ordering is deliberate and has three
consequences worth stating:

- **No handler runs.** A refused `/write-file` writes nothing, and a refused
  `/execute` reserves no lease, so an unauthenticated flood cannot keep an idle
  sandbox alive.
- **The route table is not enumerable.** An unauthenticated caller cannot tell a
  real route from a missing one, or a wrong token from a missing one: both are
  the same `401` with the same body.
- **The reason is the whole body.** No expected vs. got, no length, no prefix.
  The comparison is between fixed-width SHA-256 digests with
  `timingSafeEqual`, so neither the value nor its length is learnable by
  probing, and a bare token without the `Bearer` scheme is refused like any
  other wrong value.

`/healthz` is exempt because it is what a host polls before it has any other
business with the worker — the readiness loop runs many times per `create()`,
and a liveness question answered with a credential error would be worse than
useless. It neither requires nor echoes a token.

Two things follow from that exemption, and neither is a leak to be closed:

- **One bit separates a retiring worker from a serving one, on that route and
  nowhere else.** The retiring-worker check answers before the `/healthz`
  dispatch, so an unauthenticated `GET /healthz` gets
  `503 {"error":"worker_retiring"}` from a worker that has poisoned itself and
  `200` from one that has not. That is the drain signal, and the readiness
  probe — which has no credential to present — is who has to read it. It
  discloses that the worker is going away and nothing about what it holds, what
  it has run, or which routes exist. On every route that does anything, the
  two are the same `401` to a caller without the token.
- **The exemption is an exact match on the whole URL.** `POST /healthz`,
  `GET /healthz?x=1` and `GET /healthz/` are gated like anything else, and with
  the token they are `404`s, like any other route that does not exist.

## The startup decision

`NAMZU_SANDBOX_BIND` still defaults to `0.0.0.0`, and still has to: a published
container port forwards to the container's interface address rather than to its
loopback, so a loopback-bound worker is unreachable through the port the
backend publishes. The credential is what makes that default defensible, so its
absence fails closed before a socket exists:

| Configuration | What happens |
|---|---|
| `NAMZU_SANDBOX_TOKEN` set | Every route but `/healthz` requires it, whatever the bind address. The bind line logs `auth=bearer` |
| No token, loopback bind (`127.0.0.1`, `127.*`, `::1`, `localhost`) | Starts, unauthenticated, `auth=none` |
| No token, any other bind — including the `0.0.0.0` default | **Refuses to start**, exit 1, naming the variable, the bind address and every way out |
| `NAMZU_SANDBOX_TOKEN` set but empty, or with leading/trailing whitespace | **Refuses to start** in every mode |
| `NAMZU_SANDBOX_TOKEN` set to a value no HTTP header can carry | **Refuses to start** in every mode |
| No token, routable bind, `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` | Starts unauthenticated, on purpose |

Two asymmetries, both deliberate.

**Loopback without a token may start.** Nothing outside the container's own
network namespace can open that socket, and the host reaches the worker through
Docker's port-forward, which is a different address. Refusing here would break
the host-beside-docker dev case and close nothing.

**A token that is set but unanswerable is refused even on loopback.** Three
values take that shape, and all three are refused before the bind address is
even considered.

- **Empty.** `NAMZU_SANDBOX_TOKEN=""` is what an injected secret looks like when
  the injection resolved to nothing; honouring it would open exactly the hole
  the variable closes. The microVM guest agent refuses the same value for the
  same reason at its own startup.
- **Padded.** A value with whitespace around it is the same failure from the
  other side: the worker reads the presented token out of a trimmed header, so
  `" secret "` can never be presented, and the worker would boot looking
  authenticated while refusing every caller — its host included — until the
  container is gone.
- **Unpresentable.** A header value carries one byte per character. A code point
  above U+00FF makes the client's own `fetch` throw
  (`Cannot convert argument to a ByteString`) before the request leaves the
  host, and a C0 control other than HTAB, or DEL, is dropped by the HTTP parser
  on this side. Either way the credential is unanswerable and the worker is in
  the same "boots authenticated, refuses its host" state. The accepted set is
  exactly what a header carries — HTAB, printable ASCII and U+0080–U+00FF,
  which both ends pass as latin-1 — so a token with `é` in it is fine and a
  token with `€` is refused at boot rather than at the first call.

## The escape, and what it gives up

`NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` keeps a deployment running
unauthenticated. It is named rather than implied so that accepting the exposure
is a decision someone made on purpose, and it gives up the credential rather
than deferring it: with it set and no token, every route but `/healthz` is open
to whoever can route to the container, which is the pre-token behaviour exactly.

- Only `1`, `true`, `yes` and `on`, in any case and with no surrounding
  whitespace, turn it on. `0`, `false`, `no`, `off`, the empty string and
  anything else mean off, and an unrecognised value therefore fails **closed** —
  a flag whose off-spelling turns it on is a trap, and so is a security escape
  that accepts the shape a value takes when an editor adds a space to it.
- A configured token always wins. The escape can only mean "serve without a
  credential", never "ignore the one I was given".

## Workers this host did not create

There is no channel back. The worker is handed its credential at startup and
never publishes one, so a host cannot learn the token of a worker it did not
start, and cannot authenticate against one nobody provisioned. That is a gap in
this design rather than a detail of it, and it has three answers — the first of
which is only available to whoever builds the artifact, and the second of which
is the only one that runs on the standby pool today:

- **Set it on the profile or the image the worker comes from**, if you control
  that artifact and accept that every instance built from it shares one
  credential. This requires the client side to present it too: a credential the
  host cannot send is a worker that boots and then refuses every call, so a
  backend has to have a field or a channel to carry it. `aci-standby-pool` has
  neither, which is why this option does not apply there.
- **Set `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` on it**, if the network in front
  of it is the boundary and you are saying so on purpose.
- **Otherwise the worker will not start** on a routable address, which is the
  intended outcome: the failure is at boot and names the variable, not a silent
  execute endpoint.

### The standby pool: the channel exists, and this credential still does not go in it

This is the answer to the design question the issue opens with — *whether a
per-claim config map can carry a value the pooled profile does not already
contain* — and it is recorded here because an earlier version of this page
answered it wrongly, in the direction that matters.

**The channel exists.** `aci-standby-pool` refuses per-sandbox `env` outright,
and it is right to: the claim API admits exactly one property override and it is
not `env`. `env`, `memoryLimitMb`, `maxProcesses` and `egress` are listed as
`UNSUPPORTED_PER_SANDBOX_CONTROLS` and a request that sets one throws rather
than being silently dropped. The one override it **does** admit is a **config
map**, and a config map is not inert per-profile configuration. Microsoft
describes it as "a property that you can use to apply container configurations
similar to environment variables and secret volumes", applied to the container
group, and on Linux its values are mounted into the container as files at
`/mnt/configmap/<containername>/<key>` with no restart — "Config maps for Azure
Container Instances",
<https://learn.microsoft.com/en-us/azure/container-instances/container-instances-config-map>.
A caller-supplied per-claim value therefore **does** reach a claimed container
group. The sentence this page used to carry — that a per-claim secret "has no
channel into the container group" — was false, and it is worth saying plainly
that it was false rather than quietly replacing it: it is what told an operator
that turning authentication off was the only option open to them.

**The credential is still declined there, for two reasons that do survive their
source.**

- **The worker would not read it.** A config-map value arrives as a *file
  mount*, and this worker reads its credential from `process.env` once, at
  startup (`const TOKEN = process.env.NAMZU_SANDBOX_TOKEN`, at module scope in
  `worker/server.js`). Nothing in the worker looks at the filesystem for a
  credential. A token delivered as a mount would not be read: the worker would
  boot with no token, which on a routable bind is a refusal to start and on
  loopback is an unauthenticated listener — worse than the gap, because it
  looks configured.
- **The platform does not vouch for it.** Microsoft's guidance for config maps
  is explicit: their values "are not included in the security policy" and are
  not "validated by the runtime before the file mount is made available to the
  container", and "values that could have an impact to data or application
  security … should be made available to the container using environment
  variables" — "Standby pools for Azure Container Instances",
  <https://learn.microsoft.com/en-us/azure/container-instances/container-instances-standby-pool-overview>.
  A credential is exactly the value that sentence describes, and the
  environment variable is precisely the channel this backend cannot use.
  Declining to put it there is following the platform's own advice, not
  working around it.

**What would close the gap.** The change is concrete and small in shape: the
backend mints a per-claim value, sends it in the claim's config map, and the
worker reads it at startup from the mounted file
(`/mnt/configmap/<containername>/NAMZU_SANDBOX_TOKEN`) alongside — or instead
of — the environment variable, with the backend's client presenting the same
value as the bearer token. It is written down here so the next reader starts
from the answer rather than re-deriving it. It is **not implemented in this
round**: a credential path that cannot be exercised against a live standby pool
from here would ship unverified, and an unverified credential mechanism is
worse than a documented gap.

**What an operator does today.** Network placement is the control that carries
the exposure, and it is the one to get right first: `assertNotPubliclyAddressed`
refuses a claim that would take a public address unless `subnetId` puts the
group in a private network (or `allowPublicAddress: true` accepts it
deliberately). That refusal is unchanged. On a private address the worker still
needs a way to start, and this backend cannot present a credential:
`HttpWorkerClient` accepts one (`constructor(baseUrl, token?)`) but this backend
constructs it without a token and its two direct `read-file`/`write-file`
fetches send no header either, and there is no field a caller could put one in —
`options.env`, where it would otherwise go, is itself among the controls the
backend refuses. So the escape is what makes a pooled worker boot at all:
`NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` on the container group profile, behind a
private address, is the only configuration in which this backend runs today. A
token on the shared profile does not fix it — the worker would boot
authenticated and then `401` every call the backend makes, a loop rather than a
fix. This half of the issue is **out of scope here** and is not implemented.

## What this does not cover

- **Confidentiality of the transport.** `Authorization: Bearer` over plain HTTP
  is replayable by anything on the path. The token is defence in depth behind
  network placement, not a substitute for it: the container backend reaches the
  worker over host loopback or a private bridge, and the standby-pool backend
  still refuses a public address without `subnetId`.
- **The sandbox's own workload.** Once inside the container, a command can read
  the worker's `/proc/<pid>/environ`. It cannot read the token out of the
  environment the worker HANDS it — the worker strips every `NAMZU_SANDBOX_`
  prefixed variable from a spawned command's environment, which is why the
  token carries that prefix — but the process's own environment is not hidden
  from a peer in the same container. That is the same exposure the microVM guest
  agent has, and it is the reason the token is per-instance: a workload that
  steals its own instance's token gains nothing it did not already have.
- **Short expiry.** The token lives as long as the sandbox. There is no
  reissue, no rotation and no revocation list, because the only process that
  could accept the credential is the one the sandbox owns.

## Verification

The behaviour above was established by running the real worker as a subprocess
and probing it over loopback, not by reading it. With a token configured, every
route answered something other than `401` when the header was present — `200`
for `/execute`, `/write-file` and `/read-file`, `201` for
`/executions/reserve`, `404` for `/cancel` against an id that was never
reserved — and `401 {"error":"unauthorized"}` for every one of them without the
header, including an unknown route and a wrong or schemeless token; `/healthz`
answered `200` with no header at all; an unauthenticated `/write-file` left the
target file's contents untouched while the authenticated one beside it landed; a
worker with no token and the default bind exited 1 naming the variable; the same
worker on `127.0.0.1` started; and the escape started it on `0.0.0.0`.

The header shapes `fetch` will not produce were probed over a raw socket, and
what they answered is what the page says: `POST /healthz`, `GET /healthz?x=1`,
`GET /healthz/`, `HEAD /healthz`, `PUT /healthz` and `DELETE /execute` were all
`401` without the token and all `404` with it; a duplicated `Authorization`
resolved to the FIRST one, so the good one first reached the router and the good
one second was refused; and an obs-folded `Authorization` was answered by the
HTTP parser with a bare `400 Connection: close` before the router ran, whichever
continuation it carried.

The unpresentable-token boundary was mapped rather than assumed: every code
point from U+0000 to U+0021, plus DEL, U+0080, U+00FF, U+0100 and U+20AC, was
sent through `fetch` to a Node HTTP server and read back, which is what
separates the set that survives the round trip (HTAB, printable ASCII,
U+0080–U+00FF) from the set that does not.

The standby-pool section was checked against Microsoft's own documentation
rather than against this repository: the config-map description, the
`/mnt/configmap/<containername>/<key>` mount path on Linux, and the security
caveat are quoted from the ACI config-map and standby-pool pages, and the
worker's `process.env`-only read is from `worker/server.js` itself.

The suites that keep it that way assert the weaker-but-sufficient form of the
same thing: any answer other than `401` proves the request reached a handler,
where the fixtures are too thin to produce a clean `200`. They are
`packages/sandbox/worker/__tests__/the-worker-requires-a-token.test.js`,
`.../an-unauthenticated-worker-refuses-a-routable-bind.test.js` and
`packages/sandbox/src/backends/docker/__tests__/the-worker-credential-is-minted-per-instance.test.ts`.
