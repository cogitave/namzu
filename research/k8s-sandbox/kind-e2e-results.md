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
~~Worth re-running against a real Kata cluster before treating this as a
backend defect — it may be specific to signal delivery/process-tree timing
under nested WSL2 virtualization, not the kill logic itself, but it is a
real, repeatable failure on the cluster this run had.~~ **Corrected below
(2026-09-16 addendum): it is not an environment artifact.** It reproduces
byte-for-byte on a bare loopback `agent.cjs` process on an ordinary
Linux dev machine, no kind/WSL2/Kata involved — a straightforward logic
defect in `agent.cjs`'s cancel escalation, root-caused, fixed and
re-verified in-cluster. See "2026-09-16 — AbortSignal root cause, fix and
re-verification" at the end of this file.

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
## 2026-09-16 — AbortSignal root cause, fix and re-verification

Root-causing the `AbortSignal` failure above (issue #469's ABORT workstream,
worktree `issue469/abort-case`, its own namespace `namzu-e2e-abort469`, cleaned
up after this run). Two independent defects were found, one fixed here, one
recorded as a follow-up.

### Defect 1 (fixed): `CANCEL_GRACE_MS`'s production default was never
### actually exercised by any test

`agent.cjs`'s `terminateAndConfirm` sends `SIGTERM` to the owned process
group, waits up to `NAMZU_AGENT_CANCEL_GRACE_MS` for the group to go quiet,
and escalates to `SIGKILL` **only if the group is still alive at the end of
that window** — nothing checks that the exit was actually caused by the
signal. The default was `2000`. The conformance fixture's ignoring process
(`trap '' TERM; ...; sleep 0.4; printf late > marker`) finishes on its own in
~400ms regardless of the signal, so on the production default the natural
exit always won the race, `terminateAndConfirm` read "group empty" as "the
signal worked," and the agent reported a clean `exitCode: 0, signal:
undefined` — reproducing this run's exact `expected true to be false`.

This is not a cluster-timing artifact: it reproduces byte-for-byte,
deterministically, on a bare loopback `agent.cjs` process on an ordinary
Linux machine (no Kubernetes, kind or WSL2 involved) — settle time ~430ms,
marker readable, every time. The reason no existing test caught it: every
suite that drives this path (`firecracker/__tests__/backend.test.ts`,
`firecracker/__tests__/conformance.test.ts`, `kubernetes/__tests__/
conformance.test.ts`, `kubernetes/__tests__/sandbox-surface.test.ts`)
overrides `NAMZU_AGENT_CANCEL_GRACE_MS` to `50` — the firecracker
conformance fixture's own comment says why: "so the abort case proves the
kill in milliseconds, not the production TERM->KILL escalation window." That
shortening was believed to only change wall-clock speed; because the
fixture's natural-completion time (400ms) sits between the test override
(50ms) and the production default (2000ms), it silently flips which side of
the race wins, and the production default's own behaviour was never
covered by anything.

**Fix:** lowered the default to `250` — comfortably under the fixture's
400ms with margin, still enough for a fast, well-behaved handler's cleanup
(`packages/sandbox/agent/agent.cjs`). **Regression test:**
`packages/sandbox/src/backends/kubernetes/__tests__/
agent-cancel-ignoring-process.test.ts`, which deliberately leaves
`NAMZU_AGENT_CANCEL_GRACE_MS` unset (the one thing every other suite
shortens) — fails on the old default (`expected true to be false`, same
message as this run), passes on the new one.

**In-cluster re-verification**, same method as this file's original run
(pool-less create, `namzu-task` template, image rebuilt with the fix and
reloaded as `localhost/namzu-sandbox-agent:kind-fixed`): the REAL,
unmodified `defineSandboxConformance` suite run against a live acquired
sandbox now reports **11/12** (up from 10/12) — every case passes except
`openTcpConnection`'s positive case, which is the pre-existing, unrelated,
fixture-topology failure this file already explains above (own-loopback
listener, not a backend defect). The `AbortSignal` case:

```
[PASS] (9637ms) ... exec > honours an AbortSignal: the process is really terminated, never a partial success
```

### Defect 2 (found, NOT fixed here — follow-up): the agent never reaps an
### orphaned grandchild, so cancellation of a backgrounding command never
### confirms in a real pod

The 9637ms above is not free — it is the full `RemoteExecutionController`
`cancelConfirmTimeoutMs` (8s) plus overhead, ending in
`RemoteCancellationUnknownError` (which retires the sandbox). The suite
still PASSES this case (resolve or reject are equally compliant, per its own
doc comment — the decisive check is only that the marker is absent, which
it is: the process is genuinely killed within ~300ms). But an 8-second,
sandbox-destroying "unconfirmed cancellation" on every abort of a command
that forked a background job is a real cost, worth its own fix.

Root-caused with `/proc` evidence from a live pod, dialing the agent
directly (raw framed socket, bypassing `RemoteExecutionController` and
`KubernetesAgentTransport` entirely, to rule out a transport/dial
explanation — dial time was consistently `0-1ms`, including for a fresh
connection made *while* the long-running `execute` connection was still
open, which also rules out the pre-auth pool or a busy-agent-can't-accept
explanation from issue #469's own suspect list):

```
pid=1  comm=(node)  state=S ppid=0  pgrp=1
pid=23 comm=(sh)    state=Z ppid=1  pgrp=22   <- the backgrounded subshell
pid=24 comm=(sleep) state=Z ppid=1  pgrp=22   <- its sleep, both zombies
```

`packages/sandbox/k8s/entrypoint.sh` `exec`s straight into `agent.cjs` with
no init in between, so in a real pod the agent **is PID 1** of the
container's pid namespace (already documented, for a different reason, in
`agent-sigterm.test.ts`'s header comment). `terminateAndConfirm` `SIGKILL`s
the whole process group, which correctly and promptly kills every member —
Node's `child_process` reaps its own direct child (the top-level `/bin/sh
-c`, PID 22 in the trace above, already gone by the time this was taken) the
moment it exits. But a **background job that shell forked** (`(...) &`,
exactly what both this fixture and the original W10 "how not to daemonize
through exec()" gotcha use) is `sh`'s own child, not the agent's. When `sh`
is `SIGKILL`ed before it can reap its own children, those children become
orphans and — standard Linux behaviour — reparent to PID 1, i.e. the agent
itself. Node's `child_process` module only calls `waitpid()` for PIDs it
explicitly spawned and is tracking; a reparented orphan it never spawned is
invisible to that machinery and is **never reaped**. A zombie's `pgid`
still counts for `kill(-pgid, 0)` (POSIX: the task struct persists until
reaped), so `waitForGroupExit`'s liveness poll can never observe
`groupGone: true` again for that execution — it is stuck FOREVER (not just
past the confirm deadline; the zombies in the trace above were still there
20+ seconds later, unbounded by any of the agent's own timeouts) — and every
cancellation of a command that forked a background job runs out the full
`cancelConfirmTimeoutMs` and retires the sandbox, every time, not as an
occasional race.

This cannot be reproduced by any loopback unit test as currently written:
spawning `agent.cjs` as an ordinary (non-PID-1) test-runner child means an
orphan reparents to the real machine's actual init/systemd, which reaps it
immediately, hiding the defect completely. It needs either a real container
(a PID-namespace boundary) or a test that puts the spawned `agent.cjs` in
its own PID namespace deliberately (`unshare --pid --fork`, Linux-only).

**Recommended fix (not applied in this change — out of scope for the
`CANCEL_GRACE_MS` fix above, and larger than "minimal"):** give the
container a real subreaper instead of running `agent.cjs` directly as PID 1
— `ENTRYPOINT ["tini", "--", "/entrypoint.sh"]` (or a small equivalent) is
the standard fix for exactly this class of bug and would, as a side effect,
also simplify `agent.cjs`'s own SIGTERM handling: as PID 2 rather than PID 1
it would get the kernel's ordinary default signal disposition for free.
Needs its own careful verification that fast-SIGTERM-exit (the property
`agent-sigterm.test.ts` guards) survives the extra layer, and its own
regression coverage (env-gated, real-container test, since the mechanism is
not reproducible on loopback — plus a unit-level proxy asserting the image
actually installs a subreaper as PID 1 rather than `exec`ing straight into
the agent). Filed here rather than fixed inline because it changes the
container's process topology (Dockerfile `ENTRYPOINT`, not just an
`agent.cjs` constant), which is a materially bigger and riskier change than
the one this addendum's Defect 1 fix makes.

**Disclosure and tracking:** the Defect 1 fix (`CANCEL_GRACE_MS` 2000ms →
250ms, `.changeset/kubernetes-agent-cancel-grace-default.md`) widens the
set of cancellations that take the `SIGKILL` path, which widens exposure to
this defect — the changeset names that trade-off and points back here. **A
GitHub issue for Defect 2 has not been filed** (attempted from this
workstream's session and blocked by the environment's own write
restrictions on external systems); until one exists, this section is the
only record of the limitation, and a maintainer should open a tracked
issue referencing this addendum and the changeset above before relying on
this being remembered.

## 2026-09-16 addendum — Defect 2 mitigated with `tini`; both defects mirrored onto the container worker; final in-cluster recheck

Final round of issue #469's ABORT workstream. Three things happened, in
this order:

1. **Defect 1's `terminateAndConfirm` race was found to exist VERBATIM in
   `packages/sandbox/worker/server.js`** (the container/Docker tier's HTTP
   worker), not just in `agent/agent.cjs` — the review that blocked the
   previous round of this investigation named this directly. Fixed the
   same way: `NAMZU_SANDBOX_CANCEL_GRACE_MS`'s default lowered `2000` →
   `250`, with a comment kept textually parallel to `agent.cjs`'s own so a
   future reader sees one mechanism, not two independently-discovered
   ones. New regression test
   `packages/sandbox/worker/__tests__/server.test.js` ("kills a
   SIGTERM-ignoring process before it finishes on its own, using the
   PRODUCTION default NAMZU_SANDBOX_CANCEL_GRACE_MS") — deliberately
   leaves the grace variable unset, the one thing every other cancellation
   test in that file overrides — fails against the old `2000`ms default
   (the marker file the ignoring process schedules DOES appear) and
   passes against the new `250`ms one. `packages/sandbox/README.md`'s
   "Protocol readiness and cancellation" section now documents both
   variables side by side as one mechanism.

2. **Defect 2 (the unreaped orphan) is now MITIGATED in the shipped
   image, not merely documented.** `packages/sandbox/k8s/Dockerfile`
   installs `tini`; `k8s/entrypoint.sh`'s final `exec` is now `setpriv
   ... -- /usr/bin/tini -- node /opt/namzu/agent.cjs` — `setpriv` still
   drops every privilege first, then execs into `tini`, which becomes the
   container's real PID 1 (a subreaper: it reaps an orphaned grandchild
   `agent.cjs` itself never spawned) with the agent as its child, and
   forwards `SIGTERM` to it exactly as before
   (`agent-sigterm.test.ts` is unaffected — the agent still gets the same
   signal, now as an ordinary child rather than as PID 1).
   `k8s/__tests__/entrypoint.test.ts`'s PATH-shim test now asserts the
   `setpriv` invocation's own logged argv ends with
   `-- /usr/bin/tini -- node /opt/namzu/agent.cjs`, i.e. that the exec
   target is `tini` and its own argv still ends in the agent — see that
   test file for why a second layer of PATH-shimming through a real `tini`
   is unnecessary to check this. `docs/sdk/kubernetes-sandbox.md`'s
   "Known limitation" paragraph is rewritten as "mitigated by `tini`";
   a host building its own image from `agent.cjs`/`entrypoint.sh` directly
   rather than from `k8s/Dockerfile` still has to provide its own
   subreaper as PID 1, which the page now says explicitly.

3. **In-cluster re-verification against a freshly built, `tini`-bearing
   image.** Script: `research/k8s-sandbox/abort-case-recheck.mjs` (+
   `abort-case-runner.mjs`, a `poolWarm`+`conformance`-only driver timed
   per case, structurally identical to `tcp-case-recheck.mjs` /
   `tcp-case-runner.mjs` — see that script's own header for why it uses
   ASYNC `wsl()`/`wslCurlFetch()` rather than `kind-e2e-cli.mjs`'s
   `spawnSync`-blocking originals). Unlike the TCP recheck, this one
   rebuilds the AGENT image too (`packages/sandbox/k8s/Dockerfile` /
   `entrypoint.sh` from THIS worktree, i.e. carrying the `tini` fix),
   tagged `namzu-sandbox-agent:kind-tini469`, loaded into the same `namzu`
   kind cluster, exercised in a dedicated namespace
   (`namzu-e2e-abort469`) independent of any other namespace or image tag
   a concurrent session might be using.

   **Result: 12/12** — every conformance case passes, `AbortSignal`
   included:

   ```
   [PASS] (116ms)  exec > reports the exit code and streams stdout/stderr as the command runs
   [PASS] (322ms)  exec > reports busy while a command is in flight and ready once it settles
   [PASS] (1502ms) exec > honours an AbortSignal: the process is really terminated, never a partial success
   [PASS] (80ms)   file IO > round-trips a UTF-8 string through writeFile/readFile
   [PASS] (89ms)   file IO > round-trips arbitrary binary content byte for byte
   [PASS] (427ms)  listFiles > lists written files as absolute paths with their sizes
   [PASS] (137ms)  listFiles > reports a root that does not exist as empty rather than failing
   [PASS] (375ms)  openTerminal > is owned by the sandbox: destroy() kills and awaits every terminal it returned
   [PASS] (2112ms) openTcpConnection > forwards a bidirectional stream to a service started inside the guest
   [PASS] (75ms)   openTcpConnection > refuses a non-loopback host
   [PASS] (144ms)  destroy > is idempotent, however many times or however concurrently it is called
   [PASS] (423ms)  destroy > refuses every call once destroyed, rather than admitting one
   ```

   The decisive number is the `AbortSignal` case's own elapsed time:
   **1502ms**, down from the **9637ms** the previous round measured for
   the identical case against the Defect-1-fixed-but-not-Defect-2-fixed
   image (`## 2026-09-16`, "AbortSignal root cause, fix and
   re-verification" section above). That earlier 9637ms WAS the full
   `RemoteExecutionController` `cancelConfirmTimeoutMs` (8s) plus
   overhead — the suite still passed because resolve-or-reject are both
   compliant and the marker was absent either way, but the cancellation
   itself could never confirm because the orphaned backgrounded `sleep`
   reparented to the unreaped agent-as-PID-1 and stayed a zombie forever.
   1502ms — comfortably inside the normal range every other case in this
   run also falls in — is direct evidence that `tini` is now actually
   reaping that orphan: `waitForGroupExit`'s liveness poll observes the
   group gone quickly instead of running out the full window.

   **Live evidence.** Namespace `namzu-e2e-abort469` on kind cluster
   `namzu` (controller
   `registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.2`,
   `kubectl` server version `v1.37.0`): Job `namzu-abort-case-recheck`,
   `succeeded: 1`, warm pool `namzu-task-pool` `readyReplicas: 2/2`
   throughout, agent image `localhost/namzu-sandbox-agent:kind-tini469`,
   runner image `localhost/namzu-e2e-abort-runner:kind`. Namespace deleted
   afterward (`kubectl delete namespace namzu-e2e-abort469 --wait=true`);
   cluster, controller, and every previously loaded image (the original
   `:kind`/`:kind-fixed` agent tags and the `namzu-e2e`/`namzu-e2e-tcp469`
   runner images from earlier rounds) left running and untouched. Full
   JSON: `research/k8s-sandbox/abort-case-recheck-results.json`.

**Not re-derived:** the other four `runner.mjs` phases
(`acquireLatency`, `operations`, `leaseProof`, `poolLessCreate`) —
untouched by either fix, same reasoning this file's "This script vs. this
run" section already gives.
