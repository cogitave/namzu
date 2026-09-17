---
'@namzu/sandbox': minor
---

The Kubernetes backend can now label its own task-path claims with a
host-supplied identity, recover a crashed predecessor's claims by that label,
and read warm-pool headroom before admitting more work. All additive; no
default changed.

A `SandboxClaim`'s own name is client-generated per acquire, so nothing about
one said which host process created it. A host killed by a deploy, an OOM or
a lost node left every claim it held running until `claimTtlSeconds` reaped
it — an hour by default — and its replacement had no way to find, let alone
release, them sooner. Three new pieces of surface close that gap:

- `claimLabels?: Record<string, string>` on the Kubernetes backend config is
  written into every `SandboxClaim`'s `metadata.labels` only — never into
  `additionalPodMetadata`, so a running Sandbox's pod labels and any
  `NetworkPolicy` selecting by them are unaffected.
- `releaseKubernetesTaskSandboxes(config, { labelSelector, signal })` LISTs
  claims by `labelSelector` and DELETEs each one, returning
  `{ deleted, names }`. `labelSelector` is **required** and refused, before a
  single request goes out, if it is absent or empty: a release that fell back
  to matching every claim would delete a live fleet's work.
- `readKubernetesTaskCapacity(config, { signal })` is three GETs and no
  writes — the configured `SandboxWarmPool`, the claims collection filtered
  to that pool, and the pods collection counted by `Pending` phase — into
  `{ warmPool: { ready, desired }, activeClaims, pendingPods }`. Requires
  `warmPoolName`; there is no pool to report on for a backend that creates
  every sandbox directly.

The shipped `k8s/manifests/rbac.yaml` gains `list` on `sandboxclaims` — the
verb both new functions need to find claims by label instead of by a name
they already know — so a deployment that does not re-apply it gets a `403`
from either function alone, and never from `create()`. `sandboxwarmpools:
get` is unchanged but is now a documented backend need rather than only a
diagnostic script's.

A host setting no `claimLabels` and calling neither new function sends the
exact requests it always has.
