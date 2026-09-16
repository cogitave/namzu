# W10 — kubernetes backend end to end on kind

Real `@namzu/sandbox` kubernetes backend, real agent-sandbox v1.0.2
controller, one control-plane `kind` node running under Podman inside a
second WSL2 distro (`podman-machine-default`). No product code changed —
this is a research artifact: a driver script, its output, and this writeup.
Raw data: `kind-e2e-results.json`. Driver: `kind-e2e-cli.mjs` (+
`runner.mjs`, `lease-holder.mjs`, `Dockerfile`, `manifests/`).

## Method

1. **Guest image.** Built `packages/sandbox/k8s/Dockerfile` (build context
   `packages/sandbox`: `agent/agent.cjs` + `k8s/entrypoint.sh`) inside
   `podman-machine-default`, tagged `namzu-sandbox-agent:kind`, loaded into
   the `namzu` kind cluster with `kind load image-archive` (podman
   provider).
2. **Runner image.** `pnpm pack`ed `@namzu/sdk` and `@namzu/sandbox` (the
   package has no runtime `dependencies`, only the `@namzu/sdk` peer,
   confirmed via `packages/sandbox/package.json`), installed them plus
   `zod`/`zod-to-json-schema`/`@opentelemetry/api` into a scratch project,
   added `runner.mjs` + `lease-holder.mjs` + the two W8 acceptance scripts
   (`acquire-p50.mjs`, `capability-check.mjs`, both copied verbatim from
   `packages/sandbox/k8s/scripts/`), built a `node:22-bookworm-slim` image,
   tagged `namzu-e2e-runner:kind`, loaded into kind the same way.
3. **Manifests.** Rebased `packages/sandbox/k8s/manifests/kind-overlay`
   (checked in, untouched) into namespace `namzu-e2e` with one small
   `kustomize` layer on top — see "Kustomize and the podman image name"
   below for why a second `images:` rewrite was needed. Applied RBAC, both
   `SandboxTemplate`s, `SandboxWarmPool` (`replicas: 2`), and the baseline
   `NetworkPolicy`.
4. **Runner Job**, service-account `namzu-sandbox-host`, `{ inCluster: true
   }`: waits for the warm pool, does 20 sequential pool acquires timing
   each, runs the W9 conformance suite (`defineSandboxConformance`) against
   the live backend, exercises exec/writeFile/readFile/terminal/tcp on one
   sandbox, proves the lease (holds ~2×TTL with renewal running, then
   abandons the handle and confirms the controller reaps it), and does one
   pool-less (direct) create. Prints one JSON blob as its last output.
5. **Second Job**, same service account, runs `acquire-p50.mjs` and
   `capability-check.mjs` from `packages/sandbox/k8s/scripts/` verbatim
   with `--in-cluster` (both already supported it — no code needed).
6. Collected both Jobs' logs into `kind-e2e-results.json`, deleted
   namespace `namzu-e2e`. Cluster, controller and both loaded images were
   left running, as instructed.

## Cluster shape (what this run can and cannot say)

| | |
|---|---|
| Kubernetes | v1.37.0, one control-plane node (`kind`, podman provider) |
| Container runtime | containerd 2.3.4, plain `runc` |
| RuntimeClass | **none** — `kubectl get runtimeclass` is empty on kind; every pod in this run is a namespaced container, not a Kata microVM |
| Default StorageClass | `standard` (`rancher.io/local-path`), **Filesystem only** — cannot provision `volumeMode: Block` |
| CNI | kindnet — **does not enforce `NetworkPolicy`** |
| Controller | `registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.2`, `agent-sandbox-system`, 1/1 |

Three things this run **cannot** show, all for the reasons above and
already flagged by `packages/sandbox/k8s/README.md`'s own kind-overlay
warning:

- **No VM boundary.** `docs/sdk/kubernetes-sandbox.md`'s whole premise is a
  Kata `RuntimeClass`; every capability-probe pass below (all-zero
  capability masks, `NoNewPrivs: 1`, a refused `mount`) is `setpriv`
  dropping privilege inside an ordinary `runc` container, not a microVM.
  It is still a real, useful signal — it proves the entrypoint/probe
  plumbing actually does what it claims — just not the acceptance
  criterion's own security boundary.
- **No block-device workspace.** The workspace `SandboxTemplate`'s real
  shape (`volumeMode: Block`, `entrypoint.sh`'s `blkid`/`mkfs.ext4`/`mount`
  branch) cannot be exercised here at all — the kind overlay swaps it for
  an ordinary `Filesystem`-mode PVC specifically because `rancher.io/
  local-path` cannot provision `Block`. This run therefore says nothing
  about criteria 3 and 4 (suspend/resume disk survival, small-file IO
  ratio) — a real cluster with an actual block-capable `StorageClass` is
  the only way to measure those.
- **No enforced egress/ingress.** The baseline `NetworkPolicy` was applied
  (namespace `namzu-e2e`, `namzu-sandbox-baseline`) and confirmed present
  via the API, but kindnet does not implement `NetworkPolicy` at all, so
  its rules were never actually enforced by anything. Nothing in this run
  demonstrates the "primary boundary is the NetworkPolicy ingress rule"
  claim `docs/sdk/kubernetes-sandbox.md#the-agent-credential` makes — a
  cluster with a policy-enforcing CNI (Calico, Cilium) is needed for that.

## Results

### Acquire latency (runner Job, 20 sequential pool acquires)

p50 = **184.1 ms**, p99 = **399.3 ms** (target: p50 < 1000 ms). Full series
in `kind-e2e-results.json` (`runner.phases.acquireLatency.durationsMs`),
range 69–399 ms. The second Job's own `acquire-p50.mjs` (same method,
independent 20-acquire run) agreed closely: p50 = 183.8 ms, p99 = 479.4 ms,
`[PASS] acquire p50 < 1000ms`.

### W9 sandbox conformance suite, against a live acquired sandbox

10/12 passed. Two failures, both genuine and both explained below — this
is not a flake; a second full run (below) reproduced both exactly.

```
[PASS] exec > reports the exit code and streams stdout/stderr as the command runs
[PASS] exec > reports busy while a command is in flight and ready once it settles
[FAIL] exec > honours an AbortSignal: the process is really terminated, never a partial success
[PASS] file IO > round-trips a UTF-8 string through writeFile/readFile
[PASS] file IO > round-trips arbitrary binary content byte for byte
[PASS] listFiles > lists written files as absolute paths with their sizes
[PASS] listFiles > reports a root that does not exist as empty rather than failing
[PASS] openTerminal > is owned by the sandbox: destroy() kills and awaits every terminal it returned
[FAIL] openTcpConnection > forwards a bidirectional stream to a service on the guest loopback
[PASS] openTcpConnection > refuses a non-loopback host
[PASS] destroy > is idempotent, however many times or however concurrently it is called
[PASS] destroy > refuses every call once destroyed, rather than admitting one
```

**Why `openTcpConnection`'s positive case fails here, and always will when
run this way.** `openTcpConnection` asks the guest AGENT to dial
`127.0.0.1:<port>` from inside its OWN pod's network namespace — confirmed
by reading `KubernetesAgentTransport.openTcpConnection` down to
`VsockAgentTransport.openTcpConnection` (`backends/firecracker/
transport.ts`), which sends a `tcp-connect` control frame to the agent
rather than dialing anything itself. `sandbox-conformance.ts`'s own fixture
starts its echo server with plain `node:net` **in the process running the
suite** — fine for the loopback unit test (`backends/kubernetes/
__tests__/conformance.test.ts`), where that process and the agent
literally share one loopback, but wrong for this run: the runner Job and
the acquired sandbox are two different pods, so the agent's dial finds
nothing at `127.0.0.1:<port>` and the connection is refused
(`connect ECONNREFUSED 127.0.0.1:<port>` — the exact, consistent error
both runs produced). This is a property of the FIXTURE, not the backend:
this run's own `operations` phase (below) proves the real capability works
end to end once the target listener actually lives inside the acquired
pod. `sandbox-conformance.ts`'s doc comment claims `contract-suite.mjs`
"runs it a third time, against a live cluster" — true only in the sense
that it runs; this case specifically cannot pass from a separate
orchestrator process, and that comment should be corrected or footnoted.

**Why the `AbortSignal` case fails here.** The case starts a background
child that traps `SIGTERM` and writes a "late" marker file, aborts the
signal after seeing the process start, and asserts the marker is never
readable — i.e. that abort really kills the process rather than letting it
finish. On this cluster the marker file WAS readable (`expected true to be
false`): the abort-triggered kill did not land in time, on plain `runc`
with no Kata boundary underneath. Reproduced identically on both runs.
Worth re-running against a real Kata cluster before treating this as a
backend defect — it may be specific to signal delivery/process-tree timing
under nested WSL2 virtualization, not the kill logic itself, but it is a
real, repeatable failure on the cluster this run had.

### Operations: exec / writeFile / readFile / terminal / tcp

All five passed on the run with the fix described below:

```json
"exec": { "exitCode": 0, "stdout": "namzu-e2e-exec-ok" },
"fileRoundTrip": { "matches": true },
"terminal": { "exitCode": 0, "sawHello": true },
"tcp": { "started": true, "matches": true, "received": "echo:namzu-e2e-tcp-hello" },
"tcpNonLoopbackRefused": true
```

**A real gotcha, found and fixed during this run.** The first attempt
started the in-pod tcp echo listener with `sandbox.exec('/bin/sh', ['-c',
'nohup node -e \'...\' > /dev/null 2>&1 < /dev/null & disown; ...'])` — the
standard shell daemonize idiom. Every one of 5 reproduction attempts against
a fresh pool sandbox hung and then failed with:

```
RemoteCancellationUnknownError: ... kubernetes pod-network agent
cancellation attempt exceeded 893ms. The remote outcome is unknown; do not
automatically retry the command.
```

The same shell command run directly with `kubectl exec` (bypassing the
agent entirely) completed in well under a second every time — so the
command itself is fine; what hangs is the AGENT's own bookkeeping for
"has this exec finished", which apparently never sees the exec's output
stream close while a live, long-running grandchild process is still
running (however cleanly its own stdio was redirected away). `exec()`
documents `spawnDetached` as absent for this backend for exactly this
class of use — daemonizing a long-lived process through `exec` was never a
contracted use of it. The fix: start the listener through `openTerminal`
instead (`terminal.kill()` on teardown) — the SDK's actual primitive for a
process the caller does not wait on — which worked cleanly on 3/3
follow-up tries and on both full runs after the fix. See `runner.mjs`'s
`operations` phase for the corrected version and a comment naming this
exact failure. This is not filed as a backend bug: it is a real, useful
"what NOT to do" finding about `exec()`'s contract on this backend, worth
a line in `docs/sdk/kubernetes-sandbox.md` if this backend gets a "how to
run something in the background" section later.

### Lease proof (both halves)

`claimTtlSeconds: 60`, held **135 s** (~2.25×TTL) with the handle's own
renewal loop running, 14 liveness checks every 10 s — every one reported
`exists: true, status: "ready", execOk: true`
(`runner.phases.leaseProof.checks`). The holder then exited
**without calling `destroy()`**, in a separate child process, to make the
renewal loop actually stop (there is no public API to stop it without
destroying the object — see `runner.mjs`'s own comment on why this needed
a real second process). The controller reaped the abandoned pod well
inside the poll timeout (`reapedAfterHolderExit: true`, checked every 5 s
up to TTL+60 s). Both halves — survives past 1×TTL under active renewal,
reaped after renewal genuinely stops — held on both full runs.

### Pool-less (direct) create

One `create()` with no `warmPoolName`: 682–758 ms (cold pod start, no Kata
boundary to add its own overhead here), `exec` on it exited 0 with the
expected stdout. Confirms the SandboxTemplate's own `podTemplate` gets
copied into a directly-POSTed `Sandbox` correctly.

### W8 acceptance scripts, run in-cluster unmodified

- `acquire-p50.mjs`: `[PASS] acquire p50 < 1000ms — measured 183.8ms`
  (p99 = 479.4 ms).
- `capability-check.mjs`: all six checks passed — `create()` admitted by
  the internal privilege probe, `CapInh/CapPrm/CapEff/CapBnd` all
  `0`, `NoNewPrivs: 1`, and `mount -t tmpfs tmpfs /tmp` refused by the
  kernel (`mount: /tmp: must be superuser to use mount.`, exit 32) —
  `setpriv` under plain `runc` really does drop every capability, which is
  the one criterion this kind cluster CAN speak to honestly (see "Cluster
  shape" above for what it cannot).

Full logs for both: `runner.rawLog` equivalent is the runner Job's own
stdout captured in `kind-e2e-results.json`'s `runner` object; the W8
scripts' raw combined log is `w8Scripts.rawLog` in the same file.

## Known quirks of this specific environment (for the next person)

- **`wsl.exe -d podman-machine-default -u root -- sh -lc '<cmd>'` piped
  stdin is not safe past a few bytes.** Piping a tar (or anything else)
  into that invocation's stdin — even wrapped in `cat file | wsl.exe ...`
  — intermittently lands on a bare interactive login `-bash` instead of
  running the given command, and the piped bytes get fed to THAT shell
  line by line (`-bash: line 1: <base64 garbage>: command not found`,
  file writes truncated). A 1 MB random-content round trip through this
  path came back 263 bytes short with visible shell errors. Always
  `</dev/null` the outer invocation, and move real content in another way:
  small values as a `printf '%s' '<value>'` **argument** (proven
  byte-exact up to ~110 KB in ~4 KB chunks), anything bigger over
  `curl http://127.0.0.1:<port>/...` — this session confirmed **both
  WSL2 distros share the Windows host's loopback** (the kind API server on
  `127.0.0.1:36443` and an ad hoc `python3 -m http.server` were both
  reachable from the other distro directly), which moved a 6 MB runner
  image build context across in one `curl` instead of thousands of
  argument-sized calls.
- **Backgrounding with `setsid`/`disown` did not survive past the
  originating `wsl.exe` call**, contrary to this issue's own earlier
  guidance to run long podman/kind operations detached-and-polled. A
  bare `sleep 6 & disown` inside `sh -lc` left no trace (empty log, no
  process) moments after the outer call returned, `KillUserProcesses` was
  already `no`, and no `at`/`cron` was installed to route around it. What
  actually worked, every time, for every long step in this run
  (`podman build`, `podman save`, `kind load image-archive`): a plain
  **foreground** call with a generous timeout (a `podman build` pulling
  `node:22-bookworm-slim` fresh took under 15 s; every step here finished
  well inside 60 s once images were cached). This may be specific to this
  session's `wsl.exe`/podman-machine build, or may mean the earlier
  guidance was itself never verified against a genuinely long detached
  command — recorded here either way so the next session does not
  re-discover it the hard way.
- **`podman`'s locally-loaded images are `localhost/<name>:<tag>`, not
  `docker.io/library/<name>:<tag>`.** `packages/sandbox/k8s/manifests/
  kind-overlay`'s own `images:` transform (correctly, for a plain `docker
  build`) rewrites to a bare `namzu-sandbox-agent:kind-dev` — which
  containerd then normalizes to `docker.io/library/...` and fails to find,
  since `KIND_EXPERIMENTAL_PROVIDER=podman` loaded it as
  `localhost/namzu-sandbox-agent:kind` (confirmed via `crictl images`
  inside the kind node). This run's outer kustomize layer adds a SECOND
  `images:` entry naming `localhost/namzu-sandbox-agent` with `newTag:
  kind` on top of the base overlay's own transform to fix this — see
  `kind-e2e-cli.mjs`'s `apply()` and its kustomization.yaml comment. Only
  matters for the podman provider; a real cluster pulling from a registry
  does not hit this at all.

## This script vs. this run

`kind-e2e-cli.mjs` codifies every command this session actually ran against
the live cluster (each `wsl(...)`/`kubectl(...)` call matches one that was
executed by hand while producing the numbers above) into one reproducible
driver, organized as subcommands (`build-agent-image`,
`build-runner-image`, `apply`, `run`, `run-w8`, `collect`, `cleanup`, or
`all`). It was reviewed against the session transcript for correctness but
not re-run start to finish as this single process — doing so would only
re-derive the numbers already on record above at real additional cost
(image builds, a ~3 minute lease-proof hold, cluster churn), and this
session's own real command history is what the numbers above and the
`operations`-phase fix were drawn from directly.

## Cleanup

`kubectl delete namespace namzu-e2e --wait=true` — the two loaded images
(`namzu-sandbox-agent:kind`, `namzu-e2e-runner:kind`), the `namzu` kind
cluster, and the agent-sandbox-controller Deployment were all left
running, as instructed. No orphaned `SandboxClaim`/`Sandbox`/`Pod`/`PVC`
was left behind by either Job — confirmed via
`kubectl -n namzu-e2e get sandboxclaims,sandboxes,pods,pvc` immediately
before cleanup, which showed only the two current warm-pool replicas and
the two completed Job pods.

## 2026-09-16 addendum — `openTcpConnection` re-run after moving its listener into the guest (issue #469, TCP sub-task)

This run's own "Why `openTcpConnection`'s positive case fails here, and
always will when run this way" section, above, named the fix directly: the
suite's positive case started its echo server in the orchestrator/test
process, which only ever shares a loopback with a colocated fixture and
never with a real remote guest. `packages/sandbox/src/testing/
sandbox-conformance.ts` now starts that listener INSIDE the sandbox
through `openTerminal` (`node -e` by default, reporting the port it bound
on its own stdout so the host — which cannot inspect a real remote guest's
open ports any other way — can dial it back through
`openTcpConnection`), and tears it down again through the same terminal's
`kill()`. A `guestCanRunNode` / `guestListenerCommand` capability hook on
`defineSandboxConformance` lets a backend without a node-capable guest skip
the case with a stated reason instead of failing it. Both colocated
fixtures (Firecracker loopback, kubernetes fake+real agent) and this live
cluster now exercise the identical code path.

**Not re-derived: the other four phases.** Only `poolWarm` and
`conformance` were re-run, against a namespace and image tag dedicated to
this recheck (`namzu-e2e-tcp469`, `namzu-e2e-tcp-runner:kind` — the shared
`namzu-e2e` namespace and `namzu-e2e-runner:kind` tag from the original run
were left untouched, on the chance another session was using them
concurrently). `acquireLatency`, `operations`, `leaseProof` and
`poolLessCreate` were not touched by this fix and are still governed by the
numbers recorded above; re-running them here would only re-derive figures
already on record, the same reasoning "This script vs. this run" gives for
not re-running `kind-e2e-cli.mjs` itself end to end.

**Driver.** `research/k8s-sandbox/tcp-case-recheck.mjs` (+
`tcp-case-runner.mjs`, a `poolWarm`+`conformance`-only trim of `runner.mjs`
run via a `command` override on an image whose `CMD` is still `node
runner.mjs`). Reuses `kind-e2e-cli.mjs`'s own mechanics — the same
podman-machine transfer trick, the same kind-overlay, the same warm pool —
parameterized onto a dedicated namespace/image tag rather than editing that
file. Its own npm tarballs were packed from `packages/sdk` and
`packages/sandbox` **in this worktree**, i.e. carrying the fix above.

**A second, unrelated bug found and fixed in the driver itself.**
`wslCurlFetch`'s original shape (`kind-e2e-cli.mjs`, inherited verbatim
into the first draft of `tcp-case-recheck.mjs`) starts a Node HTTP server
in the same process and then calls the WSL-side `curl` through
`spawnSync` — which blocks that process's entire event loop, including the
very HTTP server the `curl` needs an answer from, until `spawnSync`'s own
timeout kills it. Every transfer attempt timed out at exactly the
configured `timeoutMs` until `wsl()` was rewritten around `spawn` (async,
still awaited before the next step, so every OTHER call site stayed exactly
as sequential as before). `kind-e2e-cli.mjs`'s own header already flags why
this could hide until now: its `wsl(...)` calls were "individually-verified
... executed by hand" in an interactive session, never previously run as
one unified script where the HTTP server and the blocking call share a
process. `kind-e2e-cli.mjs` itself is unchanged; this is recorded here as a
latent defect in that reproduction script for whoever next runs it as
described.

**Result: 11/12, the TCP case now passing.**

```
[PASS] exec > reports the exit code and streams stdout/stderr as the command runs
[PASS] exec > reports busy while a command is in flight and ready once it settles
[FAIL] exec > honours an AbortSignal: the process is really terminated, never a partial success
[PASS] file IO > round-trips a UTF-8 string through writeFile/readFile
[PASS] file IO > round-trips arbitrary binary content byte for byte
[PASS] listFiles > lists written files as absolute paths with their sizes
[PASS] listFiles > reports a root that does not exist as empty rather than failing
[PASS] openTerminal > is owned by the sandbox: destroy() kills and awaits every terminal it returned
[PASS] openTcpConnection > forwards a bidirectional stream to a service started inside the guest
[PASS] openTcpConnection > refuses a non-loopback host
[PASS] destroy > is idempotent, however many times or however concurrently it is called
[PASS] destroy > refuses every call once destroyed, rather than admitting one
```

The one remaining failure is the `AbortSignal` case this run's own section
above already recorded and explained (plain `runc`, no Kata boundary, the
controller's 8s cancel-confirm window); it is out of scope for the TCP
sub-task and tracked separately. Full JSON:
`research/k8s-sandbox/tcp-case-recheck-results.json`.

**Live evidence.** Namespace `namzu-e2e-tcp469` on kind cluster `namzu`
(controller `registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.2`,
`kubectl` server version `v1.37.0`): Job `namzu-tcp-case-recheck`, pod
`namzu-tcp-case-recheck-g8nrw`, `Completed`, `succeeded: 1`,
`completionTime: 2026-09-16T08:30:57Z`; warm pool `namzu-task-pool`
`readyReplicas: 2/2` (pods `namzu-task-pool-f5qrj`, `namzu-task-pool-jzbkz`)
throughout. Namespace deleted afterward (`kubectl delete namespace
namzu-e2e-tcp469 --wait=true`); cluster, controller and every previously
loaded image (including the ORIGINAL `namzu-e2e-runner:kind` tag this
addendum's own recheck image does not touch) left running.
