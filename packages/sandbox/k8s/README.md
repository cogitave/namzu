# `@namzu/sandbox` kubernetes cluster artifacts

Everything an operator applies to a real cluster to run the `microvm` /
`kubernetes` backend (`docs/sdk/kubernetes-sandbox.md`) for real: the guest
image, its entrypoint, the CRD manifests, and six scripts that each measure
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
  entrypoint.sh         format/mount (workspace only, root) then exec into setpriv
  manifests/            apply these to the cluster (two are opt-in: see step 4)
  scripts/               run these against the cluster once applied
  __tests__/             sh -n/dash -n + PATH-shimmed logic + YAML structure
```

**Task pods run non-root with no capabilities (#491).**
`manifests/sandboxtemplate-task.yaml`'s container carries `runAsUser: 1001`,
`runAsGroup: 1001`, `runAsNonRoot: true`, `allowPrivilegeEscalation: false`,
`capabilities: { drop: [ALL] }` and `seccompProfile: { type: RuntimeDefault }`
— it names no `NAMZU_WORKSPACE_DEVICE`, so `entrypoint.sh`'s format/mount
branch never runs for it, and `entrypoint.sh` itself branches on its own
`id -u` to know which start it got. `manifests/sandboxtemplate-workspace.yaml`
still runs `privileged: true`, because its device branch genuinely needs
`CAP_SYS_ADMIN` to `blkid`/`mkfs.ext4`/`mount` a raw block device before
dropping every capability — see `docs/sdk/kubernetes-sandbox.md`'s privilege
probe section for the full table of both shapes, including the
`kind-overlay/` patches (both of which take the task template's restricted
shape).

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

**A task image that `FROM`s this one and layers its own packages on top must
repeat the set-id strip.** `Dockerfile` clears every setuid/setgid bit this
image's own packages carry with `RUN find / -xdev -perm /6000 -type f -exec
chmod ug-s {} +`; a package a derived image installs afterward can
reintroduce one (Debian's `sudo`, for one common example), and that step
only ever runs once, at the layer it is written in. Verify with
`find / -xdev -perm /6000 -type f` against the FINAL image — it should print
nothing.

**A new tag and `SandboxWarmPool.spec.updateStrategy`:** `manifests/
sandboxwarmpool.yaml` uses `OnReplenish` (the CRD default) — an edited
template takes effect only as each pooled replica is claimed and the pool
replenishes behind it, never immediately. `Recreate` deletes and recreates
every unclaimed replica **the moment** the template changes; for a
disk-bearing pool that would delete pre-warmed PVCs on every image bump.
There is no disk-bearing warm pool in this repo's manifests (workspaces are
never pooled — see `manifests/sandboxtemplate-workspace.yaml`'s own header),
but keep that consequence in mind before ever changing this default.

**A new tag does not reach an existing workspace on its own.** A `Sandbox`
carries its own copy of `spec.podTemplate`, taken when it was created, and
the controller builds every replacement pod from that copy — so editing
`manifests/sandboxtemplate-workspace.yaml` changes what NEW workspaces run
and nothing about the ones already on the cluster. Moving an existing
workspace onto the new tag is a host-side call: it suspends and resumes with
`refreshPodTemplate`, which rewrites `spec.podTemplate` in the same patch
that wakes it and keeps the disk. See the SDK page's "A resume can bring the
current pod template with it". There is no `kubectl` equivalent that is
safe to recommend: a hand-written patch has no condition on the operating
mode and neither of the two disk checks that call makes.

**Disks are the one edit that does not travel.** `spec.volumeClaimTemplates`
is CEL-immutable on a standing `Sandbox`, so adding a `volumeClaimTemplates`
entry here gives NEW workspaces a second disk and cannot be applied to the
ones that exist; a refresh against such a template is refused outright rather
than writing a pod spec that claims a device node no PVC backs. Renaming or
removing an entry is refused for the mirror-image reason. Give an existing
workspace another disk by creating a new workspace from the new template and
migrating the data.

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
matches that rule, so there is nothing to remove. The same rule also grants
`list`, which the ingress check uses when a deployment sets
`ingress: { engine: 'cilium' }`; declaring that engine on a cluster with no
such CRD is refused by name rather than read as "no policies".

**Narrowing a `static`/`resolver` allowlist by port, DNS name and TLS server
name** (`config.egress.ciliumNarrowing`, `engine: 'cilium'` only) is opt-in
and, unset, changes nothing — every already-applied `CiliumNetworkPolicy`
still verifies. Turning any option on DOES require an edit here: **delete
the plain kube-dns rule from `manifests/networkpolicy.yaml` and from
whichever `sandboxtemplate-*.yaml` block is in play** the moment
`ciliumNarrowing.dnsNames` is set — both files say so at the rule itself. The
reason is Cilium's own precedence rule: an L4-only rule (which is all core
`NetworkPolicy` can express) selecting the same pods on the same port as a
rule that ALSO carries an L7 restriction cancels that L7 restriction, so the
plain kube-dns-on-53 rule these files ship makes every DNS name resolve again
regardless of the narrower allowlist the translated `CiliumNetworkPolicy`
computes — the translated object grants the cluster resolver access on its
own once DNS-name narrowing is on, so nothing else needs to.

**This is enforced, not merely documented.** With `egress.verify` at its
default `'union'`, the same check that reads every OTHER policy selecting the
sandbox pods (see "Setting `config.egress`" above) also reads THIS one, and
compares what it grants against `ciliumNarrowing.dnsNames`'s own restriction —
not only reachability, since a plain rule and a DNS-narrowed one reach the
identical peer and port. Leave the rule in place with DNS-name narrowing on
and the next `create()` refuses with `KubernetesEgressPolicyUnionError`
(`policy-widens-egress`, naming this policy) rather than silently letting the
narrowing do nothing. `egress.verify: 'named-object-only'` does not run that
check — a deployment on that setting still has to delete the rule by hand and
gets no refusal if it forgets. Port and TLS-server-name narrowing
(`ciliumNarrowing.ports`/`hostPorts`/`tlsServerNames`) have no such
interaction and need no manifest edit — they only change the
`toFQDNs`/`toPorts` shape of the ONE `CiliumNetworkPolicy` this backend
computes and verifies, which `egress-check.mjs` still does not probe (see
below): the mechanism enforcing any of these three options is a single CNI's
own L7 proxy, and nothing in this repo has measured it.

`manifests/rbac.yaml` also grants `get` on `persistentvolumeclaims` (the core
group). A workspace handle reads each of its own PVCs once, by the name the
controller derives from the `volumeClaimTemplates` entry
(`<entry name>-<sandbox name>`), so it can report the disk's uid alongside the
Sandbox's — which is how a host tells the disk its records describe from a
different disk standing under the same deterministic workspace name. It is
never listed, never created and never deleted. **Re-applying this file is
optional**: a Role from an earlier release simply leaves those uids out of the
reported identity, and nothing else changes.

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

**`sandboxtemplate-workspace.yaml`'s `terminationGracePeriodSeconds` is a
budget nobody has measured.** It is 30 seconds, and it covers two things in
sequence: the pod's `preStop` hook (`/entrypoint.sh prestop` — `sync -f` on
the workspace, then a signal to pid 1 and a wait for it) and the agent's own
termination drain afterwards, bounded by `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS`
(15 seconds, shown in that manifest at its default). The hook's own wait is
DERIVED from that deadline — `ceil(NAMZU_AGENT_SHUTDOWN_DEADLINE_MS / 1000)
+ 2` seconds, 17 as shipped — because the kubelet runs the hook, waits for
it, and only then signals pid 1: a hook that gave up first would cap the
agent's drain at its own number instead of the advertised one. Raise the
deadline and the hook's wait follows; both still have to fit inside the grace
period. Measure the right value
on THIS cluster — delete a workspace pod and compare its `deletionTimestamp`
with the container's `finishedAt` and exit code — because it depends on the
runtime class, the storage class and how much a workload leaves dirty. On a
VM runtime the stop was measured to last the whole grace period even when the
container was gone within a second, so this number is roughly what every
`suspend()` will cost; keep it well below the host's `readyTimeoutMs`
(60 seconds by default), which bounds how long a suspend waits for the pod to
be gone. Re-applying the template does NOT change an existing workspace: a
`Sandbox` carries its own copy of `spec.podTemplate`, so this reaches
workspaces created afterwards, or one resumed with `refreshPodTemplate`.

**The task template carries the same pair at a smaller scale, and no hook.**
`sandboxtemplate-task.yaml` keeps its 5 second
`terminationGracePeriodSeconds` and now sets
`NAMZU_AGENT_SHUTDOWN_DEADLINE_MS` to 3000 inside it, so the agent's own
bound expires 2 seconds before the kubelet's `SIGKILL` rather than 10
seconds after it — which is what the agent's 15000 ms default did to a task
pod that had anything still running at stop time. It ships no `preStop`
hook, and cannot at this grace period: the wait a hook derives from a
3000 ms deadline is `ceil(3000 / 1000) + 2` = 5 seconds, the whole of it,
leaving the kubelet no room after the drain. A diskless task pod has
nothing for a hook's `sync -f` to flush in any case — what its 3 seconds
bounds is a graceful stop of the guest's own processes.

**The hook signals only the init this image starts.** `kill` is a POSIX
shell builtin, so nothing on `PATH` can stand in front of it, and the pid the
hook defaults to is 1 — the machine's own init anywhere but inside the
container's pid namespace. So `entrypoint.sh prestop` reads
`/proc/<pid>/comm` and signals only a process named `tini`. A derived image
that boots a different init sets `NAMZU_PRESTOP_INIT_NAME`; one that does not
gets a line on the hook's stderr and keeps the `sync -f` plus the agent's own
`SIGTERM` handler, which is the safe half of the trade.

**Expect a `FailedPreStopHook` warning on every workspace stop that worked.**
The hook signals pid 1 of the container's own pid namespace and waits for it;
when pid 1 exits the kernel SIGKILLs everything left in that namespace, the
hook included, so the kubelet records the hook as having died. That is the
success path — the flush and the drain both finished before pid 1 could go —
and returning earlier would reintroduce the race with the kill that the wait
exists to close. A hook that gives up instead (its derived wait expiring
because the init would not go, or `NAMZU_PRESTOP_WAIT_SECONDS` set to
override it) exits 0 and is not recorded at all, which is the case worth
looking into.

**`rbac.yaml` is the wider of two Roles.** A host that only ever claims from
the warm pool — `warmPoolName` set, never a `Sandbox` created by that host —
can apply `manifests/rbac-claimant.yaml` instead: the same three objects under
the name `namzu-sandbox-claimant`, with no write verb on `sandboxes`, none on
a policy resource, and neither of the template/disk reads a claim never
issues. It exists because `rbac.yaml`'s `sandboxes: create` is an arbitrary
pod spec for any holder, which a host that never creates one does not need.
See `docs/sdk/kubernetes-sandbox.md`'s RBAC section for the host shapes each
Role is for; everything below is unchanged whichever one you apply.

**`networkpolicy.yaml` is not optional.** The backend LISTS this namespace's
policies before every create and refuses — by default, with a named error —
unless one of them enforces ingress on the pod's own labels and none of them
admits a wide-open peer on the agent port. The templates' inline
`networkPolicy` blocks do NOT satisfy that: the controller translates them
into policies selecting `agents.x-k8s.io/sandbox-template-ref-hash`, a label
it writes only onto a Sandbox adopted out of a `SandboxWarmPool` and never
onto one this backend POSTs, which is every workspace and every pool-less
task sandbox. If this deployment closes the agent port somewhere a namespaced
Role cannot read — a cluster-scoped policy, a service mesh, a cloud security
group — set `ingress: 'unverified'` on the backend config and say so out
loud; see `docs/sdk/kubernetes-sandbox.md`'s ingress section.

**Using `egress.profile` needs one more thing, and it is not in this
directory.** An egress profile is a pod label the backend puts on a
`SandboxClaim`'s `spec.additionalPodMetadata.labels`, and the agent-sandbox
controller refuses a claim whose label key is outside its allowlist — the
`allowed-label-domains` key of the `agent-sandbox-config` ConfigMap in the
CONTROLLER's namespace (not this one), whose built-in default is
`sandbox.users.io`. The backend's own default key is
`sandbox.namzu.ai/egress-profile`, so either add `sandbox.namzu.ai` to that
key:

```sh
kubectl -n agent-sandbox-system create configmap agent-sandbox-config \
  --from-literal=allowed-label-domains=sandbox.users.io,sandbox.namzu.ai \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n agent-sandbox-system rollout restart deployment/agent-sandbox-controller
```

…or set `egress.profileLabelKey` to a key that is already allowed. Skip this
entirely if no backend sets `egress.profile`; nothing else in this directory
depends on it. Each profile also needs its own applied policy, named
`<template>-<profile>-egress` by default — see
`docs/sdk/kubernetes-sandbox.md`'s egress section.

**Using `egress.perSandbox` needs two more manifests, applied together or
not at all** — they are deliberately absent from the list above:

```sh
kubectl apply -f manifests/validatingadmissionpolicy-cilium.yaml
kubectl apply -f manifests/rbac-per-sandbox-egress.yaml
```

They are prerequisites for the TASK path only: `setNetworkPolicy` is present
on a task sandbox handle and never on a `KubernetesWorkspace`, whose create
call refuses a config carrying `egress.perSandbox`
(`KubernetesWorkspacePerSandboxEgressConfigError`) rather than accepting an
option it would never use. See `docs/sdk/kubernetes-sandbox.md`.

The first is the admission FENCE: it bounds what the host ServiceAccount may
write to this namespace's `CiliumNetworkPolicies` — a name of
`namzu-sbx-<owner uid>`, one selector label keyed
`sandbox.namzu.ai/per-sandbox-egress` (edit rule 4 if you set
`egress.perSandbox.labelKey`) **whose value is that owner's own name**, so a
policy reaches only the pods of the sandbox that owns it, `toFQDNs` entries
that are each one exact name or one `*.<domain>` pattern over at least two
labels (`*`, `*.*` and `*.com` are refused), the cluster-DNS rule on port 53,
an owner reference naming the claim, no address- or entity-based peers, no
ingress, and no `DELETE` of a policy outside the `namzu-sbx-` prefix — which
is the operator's own baseline, not another sandbox's policy: a validating
policy cannot tell which sandboxes a host holds, so a host deleting one of its
own sandboxes' policies (an allowance removed, not added) is inside the
bound. **Edit the ServiceAccount username in its `matchConditions` and the
namespace in its binding** to match this deployment; as shipped they name
`system:serviceaccount:namzu-sandboxes:namzu-sandbox-host` and
`namzu-sandboxes`. It matches on that identity alone, so an operator applying
the baseline policy is unaffected by it.

The second grants that identity `create`/`patch`/`delete` on
`ciliumnetworkpolicies` — verbs `rbac.yaml` deliberately does not — plus a
read-only, cluster-scoped `get` on the two admission objects, which the
backend reads before its first write and refuses without. Both admission
objects being cluster-scoped is why that read needs the `ClusterRole` and not
only the namespaced `Role`: applied without it, the host is refused with
`KubernetesAdmissionFenceUnreadableError` (a `403`, a different file to fix
than the `404` that raises `KubernetesAdmissionFenceMissingError`) rather than
being allowed to write unproven. Apply the RBAC without the fence and the host
holds unbounded write access to every policy in the namespace; the backend
refuses to write until the fence exists, which covers the host that follows
its own config and not an attacker holding its token.

The same label-domain prerequisite as `egress.profile` applies: the
per-sandbox selector key defaults to `sandbox.namzu.ai/per-sandbox-egress`,
so either the ConfigMap edit above covers it too, or set
`egress.perSandbox.labelKey` to a key that is already allowed. Cilium has to
be the CNI for any of it to be ENFORCED; nothing in this repository has
measured that it is.

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

All six live under `scripts/`, run against the **built** package
(`pnpm -r build` from the repo root first — they import
`@namzu/sandbox`/`@namzu/sdk` from `dist/`, and `contract-suite.mjs`
additionally imports the conformance suite straight from
`../../dist/testing/sandbox-conformance.js`). Each prints `[PASS]`/`[FAIL]`
lines and a measured number, and exits non-zero if anything failed.

Every script takes `--namespace` and (task-sandbox scripts) `--template` /
`--pool`, plus one of two access modes:

- `--in-cluster` — run the script as a Job/Pod under `manifests/rbac.yaml`'s
  `namzu-sandbox-host` ServiceAccount. A host that only claims from the pool
  can run the two scripts a claimant host is expected to pass —
  `contract-suite.mjs` and `acquire-p50.mjs` — under
  `manifests/rbac-claimant.yaml`'s `namzu-sandbox-claimant` ServiceAccount
  instead; that manifest's header carries both the expectation and the record
  that it is unmeasured here.
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

# Criterion 3: a workspace's disk survives suspend/resume — including a
# 5 MiB writeFile and a 100 MiB command-written file issued immediately
# before the suspend, with no sync of the script's own anywhere. It prints
# the suspend's own duration, which is what says whether this template's
# terminationGracePeriodSeconds is the right number (see below).
node scripts/suspend-resume.mjs \
  --namespace namzu-sandboxes --template namzu-workspace --in-cluster \
  [--write-mib 5] [--exec-mib 100]

# Criterion 4: small-file IO on the block PVC vs. host ext4, within 1.5x.
node scripts/io-compare.mjs \
  --namespace namzu-sandboxes --template namzu-workspace --files 200 --in-cluster

# Criterion 5: the guest really is deprivileged (all-zero cap masks,
# NoNewPrivs, and a mount attempt the kernel itself refuses). Also prints
# (informationally — neither can fail the check) the guest's Seccomp value
# and its set-id file count.
node scripts/capability-check.mjs \
  --namespace namzu-sandboxes --template namzu-task --pool namzu-task-pool --in-cluster

# Criterion 6: the agent port is shut to a pod that is not the host.
node scripts/ingress-check.mjs \
  --namespace namzu-sandboxes --template namzu-workspace \
  --task-template namzu-task --pool namzu-task-pool --in-cluster

# Criterion 7: egress is bounded by the configured kind. Run it once per
# kind you ship; --policy decides both what the backend verifies and what
# the probes expect.
node scripts/egress-check.mjs \
  --namespace namzu-sandboxes --template namzu-task --pool namzu-task-pool \
  --policy no-network --in-cluster
```

**`ingress-check.mjs` and `egress-check.mjs` are the two scripts whose result
depends on the CNI, not only on the objects the API server accepted.** A cluster that accepts
`NetworkPolicy` and enforces none of it — the stock local kind cluster is one
— accepts `networkpolicy.yaml` and still answers the probe, so the script
reports FAIL there. That is deliberate: a non-enforcing environment must fail
loudly rather than pass for the wrong reason. It also runs a POSITIVE CONTROL
first (the same probe program against a port that must be open), and refuses
to report the real probe at all if the control comes back closed, so a broken
probe cannot be read as a closed port. Never record a pass from this script
off a cluster whose CNI does not enforce policy.

It creates a workspace under `--workspace-id` (default `ingress-probe`) as its
probe target and deletes it, disk included, however the run ends — including
when the create itself fails, because a create that gets as far as POSTing the
Sandbox and then fails suspends it rather than removing it and nothing in the
cluster reaps that. Point `--workspace-id` at a name nobody's files live under.

`egress-check.mjs` reads the same way and makes the same demand of its own
controls: before any real probe it dials the pod's own agent port on
`127.0.0.1` (which no policy governs) and resolves `localhost`, and refuses to
report anything if either fails — without that, `--policy no-network`, where
every real probe is SUPPOSED to come back closed, would pass on a guest with
no working runtime at all. It creates task sandboxes rather than a workspace,
so it leaves no disk behind. It does not probe the `static`/`resolver`
hostname allowlist, narrowed or not: that translation is enforced at L7 by
one CNI's own agent and nothing in this repo has measured it.

Record the printed numbers, with the date and the cluster's shape
(node type, storage backend, Kata version), in
`docs/sdk/kubernetes-sandbox.md`'s deployment section — that table is
currently empty and says so; these runs are what fill it in.

`contract-suite.mjs` passes `supportsRangedAndStreamedReads: true`, which
turns on two cases that read a file back — one above the wire's frame ceiling,
one an explicit byte range. That is true because the image you built in step 2
copies this repository's `agent/agent.cjs` in, so the guest has the
capability. Point the suite at an image built from an older release and set
the flag `false`: the two cases then skip, titled with the reason and still
counted, instead of failing an image that never claimed to serve them.

## Tests

`__tests__/entrypoint.test.ts` and `__tests__/manifests.test.ts` run in the
package's normal `pnpm --filter @namzu/sandbox test` — no cluster, no Kata,
no root. `entrypoint.test.ts` shims `id`/`blkid`/`dd`/`mkfs.ext4`/`mount`/
`chown`/`setpriv` in `PATH` (never the real tools) and exercises the
mount-vs-mkfs branching against a real, already-existing block device NODE
(`/dev/loop0`..`7`, present on the `ubuntu-latest` Linux CI runner this repo's own `.github/workflows/ci.yml` uses)
whose type it only ever `stat()`s — nothing shimmed ever opens it for real.
It also covers every way `blkid` can fail to answer cleanly: exiting
127/126/4/8 with no output, being entirely absent from `PATH` (proven with a
`PATH` the shim controls end to end, so the runner's own `blkid` cannot
quietly answer instead), and exiting 2 ("no filesystem found") on a device
that then fails the `dd` readability probe entrypoint.sh runs before trusting
that "2" enough to format. Every one of those must abort before `mkfs.ext4`
or `mount` ever runs. The `id` shim defaults to reporting root (uid 0), so
every one of those cases keeps taking the root branch regardless of which
uid actually runs the test process; a separate describe block overrides it
to a non-zero uid and covers the non-root branch (#491): no `blkid`/
`mkfs.ext4`/`mount` call, `setpriv --no-new-privs` (and none of the
root-path flags) exec'd, and a non-zero exit — before any of those tools run
— when a device is set on a non-root pod. `manifests.test.ts` asserts
`sandboxtemplate-task.yaml`'s container carries no `privileged`, drops every
capability, forbids privilege escalation, sets `runAsNonRoot` and matches the
Dockerfile's `AGENT_UID`/`AGENT_GID`, and that `sandboxtemplate-workspace.yaml`
still runs `privileged: true`.
