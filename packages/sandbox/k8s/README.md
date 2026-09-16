# `@namzu/sandbox` kubernetes cluster artifacts

Everything an operator applies to a real cluster to run the `microvm` /
`kubernetes` backend (`docs/sdk/kubernetes-sandbox.md`) for real: the guest
image, its entrypoint, the CRD manifests, and five scripts that each measure
one of the backend's acceptance criteria against a live cluster and print a
pass/fail line plus the measured number.

**None of this ships in the published npm package.** `packages/sandbox`'s
`files` array packs only `dist` and `src` — verify with `npm pack --dry-run`
from `packages/sandbox` any time this changes; a stray reference from `src/`
into `k8s/` would be a publish-time surprise, not a build error.

## Layout

```
k8s/
  Dockerfile           guest image: node + setpriv/blkid/mkfs.ext4 + the agent
  entrypoint.sh         format/mount (workspace only) then exec into setpriv
  manifests/            apply these to the cluster
  scripts/               run these against the cluster once applied
  __tests__/             sh -n/dash -n + PATH-shimmed logic + YAML structure
```

## 1. Confirm the RuntimeClass

`manifests/runtimeclass.yaml`'s Kata `RuntimeClass` name has drifted between
published sources — **do not trust the name in this repo**:

```sh
kubectl get runtimeclass
```

Edit `manifests/runtimeclass.yaml`, `manifests/sandboxtemplate-task.yaml` and
`manifests/sandboxtemplate-workspace.yaml`'s `runtimeClassName` to match
whatever that lists before applying anything.

## 2. Build and push the image

```sh
# From the repository root — the build context is packages/sandbox (the
# Dockerfile COPYs agent/agent.cjs, a SIBLING of k8s/, not a child of it).
docker build -f packages/sandbox/k8s/Dockerfile -t <registry>/namzu-sandbox-agent:<tag> packages/sandbox
docker push <registry>/namzu-sandbox-agent:<tag>
```

Then set that exact reference as `image:` in both
`manifests/sandboxtemplate-task.yaml` and
`manifests/sandboxtemplate-workspace.yaml` (each currently carries a
`REPLACE_WITH_YOUR_REGISTRY/namzu-sandbox-agent:TAG` placeholder).

**A new tag and `SandboxWarmPool.spec.updateStrategy`:** `manifests/
sandboxwarmpool.yaml` uses `OnReplenish` (the CRD default) — an edited
template takes effect only as each pooled replica is claimed and the pool
replenishes behind it, never immediately. `Recreate` deletes and recreates
every unclaimed replica **the moment** the template changes; for a
disk-bearing pool that would delete pre-warmed PVCs on every image bump.
There is no disk-bearing warm pool in this repo's manifests (workspaces are
never pooled — see `manifests/sandboxtemplate-workspace.yaml`'s own header),
but keep that consequence in mind before ever changing this default.

## 3. Fix the two placeholder selectors

Both `manifests/sandboxtemplate-task.yaml`'s (and `-workspace.yaml`'s)
inline `networkPolicy` block and the standalone `manifests/networkpolicy.yaml`
select ingress by:

```yaml
podSelector:
  matchLabels:
    namzu.ai/component: host
```

As shipped this matches **nothing** — a closed door, not an open one — so
replace it with whatever label your namzu host Deployment's own pods
actually carry, in **both** places (`sandboxtemplate-task.yaml`,
`sandboxtemplate-workspace.yaml` and `networkpolicy.yaml`), and set a
workload's egress destinations in `networkpolicy.yaml`'s `egress` list (the
shipped placeholder is an RFC 5737 documentation range that resolves to
nothing real).

If the backend's own `config.egress.engine` is `'cilium'` (a hostname
allowlist, translated to a `CiliumNetworkPolicy` — see
`docs/sdk/kubernetes-sandbox.md`'s egress section), the host reads that
object back before every `create()`. `manifests/rbac.yaml` already grants
`get` on `ciliumnetworkpolicies` (`cilium.io`) for exactly this — a cluster
running the default `'core'` engine, or no Cilium CRDs at all, simply never
matches that rule, so there is nothing to remove.

If a workspace's disk needs a `storageClassName` other than one that
provisions `volumeMode: Block`, fix that in
`manifests/sandboxtemplate-workspace.yaml` too — the default StorageClass on
a stock kind cluster (`standard`, rancher.io/local-path) **cannot** provision
`Block` at all (see the kind overlay below for the workaround that exists
specifically because of this).

## 4. Apply, in this order

```sh
kubectl create namespace namzu-sandboxes   # or whatever namespace you chose
kubectl apply -f manifests/rbac.yaml
kubectl apply -f manifests/runtimeclass.yaml
kubectl apply -f manifests/sandboxtemplate-task.yaml
kubectl apply -f manifests/sandboxtemplate-workspace.yaml
kubectl apply -f manifests/networkpolicy.yaml
kubectl apply -f manifests/sandboxwarmpool.yaml
```

(`SandboxWarmPool` last because it immediately starts building replicas from
`sandboxtemplate-task.yaml` — apply the template it references first, or the
first reconcile just retries until it exists.)

Confirm the pool actually warmed before running any script against it:

```sh
kubectl get sandboxwarmpool namzu-task-pool -n namzu-sandboxes -w
```

### Local kind development (NOT a security boundary)

`manifests/kind-overlay/` is a [Kustomize](https://kustomize.io) overlay for
a local `kind` cluster, which ships no Kata `RuntimeClass` and whose default
StorageClass cannot provision `volumeMode: Block`. It drops
`runtimeClassName` everywhere and converts the workspace disk to an ordinary
`Filesystem`-mode PVC — see that directory's own `kustomization.yaml` for the
full rationale and its loud warning that this gives you plain container
namespaces, not a VM boundary. Use it only to develop/smoke-test the
plumbing, never as a stand-in for the acceptance run below.

```sh
kubectl apply -k manifests/kind-overlay --load-restrictor=LoadRestrictionsNone
```

(`--load-restrictor=LoadRestrictionsNone` is required because the overlay
references its sibling manifests one directory up — see the flag's own
`kubectl kustomize --help` text for what that trades away, which is only
relocatability, not safety, for a directory this repository ships as one
unit.)

## 5. Run the acceptance scripts

All five live under `scripts/`, run against the **built** package
(`pnpm -r build` from the repo root first — they import
`@namzu/sandbox`/`@namzu/sdk` from `dist/`, and `contract-suite.mjs`
additionally imports the conformance suite straight from
`../../dist/testing/sandbox-conformance.js`). Each prints `[PASS]`/`[FAIL]`
lines and a measured number, and exits non-zero if anything failed.

Every script takes `--namespace` and (task-sandbox scripts) `--template` /
`--pool`, plus one of two access modes:

- `--in-cluster` — run the script as a Job/Pod under `manifests/rbac.yaml`'s
  `namzu-sandbox-host` ServiceAccount.
- `--server <url> --token <token>` (or `--token-file`, or `NAMZU_K8S_*` env
  vars — see `scripts/lib/cluster-access.mjs`'s own doc comment) — run it
  from a laptop or CI runner against a remote cluster.

```sh
# Criterion 1: the Sandbox contract passes against a real, live sandbox.
node scripts/contract-suite.mjs \
  --namespace namzu-sandboxes --template namzu-task --pool namzu-task-pool \
  --server https://cluster.example:6443 --token "$(cat token.txt)"

# Criterion 2: warm-pool acquire p50 < 1s, over 50 serial acquires.
node scripts/acquire-p50.mjs \
  --namespace namzu-sandboxes --template namzu-task --pool namzu-task-pool \
  --count 50 --in-cluster

# Criterion 3: a workspace's disk survives suspend/resume.
node scripts/suspend-resume.mjs \
  --namespace namzu-sandboxes --template namzu-workspace --in-cluster

# Criterion 4: small-file IO on the block PVC vs. host ext4, within 1.5x.
node scripts/io-compare.mjs \
  --namespace namzu-sandboxes --template namzu-workspace --files 200 --in-cluster

# Criterion 5: the guest really is deprivileged (all-zero cap masks,
# NoNewPrivs, and a mount attempt the kernel itself refuses).
node scripts/capability-check.mjs \
  --namespace namzu-sandboxes --template namzu-task --pool namzu-task-pool --in-cluster
```

Record the five printed numbers, with the date and the cluster's shape
(node type, storage backend, Kata version), in
`docs/sdk/kubernetes-sandbox.md`'s deployment section — that table is
currently empty and says so; these five runs are what fill it in.

## Tests

`__tests__/entrypoint.test.ts` and `__tests__/manifests.test.ts` run in the
package's normal `pnpm --filter @namzu/sandbox test` — no cluster, no Kata,
no root. `entrypoint.test.ts` shims `blkid`/`dd`/`mkfs.ext4`/`mount`/`chown`/
`setpriv` in `PATH` (never the real tools) and exercises the mount-vs-mkfs
branching against a real, already-existing block device NODE
(`/dev/loop0`..`7`, present on the `ubuntu-latest` Linux CI runner this repo's own `.github/workflows/ci.yml` uses)
whose type it only ever `stat()`s — nothing shimmed ever opens it for real.
It also covers every way `blkid` can fail to answer cleanly: exiting
127/126/4/8 with no output, being entirely absent from `PATH` (proven with a
`PATH` the shim controls end to end, so the runner's own `blkid` cannot
quietly answer instead), and exiting 2 ("no filesystem found") on a device
that then fails the `dd` readability probe entrypoint.sh runs before trusting
that "2" enough to format. Every one of those must abort before `mkfs.ext4`
or `mount` ever runs.
