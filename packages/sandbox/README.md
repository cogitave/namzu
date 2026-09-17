<!-- okf
type: Reference
title: "@namzu/sandbox"
description: >-
  Container and process isolation for Namzu runs. Two isolation tiers over
  four backends, a bounded filesystem view, and an egress boundary the run
  cannot talk its way past.
tags: [readme, package, sandbox, isolation]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-30T00:00:00Z }
-->

<div align="center">

<h1>@namzu/sandbox</h1>

**Container and process isolation for Namzu runs.**

[![npm](https://img.shields.io/npm/v/@namzu/sandbox.svg)](https://www.npmjs.com/package/@namzu/sandbox)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Runs a tool call somewhere that is not your process. Two isolation tiers
over four backends, a bounded filesystem view, and an egress boundary the
run cannot talk its way past.

## Install

```bash
pnpm add @namzu/sdk @namzu/sandbox
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { createSandboxProvider } from '@namzu/sandbox'

declare const taskId: string

const provider = createSandboxProvider({
  backend: {
    tier: 'container',
    runtime: 'docker',
    image: 'namzu-sandbox:latest',
    network: 'namzu-tasks',
    labels: { 'example.task-id': taskId },
    cpuLimit: 2,
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

## Container hardening baseline

`container:docker` confines every container it starts, and the argv it builds is
pinned by a test (`src/backends/docker/__tests__/hardening.test.ts`) so a change
to the baseline has to get past it on purpose. Each flag carries its own
argument in `src/backends/docker/index.ts`; in one line each:

| Flag | Why |
|---|---|
| `--cap-drop=ALL` | No Linux capability, with no re-add list. `CAP_DAC_OVERRIDE` alone walks past the layout's read-only binds, and `NET_ADMIN` is what would put a default route back on a `deny-all` network. |
| `--security-opt=no-new-privileges` | A setuid binary inside the image cannot re-escalate. |
| `--ipc private` | This container's IPC namespace is not joinable. `shareable` (docker's other daemon default) hands every container a namespace of its own as well, but leaves it joinable by name with `--ipc container:<name>`. |
| `--read-only` | The image is not a place the workload writes; the layout's `outputs` and `scratch` binds are separate mounts and stay writable. |
| `--tmpfs <path>` | The paths inside the container that do stay writable — see below. |
| `--memory`, `--pids-limit`, `--cpus` | Bounds the host sets through `defaultMemoryLimitMb`, `defaultMaxProcesses` and `cpuLimit`. All three are unset by default, because the right number is a property of the host's machine and of the workload. |

**What stays writable under `--read-only`.** Four paths, all `--tmpfs`:
`/tmp`, `/var/tmp`, `/workspace` and `/home/namzu`. The first three are where a
workload's own scratch goes — `/tmp` is `TMPDIR`, where pip builds wheels and
where a program compiled in the sandbox is run, so these mounts are deliberately
executable (docker's own `--tmpfs` default is `noexec`, which would turn that
into `Permission denied` on a file that is plainly executable). `/home/namzu` is
the reference image's `HOME`: LibreOffice refuses a headless conversion without a
writable user profile, and matplotlib, fontconfig, npm and `pip install --user`
all keep caches there. A host that points `image` at its own build says what
that image needs with `writableRootfsPaths` — the backend cannot read an image's
writable set, and the alternative to asking is guessing. `readOnlyRootfs: false`
turns that control off — the container filesystem is writable again — and turns
off nothing else: `--cap-drop=ALL`, `--security-opt=no-new-privileges` and
`--ipc private` are applied whatever it says.

Because those four paths are tmpfs, they are RAM, not the container's writable
layer: scratch larger than half the host's RAM (or than `--memory`, the tighter
of the two when the host sets one) fails with `ENOSPC` rather than spilling onto
the host's disk. A run that writes temp files bigger than its memory budget does
not have to give up the baseline over it: `layout.scratch` is a bind to a host
directory and stays disk-backed, so a host with room on disk mounts one there
and points the workload at it — `TMPDIR` set to that container path through the
per-call `env` option — which keeps the read-only root filesystem and the four
paths above. `readOnlyRootfs: false` is the last resort rather than the first:
it buys the container's own writable layer back at the cost of the control.

**Three controls are deliberately absent.** A seccomp profile: docker applies
its built-in one to every container and nothing here asks for anything looser,
so what is missing is a *tighter* profile, and a hand-written one cannot be
verified here against the reference image's toolchain — a profile that blocks a
syscall chromium or LibreOffice needs breaks the sandbox, which is worse than
the gap it closes. Set `seccomp-profile` in the daemon's `daemon.json` if you
want one. `--userns-remap`: it is a daemon property (`userns-remap` in
`daemon.json`), not a `docker run` flag — a container only chooses between the
namespaces the daemon already made (`--userns=host|private`), so whether a
remapped mapping exists is settled before this backend's argv is read and no
flag here could settle it. Enable it on the host and every container in this
tier gets uid 0 mapped to an unprivileged uid outside.
`--user`: supported through `runAsUser` and unset by default, because `--user`
overrides the image's own choice and the reference image already ends with
`USER namzu`.

## Container egress boundary

An egress policy of `static` or `resolver` — a host allowlist — is enforced by
the egress proxy running as a **sibling container**, not by the process that
created the sandbox. The proxy is dual-homed: `docker run` puts it on an
ordinary network so it has a route to the internet, and `docker network
connect --alias namzu-egress` adds the `--internal` network the sandbox is on.
The sandbox joins that internal network alone, so the only thing it can reach
is the proxy — a route it cannot put back, because `--cap-drop=ALL` removed
`NET_ADMIN`. `--add-host namzu-egress:host-gateway` and the loopback proxy that
needed it are gone.

`HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, `https_proxy` and `NO_PROXY` are
still set on the sandbox, and what they are has changed. They no longer permit
traffic, they direct it: a tool that honours them sends its request through the
boundary, and a tool that ignores them — a binary that does not read proxy
environment, `curl --noproxy '*'`, a raw socket — has nowhere to send anything
and fails with `Network unreachable`. Before this, that second tool reached the
network with the allowlist unconsulted.

Three things a host must supply, each refused at `create()` rather than
downgraded: an `--internal` network in `network` (`docker network create
--internal <name>`), `hostReachability: 'container-network'` (a published host
port needs a route out that this network does not have), and
`egressProxyImage` — the proxy image, built from
`packages/sandbox/egress-proxy/Dockerfile` exactly as the sandbox image is
built from `packages/sandbox/worker/Dockerfile`. Nothing in this repository
pushes an image; both are built by hand and named by tag in the config.

The proxy container carries the same baseline the sandbox does
(`--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--ipc private`,
`--read-only`), because it is the process standing between untrusted code and
the internet. `deny-all` and `allow-all` need none of this beyond the internal
network `deny-all` already required.

What the boundary does not cover — domain fronting inside a `CONNECT` tunnel, a
`resolver` policy resolved at `create()` and `setNetworkPolicy()` rather than
per request, `setNetworkPolicy()` replacing the proxy container rather than
swapping a list in place, brokered credentials now readable by anything with
daemon access, and the proxy's listener being reachable by whatever else shares
its upstream network — is stated in
[docs/sdk/sandbox-egress.md](../../docs/sdk/sandbox-egress.md), along with the
argv-level evidence this change is verified by and the fact that no test here
starts a container.

## Protocol readiness and cancellation

Pass `SandboxExecOptions.signal` to stop a command on any shipped backend. A
remote host reserves every command before admission and the container worker or
microVM guest confirms process-group termination over a separate cancellation
request; stopping the data-stream wait alone is never reported as stopping the
command. A stalled execution stream is bounded relative to the requested
command timeout and reconciled through that same control path. An unconfirmed
stop fences the handle and retires the whole container, container group, or
microVM; a confirmed stop with an incomplete terminal stream is reported
separately so callers do not mistake partial output for an unknown process
outcome.

**One exception, and it is the only object here that is not disposable.** A
persistent Kubernetes workspace is not retired on an unconfirmed stop: the
retirement there is the `operatingMode: Suspended` patch, which makes the
controller delete the pod, and a workspace is held by more than one process by
design. Nothing is written, the handle goes on serving, the rejection carries
`retirement: { accepted: false, reason: 'workspace-kept' }`, and a bounded
health probe reports through `onCancellationUnconfirmed` whether the guest
agent is serving, has fenced itself, or could not be reached — so the host
decides when the live sessions in that pod go down. Because such a workspace
is held by more than one process, the writes that DO still go to it — suspend,
resume, adopt, delete — take an optional monotonic holder epoch, stored on the
object and tested in the same request that writes, so a superseded process's
late suspend or late delete is refused by the cluster rather than applied.
A call that passes no epoch sends exactly the requests it always sent. See
`docs/sdk/kubernetes-sandbox.md`.

Remote peers retain terminal ids briefly for idempotent cancellation, but evict
the oldest terminal history before refusing new work. If a command leader exits
while descendants remain, the peer fences itself and retires the whole sandbox
instead of signalling a numeric process-group id that the kernel could reuse.
Concurrent destroy and automatic-retirement calls share one checked teardown;
Docker removal is never reported as accepted after a non-zero or aborted
`docker rm -f`.

**The SIGTERM → SIGKILL grace window.** Both peers implement the same
mechanism, deliberately kept textually parallel so a future reader sees they
are one design, not two: `SIGTERM` the owned process group, wait for it to go
quiet, and escalate to `SIGKILL` only if it is still alive at the end of a
grace window — with nothing checking that a quiet group went quiet BECAUSE of
the signal rather than by finishing on its own. A command that ignores
`SIGTERM` but happens to complete within the window therefore runs to
completion untouched and reports back as a clean, unaborted-looking success.
The container worker's `NAMZU_SANDBOX_CANCEL_GRACE_MS` and the Firecracker/
kubernetes guest agent's `NAMZU_AGENT_CANCEL_GRACE_MS` both default to `250`
(previously `2000` on both — issue #469's kind conformance run caught this on
the agent transport first; the identical worker-side race was fixed in the
same change once found). 250ms is comfortably under the shared conformance
suite's adversarial fixture (a command that finishes on its own in ~400ms)
while still enough for a fast, well-behaved `SIGTERM` handler's own cleanup;
a deployment that genuinely needs a longer cooperative-shutdown window sets
either variable explicitly.

**Retained output, and a command that outlives its connection.** On the
kubernetes workspace tier a command can be started with a caller-chosen
`executionId` and `retainOutput`, and then followed — or picked up by a
different host process — through the additive `attach-execution` op. There is
ONE retained-output primitive in the guest and every consumer reads it: an
ordered, size-bounded log of stdout and stderr in a single monotonically
increasing byte-offset space, so a reader resumes with one number and sees the
interleaving the command produced. Its bound is bytes, not chunks — a chunk
larger than the whole budget has its head sliced off rather than being kept
whole — and eviction advances the log's start offset, so a read from before it
is answered with a `droppedBytes` count. A gap is reported; output is never
silently skipped, and offsets are absolute so a stale cursor is always
answerable. Every delta frame of a retained command carries the byte range it
occupies — on the `execute` stream as well as on an attach — because a host
must never derive an offset from what it received: output crosses the wire as
decoded text, and a chunk that ends inside a multi-byte character does not
decode to its own byte length. `attach-execution` replays from the requested
offset, follows the live command, and ends with one terminal frame; it never
signals the process, and closing an attach connection is a no-op. Ending a
command stays `cancel-execution`'s job alone. Reserving an id the guest still
holds reports what it holds rather than minting a second reservation, so a
retried start runs the command once — a guarantee that ends where the record
does, at the retention window (`NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS`,
10 min) and at pod replacement. The cost is bounded twice over, per execution
(`NAMZU_AGENT_EXECUTION_LOG_BYTES`, 1 MiB) and by how many executions may
retain at once (`NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS`, 32), and only a
command that asked for retention is kept at all. The guest advertises
`execution-attach` in `healthz` and a host that asks for a detachable command
against an image without it is refused before the command is admitted.

**Sessions: a terminal or a program that outlives the host process.** On the
kubernetes workspace tier a terminal can be opened with a caller-chosen
`sessionId` and `persistent: true`, and a program can be started with no
terminal at all through the additive `start-detached` op. Both then belong to
the guest's session registry rather than to the connection that started them:
closing the connection DETACHES and sends no signal, `attach-session` replays
from a byte offset and then follows live, `list-sessions` names what is
running, and `kill-session` ends one. The registry holds the SAME retained-output
primitive described above — one ring per session, one monotonic offset space,
eviction reported as `droppedBytes` — rather than a second one, and output is
read into it whether or not anybody is attached, so a program with no reader
never blocks on a full PTY. At most one attachment exists per session: a second
attach ends the first with a named `detached` frame, so two host processes
cannot interleave keystrokes into one shell. The registry is in memory only,
so a replaced pod comes back with none. **A teardown now reaches the whole
session.** The agent's own comment claimed a process-group kill reached "the
shell and every descendant"; it did not, because util-linux `script` starts the
shell in a new session, so a job backgrounded with `&` survived every terminal
teardown and ran until the pod stopped. Both `kill-session` and a
non-persistent terminal's teardown now signal every process still in that
kernel session, found through `/proc`. The cost is bounded per session
(`NAMZU_AGENT_SESSION_LOG_BYTES`, 1 MiB) and by how many may exist
(`NAMZU_AGENT_MAX_SESSIONS`, 16), with an exited session's record kept for
`NAMZU_AGENT_SESSION_TERMINAL_TTL_MS` (10 min). The guest advertises `sessions`
in `healthz` and a host asking for any of it against an image without the
string is refused rather than served a connection-bound terminal.

**Quiesce: stop everything the guest is running, and keep serving.** A
workspace host that takes a final capture of the disk could not make it exact.
`suspend()` reaches the terminals THAT handle returned and an execution
somebody cancelled by id; a terminal another host process opened, a command
already in flight, and above all a program that moved into a session of its own
with `setsid` and was then reparented away from the agent all kept running, and
kept writing, until the pod stopped — and once the pod has stopped there is no
agent left to read the disk through. The additive `quiesce` op is where a host
stands instead: it marks every running execution BEFORE it signals anything
(without that mark, a group leader dying before the rest of its group makes an
execution's close handler fence the agent, and a fenced agent refuses the
capture the quiesce was performed for), scans `/proc` rather than its own
children, skips PID 1, itself and its own kernel session, then signals in
rounds — `SIGTERM`, `graceMs`, `SIGKILL` on what is left — until a pass finds
nothing. A process still present after `SIGKILL` FAILS the call and names its
pid; it never resolves optimistically. Afterwards `execute`, `read-file` and
`write-file` all still work, which is the whole point. While it runs, every op
that would start a process answers `quiesce_in_progress`; the reads do not. The
general scan covers the guest's PID namespace, which in a pod is the container
and nothing else, and the agent performs it only when it is the init of that
namespace or was started by it (`k8s/entrypoint.sh` makes `tini` PID 1 and the
agent its child); anywhere else it narrows itself to the kernel sessions its own
registries own and reports `scope: "owned-sessions"` rather than being silently
weaker. The guest advertises `quiesce` in `healthz` and a host asking an image
without it is refused by name.

**A workspace's writes reach its disk on purpose.** Nothing in the agent ever
called `sync`, `syncfs` or `fsync`: a `write-file` answered `ok` as soon as the
bytes were in the page cache, and a `suspend()` took the pod away as soon as it
had stopped — which says nothing is writing any more, not that what was written
arrived. Both halves are closed. A `write-file` now goes through a temp
sibling, an `fsync`, a rename and a directory `fsync` before it answers, so the
reply means the bytes are on the device and a write that fails leaves the
previous contents rather than a truncated file; one `fsync` per part sequence,
on the last part, covers the whole file. And the additive `flush` op runs
`syncfs(2)` over the workspace mount, which is the only thing that can reach
what a COMMAND wrote — the Kubernetes backend sends it and waits for the reply
before it patches a workspace to `Suspended`, and the agent runs it itself on
`SIGTERM`, after stopping every process it owns through the same routine
`quiesce` uses and before exiting 0. The guest advertises `flush` in `healthz`
**only if it can run one** — the flush runs `sync -f`, and an image that
strips coreutils has this code and no `sync` — so a host that does not see the
string is told the image cannot flush rather than being left to read an
`unknown_op`, or a refusal it can never get past, as a flush that happened.

**The command timeout ceiling is configurable.** The guest agent reads its
maximum `timeoutMs` from `NAMZU_SANDBOX_MAX_TIMEOUT_MS` — the same variable
the container worker has always read for the same limit — defaulting to the
unchanged 30 minutes, and names the variable when it refuses. A request above
the ceiling is refused, not silently shortened.

Every worker and microVM guest publishes its wire-protocol version in the
readiness response. The host admits only the exact version implemented by its
release; missing, older, and newer versions fail before a sandbox handle or
command is returned. There is no identity-less legacy execution path. For a
standby pool, publish a new container group profile revision containing the
matching worker before deploying the host; for a microVM deployment, rebuild
and validate its golden guest image from the same release. Firecracker hosts
can import `FIRECRACKER_AGENT_PROTOCOL_VERSION` to apply the same admission
check in their own warm-pool probe.

Roll the coupled Firecracker artifacts in this order: build the guest agent
from the target Namzu release, publish and canary a golden image containing
that agent, then deploy hosts that require its protocol version. Keep the
previous host and golden-image pair available together for rollback. Rolling
back only one side is intentionally rejected at readiness, so a mismatched
guest never accepts work under an unverified wire contract.

## Guest agent transports and the per-instance token

The microVM guest agent picks its listen socket from the environment, in a
fixed order: `NAMZU_AGENT_UNIX_PATH` for a unix-domain socket, then an
inherited descriptor for the vsock bridge named by `NAMZU_AGENT_VSOCK_PORT`,
then `NAMZU_AGENT_TCP_PORT` for a TCP listener on `0.0.0.0`. The third mode is
for a deployment that reaches the guest over a routed network — one sandbox per
pod on a container orchestrator — instead of over a host-local socket. Framing,
ops, execution leases, terminals, loopback TCP and file IO are identical on all
three; only the listen address differs. A guest whose environment configures
none of them still refuses to start, naming all three. `NAMZU_AGENT_TCP_PORT=0`
binds an ephemeral port, which is what the suites use; a deployment names a
fixed port, because nothing in front of the guest can be configured to reach a
port that is only chosen at startup.

A routed listener is reachable by whatever the network admits, so that
deployment also gives the agent a per-instance credential. With
`NAMZU_AGENT_BIND_TOKEN` set, every op except `healthz` must present exactly
that token in its request envelope, from the first frame of the connection; a
missing, empty or different token is answered `unauthorized` and the connection
is closed before any handler runs. The token is compared in constant time
against a fixed-width digest, so neither its value nor its length is learnable
by probing. `NAMZU_AGENT_REQUIRE_TOKEN` is the fallback for a deployment that
cannot inject a token: the agent binds to the first token it is shown and
refuses every other one for the life of the process. With neither variable set
the agent authenticates nothing, which is what the host-local vsock and unix
transports have always done and what they keep doing. `healthz` never requires
a token and never echoes one, so readiness probing needs no secret and leaks
nothing beyond liveness and the protocol version.

The TCP mode fails closed. `NAMZU_AGENT_TCP_PORT` set with neither
`NAMZU_AGENT_BIND_TOKEN` nor `NAMZU_AGENT_REQUIRE_TOKEN` is refused at startup,
naming both, rather than binding an unauthenticated listener on `0.0.0.0`; the
unix and inherited-descriptor modes keep requiring no token, because their
control channel is host↔guest only. `NAMZU_AGENT_BIND_TOKEN` set to the empty
string is refused at startup in **every** mode: that is the shape a
downward-API injection takes when it resolved to nothing, and honouring it
would open precisely the hole the variable was set to close.

Neither the framed wire nor its version changes when the agent grows a
capability. `healthz` carries a `features` list instead, and a host uses an op
or a field only when it sees the string there: `write-file-parts` for a body
written to a temporary sibling in parts and finished with an atomic rename,
`flush` for the `syncfs` over the workspace mount, `stream-heartbeat` for the
per-stream liveness frame, and `guest-boot-id` for the agent process's own
identity.

`guest-boot-id` is a field rather than an op. The agent mints one opaque id at
startup and stamps it on every reply a caller has already authenticated —
`reserve-execution`, `cancel-execution` including its `unknown_execution`
refusal, `read-file`, `write-file`, and the `ready` frame that opens a terminal,
a session attachment or a `tcp-connect` stream. `healthz`, which is
unauthenticated, carries only the feature string and no id. It exists because a
per-instance token cannot answer "is this the same agent": on a container
orchestrator the token is the pod's uid, and a container restarted in place
keeps its pod — so the token still works, every call still succeeds, and every
process the caller started is gone with nothing on the wire saying so. An agent
that predates the field sends none and a host must read that as "this guest
cannot tell me", never as a change. A heartbeat is negotiated
per stream and in both directions — the `terminal` or `tcp-connect` open body
carries the interval, the agent echoes the interval it will use in its `ready`
event and only then starts sending, and the host only starts once that echo
arrived. An agent that predates the field ignores it and echoes nothing, so its
host behaves exactly as it did; a host that predates it never asks, so it is
never sent a frame type it would treat as a protocol error. Once negotiated,
three consecutive intervals with nothing at all arriving end the stream on both
sides — the same cleanup a closed socket already runs. Both sides count bytes
rather than whole frames, so a large frame still on its way is proof of life
like any other; silence while a side has paused reading for backpressure does
not count; and the echoed interval is honoured only between 100 ms and four
times what was asked, since each side does its own watchdog arithmetic with
a number the other sent.

Because the credential rides inside the request envelope, the gate cannot run
until a whole frame has been parsed — so what an unauthenticated peer may spend
in that window is bounded rather than trusted, and in the token modes only:

| Variable | Default | What it bounds |
|---|---|---|
| `NAMZU_AGENT_MAX_FRAME_BYTES` | 256 MiB | The largest length any frame header may announce, on every listen mode. The 8-hex prefix otherwise permits 4 GiB, which the reader used to honour. Sized for the largest frame the host legitimately writes: a `write-file` carries the whole base64 body in one envelope when it fits. |
| `NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES` | 8 MiB | The same ceiling for a connection that has not yet presented the token, clamped to the one above. Token modes only. It is the ceiling on one `write-file` FRAME on a token path, no longer on a file — see below. |
| `NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS` | 64 | How many connections may be unauthenticated at once. Token modes only. Every bound above is per connection, so without this one they could be paid again on the next connection. A full pool evicts its **oldest** unauthenticated member and serves the arrival — see below for why that direction. |
| `NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES` | 32 MiB | What all unauthenticated connections may buffer **between them**, never less than one pre-auth frame. Token modes only. The count above bounds sockets; this bounds the heap behind them, and the heap is what runs out first. |
| `NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS` | 10000 | How long a connection may stay unauthenticated while **quiet**. Every byte received resets it, so it retires the connection that says nothing, not the one that says too little. Token modes only, cleared the moment a connection authenticates. |
| `NAMZU_AGENT_PREAUTH_DEADLINE_MS` | 10000 | How long a connection may stay unauthenticated **at all**, measured from accept and reset by nothing. Token modes only, cleared the moment a connection authenticates, so no long-lived terminal, `tcp-connect` or streaming `execute` is ever measured against it. |
| `NAMZU_AGENT_REFUSAL_FLUSH_GRACE_MS` | 1000 | How long a refusal frame may take to reach the wire before the socket is destroyed anyway. Every listen mode. A backstop against a peer that has stopped reading, not a budget anything normally spends. |

The `quiesce` op has four bounds and one scope of its own, on every listen mode:

| Variable | Default | What it bounds |
|---|---|---|
| `NAMZU_AGENT_QUIESCE_GRACE_MS` | 1000 | How long one round waits after `SIGTERM` before escalating to `SIGKILL`. Clamped below `NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS`, and a caller-supplied `graceMs` at or above that bound is refused: a marked execution's close handler stops waiting there, so a later escalation would fence the agent mid-quiesce. Not the pod's `terminationGracePeriodSeconds`. |
| `NAMZU_AGENT_QUIESCE_DEADLINE_MS` | 20000 | The whole op, across every round. Kept well under the host transport's 60s read-idle timeout, because nothing is written on the wire while a quiesce runs — so raise it only up to that timeout (itself configurable on the host), never past it: beyond it the host tears down a quiesce that is working and cannot learn that it did. |
| `NAMZU_AGENT_QUIESCE_MAX_ROUNDS` | 8 | Scan-and-signal passes before the call reports failure. Rounds exist because a process can be forked while a pass is in flight; a workload forking faster than it can be killed is a failure to report, not a loop to run out the deadline. |
| `NAMZU_AGENT_QUIESCE_SETTLE_MS` | 1000 | How long the op waits, after everything is gone, for a killed child's `close` event to move its session to `exited` and settle its execution. Bookkeeping only — the processes are already gone, so running out of it does not fail the call. |
| `NAMZU_AGENT_QUIESCE_SCOPE` | derived | `owned-sessions` narrows the scan to the kernel sessions the agent's own registries own. The only accepted value: the general PID-namespace scan is derived from whether this agent is the init of its own PID namespace or was started by it, and there is deliberately no way to force it on. |

Termination and the flush have two more, on every listen mode:

| Variable | Default | What it bounds |
|---|---|---|
| `NAMZU_AGENT_FLUSH_TIMEOUT_MS` | 10000 | One `sync -f` over the workspace mount, whether a host asked for it or the `SIGTERM` handler is running it. Reported unconfirmed rather than abandoned quietly when it expires, because a caller that asked for a flush is usually about to take the pod away. |
| `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS` | 15000 | The WHOLE `SIGTERM` handler: stop accepting connections, stop every process the guest is running, flush, exit. The agent exits when it expires whatever is still in flight — a process in uninterruptible IO outlives a `SIGKILL` and a `syncfs` takes as long as the device takes, and a handler with no bound would hold the pod open until the kubelet's own `SIGKILL`. Keep it well below the pod's `terminationGracePeriodSeconds`. It is the only bound: a repeat `SIGTERM` is logged and ignored, because in a stopping pod the second one is the kubelet's own (sent as soon as the `preStop` hook returns) rather than anybody asking for a shorter wait. The hook's wait is derived from this number so it outlives it. |

So the most an unauthenticated peer can make the agent hold is
`NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES`, spread over at most
`NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS` sockets, and both are tunable against the
pod's memory limit. Resident memory settles somewhat above that while the
allocator catches up; what it does not do is keep climbing. Note what a shared
budget means when it is exhausted: the connection refused is whichever one asks
next, which may be a legitimate caller rather than the peer holding the budget.
That is the trade a global bound makes — a refused request is recoverable, an
exhausted pod is not.

A header above either ceiling is answered `frame_too_large`, naming the
announced length, the limit, and the variable that governs it, because a caller
told only a number cannot tell which of the two ceilings it hit. A fourth bound
needs no variable: a frame header is exactly nine bytes, eight hex digits and a
newline, so a peer streaming bytes that contain no newline at all is refused on
the ninth of them rather than buffered against a newline that is never coming.
A refused connection — for any of these, or for `unauthorized` — is
**destroyed**, not `end()`ed: ending a socket closes only its writable half, so
a refused peer used to be able to keep streaming into the agent's frame buffer
for as long as it liked.

Two of those bounds exist because the others do not answer a slow loris, and in
one earlier shape made each other worse. An idle timeout is reset by every
byte, so a peer that trickles one byte every few seconds stays unauthenticated
for as long as it cares to; `NAMZU_AGENT_PREAUTH_DEADLINE_MS` is what bounds
it, because it runs from accept and nothing resets it. And a full pool that
refused the **newest** connection handed exactly those peers the power to
decide who else got served: enough of them locked out every later caller,
including the credential-exempt `healthz` probe that a readiness check cannot
do without. So a full pool evicts its oldest unauthenticated member instead,
answers it `too_many_unauthenticated_connections`, and serves the arrival — the
oldest unauthenticated connection being, by construction, the one that has had
the longest to present a token and has not.

What none of this does is stop a peer that can reach the port from causing
churn. It can still open connections, hold slots until the deadline, and make
the agent evict and re-accept; what it cannot do is hold a slot indefinitely or
starve a probe. That residual is deliberate, and it is the division of labour
this design rests on: the NetworkPolicy ingress rule in front of the agent port
is the boundary that decides who may reach it at all, and the token and these
bounds are defence in depth behind it, for a peer already inside that rule.

One consequence used to be worth naming as a limit, because it is the price of
putting the credential in the envelope rather than in a handshake: a
`write-file` body travels in the same first frame as the token, so in a token
mode the pre-auth cap bounds that body — about 6 MiB of file content at the
default, since the body travels base64-encoded. It is still the bound on one
frame. It is no longer the bound on a **file**.

`write-file` takes an optional `part` object, and a body too large for one
frame arrives as a sequence of them:

```jsonc
// Every part is an ordinary write-file. `path` names a TEMPORARY sibling of
// the target for the whole sequence, never the target itself.
{ "op": "write-file", "token": "…", "body": {
    "path": "seed/.namzu-write-<uuid>-repo.tar.part",
    "content": "<base64 of this slice>", "encoding": "base64",
    "part": { "offset": 0, "final": false } } }

// …and the last one renames onto the target.
{ "op": "write-file", "token": "…", "body": {
    "path": "seed/.namzu-write-<uuid>-repo.tar.part",
    "content": "<base64 of the tail>", "encoding": "base64",
    "part": { "offset": 12582912, "final": true, "renameTo": "seed/repo.tar" } } }
```

`offset` must equal the temp file's CURRENT size (`0` creates or truncates
it), so a part that went missing, arrived twice or arrived out of order is
refused — `write_part_offset_mismatch` — rather than written in the wrong
place; a per-temp-path lock refuses an overlapping writer outright
(`write_part_in_flight`). A part whose bytes did not all reach the disk is
refused too (`write_part_short_write`): one `pwrite` answers a write that
crosses the volume's free space or an `RLIMIT_FSIZE` with a short count and
no error, so the agent checks the count it got and the temp file's size
against what the part claimed before it renames anything. The temp path and
`renameTo` go through the same workspace jail every other write does, and the
target changes exactly once, in the final `rename`: a reader never sees a
half-written file, and a sequence that dies partway leaves the target exactly
as it was. A host that abandons a sequence removes what it left behind with
`part: { "discard": true }`, which is idempotent — a path that is not there,
in a directory that was never created, answers `discarded` and creates
nothing on the way — and refuses (`write_part_not_a_temp_file`) any path
whose name, or whose RESOLVED name, is not one of these part files:
`write-file` removes an abandoned part, never an arbitrary file. A `part`
that is present but is not an object is refused outright
(`write_part_invalid_shape`) rather than served as the plain whole-file write
it resembles.

The guest opts in. `healthz` answers with `features` alongside `ok` and
`protocolVersion` — `write-file-parts` among them — and a host sends a part
only to a guest that advertised it: an agent that predates the field would
ignore `part` and write that slice as a whole file. A deployment that would
rather send one big frame than several small ones can still raise
`NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES`, trading pre-auth buffer budget for
frame size. Nothing on the Firecracker path is affected either way: no token
mode is active there, so no pre-auth cap applies and a `write-file` frame of
any size up to `NAMZU_AGENT_MAX_FRAME_BYTES` is accepted exactly as before.

`read-file` has the mirror-image arrangement, for a problem that was never a
refusal — it just cost more the bigger the file got, until it stopped working.
The whole-file reply held the file buffer, its base64 string, the JSON string
and two frame buffers at once, about 7.7x the file: measured against this
agent over loopback TCP, a 64 MiB read grew it by 405 MiB, and a file of about
384 MiB or more could not be answered at all because its base64 string is
longer than V8 permits a string to be. So `read-file` now takes optional
`offset` and `length` and `pread`s one bounded slice, answering with the WHOLE
file's `sizeBytes` beside it and with the bytes that exist when the range runs
past the end; and a new `read-file-stream` op opens the fd once and sends
`meta`, then base64 `data` frames, then `end`, then the zero-length
terminator, reusing one read buffer and waiting for the socket to drain
between chunks. A 1 GiB read grows the agent by about 12 MiB on the same
measurement.

```jsonc
// One slice, one reply frame. Capped by NAMZU_AGENT_READ_FILE_RANGE_BYTES
// (1 MiB): a larger range is REFUSED, not shortened.
{ "op": "read-file", "token": "…", "body": {
    "path": "out/report.bin", "encoding": "base64",
    "offset": 1048576, "length": 262144 } }

// The whole file, as an ordered multi-frame reply.
{ "op": "read-file-stream", "token": "…", "body": { "path": "out/report.bin" } }
```

The guest opts into both together: `healthz`'s `features` list carries both
strings, `write-file-parts` and `read-file-stream` — one entry for the two
read shapes, because they ship in the same file and no guest can have one
without the other. A host that does not see it keeps to the single whole-file
reply and sends neither — an agent that predates them would ignore
`offset`/`length` and answer with the whole file, which the caller would read
as its slice, so the
host throws `AgentReadFileStreamUnsupportedError` instead. Both new shapes go
through the same workspace jail the old op used.

Two rules a host writing to this wire has to know. A range must ask for
`base64`: a `utf8` slice taken at an arbitrary offset can begin or end inside
a multi-byte character, so the guest refuses one with
`read_file_range_requires_base64`, while a whole-file read still serves `utf8`
because its boundaries are the file's own. And `read-file-stream` serves
regular files only, refusing a directory, a fifo or a device node with
`read_file_stream_not_a_regular_file` — a regular file that `stat` reports as
zero bytes and that still has content, the procfs shape, is read to EOF by
both new shapes rather than answered as empty.

None of this is a wire change. `token`, `part`, `offset` and `length` are
optional envelope and body fields, `read-file-stream` is a new op nobody is
obliged to call, and `features` is an additive `healthz` field, so the guest
protocol version is deliberately unchanged and no host and no golden image
has to roll together with this release.

What the token is not: a boundary against the sandbox's own workload. Once the
image entrypoint deprivileges, the agent and the workload share a uid, so a
workload process can read the agent's own `/proc/<pid>/environ`. It is
per-instance for exactly that reason — a workload that steals its own
instance's token gains nothing it does not already have inside that instance,
and there is no shared pool secret whose theft would reach the other instances.
The boundary that keeps other tenants out is the network rule in front of the
agent port; the token is defence in depth behind it. What the guest does
guarantee is narrower and exact: every process it starts to serve a request —
an `execute` command, a `terminal` shell, the resize helper behind that
terminal — is handed an environment stripped of every `NAMZU_AGENT_*` and
`NAMZU_SANDBOX_*` variable, so the token and the agent's own configuration
never enter the workload's environment through the environment it is given.
Reading them out of `/proc` is the exposure above, and it is why the token is
per-instance.

That scrub is a **behaviour change** for the `terminal` op, not only a new
guarantee. A terminal shell used to be handed the agent's whole `process.env`;
it now gets the scrubbed environment an `execute` child has always had, and so
does the `stty` resize helper behind it. A terminal session therefore no longer
sees the agent's own settings — `NAMZU_SANDBOX_WORKSPACE` among them. A
workload that needs a value in its terminal passes it in `env` on the
`openTerminal` call, which still wins over everything else, `TERM` included.

## The container worker's control API, and its token

The container backend runs `worker/server.js` — a different process from the
guest agent above, with a different wire: plain HTTP on a port Docker forwards,
not a framed stream over a socket. It serves `GET /healthz`,
`POST /execute`, `POST /executions/reserve`, `POST /cancel`, `POST /read-file`
and `POST /write-file`, and until recently it authenticated nothing: any peer
that could route to the container could run a command or read and write a file
inside it. What made that defensible was the network the container is attached
to, which is a property of a deployment rather than of the worker, and is
absent wherever a control plane can put the container on a public address.

Every route but `GET /healthz` now requires
`Authorization: Bearer <NAMZU_SANDBOX_TOKEN>`. A missing, empty or different
token is answered `401` with `{"error":"unauthorized"}` and nothing else — no
expected/got, no length, no hint about which routes exist — and the request
never reaches a handler, so a refused `/write-file` writes nothing. The
comparison is a fixed-width SHA-256 digest compare, so neither the value nor
its length is learnable by probing, and the gate runs before every dispatch,
including the 404, so an unauthenticated caller cannot tell a real route from a
missing one, or a wrong token from a missing one. `/healthz` requires no token
and never echoes one, because it is what the host polls before it has any other
business with the worker, and it answers with liveness and the protocol version
only. That exemption is an exact match on the whole URL, so `POST /healthz`,
`GET /healthz?x=1` and `GET /healthz/` are gated like anything else. It also
leaves exactly one bit readable without a credential, deliberately: the
retiring-worker check answers before the `/healthz` dispatch, so a worker that
has poisoned itself answers `503 {"error":"worker_retiring"}` where a healthy
one answers `200`. That is the drain signal, and the readiness probe — which
has no credential to present — is who reads it; on every route that does
anything, a caller without the token gets the same `401` from a retiring worker
and a serving one.

**The token is minted per instance, by whoever starts the container.** The
container backend generates 32 random bytes at `create()` time and hands the
value to the docker CLI in ITS environment, resolved by the valueless
`--env NAMZU_SANDBOX_TOKEN`. It shares a destination with three variables that
already exist — the workspace path and the read/write roots land in the
container's environment through the same `--env` mechanism — and nothing else:
those three are rendered in the argv as `--env K=V`, values and all, while this
one is valueless, which is docker's form for "take the value from the CLI's own
environment". So it is in no argv, `ps` on the host does not show it, and a
failed `docker run` renders its argv with every `--env` value redacted, in all
four spellings of the flag, so the error a host logs does not carry it either.
What it IS visible in, said plainly: the container's own config, so
`docker inspect <name>` shows it for the container's life to anyone who can
already talk to the daemon, and the worker's `/proc` inside the container to a
workload sharing its uid. That is why it is per-instance and why it dies with
the container — an image-level secret would be shared by every container ever
built from it and readable by anything that can pull it, and a profile-level one
would be shared by every instance claimed from a pool. The variable carries the
`NAMZU_SANDBOX_` prefix, which is what keeps it out of every command the sandbox
runs: the worker strips that prefix from the environment it hands to a spawned
command, so a sandboxed task cannot read the credential out of its own
environment.

**A worker with no token refuses to start on a routable address.** The bind
default is `0.0.0.0` and stays that way: a published container port forwards to
the container's interface address rather than to its loopback, so narrowing the
default disables the container backend instead of hardening it. The credential
is what makes that default defensible, so its absence fails closed:

| What the worker was given | What it does |
|---|---|
| `NAMZU_SANDBOX_TOKEN` set | Requires it on every route but `/healthz`, whatever the bind address |
| No token, bound to loopback (`127.0.0.1`, `::1`, `localhost`) | Starts, unauthenticated. Nothing outside the container's own network namespace can open that socket, and refusing here would break the host-beside-docker dev case while closing nothing |
| No token, bound anywhere else — including the `0.0.0.0` default | Refuses to start, exit 1, naming the variable and every way out |
| `NAMZU_SANDBOX_TOKEN` set but **empty**, or with leading/trailing whitespace | Refuses to start in every mode. An empty value is the shape an injected secret takes when the injection resolved to nothing; a padded one is read from a trimmed header and so can never be presented, leaving a worker that looks authenticated and refuses its own host for the container's life |
| `NAMZU_SANDBOX_TOKEN` set to something **no HTTP header can carry** — a code point above U+00FF, or a C0 control other than HTAB | Refuses to start in every mode. A header value is one byte per character, so the client's own `fetch` throws before the request leaves the host for the first, and the HTTP parser on this side drops the connection for the second. Same "boots authenticated, refuses its host" state, caught at boot instead of at the first call |
| No token, routable, and `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` | Starts, unauthenticated, on purpose |

**The escape, and what it gives up.**
`NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` is the explicit, named way to keep an
existing deployment running unauthenticated. It gives up the credential
entirely rather than deferring it: every route but `/healthz` is then open to
whoever can route to the container, which is exactly the pre-token behaviour
and exactly what the credential was added to remove. Only `1`, `true`, `yes` and
`on`, in any case and with no surrounding whitespace, turn it on: `= 0` and
`= false` mean off, and so does everything else, because a flag whose
off-spelling turns it on is a trap — and so is a security escape that accepts
the shape a value takes when an editor adds a space to it. A configured token
always wins over the escape, since the escape can only mean "serve without a
credential", never "ignore the one I was given".

**A worker this host did not create must be provisioned with the token by
whoever does.** There is no channel back: the worker is handed its credential
at startup and never publishes it, so a warm pool, a shared container-group
profile or a container someone else started cannot be authenticated against by
a host that has no way to learn what it holds. The standby-pool backend cannot
send a per-instance token: the one property override its claim API admits is a
config map, and a config map arrives as a file mount under `/mnt/configmap`,
not as an environment variable — while this worker reads its token from
`process.env` at startup and never looks at the filesystem for one. That is a
channel that exists and a credential that still does not go in it, for two
reasons rather than none: the worker would not read it, and Microsoft's own
guidance is that config map values are not validated by the runtime and are not
where a value affecting application security belongs. A token on the shared
profile would be one credential for every instance claimed from the pool, and
this backend has no field to present one anyway — so what runs there today is a
private address (`subnetId`) plus the worker-side escape. The full answer, and
the change that would close the gap, are in
`docs/sdk/container-sandbox-worker.md`.

**The transport is not confidential.** `Authorization: Bearer` over plain HTTP
is replayable by anything on the path, so this is defence in depth behind
network placement, not a replacement for it. On the container backend the
worker is reached over Docker's port-forward on host loopback, or by DNS name
on a private bridge; it does not make a public-address deployment safe, which is
why the standby-pool backend still refuses to claim one without `subnetId`. The
egress proxy is unrelated to any of this and checks nothing inbound.

## Firecracker workspace channels

The Firecracker backend exposes two optional same-sandbox channels. Call
`sandbox.openTerminal()` for an interactive pseudo-terminal whose process tree
is owned by the guest. The returned `TerminalSession` supports input, output,
resize and close without substituting host pipes for terminal semantics. Call
`sandbox.openTcpConnection()` to reach an IPv4 or IPv6 loopback service inside
that same guest. Its `SandboxTcpConnection` exposes bounded write/backpressure,
incoming-data pause and resume, half-close and final closure. This channel can
publish a development server or WebSocket preview without moving the checkout
to another runtime or widening guest egress.

Both methods are capability-checked. A backend that cannot preserve the same
isolation and ownership boundary omits them; callers must not fall back to a
host process or a different sandbox.

## Firecracker network policy

At microVM creation, the Firecracker backend maps the resolved egress decision
to an explicit orchestrator policy: deny-all becomes `none`, allow-all becomes
`open`, and a static or resolved host list becomes `allowlist` with the exact
allowed hosts. An omitted egress setting retains the orchestrator's legacy
no-interface behavior. In particular, an empty resolved allowlist remains an
explicit deny-all decision rather than collapsing to an absent policy.

`sandbox.setNetworkPolicy()` remains the live-sandbox contract for backends
that can change egress after admission. A backend must throw when it cannot
enforce a requested live policy; accepting without applying it would erase the
security boundary the host relied on.

## Kubernetes per-sandbox egress

The kubernetes backend serves that contract when — and only when —
`egress.perSandbox` is configured: the method is PRESENT on a task handle
then and absent otherwise, which is the same omit-rather-than-ignore rule read
from the other side. A `KubernetesWorkspace` handle never carries it, and
`createKubernetesWorkspace` refuses a config that sets the option (with
`KubernetesWorkspacePerSandboxEgressConfigError`, before the first request)
rather than omitting a method the config asked for. Configured, each
`setNetworkPolicy` call writes one
`CiliumNetworkPolicy` for that sandbox alone, named after the claim's uid,
selecting one per-sandbox pod label, owned by the claim so the cluster
collects it on `destroy()`, and resolving only once a read-back deep-equals
what was sent. An empty list deletes that object and leaves the configured
baseline in force — which is a narrowing only when that baseline denies,
because cluster policies union.

It has two operator prerequisites, and a host that enables the option without
them is refused by design rather than by accident: an applied
`ValidatingAdmissionPolicy` and its binding, which the backend proves before
its first write and which bound what the host may write, and a separate RBAC
file granting the policy-write verbs the default Role deliberately withholds.
Whether such a policy is ENFORCED is a property of the cluster's CNI and is
not measured anywhere in this repository. See
`docs/sdk/kubernetes-sandbox.md`.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
