---
"@namzu/sandbox": major
---

The container backend's worker now authenticates its caller, and a worker that
cannot refuses to start on a routable bind. This is a `major` because the wire
shape of a public surface changed: every route but `GET /healthz` now requires
`Authorization: Bearer <NAMZU_SANDBOX_TOKEN>`, a missing or wrong token is
`401 {"error":"unauthorized"}`, and a worker with no token will not listen on
anything but loopback. A token that is set but cannot be answered — empty,
padded, or carrying a character an HTTP header cannot hold — now refuses to
start rather than leaving a worker that looks authenticated and refuses its own
host.

Nothing in the package's TypeScript API changed — no export was removed,
renamed or narrowed, and `HttpWorkerClient` and `execViaHttpWorker` only gained
an optional token parameter. What changed is the contract between this backend
and the worker process it runs, and that contract is deployed separately: the
worker lives in `packages/sandbox/worker/server.js`, which the tarball does not
ship, so the image is built from whatever checkout the operator has.

**What breaks, and for whom.**

- **A worker image rebuilt from this release, paired with a host that predates
  it.** The old host injects no token, so the new worker refuses to start on
  the default `0.0.0.0` bind and every `create()` fails at readiness with the
  container already exited. The refusal names the variable. Bring the host up
  in the same step, or set the escape below.
- **Anything that talks to the worker without going through this backend.** The
  route contract is now authenticated; a probe, a health-check script that
  calls `/execute`, or a hand-rolled client must present the token.
- **The standby-pool backend.** A pooled worker built from this release will
  refuse to boot on its routable default bind, because this backend has no way
  to hand it a credential. The claim API admits exactly one property override,
  and it is not `env` — it is a config map, which on Linux reaches the container
  as a file mount under `/mnt/configmap/<containername>/<key>`, not as an
  environment variable, while the worker reads its token from `process.env` at
  startup. The platform does not validate config-map values either, and its own
  guidance is that a value affecting application security belongs in an
  environment variable. So the per-instance credential for this backend is NOT
  implemented here, and the change that would close the gap — a per-claim value
  in the config map, read by the worker — is written down in
  `docs/sdk/container-sandbox-worker.md` rather than half-built. A token on the
  shared profile does not fix it either: the worker would boot and then `401`
  every call the backend makes, because this backend's client is constructed
  without a token and it has no field to carry one.

**A host and a worker from the same release need no configuration.** The
container backend mints 32 random bytes per `create()`, hands the value to the
docker CLI in its own environment (resolved by a valueless
`--env NAMZU_SANDBOX_TOKEN`, so it is in no argv), and sends it as a bearer
header on every call it makes. Upgrading both together is the whole migration.
The token is per instance, never written to disk, and dies with the container.
It is readable where a peer in the same container or a caller who can already
talk to the docker daemon could read it — `docker inspect` shows it on the
container config for the container's life — which is why it is per-instance
rather than shared, and why it is a defence in depth behind network placement
rather than a replacement for it.

**The standby pool: place it first, decide about the credential second.** If you
run that backend, the control that actually carries the exposure is the network,
and it is the one to get right before anything else — `aci-standby-pool` already
refuses to claim a container group without `subnetId` (unless you set
`allowPublicAddress: true` and mean it), so the group sits on a private address
and that network is what stands in front of the worker. The refusal is unchanged
by this release; what has changed is that it is now the first half of the answer
rather than the whole of it. The second half is the escape below, which is what
makes a pooled worker start at all today: put
`NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` on the container group profile, with the
group on a private address. It is needed there only because this backend cannot
present a credential, and it turns a worker that cannot boot into one that
serves inside that address. Read the standby-pool bullet under "What breaks"
before taking that step, and note that a token on the shared profile is not an
alternative to it.

**For a deployment the container backend creates**, the escape is a migration
tool rather than a destination: it is what keeps you running while the host and
the worker image are brought up in the same step.

**To keep the old behaviour on purpose**, set
`NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` in the worker's environment — the
container backend's `options.env` for a sandbox it creates, or the standby
pool's container group profile for a pooled one. That gives the credential up
rather than deferring it: with it set and no token, every route but `/healthz`
is open to whoever can route to the container, which is exactly what the
default used to be. On the pool, the address comes first and this second; on
every other backend, both the host and the image should be upgraded in one step
instead. Only `1`, `true`, `yes` and `on` count, in any case and with no
surrounding whitespace; everything else — `= 0`, `= false`, `= " yes "` — means
off, so the flag cannot turn itself on.

Also unchanged, and worth repeating from the README: the transport is plain
HTTP, so this is a bearer token over the wire and it is defence in depth behind
network placement, not a replacement for it. See
`docs/sdk/container-sandbox-worker.md`.
