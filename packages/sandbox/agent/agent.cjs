/**
 * @namzu/sandbox Firecracker in-VM agent (vsock server).
 *
 * This is the custom AF_VSOCK agent the §2.2 decision calls for. It is
 * baked into the golden Firecracker rootfs and started as an init
 * service that is **listening before the golden snapshot is taken**, so
 * the listen socket is captured warm and survives resume.
 *
 * ## Same wire, different transport (vs worker/server.js)
 * It reuses `worker/server.js`'s exact spawn logic, workspace jail
 * (lexical `resolveWithinWorkspace` + realpath symlink-escape guard +
 * READ_ROOTS / WRITE_ROOTS), and the `{stdout_delta|stderr_delta|result
 * |error}` NDJSON shapes **verbatim**. What changes is the transport:
 * instead of an HTTP server on `:2024`, it serves a **framed stream**
 * over a socket. The framing matches the host dialer in
 * `src/backends/firecracker/transport.ts`:
 *
 *   request:  <8-hex byte length>\n<utf8 JSON { op, body }>
 *   reply (file-IO/healthz): one framed JSON object
 *   reply (execute): a SEQUENCE of framed NDJSON lines, then a
 *                    zero-length frame terminator
 *
 * ## Transport selection (vsock or tcp in prod, unix in dev/test)
 *   - AF_VSOCK: when `NAMZU_AGENT_VSOCK_PORT` is set and the host
 *     exposes the firecracker vsock device, the agent listens on the
 *     guest AF_VSOCK port. Node has no AF_VSOCK socket family, so the
 *     production rootfs runs the agent behind the kernel's vsock →
 *     stream bridge (the same host-UDS rendezvous the dialer connects
 *     to); from Node's side it is a stream server. The contract port
 *     is the value in `NAMZU_AGENT_VSOCK_PORT`.
 *   - UNIX: when `NAMZU_AGENT_UNIX_PATH` is set (dev + the vitest
 *     loopback peer) the agent listens on that unix-domain socket. The
 *     framing/exec/file-IO/reseed code is identical — only the listen
 *     address differs.
 *   - TCP: when `NAMZU_AGENT_TCP_PORT` is set the agent listens on that
 *     port on `0.0.0.0`, for a deployment where the host reaches the
 *     guest over a routed network (one pod per sandbox on a container
 *     orchestrator) instead of a host-local socket. Same framing, same
 *     handlers; what changes is that the listener is now reachable by
 *     anything the network lets through, which is why this mode is the
 *     one that pairs with a credential (below).
 *
 * ## Resume invariant (FC #4713 / loopholelabs reproducer)
 * On resume the guest vsock driver closes all open connections and the
 * TRANSPORT_RESET may not be delivered. The agent therefore:
 *   1. keeps the listen socket open (never tears it down per-request),
 *   2. handles each connection independently (a severed connection is
 *      not fatal — the next dial lands on the same listener),
 *   3. re-establishes its listen on `SIGUSR1` / VmGenId-change (the
 *      orchestrator/init signals a resume), AFTER reseeding entropy and
 *      regenerating machine-id / host keys / app secrets — the
 *      readiness fence is the security fence (§7 risk #4).
 *
 * ## Authn (opt-in, and absent on the vsock path)
 * The vsock control channel is host↔guest only and never traverses the
 * guest egress netns, so it carries no credential: with neither
 * `NAMZU_AGENT_BIND_TOKEN` nor `NAMZU_AGENT_REQUIRE_TOKEN` set the
 * agent authenticates nothing, exactly as it always has. A routed
 * transport has no such boundary, so a pod-network deployment sets
 * `NAMZU_AGENT_BIND_TOKEN` to a per-instance secret — the pod's own
 * `metadata.uid`, injected by the downward API and learned by the host
 * from the API server — and every op but `healthz` must present it in
 * the request envelope's optional `token` field, from the very first
 * frame. `NAMZU_AGENT_REQUIRE_TOKEN` is the fallback for a deployment
 * that cannot inject one: the agent binds to the first token it is
 * shown and refuses every other one for the life of the process.
 *
 * `token` is an OPTIONAL envelope field, so the wire format is
 * unchanged and {@link FIRECRACKER_AGENT_PROTOCOL_VERSION} is
 * deliberately NOT bumped: no host and no golden image has to roll with
 * this change.
 *
 * Because the credential rides inside the envelope, the gate cannot run
 * until a whole frame has been parsed, so an unauthenticated peer is
 * bounded rather than trusted: a small pre-auth cap on the length a
 * frame header may announce (`NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES`), an
 * ABSOLUTE deadline from accept that no byte resets
 * (`NAMZU_AGENT_PREAUTH_DEADLINE_MS`), an idle timeout beside it
 * (`NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS`), a pre-auth pool that EVICTS
 * ITS OLDEST member rather than turning the newest arrival away
 * (`NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS`), and a refusal that DESTROYS
 * the connection instead of half-closing it. All of them are confined
 * to the token modes; a connection on the vsock or unix path sees none
 * of them. A global ceiling on the announced frame length
 * (`NAMZU_AGENT_MAX_FRAME_BYTES`) applies on every mode, because the
 * 8-hex prefix otherwise lets any peer, authenticated or not, name 4 GiB.
 *
 * The deadline and the eviction are the two that answer a slow loris,
 * and neither is optional. An idle timer cannot: every byte resets it,
 * so a peer trickling one byte every few seconds holds its slot for as
 * long as it likes. A pool that refused the NEWEST connection made that
 * worse rather than better — a poolful of such peers locked out every
 * later caller, the credential-exempt `healthz` probe included. What no
 * bound here can do is stop a peer that can reach the port from causing
 * churn, and that is the point of the division of labour: the network
 * rule in front of the port is the boundary, and all of this is defence
 * in depth behind it.
 *
 * A TCP listener with neither credential variable set is refused at
 * startup rather than bound unauthenticated, and so is an empty
 * `NAMZU_AGENT_BIND_TOKEN`, in any mode.
 *
 * What the token is not: a boundary against the sandbox's own workload.
 * After the image entrypoint deprivileges, the agent and the workload
 * share a uid, so a workload process can read the agent's own
 * `/proc/<pid>/environ`. It is per-instance for exactly that reason —
 * stealing it wins nothing the thief does not already have inside that
 * instance, and there is no shared pool secret whose theft would reach
 * the others.
 */

'use strict'

const net = require('node:net')
const { spawn } = require('node:child_process')
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto')
const fs = require('node:fs/promises')
// Synchronous, and used for exactly one thing: looking for the program the
// flush runs before `healthz` promises a host that this guest can flush.
// See `canFlush`.
const { accessSync, constants: fsConstants } = require('node:fs')
const { constants: osConstants } = require('node:os')
const path = require('node:path')

const FIRECRACKER_AGENT_PROTOCOL_VERSION = 2

// This agent PROCESS's identity, minted once at startup and never again.
//
// The pod uid is the bind token, and it is the wrong thing to ask "is the
// guest I was talking to still there": under a container restart the kubelet
// brings the image back up inside the SAME pod, so the uid — and the token —
// are unchanged while every process the caller started is gone. Nothing in
// the old replies revealed that. This does, because it dies with the process
// that minted it.
//
// The kernel's `/proc/sys/kernel/random/boot_id` cannot serve: under a VM
// runtime it belongs to the pod's VM and survives exactly the restart this
// exists to expose.
//
// It is carried as an OPTIONAL field on the replies a host has already
// authenticated (see `guestIdentity`), never required, and advertised as
// `guest-boot-id` in {@link AGENT_FEATURES} for a host that wants to insist
// on it. A host that predates it ignores the field, as every host does with
// every field it does not name.
const GUEST_BOOT_ID = randomUUID()

/**
 * The optional identity fields every authenticated reply carries.
 *
 * One spread rather than a literal per reply site, so the set can only grow
 * in one place — and so a reply that forgets it is visible as a missing
 * spread rather than as a field nobody notices is absent.
 */
function guestIdentity() {
	return { guestBootId: GUEST_BOOT_ID }
}

// Capabilities this agent has that the protocol VERSION does not announce.
//
// The version is a compatibility fence — a host that speaks 2 requires a
// guest that speaks exactly 2 — so bumping it to publish an additive,
// optional op field would strand every already-running guest for a feature
// none of them has to use. `healthz` carries the list instead, and a host
// that wants the capability asks for it before it relies on it; a host
// that does not never notices the field.
//
//  - `write-file-parts` — `write-file` accepts a `part` object, so a body
//    larger than one frame can be written as a sequence of appends to a
//    temp file finished by an atomic rename. See `handleWriteFilePart`.
//  - `execution-attach` — `reserve-execution` accepts a caller-chosen
//    `executionId`, `execute` accepts `retainOutput`, and the
//    `attach-execution` op replays and then follows a retained execution's
//    output by byte offset without ever signalling it. See `OutputLog`
//    and `handleAttachExecution`.
//  - `stream-heartbeat` — `terminal` and `tcp-connect` accept a
//    `heartbeatMs` in their open body, echo it in `ready`, and then trade a
//    `{ type: 'heartbeat' }` frame every interval so neither side has to
//    guess whether a silent stream is a quiet shell or a peer that went
//    away. See `armStreamHeartbeat`.
//  - `read-file-stream` — the READ side of the write-file-parts problem.
//    One string for both halves of it, because they ship together in this
//    file and no host can ever have one without the other: `read-file`
//    accepts `offset`/`length` and answers ONE bounded slice
//    (`handleReadFile`), and the `read-file-stream` op sends a whole file
//    as an ordered `meta`, `data`..., `end` sequence
//    (`handleReadFileStream`). Both matter because the old whole-file
//    reply held the file buffer, its base64 string, the JSON string and
//    two frame buffers at once — about 7.7x the file — and refused
//    outright above ~384 MiB, where the base64 string passes V8's
//    0x1fffffe8-character ceiling. A host that does not see this string
//    keeps to the single whole-file reply and must send neither new
//    shape: an agent that predates them would IGNORE `offset`/`length`
//    and answer with the WHOLE file, which the caller would read as its
//    slice.
//  - `guest-boot-id` — every authenticated reply carries a `guestBootId`
//    naming THIS agent process, so a host can tell a container that was
//    restarted inside the same pod (same pod uid, same bind token, new boot
//    id, every guest process gone) from a guest that has been serving all
//    along. See `GUEST_BOOT_ID`.
//  - `sessions` — `terminal` accepts `{ sessionId, persistent: true }`, and
//    the `attach-session`, `start-detached`, `list-sessions` and
//    `kill-session` ops name, read, start and end a program that outlives
//    the connection that started it. See `sessions`.
//  - `quiesce` — the `quiesce` op stops every process this guest is
//    running, including ones no registry owns, and leaves the agent
//    serving `execute`, `read-file` and `write-file` so the host can still
//    read the disk it has just made quiet. See `runQuiesce`.
//  - `flush` — the `flush` op runs `syncfs(2)` over the workspace mount, so
//    a host that is about to take the pod away can make the dirty pages of
//    everything written through this guest — by `write-file` AND by a
//    command it ran — reach the device first. It is also what the agent
//    itself runs on `SIGTERM`, after it has stopped what it owns. See
//    `runFlush` and `terminate`. It is the ONE entry here that a guest
//    carrying this code may still not advertise: the flush runs a program,
//    and an image without that program cannot perform one — see
//    `advertisedFeatures`, which is what `healthz` actually answers.
const AGENT_FEATURES = [
	'write-file-parts',
	'execution-attach',
	'stream-heartbeat',
	'read-file-stream',
	'sessions',
	'quiesce',
	'flush',
	'guest-boot-id',
]

// --- config (mirrors worker/server.js env contract) -----------------------

const WORKSPACE_ROOT = process.env.NAMZU_SANDBOX_WORKSPACE || '/workspace'
const READ_ROOTS = normalizeRoots(
	[WORKSPACE_ROOT, ...(process.env.NAMZU_SANDBOX_READ_ROOTS || '').split(path.delimiter)].filter(
		Boolean,
	),
)
const WRITE_ROOTS = normalizeRoots(
	[WORKSPACE_ROOT, ...(process.env.NAMZU_SANDBOX_WRITE_ROOTS || '').split(path.delimiter)].filter(
		Boolean,
	),
)
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
// `body.timeoutMs` traces back to the bash tool's `timeout` argument, which
// is model-authored input — there is no schema ceiling on it between here
// and the LLM's tool call. Without a hard cap the caller-requested value
// alone decided how long a spawned process could pin CPU/memory in the
// guest, i.e. the one guard meant to bound that resource had no bound
// itself. A request over this is refused, not silently shortened — see
// `resolveTimeoutMs`.
//
// The ceiling belongs to the OPERATOR, not to this file. Every other
// ownership limit beside it is an environment variable, `worker/server.js`
// already reads this same limit from this same variable, and a deployment
// running a two-hour suite in a workspace could otherwise only raise it by
// rebuilding the guest image. The default is unchanged, so an unconfigured
// guest refuses exactly what it always refused, and `resolveTimeoutMs`
// names the variable in its refusal the way `frame_too_large` names its
// own bound.
const MAX_TIMEOUT_MS = positiveIntegerConfig('NAMZU_SANDBOX_MAX_TIMEOUT_MS', 30 * 60 * 1000)
const LENGTH_PREFIX_HEX = 8

function positiveIntegerConfig(name, fallback, allowZero = false) {
	const value = process.env[name] === undefined ? fallback : Number(process.env[name])
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
		throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`)
	}
	return value
}

const EXECUTION_LEASE_TTL_MS = positiveIntegerConfig('NAMZU_AGENT_EXECUTION_LEASE_TTL_MS', 30_000)
const EXECUTION_TERMINAL_TTL_MS = positiveIntegerConfig(
	'NAMZU_AGENT_EXECUTION_TERMINAL_TTL_MS',
	60_000,
)
const MAX_TRACKED_EXECUTIONS = positiveIntegerConfig('NAMZU_AGENT_MAX_TRACKED_EXECUTIONS', 1_024)
// How much of ONE retained execution's interleaved output the agent keeps,
// and how many executions may hold a retained log at the same time. The
// product is the whole of what this feature can cost the guest's heap:
// 1 MiB x 32 = 32 MiB, inside the 512Mi the shipped workspace template
// gives the container to share with the workload. Both halves are needed.
// Bytes alone would let `NAMZU_AGENT_MAX_TRACKED_EXECUTIONS` (1024 by
// default) multiply the bound by three orders of magnitude; a count alone
// would let one `yes` command eat the container.
//
// A log is created ONLY for an execution whose `execute` asked for
// `retainOutput`, so a guest nobody has asked to retain anything costs
// exactly what it always did.
const EXECUTION_LOG_BYTES = positiveIntegerConfig('NAMZU_AGENT_EXECUTION_LOG_BYTES', 1024 * 1024)
const MAX_RETAINED_OUTPUT_LOGS = positiveIntegerConfig('NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS', 32)
// How long a retained execution's record and log outlive the command,
// instead of `NAMZU_AGENT_EXECUTION_TERMINAL_TTL_MS`. Separate because the
// two answer different questions: the 60s one bounds how long a cancel may
// be retried idempotently, and shortening the window a REATTACHING host has
// to that would make the feature useless, while lengthening the cancel
// window for every execution would change a default nobody asked to change.
// Ten minutes is the floor the design calls for — long enough for a host to
// be redeployed and come back for its output.
const EXECUTION_RETAINED_TTL_MS = positiveIntegerConfig(
	'NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS',
	10 * 60 * 1000,
)
// How much unwritten output an ATTACHED reader's socket may hold before
// the agent drops that reader. A reader is an observer, and an observer
// that has stopped draining must not be able to grow the guest's heap
// outside the accounting above: everything it misses is in the log, and
// its next attach replays from the offset it last saw. One log's worth is
// the bound, because a reader further behind than that has nothing left
// to catch up TO.
const ATTACH_WRITE_BUFFER_BYTES = EXECUTION_LOG_BYTES
// How many sessions — persistent terminals and detached processes together —
// this guest will hold, and how much of each one's output it keeps.
//
// The same two-sided bound the retained-execution logs above carry, and for
// the same reason: the product is the whole of what the feature can cost the
// guest's heap, 16 x 1 MiB = 16 MiB inside the 512Mi the shipped workspace
// template gives the container to share with the workload. A count alone
// would let one `yes` in one shell eat the container; bytes alone would let
// the count multiply the bound.
//
// A session is created only when a caller NAMES one, so a guest nobody has
// asked to keep anything costs exactly what it always did.
const MAX_SESSIONS = positiveIntegerConfig('NAMZU_AGENT_MAX_SESSIONS', 16)
const SESSION_LOG_BYTES = positiveIntegerConfig('NAMZU_AGENT_SESSION_LOG_BYTES', 1024 * 1024)
// How long an exited session's record and its output outlive the program —
// the window in which a redeployed host can still come back, read the tail
// and learn the exit status. Ten minutes, matching
// `NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS`, because it answers the same
// question for the same reader.
const SESSION_TERMINAL_TTL_MS = positiveIntegerConfig(
	'NAMZU_AGENT_SESSION_TERMINAL_TTL_MS',
	10 * 60 * 1000,
)
// How long `kill-session` waits for the program to actually go before it
// answers. The answer carries the session's state either way, so a program
// that outlives the wait is reported still running rather than reported dead.
const SESSION_KILL_CONFIRM_TIMEOUT_MS = positiveIntegerConfig(
	'NAMZU_AGENT_SESSION_KILL_CONFIRM_TIMEOUT_MS',
	5_000,
)
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// `terminateAndConfirm` only escalates SIGTERM to SIGKILL when the owned
// process group is STILL alive at the end of this window — a group that
// goes quiet before then is read as "the signal worked," with no check
// that the signal was the reason. A command that ignores SIGTERM but
// happens to finish on its own before this elapses therefore runs to
// completion untouched, and is reported back as a clean, unaborted-looking
// result: exactly the outcome `SandboxExecOptions.signal`'s contract
// forbids ("must terminate the owned process ... never silently ignore the
// signal and let the command run to completion"). This was 2000ms until
// issue #469's kind conformance run caught it — every suite that drives
// this path shortens it to 50ms "so the abort case proves the kill in
// milliseconds, not the production window" (see
// `firecracker/__tests__/conformance.test.ts`), which happened to flip
// which side of that race wins for the shared conformance fixture's
// ~400ms-to-finish ignoring process and hid this default's own behaviour
// from every test. Kept short enough to leave that fixture a wide margin;
// a deployment that genuinely needs longer for cooperative cleanup sets
// `NAMZU_AGENT_CANCEL_GRACE_MS` explicitly.
const CANCEL_GRACE_MS = positiveIntegerConfig('NAMZU_AGENT_CANCEL_GRACE_MS', 250, true)
const CANCEL_CONFIRM_TIMEOUT_MS = positiveIntegerConfig(
	'NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS',
	5_000,
)
// How long `quiesce` gives a round of processes to go down on SIGTERM
// before it escalates to SIGKILL, and the ceiling a caller-supplied
// `graceMs` is refused above.
//
// The ceiling is `CANCEL_CONFIRM_TIMEOUT_MS`, and it is not a taste: a
// running execution is MARKED before it is signalled (see `runQuiesce`),
// and a marked execution's close handler waits exactly that long for the
// rest of its process group before it gives up and FENCES the agent. A
// grace window at or above that bound would let the escalation land after
// the handler had already stopped waiting — so the agent would retire
// itself in the middle of the quiesce, and refuse the capture the quiesce
// was performed for. The default is clamped for the same reason, because
// `NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS` is itself configurable.
//
// It is NOT the pod's `terminationGracePeriodSeconds`. That one bounds how
// long the kubelet waits after it has asked the pod to stop; this one
// bounds one round of one op the host called while the pod is still
// running and still serving. Different clocks, different budgets.
const QUIESCE_MAX_GRACE_MS = Math.max(1, CANCEL_CONFIRM_TIMEOUT_MS - 1)
const QUIESCE_GRACE_MS = Math.min(
	positiveIntegerConfig('NAMZU_AGENT_QUIESCE_GRACE_MS', 1_000),
	QUIESCE_MAX_GRACE_MS,
)
// The whole op's bound, across every round. Comfortably below the host
// transport's 60s read-idle timeout, because nothing is written on the wire
// while a quiesce runs: a guest that spent longer than that would be torn
// down as unresponsive by a host that was only waiting for it. That is also
// the ceiling an operator raising this has to respect — past the host's
// read-idle timeout, a quiesce that is working is torn down anyway, and the
// host cannot know it worked.
const QUIESCE_DEADLINE_MS = positiveIntegerConfig('NAMZU_AGENT_QUIESCE_DEADLINE_MS', 20_000)
// How many scan-and-signal rounds one quiesce performs before it reports
// failure. Rounds exist because a process can be forked while a pass is in
// flight; a workload forking faster than it can be killed is a failure to
// report, not a loop to run until the deadline.
const QUIESCE_MAX_ROUNDS = positiveIntegerConfig('NAMZU_AGENT_QUIESCE_MAX_ROUNDS', 8)
// How long the op waits, after everything is gone, for the registries to
// record what it did — a killed child's `close` event is what moves a
// session to `exited` and settles an execution's result. Purely
// bookkeeping: the processes are already gone when this starts, so running
// out of it does not fail the call.
const QUIESCE_SETTLE_MS = positiveIntegerConfig('NAMZU_AGENT_QUIESCE_SETTLE_MS', 1_000)

// --- flush + termination budgets ------------------------------------------
//
// How long ONE flush may take before it is reported unconfirmed. A `syncfs`
// over a workspace holding gigabytes of dirty pages is not instant, and the
// number that matters is the pod's `terminationGracePeriodSeconds`, which
// has to cover this twice over (see `k8s/manifests/sandboxtemplate-
// workspace.yaml`): the hook's flush before the stop signal, and this one
// after it. Reported rather than silently abandoned — a host that asked for
// a flush is about to take the pod away.
const FLUSH_TIMEOUT_MS = positiveIntegerConfig('NAMZU_AGENT_FLUSH_TIMEOUT_MS', 10_000)
// The whole SIGTERM handler's bound, from the signal to `process.exit`. It
// exists because every step inside it can block: a process in
// uninterruptible IO outlives a SIGKILL, and a `syncfs` over a slow device
// takes as long as the device takes. A handler with no bound would hold the
// pod open until the kubelet's own SIGKILL landed, which is the failure
// this agent's handler exists to avoid rather than one to reintroduce. It
// must stay comfortably BELOW the pod's `terminationGracePeriodSeconds`,
// because the two are measured from nearly the same moment and the one that
// expires first decides how the container ends.
const SHUTDOWN_DEADLINE_MS = positiveIntegerConfig('NAMZU_AGENT_SHUTDOWN_DEADLINE_MS', 15_000)
// The command that flushes the workspace filesystem. `sync -f PATH` is
// `syncfs(2)` on the filesystem holding PATH — every dirty page of every
// file on that mount, whichever process wrote it — and it needs no
// capability, which matters because the agent runs with an empty bounding
// set (`k8s/entrypoint.sh`). A plain `sync` is deliberately NOT a fallback:
// it flushes EVERY mounted filesystem, and on a runtime that shares the
// host kernel that is the node's disks, not this workspace's. The preStop
// hook in `k8s/entrypoint.sh` refuses it for the same reason and says so —
// an image whose `sync` cannot do `-f` gets no flush from either of them,
// which is a gap to report rather than a node's disks to spend.
//
// Overridable for tests via `NAMZU_AGENT_FLUSH_COMMAND` (run through
// `/bin/sh -c`, the same shape as `NAMZU_AGENT_RESEED_HOOK`), which is how
// a suite observes THAT the flush ran without a block device to watch.
const FLUSH_COMMAND = process.env.NAMZU_AGENT_FLUSH_COMMAND
const EXECUTION_ID_PATTERN =
	/^exec_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// The largest frame length a peer may ANNOUNCE in the 8-hex prefix. The
// prefix itself allows 0xffffffff — 4 GiB — and the reader used to honour
// it, so one peer could name a length and stream toward it while the agent
// concatenated every byte into one heap buffer. The ceiling has to clear
// the largest frame the host legitimately writes, and that is a
// `write-file`: transport.ts sends the whole body base64-encoded in a
// single envelope (`writeFile`, backends/firecracker/transport.ts) whenever
// it fits, and splits it into parts that each fit when it does not. 256 MiB
// of base64 is a ~192 MiB file — orders of magnitude above anything the
// Firecracker suites send and far below what the prefix would otherwise
// permit.
const MAX_FRAME_BYTES = positiveIntegerConfig('NAMZU_AGENT_MAX_FRAME_BYTES', 256 * 1024 * 1024)
// The same ceiling for a connection that has not yet presented the token,
// and only in the modes where a token is required at all. The gate cannot
// run until a whole frame has been parsed, because the credential rides
// inside the envelope, so without this an UNAUTHENTICATED peer got the
// full post-auth budget.
//
// Sized by what it would otherwise break rather than by what a request
// envelope costs: a `write-file` body travels in the same first frame as
// the token, so this cap is the ceiling on ONE write-file frame on a token
// path — 8 MiB of frame is a ~6 MiB file. It is no longer the ceiling on a
// file: a host that sees `write-file-parts` in the healthz reply splits a
// larger body into parts that each fit here and finishes with an atomic
// rename (see `handleWriteFilePart`), so this variable bounds what an
// unauthenticated connection may spend without bounding what a caller may
// write. See the README.
//
// Clamped to the global ceiling, because a pre-auth budget above the
// post-auth one is not a budget — it reads as a bug the first time
// someone hits the smaller number after authenticating.
const MAX_PREAUTH_FRAME_BYTES = Math.min(
	positiveIntegerConfig('NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES', 8 * 1024 * 1024),
	MAX_FRAME_BYTES,
)
// How many connections may be unauthenticated AT ONCE, in a token mode.
// The cap above bounds what one unauthenticated peer may hold; without
// this it could hold it many times over, once per connection. A
// connection leaves the pool the moment it authenticates, which on a
// healthy host is one round trip after it was accepted, so 64 is far
// above anything a host legitimately has in flight.
//
// A FULL pool gives up its oldest member rather than refusing the
// arrival. Refusing the newest is what makes a connection cap a denial
// of service in its own right: peers that hold their slots without ever
// authenticating then decide who else may be served, and `healthz` is
// answered on a connection like any other. The oldest unauthenticated
// connection is by construction the one that has had the longest to
// present a token and has not.
const MAX_PREAUTH_CONNECTIONS = positiveIntegerConfig('NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS', 64)
// What every unauthenticated connection may buffer BETWEEN THEM, in a
// token mode. The count above bounds sockets; this bounds the heap, and
// the heap is what runs out first: 64 connections each holding a frame
// just under the pre-auth cap is 64 x 8 MiB, which is a bound but not a
// survivable one for a pod. Charged against what the readers actually
// hold rather than against what was announced, so the ordinary case —
// many small envelopes in flight — spends almost none of it, and the
// default still leaves room for four concurrent maximum-size ones. Never
// smaller than one pre-auth frame, or a single legitimate write-file
// could not fit inside the budget it has to pass through.
const MAX_PREAUTH_BUFFER_BYTES = Math.max(
	positiveIntegerConfig('NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES', 32 * 1024 * 1024),
	MAX_PREAUTH_FRAME_BYTES,
)
// How long a connection in a token mode may stay unauthenticated while
// QUIET. This is an IDLE timeout: every byte received resets it, so on its
// own it retires only the connection that opens and then says nothing, or
// says too little to parse. It is kept because that connection should go
// early, not because it bounds anything.
const PREAUTH_IDLE_TIMEOUT_MS = positiveIntegerConfig('NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS', 10_000)
// How long a connection in a token mode may stay unauthenticated AT ALL.
// Measured from accept and reset by nothing — this is the bound the idle
// timer above is not. Without it a peer trickling a byte every few seconds
// pushed the idle timer out forever and held its slot indefinitely; enough
// such peers filled the pre-auth pool and, while the pool refused the
// newest arrival rather than evicting its oldest member, starved every
// later caller including `healthz`. A connection clears the deadline the
// moment it authenticates, so no long-lived terminal, `tcp-connect` or
// streaming `execute` is ever measured against it.
const PREAUTH_DEADLINE_MS = positiveIntegerConfig('NAMZU_AGENT_PREAUTH_DEADLINE_MS', 10_000)
// How long a refusal may take to reach the wire before the socket is
// destroyed anyway. The refusal is one small frame on an otherwise idle
// socket, so this is a backstop against a peer that has stopped reading,
// not a budget anything normally uses.
const REFUSAL_FLUSH_GRACE_MS = positiveIntegerConfig('NAMZU_AGENT_REFUSAL_FLUSH_GRACE_MS', 1_000)
// The largest slice ONE ranged `read-file` may answer with. A ranged read
// is a single reply frame, so this is the read-side twin of
// `NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES`: it keeps the encoded reply,
// its JSON string and the frame buffer to a few megabytes between them
// however large the file behind it is.
//
// It bounds a RANGE, never a whole-file read. `{ path }` with no `offset`
// and no `length` is the op this agent has always served and is not
// measured against this at all — a 64 MiB whole-file read that worked
// before this variable existed still works. A range over the limit is
// REFUSED rather than shortened, for `resolveTimeoutMs`'s reason: a
// caller that asked for 4 MiB, got 1 MiB and was told nothing would read
// the short answer as the end of its range. The refusal names
// `read-file-stream`, which has no such ceiling.
const READ_FILE_MAX_RANGE_BYTES = positiveIntegerConfig(
	'NAMZU_AGENT_READ_FILE_RANGE_BYTES',
	1024 * 1024,
)
// How much of the file one `data` frame of a `read-file-stream` carries.
// The read buffer is reused and the next read waits for the socket to
// drain, so the stream holds one chunk at a time and the guest's peak
// stops tracking the file's size: measured on node 24 over loopback TCP,
// reading `VmHWM` from the agent's OWN process, a 1 GiB read grew the
// agent by about 12 MiB at this default and by 74.5 MiB at 1 MiB, against
// 405 MiB for a 64 MiB read on the whole-file path.
//
// 256 KiB rather than the 1 MiB the issue suggested, chosen from that
// measurement: the acceptance budget is 64 MiB for a 1 GiB read, 1 MiB
// chunks sat above it, and the cost of the smaller chunk is about 40%
// more wall time for a gigabyte (2.7s against 1.9s). A deployment that
// would rather have the throughput raises this and pays for it in
// resident bytes.
const READ_FILE_STREAM_CHUNK_BYTES = positiveIntegerConfig(
	'NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES',
	256 * 1024,
)

// --- framing (matches transport.ts byte-for-byte) --------------------------

function frame(payload) {
	const body = Buffer.from(payload, 'utf8')
	const header = Buffer.from(
		`${body.length.toString(16).padStart(LENGTH_PREFIX_HEX, '0')}\n`,
		'ascii',
	)
	return Buffer.concat([header, body])
}

function writeFrame(socket, obj) {
	return socket.write(frame(JSON.stringify(obj)))
}

function writeTerminator(socket) {
	// zero-length frame: "00000000\n"
	socket.write(Buffer.from('00000000\n', 'ascii'))
}

const EMPTY_CHUNK = Buffer.alloc(0)

// A frame header is exactly nine bytes: eight hex digits and a newline.
// Nothing longer is one, which is what lets the reader decide on the ninth
// byte that a peer streaming bytes with no newline in them is never going
// to produce a header.
const FRAME_HEADER_BYTES = LENGTH_PREFIX_HEX + 1

// The two halves of a `read-file-stream` `data` frame's JSON, either side
// of the base64 payload. See {@link writeReadFileDataFrame}.
const READ_FILE_DATA_PREFIX = '{"type":"data","data":"'
const READ_FILE_DATA_SUFFIX = '"}'

/**
 * Write one `data` frame of a `read-file-stream` without ever building the
 * frame's JSON as a string.
 *
 * `writeFrame` would cost four allocations the size of the payload per
 * chunk — the base64 string, the JSON string, the UTF-8 buffer of that
 * string, and the `Buffer.concat` that prepends the header — and over a
 * long stream that garbage is what the agent's resident peak actually
 * measures: at a 1 MiB chunk it held a 1 GiB read about 10 MiB above the
 * 64 MiB the read is budgeted. Here the base64 string and one output
 * buffer are the whole cost.
 *
 * Producing JSON by concatenation is safe for exactly one reason, and it
 * does not generalise: the base64 alphabet is `A-Za-z0-9+/=`, and JSON
 * escapes none of those characters, so the encoded payload contributes
 * precisely itself and precisely its own length. `latin1` rather than
 * `utf8` for the same reason — every character is one ASCII byte, so the
 * copy needs no encoder. Any other field would have to go through
 * `writeFrame`.
 *
 * The buffer is fresh per chunk and never reused: `socket.write` takes a
 * REFERENCE and may still hold it after returning true, so a reused buffer
 * would rewrite bytes that had not reached the wire.
 */
function writeReadFileDataFrame(socket, bytes) {
	const encoded = bytes.toString('base64')
	const bodyBytes = READ_FILE_DATA_PREFIX.length + encoded.length + READ_FILE_DATA_SUFFIX.length
	const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + bodyBytes)
	out.write(`${bodyBytes.toString(16).padStart(LENGTH_PREFIX_HEX, '0')}\n`, 0, 'ascii')
	let at = FRAME_HEADER_BYTES
	at += out.write(READ_FILE_DATA_PREFIX, at, 'latin1')
	at += out.write(encoded, at, 'latin1')
	out.write(READ_FILE_DATA_SUFFIX, at, 'latin1')
	return socket.write(out)
}

/**
 * Split a byte stream into `<8-hex length>\n<payload>` frames.
 *
 * The reader is the agent's memory-bounding component: everything an
 * unauthenticated peer can make the agent hold, it holds here. So it
 * keeps arrived chunks as a queue and copies each frame exactly once,
 * rather than concatenating every chunk into one growing buffer — which
 * cost O(n²) in the bytes a peer sent, and handed anyone who could reach
 * the port an amplifier.
 *
 * Two bounds keep the queue small. A header may not announce more than
 * `maxFrameBytes`, and no header may take more than nine bytes to arrive.
 */
class FrameReader {
	/**
	 * @param maxFrameBytes the largest length a header may announce. A
	 * header above it stops the reader dead: nothing further is parsed and
	 * nothing further is buffered, which is what keeps a peer from naming
	 * a length and streaming toward it. The bound is a mutable field
	 * rather than a constructor-fixed one because a connection's budget
	 * legitimately changes — see `handleConnection`, which starts a
	 * token-gated connection at the pre-auth cap and raises it once the
	 * connection has authenticated.
	 */
	constructor(maxFrameBytes = MAX_FRAME_BYTES) {
		/** Arrived chunks, oldest first, starting on a frame boundary. */
		this.chunks = []
		/** What `chunks` holds, so a length check costs no walking. */
		this.length = 0
		this.maxFrameBytes = maxFrameBytes
		/**
		 * `{ announced, limit }` once a header has asked for more than the
		 * cap allowed, otherwise undefined.
		 */
		this.overflow = undefined
	}
	push(chunk) {
		// An overflowing reader takes no more bytes. Re-pushing after the
		// caller has raised `maxFrameBytes` and cleared `overflow` re-parses
		// what is already buffered.
		if (this.overflow) return []
		if (chunk.length > 0) {
			this.chunks.push(chunk)
			this.length += chunk.length
		}
		const out = []
		for (;;) {
			if (this.length < FRAME_HEADER_BYTES) break
			const header = this.peek(FRAME_HEADER_BYTES)
			const nl = header.indexOf(0x0a)
			if (nl !== LENGTH_PREFIX_HEX) {
				// Deciding this here, on the ninth byte, is the whole reason the
				// header is read as a fixed width. Waiting for a newline instead
				// meant a peer who never sent one was never wrong, and every byte
				// it sent was buffered while the agent kept waiting — reachable
				// before any credential had been checked.
				throw new Error(
					nl < 0
						? `malformed frame header (no newline in the first ${FRAME_HEADER_BYTES} bytes)`
						: `malformed frame header (newline at ${nl})`,
				)
			}
			const prefix = header.subarray(0, LENGTH_PREFIX_HEX).toString('ascii')
			if (!/^[0-9a-fA-F]{8}$/.test(prefix)) {
				throw new Error(`invalid frame length header ${JSON.stringify(prefix)}`)
			}
			const len = Number.parseInt(prefix, 16)
			if (len > this.maxFrameBytes) {
				// Recorded rather than thrown: whole frames already parsed out
				// of this same chunk are still valid, and one of them may be
				// the frame that authenticates the connection and raises the
				// cap this header just exceeded.
				this.overflow = { announced: len, limit: this.maxFrameBytes }
				break
			}
			if (this.length < FRAME_HEADER_BYTES + len) break
			this.consume(FRAME_HEADER_BYTES)
			out.push(this.take(len).toString('utf8'))
		}
		return out
	}
	/**
	 * The first `n` buffered bytes as one contiguous buffer, left in the
	 * queue. Only ever called for a header, and a header almost always
	 * lies inside the chunk it arrived in, so the copy is the rare path.
	 */
	peek(n) {
		const first = this.chunks[0]
		if (first.length >= n) return first.subarray(0, n)
		const head = Buffer.allocUnsafe(n)
		let filled = 0
		for (const chunk of this.chunks) {
			const take = Math.min(n - filled, chunk.length)
			chunk.copy(head, filled, 0, take)
			filled += take
			if (filled === n) break
		}
		return head
	}
	/** Drop the first `n` buffered bytes. */
	consume(n) {
		let left = n
		while (left > 0) {
			const first = this.chunks[0]
			if (first.length > left) {
				this.chunks[0] = first.subarray(left)
				break
			}
			left -= first.length
			this.chunks.shift()
		}
		this.length -= n
	}
	/** Take the first `n` buffered bytes out, as one contiguous buffer. */
	take(n) {
		if (n === 0) return EMPTY_CHUNK
		const first = this.chunks[0]
		if (first.length >= n) {
			const head = first.subarray(0, n)
			if (first.length === n) this.chunks.shift()
			else this.chunks[0] = first.subarray(n)
			this.length -= n
			return head
		}
		const out = Buffer.allocUnsafe(n)
		let filled = 0
		while (filled < n) {
			const chunk = this.chunks[0]
			const take = Math.min(n - filled, chunk.length)
			chunk.copy(out, filled, 0, take)
			filled += take
			if (take === chunk.length) this.chunks.shift()
			else this.chunks[0] = chunk.subarray(take)
		}
		this.length -= n
		return out
	}
	/** Drop everything buffered. Used when a connection is given up on. */
	reset() {
		this.chunks = []
		this.length = 0
		this.overflow = undefined
	}
}

// --- workspace jail (verbatim from worker/server.js) -----------------------

function resolveWithinWorkspace(p, base) {
	const resolved = path.resolve(base, p)
	const baseResolved = path.resolve(base)
	if (!resolved.startsWith(`${baseResolved}${path.sep}`) && resolved !== baseResolved) {
		throw new Error('path escapes the workspace')
	}
	return resolved
}

function normalizeRoots(roots) {
	const seen = new Set()
	const normalized = []
	for (const root of roots) {
		const trimmed = String(root || '').trim()
		if (!trimmed) continue
		const resolved = path.resolve(trimmed)
		if (seen.has(resolved)) continue
		seen.add(resolved)
		normalized.push(resolved)
	}
	return normalized
}

function isWithinRoot(resolved, root) {
	return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

function resolveAgainstRoots(p, roots) {
	if (!path.isAbsolute(p)) {
		return {
			target: resolveWithinWorkspace(p, WORKSPACE_ROOT),
			root: path.resolve(WORKSPACE_ROOT),
		}
	}
	const target = path.resolve(p)
	const root = roots.find((candidate) => isWithinRoot(target, candidate))
	if (!root) throw new Error('path escapes the workspace')
	return { target, root }
}

const resolveReadablePath = (p) => resolveAgainstRoots(p, READ_ROOTS)
const resolveWritablePath = (p) => resolveAgainstRoots(p, WRITE_ROOTS)

async function realpathWithinWorkspace(target, base) {
	const baseReal = await fs.realpath(path.resolve(base))
	let real
	try {
		real = await fs.realpath(target)
	} catch (err) {
		if (err && err.code === 'ENOENT') {
			const parentReal = await fs.realpath(path.dirname(target))
			real = path.join(parentReal, path.basename(target))
		} else {
			throw err
		}
	}
	if (!real.startsWith(`${baseReal}${path.sep}`) && real !== baseReal) {
		throw new Error('symlink escapes the workspace')
	}
	return real
}

// --- handlers (NDJSON shapes verbatim from worker/server.js) ---------------

// Pure so the loopback test can pin the ceiling without spawning a process.
// Throws (rather than clamping) on an out-of-range request: a caller that
// asked for more than the ceiling and silently got less would believe its
// process was protected for the duration it asked for.
function resolveTimeoutMs(rawTimeoutMs) {
	const timeoutMs = rawTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeoutMs)
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(
			`timeoutMs must be a finite number in (0, ${MAX_TIMEOUT_MS}] (NAMZU_SANDBOX_MAX_TIMEOUT_MS)`,
		)
	}
	return timeoutMs
}

/**
 * The environment for a process started to serve a request. Every
 * `NAMZU_AGENT_*` and `NAMZU_SANDBOX_*` variable is dropped, so the
 * agent's own configuration — the bind token among it — never enters
 * the workload's environment. Every process the agent starts to serve
 * a request — an `execute` command, a `terminal` shell, the resize
 * helper behind it — goes through here, with the caller's own `env`
 * layered on top.
 */
function childEnvironment(requested) {
	const inherited = {}
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('NAMZU_AGENT_') || key.startsWith('NAMZU_SANDBOX_')) continue
		inherited[key] = process.env[key]
	}
	return { ...inherited, ...(requested || {}) }
}

// --- retained output ------------------------------------------------------

/**
 * ONE ordered, size-bounded log of a command's output, addressed by a
 * monotonically increasing byte offset.
 *
 * This is the guest's only retained-output primitive. `attach-execution`
 * reads it here; a later persistent-session op reads the same class rather
 * than a second one, because two registries would mean two overflow
 * accountings, two sweeps and two ways to read an offset — and a reader
 * that had to know which one it was talking to.
 *
 * The shape, and why each part of it is there:
 *
 *  - **One offset space for both streams.** stdout and stderr are appended
 *    to the same log and share one cursor, so a reader resumes with a
 *    single number and the interleaving it sees on reattach is the
 *    interleaving the command produced. A per-stream offset would need two
 *    cursors and could not express "these arrived in this order".
 *  - **Offsets are absolute and never rewound.** `endOffset` counts every
 *    byte ever appended, including bytes that have since been evicted, so
 *    an offset a reader was handed stays meaningful after eviction: it
 *    either still points into the log or names exactly how much it missed.
 *  - **Eviction is reported, never silent.** Dropping the oldest bytes
 *    advances `startOffset`, and a read from before it answers with a
 *    `droppedBytes` count. A reader is told what it lost; it is never
 *    handed a shorter stream that looks complete.
 *  - **The bound is bytes, not chunks.** A single chunk larger than the
 *    whole budget has its head sliced off rather than being kept whole, so
 *    `maxBytes` is a real ceiling on what one command can cost.
 *
 * Chunks are held as `Buffer`s: offsets are byte offsets, and a slice taken
 * to honour the ceiling has to be a byte slice. A slice can land inside a
 * multi-byte character exactly as a socket read already can, which is why
 * the gap is reported — nothing here pretends the surviving bytes are a
 * whole string.
 */
class OutputLog {
	constructor(maxBytes) {
		this.maxBytes = maxBytes
		/** @type {{ stream: string, data: Buffer, offset: number }[]} */
		this.chunks = []
		/** Bytes currently held. */
		this.bytes = 0
		/** Offset of the oldest byte still held. */
		this.startOffset = 0
		/** Offset one past the newest byte ever appended. */
		this.endOffset = 0
		/** Total bytes evicted over this log's life. */
		this.droppedBytes = 0
	}

	/** Append one chunk and return the offset it starts at. */
	append(stream, data) {
		const offset = this.endOffset
		if (data.length > 0) {
			this.chunks.push({ stream, data, offset })
			this.bytes += data.length
			this.endOffset += data.length
			this.trim(this.maxBytes)
		}
		return offset
	}

	/**
	 * Give up everything held, keeping the offsets. Used to make room for a
	 * new retained execution without losing the fact that output existed:
	 * a later read reports the whole of it as a gap.
	 */
	discard() {
		this.trim(0)
	}

	/** Evict from the front until at most `budget` bytes remain. */
	trim(budget) {
		while (this.bytes > budget && this.chunks.length > 0) {
			const first = this.chunks[0]
			const excess = this.bytes - budget
			if (first.data.length <= excess) {
				this.chunks.shift()
				this.bytes -= first.data.length
				this.startOffset += first.data.length
				this.droppedBytes += first.data.length
				continue
			}
			first.data = first.data.subarray(excess)
			first.offset += excess
			this.bytes -= excess
			this.startOffset += excess
			this.droppedBytes += excess
		}
	}

	/**
	 * Everything retained from `fromOffset` on, plus the size of the gap
	 * between what was asked for and what survives.
	 *
	 * An offset ahead of `endOffset` is refused rather than clamped: it
	 * names bytes that do not exist yet, and answering it with "nothing,
	 * and no gap" would let a reader with a stale cursor believe it was
	 * caught up.
	 */
	read(fromOffset) {
		if (!Number.isSafeInteger(fromOffset) || fromOffset < 0 || fromOffset > this.endOffset) {
			return undefined
		}
		const droppedBytes = Math.max(0, this.startOffset - fromOffset)
		const start = Math.max(fromOffset, this.startOffset)
		const chunks = []
		for (const chunk of this.chunks) {
			const end = chunk.offset + chunk.data.length
			if (end <= start) continue
			if (chunk.offset >= start) {
				chunks.push(chunk)
				continue
			}
			const skip = start - chunk.offset
			chunks.push({ stream: chunk.stream, data: chunk.data.subarray(skip), offset: start })
		}
		return { chunks, droppedBytes, fromOffset: start, nextOffset: this.endOffset }
	}
}

// --- execution ownership --------------------------------------------------

const executions = new Map()
let agentRetiring = false

function pruneExecutions(now = Date.now()) {
	for (const [executionId, execution] of executions) {
		if (
			(execution.state === 'reserved' || execution.state === 'terminal') &&
			execution.expiresAt <= now
		) {
			executions.delete(executionId)
		}
	}
}

function makeRoomForReservation() {
	if (executions.size < MAX_TRACKED_EXECUTIONS) return
	const terminal = [...executions.entries()]
		.filter(([, execution]) => execution.state === 'terminal')
		.sort(([, left], [, right]) => left.expiresAt - right.expiresAt)
	for (const [executionId] of terminal) {
		executions.delete(executionId)
		if (executions.size < MAX_TRACKED_EXECUTIONS) return
	}
}

function validateExecutionId(executionId) {
	return typeof executionId === 'string' && EXECUTION_ID_PATTERN.test(executionId)
}

function syntheticCancelledResult(start = Date.now()) {
	return {
		exitCode: 1,
		timedOut: false,
		durationMs: Math.max(0, Date.now() - start),
		stdoutTruncated: false,
		stderrTruncated: false,
	}
}

function rememberTerminal(execution, outcome, result, error) {
	execution.started = execution.started ?? Boolean(execution.child)
	execution.state = 'terminal'
	execution.outcome = outcome
	execution.result = result
	execution.error = error
	// An execution whose output is retained keeps its record for the longer
	// window, because the point of retention is that the host that started
	// it may be gone and may come back. Everything else keeps the 60s
	// idempotent-cancel window it always had.
	execution.expiresAt =
		Date.now() + (execution.log ? EXECUTION_RETAINED_TTL_MS : EXECUTION_TERMINAL_TTL_MS)
	execution.child = undefined
	execution.processGroupId = undefined
	execution.done = undefined
	execution.resolveDone = undefined
	execution.terminationPromise = undefined
	// Every terminal transition goes through here, so every attached reader
	// is answered from here and there is no path that settles an execution
	// while an observer is still waiting on it.
	broadcastTerminal(execution)
}

// --- retained-output accounting and attached readers ----------------------

/** Executions still holding bytes-worth of retained output. */
function retainedLogCount() {
	let count = 0
	for (const execution of executions.values()) {
		if (execution.log && !execution.log.discarded) count += 1
	}
	return count
}

/**
 * Make a retained-output slot available, by giving up the logs of the
 * OLDEST-expiring finished executions. Answers whether there is room now.
 *
 * A finished execution gives up its output and keeps its record: its result
 * is what a late reader most needs, it costs almost nothing to keep, and a
 * reader that attaches afterwards is told the whole log is a gap rather
 * than being told the execution never existed. A slot held by a RUNNING
 * execution is not taken — its output has nowhere else to go — so a guest
 * already retaining `MAX_RETAINED_OUTPUT_LOGS` live commands refuses the
 * next one before it starts a process.
 */
function makeRoomForRetainedOutput() {
	if (retainedLogCount() < MAX_RETAINED_OUTPUT_LOGS) return true
	const finished = [...executions.values()]
		.filter(
			(execution) => execution.log && !execution.log.discarded && execution.state === 'terminal',
		)
		.sort((left, right) => left.expiresAt - right.expiresAt)
	for (const execution of finished) {
		execution.log.discard()
		execution.log.discarded = true
		if (retainedLogCount() < MAX_RETAINED_OUTPUT_LOGS) return true
	}
	return false
}

/** The one terminal frame an `attach-execution` stream ends with. */
function attachResultFrame(execution) {
	return {
		type: 'attach_result',
		executionId: execution.executionId,
		outcome: execution.outcome,
		started: execution.started === true,
		...(execution.result ? { result: execution.result } : {}),
		...(execution.error ? { error: execution.error } : {}),
		nextOffset: execution.log ? execution.log.endOffset : 0,
	}
}

/**
 * Append one output chunk to the retained log and hand it to every reader
 * attached right now.
 *
 * The append happens first and returns the span the chunk occupies, so a
 * live reader is told the same offsets a replaying one would compute. An
 * attach takes its replay and joins this set in one synchronous step (see
 * `handleAttachExecution`), which is what makes the two exact complements:
 * no chunk can be both replayed and broadcast, and none can fall between.
 */
function recordOutput(execution, stream, data) {
	if (!execution.log) return undefined
	const offset = execution.log.append(stream, data)
	// Both ends of the chunk, measured in the log's own byte space. The
	// caller stamps them on the frame it sends, because a host cannot
	// recover them from the string: `toString('utf8')` on a chunk that
	// ends mid-character yields U+FFFD, which is WIDER than the bytes it
	// replaced, so a host counting the decoded string drifts ahead of this
	// log and its reattach either skips bytes nobody reports or names an
	// offset that was never real.
	const span = { offset, nextOffset: offset + data.length }
	if (!execution.attachments || execution.attachments.size === 0) return span
	const event = { type: `${stream}_delta`, data: data.toString('utf8'), ...span }
	for (const attachment of execution.attachments) {
		// A reader whose socket has gone away is not this command's problem:
		// an attach is an observer, and losing one changes nothing about the
		// process. Its `onClose` removes it from the set either way.
		try {
			writeFrame(attachment.socket, event)
			// Nor is a reader that has stopped draining. Dropping it bounds
			// what one observer can buffer in the guest; it reattaches from
			// its own offset and the log replays what it missed.
			if (attachment.socket.writableLength > ATTACH_WRITE_BUFFER_BYTES) {
				execution.attachments.delete(attachment)
				attachment.socket.destroy()
			}
		} catch {}
	}
	return span
}

/** Answer and close every attached reader. Never signals anything. */
function broadcastTerminal(execution) {
	if (!execution.attachments || execution.attachments.size === 0) return
	const event = attachResultFrame(execution)
	for (const attachment of execution.attachments) {
		try {
			writeFrame(attachment.socket, event)
			writeTerminator(attachment.socket)
			attachment.socket.end()
		} catch {}
	}
	execution.attachments.clear()
}

function terminalPayload(execution) {
	return {
		ok: true,
		...guestIdentity(),
		state: execution.outcome,
		started: execution.started === true,
		...(execution.result ? { result: execution.result } : {}),
		...(execution.error ? { error: execution.error } : {}),
	}
}

function processGroupAlive(processGroupId) {
	if (!processGroupId) return false
	if (process.platform === 'win32') return true
	try {
		process.kill(-processGroupId, 0)
		return true
	} catch (error) {
		if (error?.code === 'ESRCH') return false
		return true
	}
}

function signalProcessGroup(execution, signal) {
	const processGroupId = execution.processGroupId
	if (!processGroupId || process.platform === 'win32') {
		try {
			execution.child?.kill(signal)
		} catch {}
		return
	}
	try {
		process.kill(-processGroupId, signal)
	} catch (error) {
		if (error?.code !== 'ESRCH') throw error
	}
}

function delay(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		timer.unref?.()
	})
}

async function waitForGroupExit(processGroupId, deadlineAt) {
	while (processGroupAlive(processGroupId)) {
		const remaining = deadlineAt - Date.now()
		if (remaining <= 0) return false
		await delay(Math.min(25, remaining))
	}
	return true
}

async function waitForDone(execution, deadlineAt) {
	const remaining = deadlineAt - Date.now()
	if (remaining <= 0) throw new Error('execution close was not observed before the deadline')
	let timer
	try {
		return await Promise.race([
			execution.done,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('execution close was not observed before the deadline')),
					remaining,
				)
				timer.unref?.()
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function terminateAndConfirm(execution, cause) {
	if (execution.state === 'terminal') return terminalPayload(execution)
	if (execution.state === 'exited') {
		await waitForDone(execution, Date.now() + CANCEL_CONFIRM_TIMEOUT_MS)
		return terminalPayload(execution)
	}
	if (execution.state !== 'running') {
		throw new Error(`execution is not running (state=${execution.state})`)
	}
	if (execution.terminationCause === undefined) execution.terminationCause = cause

	const deadlineAt = Date.now() + CANCEL_CONFIRM_TIMEOUT_MS
	signalProcessGroup(execution, 'SIGTERM')
	const termDeadline = Math.min(deadlineAt, Date.now() + CANCEL_GRACE_MS)
	let groupGone = await waitForGroupExit(execution.processGroupId, termDeadline)
	if (!groupGone) {
		if (execution.state === 'exited') {
			throw new Error(
				`process group ${execution.processGroupId} outlived its leader during cancellation; refusing to signal a reusable numeric process-group id`,
			)
		}
		signalProcessGroup(execution, 'SIGKILL')
		groupGone = await waitForGroupExit(execution.processGroupId, deadlineAt)
	}
	if (!groupGone) {
		throw new Error(`process group ${execution.processGroupId} remained live after SIGKILL`)
	}
	await waitForDone(execution, deadlineAt)
	return terminalPayload(execution)
}

function ensureTermination(execution, cause) {
	if (!execution.terminationPromise) {
		execution.terminationPromise = terminateAndConfirm(execution, cause).catch((error) => {
			execution.terminationPromise = undefined
			throw error
		})
	}
	return execution.terminationPromise
}

function retireAgent(error) {
	if (agentRetiring) return
	agentRetiring = true
	console.error(
		`[namzu-fc-agent] termination could not be confirmed; refusing reuse: ${error instanceof Error ? error.message : String(error)}`,
	)
}

/**
 * Reserve an execution id, or report the one the caller named.
 *
 * With no `executionId` in the body this is exactly the call it has always
 * been, down to the fields in the reply: the agent mints the id and the
 * reply carries no `state`, so a host that has never heard of any of this
 * reads the bytes it always read.
 *
 * With one, the id is the CALLER's, and reserving an id the agent still
 * holds reports what it holds rather than minting a second reservation.
 * That is what makes a retried start idempotent: the second caller sees
 * `state: 'running'` (or `'terminal'`) instead of `'reserved'`, sends no
 * `execute`, and attaches. `handleExecute` refuses a non-reserved id from
 * the other side, so even a caller that ignores the state cannot start the
 * command twice.
 *
 * Idempotency ends where the record does: at `pruneExecutions` (the
 * retention window) and at pod replacement, which takes the whole registry
 * with it. Both are stated in the docs.
 */
function handleReserveExecution(socket, body) {
	pruneExecutions()
	if (agentRetiring) {
		writeFrame(socket, { ok: false, error: 'agent_retiring' })
		socket.end()
		return
	}
	const requested = body?.executionId
	if (requested !== undefined && !validateExecutionId(requested)) {
		writeFrame(socket, { ok: false, error: 'invalid_execution_id' })
		socket.end()
		return
	}
	// Asked BEFORE making room, so a re-reservation cannot evict the very
	// record it is asking about.
	const existing = requested === undefined ? undefined : executions.get(requested)
	if (existing !== undefined) {
		writeFrame(socket, {
			ok: true,
			...guestIdentity(),
			protocolVersion: FIRECRACKER_AGENT_PROTOCOL_VERSION,
			executionId: requested,
			// Meaningless once a command has started — the lease is what
			// bounds an UNUSED reservation — and reported anyway so the field
			// is always a finite number, as every host that parses this reply
			// requires. `state` is what a caller reads here.
			leaseExpiresAt: existing.expiresAt ?? Date.now(),
			state: existing.state,
			...(existing.log ? { retainedOutput: true, outputOffset: existing.log.endOffset } : {}),
		})
		socket.end()
		return
	}
	makeRoomForReservation()
	if (executions.size >= MAX_TRACKED_EXECUTIONS) {
		writeFrame(socket, { ok: false, error: 'execution_capacity' })
		socket.end()
		return
	}
	const executionId = requested ?? `exec_${randomUUID()}`
	const leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
	executions.set(executionId, {
		executionId,
		state: 'reserved',
		expiresAt: leaseExpiresAt,
	})
	writeFrame(socket, {
		ok: true,
		...guestIdentity(),
		protocolVersion: FIRECRACKER_AGENT_PROTOCOL_VERSION,
		executionId,
		leaseExpiresAt,
		// Only for a caller that named an id: the default reserve's reply
		// stays byte-for-byte what it was.
		...(requested === undefined ? {} : { state: 'reserved' }),
	})
	socket.end()
}

/**
 * Replay and then follow one execution's retained output, and end with its
 * result.
 *
 * It is an OBSERVER and nothing else. It never signals the process, never
 * changes the execution's state, and closing the connection removes the
 * reader and does nothing else — deliberately unlike `cancel-execution`,
 * which is the op for ending a command and stays the only one.
 *
 * Synchronous on purpose: the replay is taken and the reader joins the live
 * set in one step with no `await` between them, so no chunk is both
 * replayed and broadcast and none falls between the two.
 */
function handleAttachExecution(socket, body) {
	const refuse = (error, extra) => {
		writeFrame(socket, { type: 'error', error, ...extra })
		writeTerminator(socket)
		socket.end()
	}
	if (!validateExecutionId(body?.executionId)) {
		refuse('invalid_execution_id')
		return
	}
	pruneExecutions()
	const execution = executions.get(body.executionId)
	if (execution === undefined) {
		// Past retention, or in a pod this execution never ran in. Both are
		// the same answer from here, and the docs say so.
		refuse('unknown_execution')
		return
	}
	if (!execution.log) {
		// The state goes with the refusal because it is the difference
		// between two facts a caller must not confuse: an execution still
		// `reserved` has no log because the command NEVER STARTED, while
		// any other state means this command simply kept no output. The
		// host says which one in its error.
		refuse('output_not_retained', { state: execution.state })
		return
	}
	const fromOffset = body.fromOffset === undefined ? 0 : Number(body.fromOffset)
	const replay = execution.log.read(fromOffset)
	if (replay === undefined) {
		refuse('invalid_offset')
		return
	}
	writeFrame(socket, {
		type: 'attached',
		executionId: execution.executionId,
		state: execution.state,
		fromOffset: replay.fromOffset,
		// The bytes between what the reader asked for and what survives. A
		// gap is REPORTED; output is never quietly skipped.
		droppedBytes: replay.droppedBytes,
	})
	for (const chunk of replay.chunks) {
		writeFrame(socket, {
			type: `${chunk.stream}_delta`,
			data: chunk.data.toString('utf8'),
			offset: chunk.offset,
			// The end of the chunk, so a reader that loses this connection
			// after the frame resumes exactly here. It cannot be computed
			// from `data`: see `recordOutput`.
			nextOffset: chunk.offset + chunk.data.length,
		})
	}
	if (execution.state === 'terminal') {
		writeFrame(socket, attachResultFrame(execution))
		writeTerminator(socket)
		socket.end()
		return
	}
	const attachment = { socket }
	execution.attachments.add(attachment)
	return {
		// An attach carries no further request frames. Anything after the
		// first one is a peer this op has no conversation with.
		onFrame: () => {
			execution.attachments.delete(attachment)
			socket.destroy()
		},
		onClose: () => {
			execution.attachments.delete(attachment)
		},
	}
}

async function handleCancelExecution(socket, body) {
	if (!validateExecutionId(body?.executionId)) {
		writeFrame(socket, { ok: false, error: 'invalid_execution_id' })
		return
	}
	pruneExecutions()
	const execution = executions.get(body.executionId)
	if (!execution) {
		// The boot id rides on THIS refusal above all: an agent that restarted
		// inside its pod answers a cancel for a command the previous process
		// started with exactly this, and the changed id is the only thing on
		// the wire that says the command died with that process.
		writeFrame(socket, { ok: false, ...guestIdentity(), error: 'unknown_execution' })
		return
	}
	if (execution.state === 'reserved' || execution.state === 'starting') {
		rememberTerminal(execution, 'cancelled', syntheticCancelledResult(execution.startedAt))
		writeFrame(socket, terminalPayload(execution))
		return
	}
	if (execution.state === 'terminal') {
		writeFrame(socket, terminalPayload(execution))
		return
	}
	try {
		writeFrame(socket, await ensureTermination(execution, 'cancelled'))
	} catch (error) {
		writeFrame(socket, {
			ok: false,
			...guestIdentity(),
			error: 'cancellation_unconfirmed',
			message: error instanceof Error ? error.message : String(error),
		})
		retireAgent(error)
	}
}

async function handleExecute(socket, body) {
	if (!body || !body.command || typeof body.command !== 'string') {
		writeFrame(socket, { type: 'error', error: 'missing_command' })
		writeTerminator(socket)
		socket.end()
		return
	}
	if (body.executionId !== undefined && !validateExecutionId(body.executionId)) {
		writeFrame(socket, { type: 'error', error: 'invalid_execution_id' })
		writeTerminator(socket)
		socket.end()
		return
	}
	// Retention is addressed by execution id and by nothing else: a log
	// nobody can name is a log nobody can attach to, so asking for one
	// without an id is a caller mistake, not a silently-ignored field.
	if (body.retainOutput === true && body.executionId === undefined) {
		writeFrame(socket, { type: 'error', error: 'retain_requires_execution_id' })
		writeTerminator(socket)
		socket.end()
		return
	}
	let trackedExecution
	let cwd
	try {
		cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
	} catch (err) {
		writeFrame(socket, { type: 'error', error: `invalid_cwd: ${err.message}` })
		writeTerminator(socket)
		socket.end()
		return
	}
	let timeoutMs
	try {
		timeoutMs = resolveTimeoutMs(body.timeoutMs)
	} catch (err) {
		writeFrame(socket, {
			type: 'error',
			error: `invalid_timeout: ${err.message}`,
		})
		writeTerminator(socket)
		socket.end()
		return
	}
	const maxOutputBytes = Number(body.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES
	const start = Date.now()

	if (body.executionId !== undefined) {
		pruneExecutions()
		trackedExecution = executions.get(body.executionId)
		if (!trackedExecution) {
			writeFrame(socket, { type: 'error', error: 'unknown_execution' })
			writeTerminator(socket)
			socket.end()
			return
		}
		if (trackedExecution.state !== 'reserved') {
			writeFrame(socket, {
				type: 'error',
				error: `execution_not_reserved: ${trackedExecution.state}`,
			})
			writeTerminator(socket)
			socket.end()
			return
		}
		if (body.retainOutput === true) {
			// Refused BEFORE the reservation is spent and before a process
			// exists, so a guest at its retained-output ceiling turns the
			// command away rather than running one whose output it cannot
			// keep. The reservation is left intact for the caller to retry.
			if (!makeRoomForRetainedOutput()) {
				writeFrame(socket, {
					type: 'error',
					error: `retained_output_capacity: limit ${MAX_RETAINED_OUTPUT_LOGS} (NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS)`,
				})
				writeTerminator(socket)
				socket.end()
				return
			}
			trackedExecution.log = new OutputLog(EXECUTION_LOG_BYTES)
			trackedExecution.attachments = new Set()
		}
		trackedExecution.state = 'starting'
		trackedExecution.startedAt = start
		trackedExecution.expiresAt = undefined
	}

	try {
		await fs.mkdir(cwd, { recursive: true })
	} catch (err) {
		if (trackedExecution?.state === 'starting') {
			rememberTerminal(trackedExecution, 'failed', undefined, err.message)
		}
		writeFrame(socket, {
			type: 'error',
			error: `mkdir_failed: ${err.message}`,
		})
		writeTerminator(socket)
		socket.end()
		return
	}
	if (trackedExecution?.state === 'terminal') {
		writeFrame(socket, { type: 'error', error: 'execution_cancelled' })
		writeTerminator(socket)
		socket.end()
		return
	}

	let child
	try {
		child = spawn(body.command, Array.isArray(body.args) ? body.args : [], {
			cwd,
			env: childEnvironment(body.env),
			stdio: [body.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		})
	} catch (err) {
		if (trackedExecution?.state === 'starting') {
			rememberTerminal(trackedExecution, 'failed', undefined, err.message)
		}
		writeFrame(socket, { type: 'error', error: err.message })
		writeTerminator(socket)
		socket.end()
		return
	}
	if (body.stdin !== undefined && child.stdin) child.stdin.end(String(body.stdin))

	const stdout = { bytes: 0, truncated: false }
	const stderr = { bytes: 0, truncated: false }
	let settled = false
	let resolveDone
	const done = new Promise((resolve) => {
		resolveDone = resolve
	})
	const execution = trackedExecution ?? { state: 'starting', startedAt: start }
	Object.assign(execution, {
		state: 'running',
		child,
		processGroupId: child.pid,
		done,
		resolveDone,
		terminationCause: undefined,
	})

	function clip(target, chunk) {
		if (target.truncated) return null
		const remaining = maxOutputBytes - target.bytes
		if (remaining <= 0) {
			target.truncated = true
			return null
		}
		const clipped = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
		target.bytes += clipped.length
		if (clipped.length < chunk.length) target.truncated = true
		return clipped
	}

	// The retained log is written BEFORE the frame that goes to the
	// connection which started the command, and deliberately: this
	// connection can already be a socket that is going away, while the log
	// is what a reattaching host will read. A write that fails must not be
	// able to cost the log a chunk. `recordOutput` is a no-op unless this
	// execution asked for retention, so the ordinary path is unchanged.
	child.stdout.on('data', (chunk) => {
		const clipped = clip(stdout, chunk)
		if (!clipped) return
		// `span` is present only for a retained execution, so an ordinary
		// execute stream carries exactly the fields it always carried. When
		// it IS present the host reads its cursor off it rather than
		// counting the decoded string — see `recordOutput`.
		const span = recordOutput(execution, 'stdout', clipped)
		writeFrame(socket, {
			type: 'stdout_delta',
			data: clipped.toString('utf8'),
			...(span ?? {}),
		})
	})
	child.stderr.on('data', (chunk) => {
		const clipped = clip(stderr, chunk)
		if (!clipped) return
		// Stamped for the same reason stdout is: one interleaved offset
		// space, one cursor, and neither stream may advance it by guesswork.
		const span = recordOutput(execution, 'stderr', clipped)
		writeFrame(socket, {
			type: 'stderr_delta',
			data: clipped.toString('utf8'),
			...(span ?? {}),
		})
	})

	const timeout = setTimeout(() => {
		void ensureTermination(execution, 'timeout').catch((error) => {
			retireAgent(error)
		})
	}, timeoutMs)
	timeout.unref()

	function settle(error, result) {
		if (settled) return
		settled = true
		clearTimeout(timeout)
		if (trackedExecution) {
			rememberTerminal(
				trackedExecution,
				// A quiesce is a host-initiated stop, so it reports the outcome a
				// host-initiated stop reports. Anything else would tell a later
				// `attach-execution` that a command the host killed ran to
				// completion.
				execution.terminationCause === 'cancelled' || execution.terminationCause === 'quiesced'
					? 'cancelled'
					: error
						? 'failed'
						: 'completed',
				result,
				error?.message,
			)
		}
		resolveDone({ error, result })
		try {
			if (error) writeFrame(socket, { type: 'error', error: error.message })
			else writeFrame(socket, { type: 'result', ...result })
			writeTerminator(socket)
			socket.end()
		} catch {}
	}

	child.on('error', (error) => settle(error))
	child.on('exit', (exitCode, signal) => {
		if (execution.state !== 'running') return
		execution.state = 'exited'
		execution.exitCode = exitCode
		execution.exitSignal = signal
	})
	child.on('close', (exitCode, signal) => {
		void (async () => {
			if (settled) return
			execution.state = 'exited'
			if (processGroupAlive(execution.processGroupId)) {
				if (execution.terminationCause !== undefined) {
					const groupGone = await waitForGroupExit(
						execution.processGroupId,
						Date.now() + CANCEL_CONFIRM_TIMEOUT_MS,
					)
					if (!groupGone) {
						throw new Error(
							`process group ${execution.processGroupId} remained live after termination`,
						)
					}
				} else {
					await delay(25)
					if (processGroupAlive(execution.processGroupId)) {
						throw new Error(
							`process group ${execution.processGroupId} remained live after its leader exited; refusing to signal a reusable numeric process-group id`,
						)
					}
				}
			}
			settle(undefined, {
				exitCode: typeof exitCode === 'number' ? exitCode : -1,
				timedOut: execution.terminationCause === 'timeout',
				durationMs: Date.now() - start,
				...(signal ? { signal } : {}),
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
			})
		})().catch((error) => {
			retireAgent(error)
			// No terminal frame is truthful here: the owned process group may
			// still be alive. Drop the data connection so the host reconciles
			// through cancel, observes the unconfirmed state, and retires the VM.
			socket.destroy()
		})
	})
}

/**
 * Where a ranged `read-file` starts and how much of the file it answers
 * with, or `undefined` for the whole-file read this op has always served.
 *
 * Pure, and separated from the fd work, so the ceiling can be pinned
 * without a disk: every refusal below is a decision about the REQUEST,
 * and the only thing the file contributes is its size.
 *
 * A range that starts past EOF is not an error. It answers zero bytes
 * with the file's real `sizeBytes` beside them, which is exactly what a
 * caller resuming from a remembered offset has to be able to see.
 */
function resolveReadRange(body, sizeBytes) {
	if (body.offset === undefined && body.length === undefined) return undefined
	const offset = body.offset === undefined ? 0 : Number(body.offset)
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error('read_file_invalid_offset: offset must be a non-negative safe integer')
	}
	const remaining = Math.max(0, sizeBytes - offset)
	const length = body.length === undefined ? remaining : Number(body.length)
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new Error('read_file_invalid_length: length must be a non-negative safe integer')
	}
	if (length > READ_FILE_MAX_RANGE_BYTES) {
		throw new Error(
			`read_file_range_too_large: ${length} bytes requested, limit ${READ_FILE_MAX_RANGE_BYTES} (NAMZU_AGENT_READ_FILE_RANGE_BYTES). Use the read-file-stream op to read a whole file.`,
		)
	}
	return { offset, length: Math.min(length, remaining) }
}

/**
 * Read a file, whole or by range.
 *
 * `{ path }` alone is byte-for-byte the op this agent has always served:
 * one `fs.readFile`, one encoded reply, one frame. `offset`/`length` opens
 * an fd instead and `pread`s at that position, so a caller draining a
 * large file pays for its slice rather than for the file. `sizeBytes`
 * always describes the WHOLE file in both shapes — it is how a ranged
 * caller knows where the file ends, and the sizeless-file branch below
 * exists to keep that promise on the one file shape `stat` cannot size —
 * and a ranged reply adds `offset` and `bytesRead` so a short answer is
 * legible as one.
 *
 * A range must be asked for in `base64`. A `utf8` slice taken at an
 * arbitrary offset can begin or end inside a multi-byte character, and
 * what comes back then is not those bytes; the whole-file shape keeps
 * `utf8` because its boundaries are the file's own.
 *
 * Both shapes go through `resolveReadablePath` + `realpathWithinWorkspace`,
 * the same jail, in the same order: there is no second path resolution in
 * this file and a range is not a way around the first one.
 */
async function handleReadFile(socket, body) {
	if (!body || !body.path) {
		writeFrame(socket, { ok: false, error: 'missing_path' })
		return
	}
	const encoding = body.encoding === 'base64' ? 'base64' : 'utf8'
	const ranged = body.offset !== undefined || body.length !== undefined
	if (ranged && encoding !== 'base64') {
		writeFrame(socket, {
			ok: false,
			error:
				'read_file_range_requires_base64: a ranged read must ask for base64, because a utf8 slice at an arbitrary offset can split a multi-byte character',
		})
		return
	}
	let handle
	try {
		const { target, root } = resolveReadablePath(body.path)
		const real = await realpathWithinWorkspace(target, root)
		if (!ranged) {
			const buf = await fs.readFile(real)
			writeFrame(socket, {
				ok: true,
				...guestIdentity(),
				content: buf.toString(encoding),
				sizeBytes: buf.length,
				encoding,
			})
			return
		}
		handle = await fs.open(real, 'r')
		const stat = await handle.stat()
		// The same sizeless-regular-file shape `read-file-stream` answers,
		// answered the same way. Every number a range is made of comes from
		// the file's size, and `stat` reports none for a procfs/sysfs file
		// that has content — so a range resolved against that zero would
		// answer an empty slice beside `sizeBytes: 0`, telling the caller the
		// file is empty when it is not. Reading once gives the range a true
		// size to be resolved against, at exactly the cost the whole-file
		// shape pays on the same file, and only when `stat` gave nothing to
		// range against: a file whose size `stat` knows is never read here.
		const preread = stat.size === 0 && stat.isFile() ? await handle.readFile() : undefined
		const sizeBytes = preread === undefined ? stat.size : preread.length
		const range = resolveReadRange(body, sizeBytes)
		let slice
		if (preread === undefined) {
			const buf = Buffer.allocUnsafe(range.length)
			const { bytesRead } = await handle.read(buf, 0, range.length, range.offset)
			slice = buf.subarray(0, bytesRead)
		} else {
			slice = preread.subarray(range.offset, range.offset + range.length)
		}
		writeFrame(socket, {
			ok: true,
			...guestIdentity(),
			content: slice.toString(encoding),
			sizeBytes,
			encoding,
			offset: range.offset,
			bytesRead: slice.length,
		})
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
	} finally {
		if (handle) {
			await handle.close().catch(() => {})
		}
	}
}

/**
 * Resolve the socket's next `drain`, or its end, whichever comes first.
 *
 * The same backpressure signal `handleTcpConnect` pauses its upstream on,
 * awaited instead of subscribed to because the reader below is a pull
 * loop rather than a push source — one mechanism, two shapes, not two
 * schemes. `close` and `error` resolve it too, so a peer that goes away
 * mid-stream never leaves the loop parked on a `drain` that cannot come.
 * Every listener is removed on the way out: a stream of a thousand chunks
 * that leaked three listeners per chunk would trip the max-listeners
 * warning and hold three closures per chunk alive.
 */
function waitForDrain(socket) {
	return new Promise((resolve) => {
		const done = () => {
			socket.removeListener('drain', done)
			socket.removeListener('close', done)
			socket.removeListener('error', done)
			resolve()
		}
		socket.once('drain', done)
		socket.once('close', done)
		socket.once('error', done)
	})
}

/**
 * Send a file as an ordered sequence of frames: `meta`, then `data`
 * chunks, then `end`, then the zero-length terminator — the same
 * terminated-stream shape `execute` uses, on a connection the dispatcher
 * keeps open the way it does for `terminal` and `tcp-connect`.
 *
 * This is the op that removes the ceiling. The whole-file reply had to
 * hold the file, its base64 form, the JSON envelope and two frame buffers
 * at once, so a 64 MiB read peaked around 542 MiB — above the shipped
 * workspace template's 512Mi limit, in the container the workload shares
 * — and a file of ~384 MiB or more could not be answered at all, because
 * its base64 string is longer than V8 permits a string to be. Here one
 * reused `READ_FILE_STREAM_CHUNK_BYTES` buffer crosses the wire at a time
 * and the next read waits for the socket to drain, so the guest's peak is
 * the same few megabytes whether the file is 1 MiB or 1 GiB.
 *
 * `offset`/`length` are accepted here too and are NOT capped: this op is
 * where `read-file`'s range ceiling sends a caller who wants more than
 * one frame's worth, so capping it would leave that caller nowhere to go.
 *
 * The fd is closed on every exit — completion, error, and a peer that
 * hangs up mid-stream (`onClose`) — because the alternative is an agent
 * that leaks a descriptor per abandoned read. The body below OWNS the
 * descriptor from `fs.open` to its own `finally`, which is the one thing
 * that makes that true for the narrow window where the peer hangs up
 * BEFORE the open resolves: `onClose` runs then with nothing to close,
 * and every exit after it is an early `return` that no longer reaches
 * `finish`. `releaseHandle` is idempotent, so `onClose`'s early release —
 * which is what makes an abort prompt rather than waiting for the loop to
 * notice — and the `finally` together close the fd exactly once.
 */
function handleReadFileStream(socket, body) {
	let settled = false
	let handle

	function releaseHandle() {
		const open = handle
		handle = undefined
		if (open) {
			void open.close().catch(() => {})
		}
	}

	function finish(event) {
		if (settled) return
		settled = true
		if (event) writeFrame(socket, event)
		writeTerminator(socket)
		socket.end()
	}

	void (async () => {
		try {
			if (!body || !body.path) {
				finish({ type: 'error', error: 'missing_path' })
				return
			}
			const { target, root } = resolveReadablePath(body.path)
			const real = await realpathWithinWorkspace(target, root)
			handle = await fs.open(real, 'r')
			// The peer can have gone in the time the open took. Returning
			// here rather than at the next guard skips a `stat` — and, on a
			// file whose size `stat` does not know, a whole pre-read — for a
			// connection that can no longer receive any of it. The `finally`
			// is what closes the descriptor this line just assigned.
			if (settled) return
			const stat = await handle.stat()
			if (!stat.isFile()) {
				finish({ type: 'error', error: 'read_file_stream_not_a_regular_file' })
				return
			}
			const offset = body.offset === undefined ? 0 : Number(body.offset)
			if (!Number.isSafeInteger(offset) || offset < 0) {
				finish({
					type: 'error',
					error: 'read_file_invalid_offset: offset must be a non-negative safe integer',
				})
				return
			}
			const length = body.length === undefined ? undefined : Number(body.length)
			if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
				finish({
					type: 'error',
					error: 'read_file_invalid_length: length must be a non-negative safe integer',
				})
				return
			}
			// A regular file whose `stat` reports no size can still have content:
			// the procfs/sysfs shape, reachable whenever an operator adds such a
			// root to `NAMZU_SANDBOX_READ_ROOTS`. `fs.readFile` reads those to
			// EOF, and a whole-file `readFile` the host now serves THROUGH this
			// op has to answer the same bytes it always did rather than an empty
			// buffer. Their length is discoverable only by reading, so this
			// branch reads — sequentially, which is the access pattern those
			// files support, and only when `stat` gave nothing to stream
			// against, so a file whose size is known is never materialised here.
			// It costs exactly what the old whole-file op cost on the same file,
			// which is the thing it is standing in for.
			const preread = stat.size === 0 ? await handle.readFile() : undefined
			const sizeBytes = preread === undefined ? stat.size : preread.length
			const rest = Math.max(0, sizeBytes - offset)
			const wanted = length === undefined ? rest : Math.min(length, rest)
			if (settled) return
			writeFrame(socket, { type: 'meta', sizeBytes, offset, length: wanted })

			// One buffer for the whole stream, reused: `toString('base64')`
			// copies out of it synchronously, so nothing observes it after the
			// next read has overwritten it.
			const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(READ_FILE_STREAM_CHUNK_BYTES, wanted)))
			// One chunk into that buffer, from the fd or from the pre-read one,
			// answering how many bytes landed. Zero means EOF in both shapes.
			const readChunk = async (want, position) => {
				if (preread === undefined) {
					const read = await handle.read(chunk, 0, want, position)
					return read.bytesRead
				}
				return preread.copy(chunk, 0, position, Math.min(position + want, preread.length))
			}
			let position = offset
			let sent = 0
			while (sent < wanted) {
				if (settled) return
				const want = Math.min(chunk.length, wanted - sent)
				const bytesRead = await readChunk(want, position)
				// A file that shrank under an open fd answers short and then
				// zero. `end` is still the truthful terminator: `bytesSent` says
				// what crossed and `meta.sizeBytes` said what was expected, so
				// the host compares them rather than being told a lie.
				if (bytesRead === 0) break
				position += bytesRead
				sent += bytesRead
				if (settled) return
				const flushed = writeReadFileDataFrame(socket, chunk.subarray(0, bytesRead))
				if (!flushed) await waitForDrain(socket)
			}
			finish({ type: 'end', bytesSent: sent })
		} finally {
			// The descriptor's one owner. Unconditional, so no reader has to
			// prove which exits reach `finish`: every `return` above, every
			// throw on the way to the `catch` below, and the normal end all
			// pass through here.
			releaseHandle()
		}
	})().catch((err) => {
		finish({ type: 'error', error: err instanceof Error ? err.message : String(err) })
	})

	return {
		onFrame() {
			// Nothing travels host->guest on this op. A frame arriving here
			// is a host talking a protocol this one does not have, and
			// ignoring it is what every other reply-only op does.
		},
		onClose() {
			settled = true
			releaseHandle()
		},
	}
}

/**
 * Temp files a part sequence is currently appending to, keyed by the
 * RESOLVED guest path.
 *
 * The offset check alone already refuses a lost, duplicated or reordered
 * part, but two writers appending to the same temp file concurrently could
 * both read the size the other is about to change and both believe their
 * offset matched. A part is short and the host sends its own parts
 * sequentially, so refusing the overlap outright costs a correct caller
 * nothing and removes the race rather than narrowing it.
 */
const writePartsInFlight = new Set()

/**
 * The host's own temp-file naming (`writeFilePartTempPath`,
 * backends/firecracker/transport.ts).
 *
 * `part.discard` is the only verb on `write-file` that REMOVES a file, and
 * the only thing it exists to remove is a part file this agent created for
 * a sequence that was abandoned. Matching the name — against the RESOLVED
 * path, so a symlink named like a part file does not launder the check —
 * keeps `write-file` from quietly becoming a general delete.
 *
 * `[\s\S]` rather than `.`, which does not match a newline: a target whose
 * basename contains one still gets a temp file, and a pattern that could
 * not name it would strand that file inside the workspace forever.
 */
const WRITE_PART_TEMP_NAME = /^\.namzu-write-[\s\S]+\.part$/

/**
 * The durability half of a write, and why it is here rather than left to
 * the kernel's own writeback.
 *
 * `fs.writeFile` returning means the bytes are in the page cache, not that
 * they are on the device. That was invisible for as long as nothing ever
 * took the guest away deliberately — but a workspace's whole purpose is to
 * be suspended and resumed, and `suspend()` stops the pod within a second
 * or two of the reply this agent sends. A `write-file` that answered `ok`
 * and then lost its bytes to a pod stop would be the quietest possible
 * data loss: nothing fails, and the file is simply older than the caller
 * was told.
 *
 * So the reply now means what a caller reads it as. The sequence is the
 * standard one, and every step of it is load-bearing:
 *
 *  1. write a temp sibling — so an interrupted write leaves the TARGET
 *     untouched rather than truncated-and-half-rewritten, which is what
 *     `fs.writeFile` onto the target did;
 *  2. `fsync` it — the file's own data reaches the device;
 *  3. `rename` onto the target — atomic within one directory, so a reader
 *     sees the old file or the new one and never a partial one;
 *  4. `fsync` the DIRECTORY — the rename itself is metadata, and a crash
 *     after step 3 but before the directory entry is written back would
 *     leave the target pointing at the old inode with the new data already
 *     safely on the device and unreachable.
 *
 * `handleWriteFilePart` already had steps 1 and 3 (#475's part protocol);
 * this adds 2 and 4 to it and gives the single-frame path all four. Both
 * paths also carry the mode of the file they replace onto the temp file
 * before the rename — step 3 replaces the target whole, permissions
 * included — through {@link replacementMode}, which is one helper rather
 * than one rule per path.
 */
async function syncDirectoryEntry(file) {
	// Opening a directory read-only and fsyncing the handle is how the
	// directory's own metadata is written back. Windows has no equivalent
	// (opening a directory as a file fails there), and no guest this agent
	// ships in runs on it — the skip keeps the loopback suites runnable on a
	// developer's machine rather than pretending the guarantee holds there.
	if (process.platform === 'win32') return
	let handle
	try {
		handle = await fs.open(path.dirname(file), 'r')
		await handle.sync()
	} finally {
		if (handle) await handle.close().catch(() => {})
	}
}

/** The temp sibling a durable single-frame write goes through. */
function writeTempSibling(real) {
	// Deliberately in the same `.namzu-write-*.part` family the part
	// protocol uses: one recognisable name for "a write that was in
	// flight", one `WRITE_PART_TEMP_NAME` pattern, and the existing
	// `part.discard` verb can remove one a crash left behind.
	return path.join(path.dirname(real), `.namzu-write-${path.basename(real)}.${randomUUID()}.part`)
}

/**
 * The mode a replacement of `real` has to carry, or `undefined` when there
 * is nothing to carry it from.
 *
 * A rename replaces the target with the temp file, mode included, so a file
 * that was executable before a rewrite has to still be afterwards. An absent
 * target keeps the old behaviour (`fs.writeFile`'s 0o666 through the umask);
 * an existing one keeps its own bits. A `stat` that fails for any reason is
 * read as "no target to carry anything from": the write itself is what
 * decides whether the path is writable, and a mode this code could not read
 * is not a reason to refuse a write the caller asked for.
 *
 * Shared by BOTH rename paths on purpose — `writeFileDurably` and
 * `handleWriteFilePart`'s final part. They replace a file the same way, so
 * they owe the caller the same answer, and a rule kept in one of them is a
 * rule the other one loses.
 */
async function replacementMode(real) {
	try {
		return (await fs.stat(real)).mode & 0o7777
	} catch {
		return undefined
	}
}

/**
 * Write one whole body to `real` so that a reply of `ok` means the bytes
 * are on the device. Answers how many bytes were written.
 *
 * The short-write check is the parts path's, for the parts path's reason:
 * Linux reports a SHORT COUNT and no error when a write crosses the
 * filesystem's free space, and renaming that onto the target would destroy
 * the file this sequence exists to protect while reporting success.
 */
async function writeFileDurably(real, buf) {
	const temp = writeTempSibling(real)
	const mode = await replacementMode(real)
	let handle
	try {
		handle = await fs.open(temp, 'wx')
		if (mode !== undefined) await handle.chmod(mode)
		const written = await handle.write(buf, 0, buf.length, 0)
		const sizeBytes = (await handle.stat()).size
		if (written.bytesWritten !== buf.length || sizeBytes !== buf.length) {
			throw new Error(
				`write_short_write: wrote ${written.bytesWritten} of ${buf.length} bytes, temp file is ${sizeBytes} bytes`,
			)
		}
		await handle.sync()
		await handle.close()
		handle = undefined
		await fs.rename(temp, real)
		await syncDirectoryEntry(real)
		return written.bytesWritten
	} catch (err) {
		// Nothing half-written is left inside the workspace for a later
		// `listFiles` to show, and the target is exactly as it was.
		if (handle) await handle.close().catch(() => {})
		handle = undefined
		await fs.rm(temp, { force: true }).catch(() => {})
		throw err
	} finally {
		if (handle) await handle.close().catch(() => {})
	}
}

function decodeWriteBody(body) {
	return body.encoding === 'base64'
		? Buffer.from(String(body.content), 'base64')
		: Buffer.from(String(body.content), 'utf8')
}

/**
 * Remove one abandoned part file, and nothing else.
 *
 * The host sends this after a sequence it could not finish, and swallows
 * whatever comes back — the reason the sequence failed is usually the
 * reason the cleanup will fail too. So everything that means "there is no
 * such part file" answers success, including a directory that does not
 * exist because the first part never landed; a host retrying a cleanup is
 * never told it failed at something that was already done.
 *
 * The name is checked twice on purpose: lexically first, so a path that
 * was never a part file is refused as one whether or not it exists, and
 * again on the RESOLVED path, so a symlink named like a part file cannot
 * launder the check into removing something else.
 */
async function discardWritePartFile(socket, target, root) {
	if (!WRITE_PART_TEMP_NAME.test(path.basename(target))) {
		writeFrame(socket, { ok: false, error: 'write_part_not_a_temp_file' })
		return
	}
	let real
	try {
		real = await realpathWithinWorkspace(target, root)
	} catch (err) {
		if (err && err.code === 'ENOENT') {
			writeFrame(socket, { ok: true, discarded: true })
			return
		}
		writeFrame(socket, { ok: false, error: err.message })
		return
	}
	if (!WRITE_PART_TEMP_NAME.test(path.basename(real))) {
		writeFrame(socket, { ok: false, error: 'write_part_not_a_temp_file' })
		return
	}
	try {
		await fs.rm(real, { force: true })
		writeFrame(socket, { ok: true, discarded: true })
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
	}
}

/**
 * One slice of a body too large for a single frame.
 *
 * `body.path` names the TEMP file, never the target — so it goes through
 * the SAME `resolveWritablePath` + `realpathWithinWorkspace` jail checks
 * every other write does, and an agent that did not understand `part` at
 * all would overwrite a temp file rather than the caller's target. The
 * target is named separately by `part.renameTo`, checked the same way, and
 * only ever touched by the final `rename` — so a reader never observes a
 * half-written file and an abandoned sequence leaves the target exactly as
 * it was.
 *
 * `part.offset` must equal the temp file's CURRENT size (offset 0 creates
 * or truncates it). That is what makes a part sequence verifiable rather
 * than hopeful: a part that went missing, arrived twice, or arrived out of
 * order is refused, not appended in the wrong place.
 */
async function handleWriteFilePart(socket, body, part) {
	let target
	let root
	try {
		const resolved = resolveWritablePath(body.path)
		target = resolved.target
		root = resolved.root
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
		return
	}

	// Abandoning a sequence is a write-file too: the host has no other op
	// that can reach into the jail to remove what it left behind. Only a
	// part file, though — see `WRITE_PART_TEMP_NAME` — and it answers
	// before the `mkdir` below ever runs: a verb whose whole job is to
	// leave nothing behind must not create directories on its way to
	// deciding there was nothing there.
	if (part.discard === true) {
		await discardWritePartFile(socket, target, root)
		return
	}

	let real
	try {
		await fs.mkdir(path.dirname(target), { recursive: true })
		real = await realpathWithinWorkspace(target, root)
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
		return
	}

	if (body.content === undefined) {
		writeFrame(socket, { ok: false, error: 'missing_path_or_content' })
		return
	}
	const offset = part.offset === undefined ? 0 : part.offset
	if (!Number.isSafeInteger(offset) || offset < 0) {
		writeFrame(socket, {
			ok: false,
			error: `write_part_invalid_offset: ${JSON.stringify(part.offset)}`,
		})
		return
	}
	const final = part.final === true
	if (final && !part.renameTo) {
		writeFrame(socket, { ok: false, error: 'write_part_missing_rename_target' })
		return
	}
	// Resolved through the jail BEFORE a byte is written, so a final part
	// naming a target outside the workspace is a true no-op rather than a
	// refusal that already appended to the temp file.
	let realTarget
	if (final) {
		try {
			const { target: renameTarget, root: renameRoot } = resolveWritablePath(part.renameTo)
			await fs.mkdir(path.dirname(renameTarget), { recursive: true })
			realTarget = await realpathWithinWorkspace(renameTarget, renameRoot)
		} catch (err) {
			writeFrame(socket, { ok: false, error: err.message })
			return
		}
	}
	if (writePartsInFlight.has(real)) {
		writeFrame(socket, { ok: false, error: 'write_part_in_flight' })
		return
	}

	writePartsInFlight.add(real)
	let handle
	try {
		const buf = decodeWriteBody(body)
		if (offset === 0) {
			handle = await fs.open(real, 'w')
		} else {
			let size = -1
			try {
				size = (await fs.stat(real)).size
			} catch {
				size = -1
			}
			if (size !== offset) {
				throw new Error(
					`write_part_offset_mismatch: temp file is ${size < 0 ? 'absent' : `${size} bytes`}, part starts at offset ${offset}`,
				)
			}
			handle = await fs.open(real, 'r+')
		}
		// One `pwrite`, not a loop: Linux returns a SHORT count and NO
		// error when a write crosses the filesystem's free space or the
		// process's RLIMIT_FSIZE. Reporting the length that was REQUESTED
		// and renaming anyway would put a truncated file onto the target —
		// destroying exactly what the atomic rename exists to protect —
		// while telling the host the write failed. So the bytes are counted
		// twice, by the syscall and by the file itself, and both must agree
		// with what this part claimed BEFORE anything is renamed. A short
		// write on an earlier part is caught by the next part's offset
		// check; the final part has no next part, and is the whole reason
		// this check is here.
		const written = await handle.write(buf, 0, buf.length, offset)
		const sizeBytes = (await handle.stat()).size
		if (final) {
			// The target's own mode, onto the temp, BEFORE the rename two
			// blocks below — the rename is what would otherwise install the
			// 0o666-and-umask the temp was created with, silently stripping
			// the executable bit off a script or widening a 0600 file. Same
			// rule, same helper and the same reply as a whole-body write: see
			// `replacementMode`. Read HERE rather than at part 0 because this
			// is the part that renames, and applied before the `fsync` so the
			// file's own writeback carries the mode back with the data.
			//
			// A `chmod` that fails throws out of this block before the rename,
			// so the whole sequence is refused with `ok: false` and the target
			// keeps both its bytes and its bits — exactly what
			// `writeFileDurably` does with the same failure. Failing closed is
			// deliberate: a write that cannot keep the target's mode is
			// reported rather than quietly performed as a different file, and
			// the caller has no way to discover a silent mode change. Nothing
			// is lost by it — no rename ran, and the temp file is left for
			// `part.discard` like any other abandoned sequence.
			const mode = await replacementMode(realTarget)
			if (mode !== undefined) await handle.chmod(mode)
			// ONE fsync per sequence, on the last part, and it covers the whole
			// file: `fsync` writes back every dirty page of the FILE, not of the
			// descriptor, so the pages the earlier parts left in the cache go
			// with it. Per-part fsyncs would multiply the cost of a large write
			// by the number of frames it took and buy nothing — an abandoned
			// sequence is thrown away rather than renamed, so an unflushed part
			// file is not a durability question at all.
			await handle.sync()
		}
		await handle.close()
		handle = undefined
		if (written.bytesWritten !== buf.length || sizeBytes !== offset + buf.length) {
			throw new Error(
				`write_part_short_write: wrote ${written.bytesWritten} of ${buf.length} bytes at offset ${offset}, temp file is ${sizeBytes} bytes`,
			)
		}
		if (final) {
			// Same directory by construction (the host names a sibling), so
			// this is a rename within one filesystem: atomic, and the only
			// moment the target changes at all.
			await fs.rename(real, realTarget)
			// And then the directory entry that rename created — see
			// `writeFileDurably` for why the file's own fsync is not enough.
			await syncDirectoryEntry(realTarget)
		}
		writeFrame(socket, {
			ok: true,
			...guestIdentity(),
			bytesWritten: written.bytesWritten,
			sizeBytes,
		})
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
	} finally {
		if (handle) await handle.close().catch(() => {})
		writePartsInFlight.delete(real)
	}
}

async function handleWriteFile(socket, body) {
	if (!body || !body.path) {
		writeFrame(socket, { ok: false, error: 'missing_path_or_content' })
		return
	}
	if (body.part !== undefined && body.part !== null) {
		// An array is `typeof 'object'` too, and would otherwise read as a
		// part with every field undefined — a whole-file write to `body.path`
		// under an op shape claiming to be something else. A `part` that is
		// present but is not an object is a malformed request, so it is
		// refused rather than quietly served as the other thing.
		if (typeof body.part !== 'object' || Array.isArray(body.part)) {
			writeFrame(socket, { ok: false, error: 'write_part_invalid_shape' })
			return
		}
		await handleWriteFilePart(socket, body, body.part)
		return
	}
	if (body.content === undefined) {
		writeFrame(socket, { ok: false, error: 'missing_path_or_content' })
		return
	}
	try {
		const { target, root } = resolveWritablePath(body.path)
		await fs.mkdir(path.dirname(target), { recursive: true })
		const real = await realpathWithinWorkspace(target, root)
		const buf = decodeWriteBody(body)
		// Through the same temp-sibling-fsync-rename sequence the part
		// protocol uses, rather than `fs.writeFile` onto the target: see
		// `writeFileDurably`. The reply is sent only once the bytes are on
		// the device, so a `suspend()` issued the moment it arrives cannot
		// take the pod away over a write the caller was told had landed.
		const bytesWritten = await writeFileDurably(real, buf)
		writeFrame(socket, { ok: true, ...guestIdentity(), bytesWritten })
	} catch (err) {
		writeFrame(socket, { ok: false, error: err.message })
	}
}

// --- guest-owned pseudo-terminal ------------------------------------------

const MAX_TERMINAL_COLS = 1000
const MAX_TERMINAL_ROWS = 1000
const TERMINAL_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'])

/** Quote one argv token for the shell command accepted by util-linux script. */
function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`
}

function terminalDimension(value, max, name) {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
		throw new Error(`${name} must be an integer in [1, ${max}]`)
	}
	return parsed
}

/** `/dev/pts/<n>`, the only slave shape util-linux `script` allocates. */
const PTY_SLAVE_PATH = /^\/dev\/pts\/\d+$/

/**
 * How long a terminal waits for `script` to fork its shell, and how often it
 * looks. Measured in #512: the slave is there on attempt 0 or 1 (1-2ms) and
 * within 101ms against a 100m CPU limit, so this budget is roughly ten times
 * what any tested guest needed — the number is repeated in the failure the
 * loop throws, which is where it is read from.
 */
const PTY_SLAVE_ATTEMPTS = 200
const PTY_SLAVE_POLL_MS = 5

/**
 * The device major every devpts slave carries.
 *
 * `devpts` is registered under a FIXED major rather than a dynamically
 * allocated one, so a controlling terminal whose device number decodes to
 * this is a pty slave and nothing else. The name is the kernel's, and it is
 * the same number on every kernel this agent can run on.
 */
const DEV_PTS_MAJOR = 136

/** Whatever a failed proc read should be reported BY. */
function probeErrorCode(error) {
	if (typeof error?.code === 'string' && error.code) return error.code
	return error instanceof Error ? error.message : String(error)
}

/**
 * The children of one pid, from `/proc/<pid>/task/<pid>/children`.
 *
 * The error is RETURNED beside the list rather than swallowed into it. A
 * caller that can live without the children reads `children` and moves on,
 * but {@link findPtySlave} is about to tell a human that no slave appeared,
 * and "which of these reads was refused, and with what" is the whole
 * difference between an error someone can act on and one that costs a
 * cluster and a debugger to find (#512).
 */
async function processChildren(pid) {
	try {
		const raw = await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')
		return {
			children: raw
				.trim()
				.split(/\s+/)
				.map(Number)
				.filter((value) => Number.isInteger(value) && value > 0),
			error: undefined,
		}
	} catch (error) {
		return { children: [], error: probeErrorCode(error) }
	}
}

/**
 * Decode a `/proc/<pid>/stat` `tty_nr` into the device number it encodes.
 *
 * The kernel's own `new_decode_dev`, inverted: a 32-bit `dev_t` keeps the
 * major in bits 8-19 and splits the minor across bits 0-7 and 20-31. This is
 * ABI, not a guess about one kernel's layout.
 */
function decodeDeviceNumber(deviceNumber) {
	return {
		major: (deviceNumber & 0xfff00) >> 8,
		minor: (deviceNumber & 0xff) | ((deviceNumber >> 12) & 0xfff00),
	}
}

/**
 * The `/dev/pts/<n>` one `tty_nr` names as its controlling terminal, or
 * `undefined` — for `0` (no controlling terminal at all) as much as for a
 * terminal on some other device.
 */
function controllingPtySlave(ttyNr) {
	if (!Number.isInteger(ttyNr) || ttyNr === 0) return undefined
	const { major, minor } = decodeDeviceNumber(ttyNr)
	return major === DEV_PTS_MAJOR ? `/dev/pts/${minor}` : undefined
}

/**
 * Both facts one candidate pid can be asked, and which of the two probes
 * could not answer at all.
 *
 * `fd/0` is asked FIRST and keeps answering first where it can: it names the
 * very file the shell reads and writes, and a terminal that resolved through
 * it before must keep resolving through it, byte for byte.
 */
async function probePtySlave(pid) {
	const probe = { slavePath: undefined, fdError: undefined, statError: undefined }
	try {
		const target = await fs.readlink(`/proc/${pid}/fd/0`)
		if (PTY_SLAVE_PATH.test(target)) return { ...probe, slavePath: target }
	} catch (error) {
		probe.fdError = probeErrorCode(error)
	}
	// The second probe, and the reason this function has two. `/proc/<pid>/fd`
	// is `dr-x------` owned by the target and answering a readlink from it is
	// `ptrace_may_access`, which refuses a reader whose credentials do not
	// match the target's — the one axis that differs between a guest that runs
	// this agent as root and one that drops it to an unprivileged uid. The read
	// is attempted anyway and simply fails there, so the walk depended on a
	// privilege it never declared. `/proc/<pid>/stat` is world-readable, and
	// its `tty_nr` is the kernel's own record of which terminal the process is
	// attached to — the fact `fd/0` was being used as a proxy for.
	try {
		const stat = parseProcessStat(pid, await fs.readFile(`/proc/${pid}/stat`, 'utf8'))
		if (stat?.ptySlave !== undefined) return { ...probe, slavePath: stat.ptySlave }
	} catch (error) {
		probe.statError = probeErrorCode(error)
	}
	return probe
}

/**
 * What the kernel says about one pid's `/proc` entry: released, there, or
 * neither — and the neither is a value, not a `false`.
 *
 * Only `ENOENT` says the kernel has RELEASED the entry. `EACCES` is this
 * process being refused the read, a different fact about a process that is
 * still there, and ending the walk on it would report an exit that never
 * happened. Every other error — `EMFILE`, `EIO`, a descriptor this process
 * could not spare — establishes NEITHER, and that is the answer this has to
 * be able to give: the one place it is read is a failure message a human
 * acts on, and the two-answer version of this turned a read that never
 * happened into "script alive", a fact the walk never established.
 */
async function procEntryState(pid) {
	try {
		await fs.stat(`/proc/${pid}`)
		return 'present'
	} catch (error) {
		if (error?.code === 'ENOENT') return 'gone'
		return probeErrorCode(error)
	}
}

/**
 * What {@link findPtySlave} throws, naming everything the walk learned.
 *
 * Every field is the LAST OBSERVATION of the thing it names, not the last
 * error it ever had: `fdError` and `statError` are assignments of what the
 * probe just answered, so a candidate that was refused followed by one that
 * read fine reports the read, and `probed` is what keeps a walk that never
 * reached a candidate from claiming its probes were readable.
 */
function ptySlaveFailure(
	attempts,
	startedAt,
	childrenError,
	fdError,
	statError,
	probed,
	scriptState,
) {
	const readable = (answer) => (probed > 0 ? answer : 'never read')
	const facts = [
		`${attempts} attempts, ${Date.now() - startedAt}ms`,
		`last children(): ${childrenError ?? 'readable, none'}`,
		`last fd/0: ${fdError ?? readable('readable, not a pty slave')}`,
		`last stat: ${statError ?? readable('readable, no controlling pty')}`,
		`script: ${scriptState === 'present' ? 'alive' : scriptState}`,
	]
	return new Error(`terminal PTY slave did not appear (${facts.join('; ')})`)
}

/**
 * Resolve the slave allocated by util-linux `script`, and the pid holding it.
 *
 * `script` owns the PTY master and the login shell is its child. The slave is
 * where the terminal's resize lands, so it has to be the REAL slave path: the
 * `stty -F` that sets the winsize is the TIOCSWINSZ ioctl, which is what
 * raises the SIGWINCH programs expect, and no pipe is represented as a
 * terminal. Two probes answer it — the shell's own fd 0, and its controlling
 * terminal taken from `/proc/<pid>/stat` — and a candidate is accepted when
 * EITHER does; see {@link probePtySlave} for why the second is not optional.
 *
 * Both probes report the same pid, and that pid is not incidental. The shell
 * is the leader of the kernel session `script` created for it — the unit a
 * teardown has to signal, and the one a process-group kill misses entirely
 * (a job backgrounded with `&` is reachable by nothing else).
 *
 * The second probe is strictly a FALLBACK, and the pid this returns is
 * therefore the one the fd 0 probe alone used to return whenever that probe
 * can answer at all, anywhere in the tree. The walk is breadth-first from
 * `script` and returns on the first candidate that answers either probe; if
 * that candidate answers fd 0, then every candidate before it answered
 * neither, so it is exactly where the fd 0-only walk would have stopped. A
 * candidate that answers only the second probe is reached exactly when the
 * first probe answered `no` for every candidate there is — which is the case
 * that used to end in `terminal PTY slave did not appear`.
 */
async function findPtySlave(scriptPid) {
	const startedAt = Date.now()
	let attempts = 0
	let probed = 0
	let childrenError
	let fdError
	let statError
	let scriptState = 'present'
	for (let attempt = 0; attempt < PTY_SLAVE_ATTEMPTS && scriptState !== 'gone'; attempt += 1) {
		attempts = attempt + 1
		const root = await processChildren(scriptPid)
		childrenError = root.error
		const queue = root.children
		while (queue.length > 0) {
			const pid = queue.shift()
			probed += 1
			const probe = await probePtySlave(pid)
			fdError = probe.fdError
			statError = probe.statError
			if (probe.slavePath !== undefined) return { slavePath: probe.slavePath, shellPid: pid }
			const kids = await processChildren(pid)
			childrenError = kids.error
			queue.push(...kids.children)
		}
		// `script` is gone: the shell was its child, the kernel has released
		// the tree the walk reads, and the remaining budget would be spent
		// walking a pid that does not exist. What stopping here costs is the
		// rest of that budget and nothing else — this terminal is over, and
		// `handleTerminal` answers it with the EXIT frame its `close` handler
		// writes rather than with this error. See the catch there: which of
		// the two the host gets is decided by whether that handler has run.
		scriptState = await procEntryState(scriptPid)
		if (scriptState === 'gone') break
		await delay(PTY_SLAVE_POLL_MS)
	}
	throw ptySlaveFailure(attempts, startedAt, childrenError, fdError, statError, probed, scriptState)
}

function resizePty(slavePath, cols, rows) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'/usr/bin/stty',
			['-F', slavePath, 'rows', String(rows), 'cols', String(cols)],
			{
				// Scrubbed too: resize is caller-triggered, and stty needs
				// none of the agent's own configuration to set a winsize.
				env: childEnvironment(),
				stdio: 'ignore',
			},
		)
		child.once('error', reject)
		child.once('close', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`stty resize failed with code ${String(code)}`))
		})
	})
}

// --- stream liveness ------------------------------------------------------

// Missed intervals that end a stream, and the floor a host's requested
// interval is clamped to. Three misses so one lost frame is not fatal; the
// floor because the interval arrives from the host and a pathological value
// would have this process doing nothing but writing heartbeats. Both are
// the host's numbers too — `protocol.ts` declares them for that side.
const STREAM_HEARTBEAT_MISS_LIMIT = 3
const MIN_STREAM_HEARTBEAT_MS = 100

// Idle time before the kernel sends its first keepalive probe on an accepted
// connection, in the routed listen mode. Matches the host dial's own delay.
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15_000

/**
 * What this agent will actually use for a requested interval, or undefined
 * if the host asked for none.
 *
 * The clamped value is what goes back in `ready`, so the host arms the same
 * number this side did rather than the one it asked for.
 */
function normalizeHeartbeatMs(requested) {
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
		return undefined
	}
	return Math.max(MIN_STREAM_HEARTBEAT_MS, Math.floor(requested))
}

/**
 * Arm the negotiated heartbeat for one stream: send a `heartbeat` frame
 * every `intervalMs`, and call `onDead` when the host has sent nothing —
 * not a heartbeat, not a frame, not a byte — for
 * {@link STREAM_HEARTBEAT_MISS_LIMIT} of them.
 *
 * Proof of life is counted in BYTES, off the socket itself, rather than in
 * complete frames: a single large `data` frame can take longer to arrive
 * than the window, and the host was plainly still there while it arrived.
 * That is also why nothing here has to be threaded through the per-op frame
 * handlers — the listener is attached to the one socket this stream owns,
 * and removed again by `stop`.
 *
 * Only ever called with an interval the host asked for, which is the whole
 * of the compatibility story: a host that predates this never sets the
 * field, never gets a frame type it would treat as a protocol error, and
 * sees exactly the stream it always saw.
 *
 * The watchdog polls at a quarter of the interval so a dead host is noticed
 * within three intervals plus at most one tick. Both timers are unref'd, so
 * an open stream never by itself keeps this process alive.
 */
function armStreamHeartbeat(socket, intervalMs, onDead) {
	let stopped = false
	let watching = true
	let lastSeen = Date.now()
	// Attached while the socket is flowing — every caller arms at `ready`,
	// before any backpressure pause — so this never resumes a paused socket.
	const seen = () => {
		lastSeen = Date.now()
	}
	socket.on('data', seen)
	const send = setInterval(() => {
		if (stopped) return
		if (socket.destroyed || socket.writableEnded) return
		writeFrame(socket, { type: 'heartbeat' })
	}, intervalMs)
	const watch = setInterval(
		() => {
			if (stopped || !watching) return
			if (Date.now() - lastSeen < intervalMs * STREAM_HEARTBEAT_MISS_LIMIT) return
			stop()
			onDead()
		},
		Math.max(10, Math.floor(intervalMs / 4)),
	)
	if (typeof send.unref === 'function') send.unref()
	if (typeof watch.unref === 'function') watch.unref()
	function stop() {
		stopped = true
		socket.off('data', seen)
		clearInterval(send)
		clearInterval(watch)
	}
	return {
		/**
		 * This side paused reading for backpressure, so silence is its own
		 * doing: the host's frames are sitting in the kernel, unread.
		 */
		suspend() {
			watching = false
		},
		resume() {
			if (stopped) return
			watching = true
			lastSeen = Date.now()
		},
		stop,
	}
}

// --- guest-owned sessions -------------------------------------------------

/**
 * The programs this guest is running that are NOT bound to the connection
 * that started them, keyed by the `sessionId` their caller chose.
 *
 * A workspace exists to outlive the host process — it carries no lease for
 * exactly that reason — and until this registry the processes inside it did
 * not. A terminal belonged to one socket: the host went away, the socket
 * closed, and the agent killed what it could reach. This is the other half
 * of that promise, and it is deliberately small: a map, one
 * {@link OutputLog} per entry, and at most one attachment.
 *
 *  - **The log is W4's, not a second one.** `attach-execution` and every op
 *    here read the same class, so there is one overflow accounting, one
 *    monotonic offset space and one way to ask what was lost. A reader never
 *    has to know which registry it is talking to.
 *  - **Output keeps flowing with nobody attached.** The child's pipes are
 *    read into the log whether or not anyone is reading the log, so a
 *    detached program never blocks on a full PTY. What a disconnected host
 *    misses is eviction, and eviction is reported.
 *  - **At most one attachment.** A second attach ends the first with a named
 *    `detached` frame, so two host processes cannot interleave keystrokes
 *    into one shell.
 *  - **In memory only.** A resumed pod runs a fresh agent, so it comes back
 *    with no sessions. That is stated in the docs rather than worked around:
 *    a registry on the disk would promise a process that is not there.
 */
const sessions = new Map()

/** The agent's own kernel session, so nothing here can ever signal it. */
let ownUnixSessionId

/**
 * That session, read once and remembered.
 *
 * A session id never changes for the life of a process unless the process
 * calls `setsid` itself, and this one does not, so one read is the whole of
 * it. `0` when `/proc` could not answer — a value no session has, which
 * leaves the pid-level exclusions (PID 1, and this process) standing on
 * their own rather than excluding something arbitrary.
 */
async function ownSessionId() {
	if (ownUnixSessionId === undefined) {
		ownUnixSessionId = (await readUnixSessionId(process.pid)) ?? 0
	}
	return ownUnixSessionId
}

function validateSessionId(sessionId) {
	return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)
}

function pruneSessions(now = Date.now()) {
	for (const [sessionId, record] of sessions) {
		if (record.state === 'exited' && record.expiresAt <= now) sessions.delete(sessionId)
	}
}

/**
 * Make a slot available by giving up the OLDEST-expiring exited sessions,
 * and answer whether there is one now.
 *
 * A running session is never evicted: its program has nowhere else to go and
 * its output has nowhere else to be kept, so a guest already holding
 * `MAX_SESSIONS` live programs refuses the next one before it starts a
 * process rather than quietly dropping one it is still serving.
 */
function makeRoomForSession() {
	if (sessions.size < MAX_SESSIONS) return true
	const finished = [...sessions.entries()]
		.filter(([, record]) => record.state === 'exited')
		.sort(([, left], [, right]) => left.expiresAt - right.expiresAt)
	for (const [sessionId] of finished) {
		sessions.delete(sessionId)
		if (sessions.size < MAX_SESSIONS) return true
	}
	return false
}

/**
 * One process's `/proc/<pid>/stat`, as much of it as anything here needs:
 * its name, its run state, its kernel session id and its controlling
 * terminal.
 *
 * Parsed from the last `)` rather than by splitting on spaces: field 2 is
 * the executable's own name, in parentheses, and it may contain spaces and
 * parentheses of its own. `undefined` means the process is gone — which is
 * the answer a caller wants, not an error to handle.
 */
function parseProcessStat(pid, raw) {
	const open = raw.indexOf('(')
	const close = raw.lastIndexOf(')')
	if (open < 0 || close < open) return undefined
	// state, ppid, pgrp, session, tty_nr — the five fields after the name.
	const fields = raw.slice(close + 2).split(' ')
	const sessionId = Number(fields[3])
	const ttyNr = Number(fields[4])
	return {
		pid,
		// The kernel's short name for the executable, and deliberately not
		// `/proc/<pid>/cmdline`: a quiesce reports what it stopped to the
		// HOST, and a command line carries the workload's own arguments.
		command: raw.slice(open + 1, close),
		state: fields[0] ?? '',
		sessionId: Number.isInteger(sessionId) && sessionId > 0 ? sessionId : undefined,
		// Field 7, the controlling terminal's device number (0 for none).
		// Read here rather than through `/proc/<pid>/fd/0` because it is a
		// READ of a world-readable file rather than a readlink answered by
		// `ptrace_may_access` — see {@link probePtySlave}.
		ttyNr: Number.isInteger(ttyNr) ? ttyNr : 0,
		ptySlave: controllingPtySlave(ttyNr),
	}
}

async function readProcessStat(pid) {
	try {
		return parseProcessStat(pid, await fs.readFile(`/proc/${pid}/stat`, 'utf8'))
	} catch {
		return undefined
	}
}

/**
 * The kernel session id (`/proc/<pid>/stat` field 6) of one process.
 *
 * Parsed from the last `)` rather than by splitting on spaces: field 2 is
 * the executable's own name, in parentheses, and it may contain spaces and
 * parentheses of its own. See {@link readProcessStat}, which is the one
 * place in this file that parses that line.
 */
async function readUnixSessionId(pid) {
	return (await readProcessStat(pid))?.sessionId
}

/**
 * Every live process in one of `wanted`, which is the ONLY way to reach a
 * job a shell left running.
 *
 * The comment this replaces claimed a process-group kill "reaches the shell
 * and every descendant". It does not, and the gap is not subtle: util-linux
 * `script` starts the shell in a NEW session, so `kill(-script.pid)` reaches
 * `script` alone. `script`, the shell and the FOREGROUND job then die of the
 * PTY hanging up — but a job backgrounded with `&` is never signalled, keeps
 * running with no terminal, holds its port, and is reachable by no op until
 * the pod stops. A process group is the wrong unit here; the kernel session
 * the shell created is the right one, and it is stable: a session id never
 * changes for the life of a process unless that process calls `setsid`
 * itself, so a job reparented to PID 1 is still found by this scan.
 *
 * The agent's own session is excluded by construction, and so are PID 1 and
 * this process: a bug in the caller must not be able to signal the agent, the
 * init the image runs, or the test runner that loaded this module.
 */
async function processesInSessions(wanted) {
	const own = await ownSessionId()
	const targets = new Set(
		[...wanted].filter(
			(sessionId) => Number.isInteger(sessionId) && sessionId > 1 && sessionId !== own,
		),
	)
	if (targets.size === 0) return []
	let entries
	try {
		entries = await fs.readdir('/proc')
	} catch {
		return []
	}
	const pids = []
	for (const entry of entries) {
		const pid = Number(entry)
		if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue
		const sessionId = await readUnixSessionId(pid)
		if (sessionId !== undefined && targets.has(sessionId)) pids.push(pid)
	}
	return pids
}

/**
 * Signal everything one session owns, and answer with the pids that were
 * signalled.
 *
 * Both units, because neither alone is the session: the process group is
 * what reaches the leader the agent spawned (`script`, or a detached
 * program) and is the only thing available when a PTY never appeared, while
 * the `/proc` scan is what reaches the shell and its jobs. They overlap
 * harmlessly and neither is optional.
 *
 * The scan runs FIRST, and that order is deliberate. Killing `script` hangs
 * the PTY up, and the hangup takes the shell with it — so a scan afterwards
 * races the very processes it is looking for, and would report having
 * signalled nothing on exactly the runs where the kernel happened to win.
 * What the hangup does NOT reliably reach is the job: whether a backgrounded
 * process dies with its shell depends on which shell the image ships and
 * what it does with SIGHUP, and a teardown may not depend on that.
 */
async function signalSessionProcesses(record, signal) {
	const signalled = new Set()
	for (const pid of await processesInSessions(record.unixSessionIds ?? [])) {
		try {
			process.kill(pid, signal)
			signalled.add(pid)
		} catch {}
	}
	if (record.processGroupId && process.platform !== 'win32') {
		try {
			process.kill(-record.processGroupId, signal)
			// One call, many processes, and the kernel never says how many it
			// reached — so the count claims the leader alone, which is the one
			// pid this call is known to have signalled. The scan above has
			// usually found it already; the set is what stops it being counted
			// twice, and what stops a session whose PTY never appeared
			// reporting that it signalled nothing.
			signalled.add(record.processGroupId)
		} catch {}
	}
	return [...signalled]
}

/** One session's row in `list-sessions`, and the reply `kill-session` ends with. */
function sessionSummary(record) {
	return {
		sessionId: record.sessionId,
		kind: record.kind,
		command: record.command,
		args: record.args,
		startedAt: record.startedAt,
		lastInputAt: record.lastInputAt,
		lastOutputAt: record.lastOutputAt,
		// The log's own numbers, so a caller can ask for exactly what it has
		// not read and be told exactly what it missed.
		nextOffset: record.log.endOffset,
		droppedBytes: record.log.droppedBytes,
		state: record.state,
		attached: record.attachment !== undefined,
		...(record.state === 'exited'
			? {
					exitCode: record.exitCode,
					...(record.signal !== undefined ? { signal: record.signal } : {}),
				}
			: {}),
	}
}

/**
 * The one place a terminal stream's opening frame is built.
 *
 * Every consumer sends the same `ready` — the connection that starts a
 * connection-bound terminal, the one that starts a persistent session, a
 * later attach, and a one-shot read — so a field added to it later is added
 * ONCE. `record` is undefined for a connection-bound terminal, which has no
 * registry entry to describe: that frame is then exactly the bare `ready`
 * this op has always sent. `heartbeatMs` is W5's echo and rides in `extra`,
 * present only when the host asked for one.
 */
function readyFrame(record, extra) {
	return {
		type: 'ready',
		// The stream's half of `guest-boot-id`: a terminal or an attach is
		// authenticated exactly as a request is, and its opening frame is the
		// only reply it ever sends that a host can read an identity off.
		...guestIdentity(),
		...(record !== undefined
			? {
					sessionId: record.sessionId,
					kind: record.kind,
					state: record.state,
					...(record.state === 'exited'
						? {
								exitCode: record.exitCode,
								...(record.signal !== undefined ? { signal: record.signal } : {}),
							}
						: {}),
				}
			: {}),
		...extra,
	}
}

/**
 * Append one chunk to a session's log and hand it to the attachment, if
 * there is one.
 *
 * The append happens first and the frame carries the span it occupies, for
 * the reason `recordOutput` states: a host cannot recover a byte offset from
 * decoded text, because a chunk that ends mid-character decodes WIDER than
 * the bytes it replaced. Nothing here pauses the child. An attachment that
 * has stopped draining is dropped instead — everything it misses is in the
 * log, and its next attach replays from the offset it last saw.
 */
function recordSessionOutput(record, stream, data) {
	const offset = record.log.append(stream, data)
	record.lastOutputAt = Date.now()
	const attachment = record.attachment
	if (attachment === undefined) return
	try {
		writeFrame(attachment.socket, {
			type: 'data',
			stream,
			data: data.toString('utf8'),
			offset,
			nextOffset: offset + data.length,
		})
		if (attachment.socket.writableLength > SESSION_LOG_BYTES) {
			endAttachment(record, 'slow_reader', true)
		}
	} catch {}
}

/**
 * End the current attachment WITHOUT touching the program.
 *
 * `reason` is on the wire because the three are different facts to the host:
 * `superseded` means another process took the session, `slow_reader` means
 * this one stopped draining, and neither is the program exiting.
 */
function endAttachment(record, reason, destroy = false) {
	const attachment = record.attachment
	if (attachment === undefined) return
	record.attachment = undefined
	attachment.heartbeat?.stop()
	try {
		writeFrame(attachment.socket, { type: 'detached', reason })
		writeTerminator(attachment.socket)
		attachment.socket.end()
	} catch {}
	if (destroy) attachment.socket.destroy()
}

/**
 * Record a session's program as gone and tell whoever is attached.
 *
 * The record OUTLIVES the program by `SESSION_TERMINAL_TTL_MS`, because the
 * whole point of the registry is that the host which started it may be gone
 * and may come back: it comes back to an exit code and the tail of the
 * output, not to "no such session".
 */
function finishSession(record, exitCode, signal) {
	if (record.state === 'exited') return
	record.state = 'exited'
	record.exitCode = typeof exitCode === 'number' ? exitCode : -1
	if (signal && osConstants.signals[signal]) record.signal = osConstants.signals[signal]
	record.exitedAt = Date.now()
	record.expiresAt = record.exitedAt + SESSION_TERMINAL_TTL_MS
	record.child = undefined
	record.resolveDone?.()
	const attachment = record.attachment
	if (attachment === undefined) return
	record.attachment = undefined
	attachment.heartbeat?.stop()
	try {
		writeFrame(attachment.socket, {
			type: 'exit',
			exitCode: record.exitCode,
			...(record.signal !== undefined ? { signal: record.signal } : {}),
			nextOffset: record.log.endOffset,
		})
		writeTerminator(attachment.socket)
		attachment.socket.end()
	} catch {}
}

/** A fresh registry entry. `child` and the session ids are filled in as they become known. */
function createSessionRecord(sessionId, kind, command, args) {
	const record = {
		sessionId,
		kind,
		command,
		args,
		startedAt: Date.now(),
		lastInputAt: undefined,
		lastOutputAt: undefined,
		log: new OutputLog(SESSION_LOG_BYTES),
		state: 'running',
		exitCode: undefined,
		signal: undefined,
		child: undefined,
		processGroupId: undefined,
		slavePath: undefined,
		/** Every kernel session this entry owns; see `processesInSessions`. */
		unixSessionIds: [],
		attachment: undefined,
	}
	record.done = new Promise((resolve) => {
		record.resolveDone = resolve
	})
	sessions.set(sessionId, record)
	return record
}

/**
 * Apply one host to guest terminal event to whatever process is behind it.
 *
 * The accessors are read lazily on purpose: the SAME routine serves the
 * connection that started a terminal — where the child does not exist yet
 * when the handler is built — and every later attachment to the same
 * session, where it already does. One implementation, so input, resize and
 * kill cannot come to mean different things depending on which connection a
 * keystroke arrived on.
 */
function applyTerminalEvent(event, context) {
	if (!event || typeof event !== 'object') return
	if (event.type === 'heartbeat') return
	if (event.type === 'input') {
		const child = context.child()
		if (typeof event.data === 'string' && child?.stdin?.writable) {
			context.onInput?.()
			if (!child.stdin.write(event.data)) {
				context.pause()
				// Nothing is read while this is paused, so the watchdog must
				// not read that as the host having gone away.
				context.heartbeat()?.suspend()
				child.stdin.once('drain', () => {
					context.resume()
					context.heartbeat()?.resume()
				})
			}
		}
		return
	}
	if (event.type === 'resize') {
		try {
			const cols = terminalDimension(event.cols, MAX_TERMINAL_COLS, 'cols')
			const rows = terminalDimension(event.rows, MAX_TERMINAL_ROWS, 'rows')
			const slavePath = context.slavePath()
			if (slavePath) void resizePty(slavePath, cols, rows).catch(() => {})
		} catch {}
		return
	}
	if (event.type === 'kill') {
		// The allow-list is applied HERE rather than in either context, so the
		// frame means the same signal on the connection that opened the
		// terminal and on every later attachment to it. Applied in one of the
		// two it would be no allow-list at all: an attached caller could stop
		// a session with SIGSTOP that the opening caller could only terminate.
		const requested = typeof event.signal === 'string' ? event.signal : 'SIGTERM'
		context.kill(TERMINAL_SIGNALS.has(requested) ? requested : 'SIGTERM')
	}
}

/**
 * Serve one connection reading a session: replay from `fromOffset`, then
 * either follow the program live or end.
 *
 * Synchronous from the replay to joining the live set, exactly as
 * `handleAttachExecution` is and for the same reason: no chunk can be both
 * replayed and broadcast, and none can fall between the two.
 *
 * Returns the stream handle for a following attachment, and nothing for a
 * refusal or a one-shot read — both of which have already ended the socket.
 */
function attachToSession(socket, record, options) {
	const refuse = (error, extra) => {
		writeFrame(socket, { type: 'error', error, ...extra })
		writeTerminator(socket)
		socket.end()
	}
	const fromOffset = options.fromOffset === undefined ? 0 : Number(options.fromOffset)
	const replay = record.log.read(fromOffset)
	if (replay === undefined) {
		refuse('invalid_offset', { nextOffset: record.log.endOffset })
		return undefined
	}
	const follow = options.follow !== false
	writeFrame(
		socket,
		readyFrame(record, {
			fromOffset: replay.fromOffset,
			// The bytes between what the reader asked for and what survives.
			// A gap is REPORTED; output is never quietly skipped.
			droppedBytes: replay.droppedBytes,
			nextOffset: replay.nextOffset,
			...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
		}),
	)
	for (const chunk of replay.chunks) {
		writeFrame(socket, {
			type: 'data',
			stream: chunk.stream,
			data: chunk.data.toString('utf8'),
			offset: chunk.offset,
			nextOffset: chunk.offset + chunk.data.length,
		})
	}
	if (!follow) {
		// A READ is not an attachment. It has taken nothing from the live
		// reader and signalled nothing, which is what `readSession` promises
		// — a host polling a shell's tail must not end the terminal it is
		// polling. The supersede below is reached only by a real attach.
		writeTerminator(socket)
		socket.end()
		return undefined
	}
	if (record.state === 'exited') {
		writeFrame(socket, {
			type: 'exit',
			exitCode: record.exitCode ?? -1,
			...(record.signal !== undefined ? { signal: record.signal } : {}),
			nextOffset: record.log.endOffset,
		})
		writeTerminator(socket)
		socket.end()
		return undefined
	}
	const attachment = { socket }
	// One attachment per session: the previous reader is told, by name, that
	// it has been taken over, so two host processes never interleave
	// keystrokes into one shell.
	if (record.attachment !== undefined) endAttachment(record, 'superseded')
	record.attachment = attachment
	if (options.heartbeatMs !== undefined) {
		// Destroying the socket runs `onClose` below, which is the same
		// cleanup a host that simply went away already triggers — and on a
		// persistent session that cleanup signals nothing.
		attachment.heartbeat = armStreamHeartbeat(socket, options.heartbeatMs, () => socket.destroy())
	}
	if (record.kind === 'terminal' && options.cols !== undefined && options.rows !== undefined) {
		applyTerminalEvent(
			{ type: 'resize', cols: options.cols, rows: options.rows },
			sessionEventContext(socket, record, attachment),
		)
	}
	return {
		onFrame(payload) {
			let event
			try {
				event = JSON.parse(payload)
			} catch {
				return
			}
			applyTerminalEvent(event, sessionEventContext(socket, record, attachment))
		},
		onClose() {
			attachment.heartbeat?.stop()
			// A closed connection DETACHES. No signal of any kind: the
			// session ends when its program exits, on an explicit kill, or
			// when the pod stops, and that is the whole feature.
			if (record.attachment === attachment) record.attachment = undefined
		},
	}
}

/** The lazily-read accessors {@link applyTerminalEvent} needs for a session. */
function sessionEventContext(socket, record, attachment) {
	return {
		child: () => record.child,
		slavePath: () => record.slavePath,
		heartbeat: () => attachment?.heartbeat,
		pause: () => socket.pause(),
		resume: () => socket.resume(),
		onInput: () => {
			record.lastInputAt = Date.now()
		},
		// The signal has already been through the allow-list:
		// `applyTerminalEvent` is this context's only caller, and the rule
		// lives there precisely so an attachment cannot send one the
		// connection that opened the terminal could not.
		kill: (signal) => {
			void signalSessionProcesses(record, signal).catch(() => {})
		},
	}
}

async function handleStartDetached(socket, body) {
	pruneSessions()
	if (!validateSessionId(body?.sessionId)) {
		writeFrame(socket, { ok: false, error: 'invalid_session_id' })
		return
	}
	if (sessions.has(body.sessionId)) {
		// Not an attach and not a second start: an id that already names a
		// session is a caller confusion, and starting a second program under
		// one name would make `kill-session` ambiguous forever after.
		writeFrame(socket, { ok: false, error: 'session_exists' })
		return
	}
	if (typeof body?.command !== 'string' || body.command.length === 0) {
		writeFrame(socket, { ok: false, error: 'missing_command' })
		return
	}
	if (!makeRoomForSession()) {
		writeFrame(socket, { ok: false, error: 'session_capacity' })
		return
	}
	const cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
	await fs.mkdir(cwd, { recursive: true })
	const args = Array.isArray(body.args) ? body.args.map(String) : []
	const record = createSessionRecord(body.sessionId, 'detached', body.command, args)
	let child
	try {
		child = spawn(body.command, args, {
			cwd,
			// Scrubbed exactly like an `execute` child and a `terminal` one:
			// the agent's own configuration, its bind token included, never
			// enters the workload's environment.
			env: childEnvironment(body.env),
			// Its own kernel session, which is what makes it survivable AND
			// killable: nothing it starts is in the agent's session, and
			// everything it starts is in its own until something calls
			// `setsid` for itself.
			detached: true,
			// No PTY and no stdin. A detached program has no terminal to read
			// from, and leaving stdin open would hand it a pipe nobody writes
			// to — which reads as a terminal that never answers.
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	} catch (error) {
		sessions.delete(record.sessionId)
		writeFrame(socket, {
			ok: false,
			error: 'spawn_failed',
			message: String(error?.message ?? error),
		})
		return
	}
	record.child = child
	record.processGroupId = child.pid
	record.unixSessionIds = [child.pid]
	child.stdout.on('data', (chunk) => recordSessionOutput(record, 'stdout', chunk))
	child.stderr.on('data', (chunk) => recordSessionOutput(record, 'stderr', chunk))
	let spawnError
	child.once('error', (error) => {
		spawnError = error
		finishSession(record, -1, undefined)
	})
	child.once('close', (exitCode, signal) => finishSession(record, exitCode, signal))
	const started = await new Promise((resolve) => {
		child.once('spawn', () => resolve(true))
		child.once('error', () => resolve(false))
	})
	if (!started) {
		sessions.delete(record.sessionId)
		writeFrame(socket, {
			ok: false,
			error: 'spawn_failed',
			message: String(spawnError?.message ?? 'the program could not be started'),
		})
		return
	}
	writeFrame(socket, { ok: true, ...sessionSummary(record), pid: child.pid })
}

function handleListSessions(socket) {
	pruneSessions()
	writeFrame(socket, { ok: true, sessions: [...sessions.values()].map(sessionSummary) })
}

async function handleKillSession(socket, body) {
	pruneSessions()
	if (!validateSessionId(body?.sessionId)) {
		writeFrame(socket, { ok: false, error: 'invalid_session_id' })
		return
	}
	const record = sessions.get(body.sessionId)
	if (record === undefined) {
		writeFrame(socket, { ok: false, error: 'unknown_session' })
		return
	}
	// Idempotent: a session that has already exited answers with what it
	// exited with, so a retried kill is not an error.
	if (record.state === 'exited') {
		writeFrame(socket, { ok: true, ...sessionSummary(record) })
		return
	}
	const requested = body?.signal
	const signal =
		typeof requested === 'string' && TERMINAL_SIGNALS.has(requested) ? requested : 'SIGKILL'
	const signalled = await signalSessionProcesses(record, signal)
	// Bounded, and the state is reported either way: a program that ignores
	// SIGTERM and outlives the wait is answered as still running rather than
	// answered as dead.
	await Promise.race([record.done, delay(SESSION_KILL_CONFIRM_TIMEOUT_MS)])
	writeFrame(socket, { ok: true, ...sessionSummary(record), signalled: signalled.length })
}

function handleAttachSession(socket, body) {
	const refuse = (error, extra) => {
		writeFrame(socket, { type: 'error', error, ...extra })
		writeTerminator(socket)
		socket.end()
	}
	if (!validateSessionId(body?.sessionId)) {
		refuse('invalid_session_id')
		return undefined
	}
	pruneSessions()
	const record = sessions.get(body.sessionId)
	if (record === undefined) {
		// Past retention, or in a pod this session never ran in. Both are the
		// same answer from here, and the docs say so.
		refuse('unknown_session')
		return undefined
	}
	return attachToSession(socket, record, {
		fromOffset: body.fromOffset,
		follow: body.follow,
		...(body.cols !== undefined ? { cols: body.cols } : {}),
		...(body.rows !== undefined ? { rows: body.rows } : {}),
		...(normalizeHeartbeatMs(body?.heartbeatMs) !== undefined
			? { heartbeatMs: normalizeHeartbeatMs(body.heartbeatMs) }
			: {}),
	})
}

// --- quiesce: stopping every process this guest is running ----------------

/**
 * Stopping everything, so a host can take a capture it can trust.
 *
 * `suspend()` on a workspace used to reach exactly two kinds of process:
 * the terminals THAT handle returned, and an execution somebody explicitly
 * cancelled. Everything else — a terminal opened through another host
 * process's handle, an `exec` already running, and above all a program that
 * moved into a session of its own with `setsid` and was then reparented
 * away from the agent — kept running and kept writing until the pod
 * stopped. And once the pod has stopped there is no agent left to read the
 * disk through, so a host that wanted the disk QUIET WHILE IT COULD STILL
 * READ IT had nowhere to stand.
 *
 * This op is that place to stand, and the four things it must get right:
 *
 *  - **Mark before signalling.** A running execution's close handler waits
 *    for its whole process group only when the execution carries a
 *    `terminationCause`; without one, a group leader that dies before the
 *    rest of its group makes the handler throw and `retireAgent` FENCE the
 *    agent — after which every op but `healthz` and `cancel-execution` is
 *    refused and the capture this was performed for can no longer run. So
 *    every running execution is marked first, before a single signal goes
 *    out. `terminateAndConfirm` cannot be reused for this: it throws in
 *    exactly the case a quiesce creates on purpose.
 *  - **Scan, do not walk the child list.** An orphan is reparented to PID 1
 *    and is no longer this process's child, so the agent's own bookkeeping
 *    cannot see it. `/proc` can.
 *  - **Rounds, not one pass.** A process forked while a pass is in flight
 *    would otherwise survive the pass that was supposed to include it.
 *  - **Report failure rather than resolving.** A process still present
 *    after `SIGKILL` fails the call and names its pid, the way
 *    `terminateAndConfirm` already refuses. A quiesce that resolved
 *    optimistically would be worse than no quiesce at all: the host would
 *    take its capture believing the disk was still.
 */
let quiescing = false

/**
 * Ops refused while a quiesce runs, by the shape of their refusal.
 *
 * Everything that starts work, resumes work, or would change what the loop
 * is counting. `healthz`, `cancel-execution`, `list-sessions`, `read-file`,
 * `read-file-stream`, `write-file` and `tcp-connect` are deliberately NOT
 * here: the whole point of quiescing a guest rather than stopping its pod
 * is that the host can still read and write the disk afterwards, and a
 * refusal that covered those would take the capture away again.
 */
const QUIESCE_REFUSED_OPS = new Set([
	'reserve-execution',
	'start-detached',
	'kill-session',
	'quiesce',
	// `flush` spawns a `sync` child, and the very next round of a quiesce
	// in flight would count it, signal it and report a flush that failed
	// for no reason but the quiesce itself. A host flushes AFTER the guest
	// is quiet anyway — that is the order `suspend()` uses.
	'flush',
])
const QUIESCE_REFUSED_STREAM_OPS = new Set([
	'execute',
	'terminal',
	'attach-execution',
	'attach-session',
])

/**
 * How wide this agent is allowed to look for processes to stop.
 *
 *  - `pid-namespace` — every process in the PID namespace but PID 1 and
 *    this one. The shipped image's shape, and the only scope that reaches a
 *    program which `setsid` moved out of every session the agent knows
 *    about.
 *  - `owned-sessions` — only the kernel sessions the execution and session
 *    registries own. Narrower, and it can miss exactly the process this op
 *    exists for.
 *
 * The scope is DERIVED, from the one fact that decides whether a general
 * scan is safe: whether this agent is the init of its own PID namespace or
 * was started by it. `k8s/entrypoint.sh` execs `tini` as PID 1 and `tini`
 * starts this process, so a shipped pod is `pid-namespace` and every pid in
 * `/proc` there belongs to this container and to nothing else. An agent
 * loaded into some other process — a test runner, an embedded host — is
 * not that, and a general scan there would signal processes that have
 * nothing to do with any sandbox. The reply carries the scope it used, so a
 * narrowed one is reported rather than silently weaker.
 *
 * `NAMZU_AGENT_QUIESCE_SCOPE=owned-sessions` narrows it further and is the
 * only value accepted: there is deliberately no way to force the general
 * scan on, because the environment where that would be wrong is exactly the
 * environment where somebody would be tempted to set it.
 */
function quiesceScope() {
	if (process.env.NAMZU_AGENT_QUIESCE_SCOPE === 'owned-sessions') return 'owned-sessions'
	return process.pid === 1 || process.ppid === 1 ? 'pid-namespace' : 'owned-sessions'
}

/**
 * Every kernel session the two registries own, which is what
 * `owned-sessions` scope is allowed to reach.
 *
 * Read off the registries rather than kept as a third list of its own: an
 * `execute` child and a `start-detached` child are both spawned `detached`,
 * so each is a session leader and its process-group id is its session id,
 * and a terminal records the shell's session as `script` creates it.
 */
function ownedKernelSessions() {
	const owned = new Set()
	for (const execution of executions.values()) {
		if (execution.processGroupId) owned.add(execution.processGroupId)
	}
	for (const record of sessions.values()) {
		for (const sessionId of record.unixSessionIds ?? []) owned.add(sessionId)
		if (record.processGroupId) owned.add(record.processGroupId)
	}
	return owned
}

/**
 * The processes this quiesce may signal, as `/proc` has them right now.
 *
 * PID 1 is skipped because it is the container's init and stopping it would
 * stop the pod — the thing this op exists to avoid. This process is skipped
 * for the obvious reason, and so is every other process in this process's
 * own kernel session: in a pod that is PID 1 and the agent, and nothing
 * else ever joins it, because every child the agent spawns is spawned
 * `detached` into a session of its own. A ZOMBIE counts as stopped — it has
 * closed its files and released its memory and is waiting to be reaped,
 * which is all a capture needs — and signalling one would achieve nothing
 * anyway. The uid check is the last fence: every workload process runs
 * under the uid `entrypoint.sh` drops to, so a process that does not is not
 * one of them.
 */
async function quiesceCandidates(scope) {
	const own = await ownSessionId()
	const ownUid = process.getuid?.()
	const owned = scope === 'owned-sessions' ? ownedKernelSessions() : undefined
	let entries
	try {
		entries = await fs.readdir('/proc')
	} catch (error) {
		throw new Error(`quiesce could not read /proc: ${error?.message ?? String(error)}`)
	}
	const candidates = []
	for (const entry of entries) {
		const pid = Number(entry)
		if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue
		const stat = await readProcessStat(pid)
		if (stat === undefined || stat.state === 'Z') continue
		if (stat.sessionId !== undefined && stat.sessionId === own) continue
		if (owned !== undefined && (stat.sessionId === undefined || !owned.has(stat.sessionId)))
			continue
		if (ownUid !== undefined) {
			// `/proc/<pid>` is owned by the process's REAL uid, so one stat
			// answers this without opening a second file and without reading
			// anything the process itself put there.
			let procUid
			try {
				procUid = (await fs.stat(`/proc/${pid}`)).uid
			} catch {
				continue
			}
			if (procUid !== ownUid) continue
		}
		candidates.push({ pid, command: stat.command })
	}
	return candidates
}

/** Send one signal to one pid. Answers whether the kernel took it. */
function signalPid(pid, signal) {
	try {
		process.kill(pid, signal)
		return true
	} catch {
		return false
	}
}

/** Whether a pid is a process that still holds anything. A zombie does not. */
async function processIsLive(pid) {
	const stat = await readProcessStat(pid)
	return stat !== undefined && stat.state !== 'Z'
}

/** The pids of `pids` still live at `deadlineAt`, polled until then. */
async function waitForPidsGone(pids, deadlineAt) {
	let remainingPids = [...pids]
	for (;;) {
		const left = []
		for (const pid of remainingPids) {
			if (await processIsLive(pid)) left.push(pid)
		}
		if (left.length === 0) return []
		const remaining = deadlineAt - Date.now()
		if (remaining <= 0) return left
		await delay(Math.min(25, remaining))
		remainingPids = left
	}
}

/**
 * Let the registries catch up with what the signals did.
 *
 * The processes are already gone when this runs; what is not yet true is
 * the BOOKKEEPING — a killed child's `close` event is what settles an
 * execution's result and what moves a session to `exited`. Without this
 * wait, `list-sessions` could answer a host that had just quiesced the
 * guest with a session still marked `running`, which would be a lie about a
 * process that no longer exists. Bounded, and never fatal: the promise this
 * op makes is about processes, and that one has already been kept.
 */
async function settleRegistries(deadlineAt) {
	const pending = []
	for (const execution of executions.values()) {
		if (execution.done) pending.push(execution.done)
	}
	for (const record of sessions.values()) {
		if (record.state !== 'exited' && record.done) pending.push(record.done)
	}
	if (pending.length === 0) return
	await Promise.race([
		Promise.allSettled(pending),
		delay(Math.max(0, Math.min(QUIESCE_SETTLE_MS, deadlineAt - Date.now()))),
	])
}

/**
 * Stop everything, in rounds, under one deadline.
 *
 * Marking comes first and covers every running execution at once, before a
 * single signal goes out — see `quiescing` above for what a naive ordering
 * costs. After that each round scans, signals what it found with SIGTERM,
 * gives it `graceMs`, SIGKILLs whatever is left, and scans again; the loop
 * ends on a pass that finds nothing, which is also what makes a second
 * quiesce straight after the first answer with an empty list.
 */
async function runQuiesce(graceMs, budget = {}) {
	const scope = quiesceScope()
	// The op's own deadline by default. A caller that is itself under a
	// bound — the SIGTERM handler, which has to exit inside the pod's
	// `terminationGracePeriodSeconds` whatever happens — passes its own
	// remaining budget instead, and the name of the knob that set it, so a
	// refusal names the bound that actually applied rather than one that
	// did not.
	const deadlineMs = budget.deadlineMs ?? QUIESCE_DEADLINE_MS
	const deadlineSource = budget.deadlineSource ?? 'NAMZU_AGENT_QUIESCE_DEADLINE_MS'
	const deadlineAt = Date.now() + deadlineMs
	/**
	 * Mark every execution the agent is running, so that nothing this loop
	 * kills can fence the agent.
	 *
	 * Called once per ROUND, between that round's scan and its first signal,
	 * and the placement is the whole of its correctness. Every pid the round
	 * is about to signal was in `/proc` when the scan ran, and a child's pid
	 * exists only once `spawn` has returned — after which `handleExecute`
	 * moves its record to `running` in the same tick. So a mark taken after
	 * the scan covers every execution whose process this round can reach,
	 * including one admitted a moment before the refusal gate went up and
	 * started while the scan was in flight. A mark taken BEFORE the scan
	 * would not: an execution still `starting` then is marked in vain,
	 * because `handleExecute` resets `terminationCause` to `undefined` as
	 * it goes `running`.
	 *
	 * What no placement covers is an execution whose child appears after the
	 * final scan found nothing. The refusal gate is what keeps that window
	 * to the executions already admitted when the quiesce began, and a
	 * command that survives it is reported by no round.
	 */
	const markRunningExecutions = () => {
		for (const execution of executions.values()) {
			if (execution.state === 'running' && execution.terminationCause === undefined) {
				execution.terminationCause = 'quiesced'
			}
		}
	}
	/** pid -> what it was and the last signal it was actually sent. */
	const stopped = new Map()
	let rounds = 0
	for (;;) {
		const candidates = await quiesceCandidates(scope)
		if (candidates.length === 0) break
		// Asked here rather than at the end of a round, because a round that
		// stopped everything exactly as the deadline arrived has done the job
		// the call was made for: the scan above is what says so, and it has
		// already said it. What the deadline refuses is starting ANOTHER
		// round with no time to finish it.
		if (Date.now() >= deadlineAt) {
			throw new Error(
				`quiesce did not settle within ${deadlineMs}ms (${deadlineSource}); pid ${candidates[0].pid} (${candidates[0].command}) was still running`,
			)
		}
		rounds += 1
		if (rounds > QUIESCE_MAX_ROUNDS) {
			throw new Error(
				`quiesce did not settle in ${QUIESCE_MAX_ROUNDS} rounds; pid ${candidates[0].pid} (${candidates[0].command}) was still starting processes`,
			)
		}
		const commands = new Map(candidates.map(({ pid, command }) => [pid, command]))
		markRunningExecutions()
		for (const { pid, command } of candidates) {
			if (signalPid(pid, 'SIGTERM')) stopped.set(pid, { pid, command, signal: 'SIGTERM' })
		}
		// Every wait is capped by the WHOLE op's deadline as well as by its
		// own window, so the rounds cannot compound into a call that outlives
		// the host's read-idle timeout: eight rounds of a caller's maximum
		// `graceMs`, twice each, would otherwise reach eighty seconds and the
		// host would tear down a connection it was only waiting on.
		const roundEnd = () => Math.min(deadlineAt, Date.now() + graceMs)
		let left = await waitForPidsGone([...commands.keys()], roundEnd())
		if (left.length > 0) {
			for (const pid of left) {
				if (signalPid(pid, 'SIGKILL')) {
					stopped.set(pid, { pid, command: commands.get(pid) ?? '', signal: 'SIGKILL' })
				}
			}
			left = await waitForPidsGone(left, roundEnd())
		}
		if (left.length > 0) {
			// Two different facts, and the message says which. A pid still
			// live after SIGKILL when there was time to watch it is a process
			// the kernel would not kill — uninterruptible IO, most likely.
			// The same pid when the deadline had already passed was never
			// waited for at all, because `roundEnd()` had nothing left to
			// give. Both refuse the call; only one of them is about the
			// process.
			const description = `pid ${left[0]} (${commands.get(left[0]) ?? 'unknown'})`
			throw new Error(
				Date.now() >= deadlineAt
					? `quiesce ran out of its ${deadlineMs}ms deadline (${deadlineSource}) with ${description} still live after SIGKILL`
					: `quiesce could not stop ${description}; it is still live after SIGKILL`,
			)
		}
	}
	await settleRegistries(deadlineAt)
	return { ok: true, scope, graceMs, rounds, stopped: [...stopped.values()] }
}

/** The `quiesce` op: validate, run, and refuse rather than resolve. */
async function handleQuiesce(socket, body) {
	if (process.platform === 'win32') {
		writeFrame(socket, { ok: false, error: 'quiesce_unsupported_platform' })
		return
	}
	const requested = body?.graceMs
	let graceMs = QUIESCE_GRACE_MS
	if (requested !== undefined) {
		if (!Number.isSafeInteger(requested) || requested <= 0 || requested > QUIESCE_MAX_GRACE_MS) {
			writeFrame(socket, {
				ok: false,
				error: 'quiesce_invalid_grace',
				message: `graceMs must be a positive integer of at most ${QUIESCE_MAX_GRACE_MS}ms (NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS minus one), got ${String(requested)}`,
			})
			return
		}
		graceMs = requested
	}
	quiescing = true
	try {
		writeFrame(socket, await runQuiesce(graceMs))
	} catch (error) {
		// Named, and never a resolved call with a shorter list: a host that
		// is about to capture a disk has to be able to tell "everything is
		// stopped" from "something would not stop".
		writeFrame(socket, {
			ok: false,
			error: 'quiesce_unconfirmed',
			message: error instanceof Error ? error.message : String(error),
		})
	} finally {
		// Unless this process is on its way out. `terminate()` raises the
		// same gate and owns it from then on, so a quiesce that was already
		// in flight when the stop signal arrived must not lower a gate it
		// did not raise: `server.close()` has stopped new connections, but a
		// connection that was already open would otherwise be handed the
		// right to start a command in a guest that is going away.
		if (!terminating) quiescing = false
	}
}

// --- flush: getting what was written onto the device ----------------------

/**
 * Making the workspace's dirty pages reach the disk, on purpose and at a
 * moment somebody chose.
 *
 * Until this op, nothing in this guest and nothing in the backend ever
 * called `sync`, `syncfs` or `fsync`. A workspace's disk kept whatever the
 * kernel had happened to write back, and the two moments that most need it
 * to hold everything are exactly the two where nothing was asked of it:
 * the suspend that takes the pod away, and the stop the cluster performs
 * for its own reasons (an eviction, a drain, a node going down).
 *
 * `write-file` closes the smaller half of that itself — a body this agent
 * accepted is fsynced and renamed before the reply says `ok`, see
 * `handleWriteFilePart`. This is the other half: a command the host ran
 * wrote through the page cache like any program does, and no per-file
 * fsync can reach what `dd`, a compiler or a package manager left there.
 * `syncfs(2)` can, for the whole mount at once, and it needs no capability
 * — which is the property that makes it usable here at all, since the
 * agent runs with an empty bounding set.
 *
 * Spawned rather than linked: Node exposes `fsync` and `fdatasync` and no
 * binding for `syncfs`, so `sync -f PATH` is the one way to reach the call
 * from this process without a native addon (and this package ships no
 * runtime dependency).
 */
function flushCommand() {
	if (FLUSH_COMMAND) return { file: '/bin/sh', args: ['-c', FLUSH_COMMAND] }
	return { file: 'sync', args: ['-f', WORKSPACE_ROOT] }
}

/**
 * Whether this guest can perform a flush at all — LOOKED FOR, not assumed.
 *
 * `AGENT_FEATURES` is a promise: a feature named in `healthz` is one the
 * host will use, and the host uses this one BY DEFAULT on every `suspend()`
 * and every `destroy()` that suspends. So a guest that advertised a flush
 * it has no program to run would refuse every default suspend for the whole
 * life of the pod, and nothing about that guest would ever change — the one
 * failure the feature list exists to prevent, arrived at by the feature
 * list itself.
 *
 * The image this repo ships has coreutils and `k8s/Dockerfile` says in so
 * many words that a derived image which strips them is a real shape. So the
 * claim is checked against the filesystem, once: a pod's PATH and its
 * contents do not change under it, and `healthz` is answered on connections
 * this must not stat for.
 */
let flushRunnable
function canFlush() {
	if (flushRunnable !== undefined) return flushRunnable
	// Not advertised on the platform whose refusal `handleFlush` already
	// answers, either: a host that cannot be told degrades instead.
	flushRunnable = process.platform !== 'win32' && isExecutableFile(flushCommand().file)
	return flushRunnable
}

/**
 * Whether `file` names a program this guest could run, resolved the way
 * `execvp` resolves one: a name carrying a separator stands for itself, a
 * bare name is looked for in each PATH entry in order.
 */
function isExecutableFile(file) {
	const candidates =
		file.includes('/') || file.includes('\\')
			? [file]
			: (process.env.PATH || '')
					.split(path.delimiter)
					.filter(Boolean)
					.map((dir) => path.join(dir, file))
	for (const candidate of candidates) {
		try {
			accessSync(candidate, fsConstants.X_OK)
			return true
		} catch {
			// The next PATH entry, exactly as a shell would.
		}
	}
	return false
}

/**
 * What `healthz` may claim, which is not always what this code implements.
 *
 * Read off {@link AGENT_FEATURES} on every call rather than computed once,
 * so a suite that empties that list to stand in for an older agent still
 * gets an older agent's reply.
 */
function advertisedFeatures() {
	return AGENT_FEATURES.filter((feature) => feature !== 'flush' || canFlush())
}

/**
 * Run one flush, bounded, and answer what it did.
 *
 * Rejects rather than resolving quietly on every failure, because a caller
 * asks for this immediately before the pod stops: "the flush did not run"
 * and "the flush ran" have to be distinguishable by the host, the way an
 * unconfirmed quiesce is.
 *
 * `timeoutSource` names where `timeoutMs` came from, and is threaded for
 * the reason {@link runQuiesce}'s `deadlineSource` is: the budget is not
 * always `NAMZU_AGENT_FLUSH_TIMEOUT_MS`. A host can send one with the op,
 * and {@link terminate} derives one from what is left of
 * `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS`. A message that named the wrong knob
 * would send whoever read it to raise a number that changes nothing.
 */
async function runFlush(timeoutMs, timeoutSource = 'NAMZU_AGENT_FLUSH_TIMEOUT_MS') {
	const startedAt = Date.now()
	const { file, args } = flushCommand()
	return await new Promise((resolve, reject) => {
		let child
		try {
			child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] })
		} catch (error) {
			reject(new Error(`flush could not start '${file}': ${error?.message ?? String(error)}`))
			return
		}
		let stderr = ''
		let settled = false
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			// Killed, so nothing is left running in a guest that is about to
			// be stopped — and reported, because the pages this was supposed
			// to write back may not have reached the device.
			try {
				child.kill('SIGKILL')
			} catch {}
			reject(
				new Error(
					`flush did not finish within ${timeoutMs}ms (${timeoutSource}); the workspace filesystem may still hold unwritten pages`,
				),
			)
		}, timeoutMs)
		timer.unref?.()
		child.stderr?.on('data', (chunk) => {
			if (stderr.length < 4096) stderr += String(chunk)
		})
		child.on('error', (error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(new Error(`flush could not run '${file}': ${error?.message ?? String(error)}`))
		})
		child.on('close', (code, signal) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (code === 0) {
				resolve({ durationMs: Date.now() - startedAt, workspace: WORKSPACE_ROOT })
				return
			}
			const how = signal ? `was killed by ${signal}` : `exited ${code}`
			reject(new Error(`flush command '${file}' ${how}${stderr ? `: ${stderr.trim()}` : ''}`))
		})
	})
}

/** The `flush` op: validate, run, and refuse rather than resolve. */
async function handleFlush(socket, body) {
	if (process.platform === 'win32') {
		writeFrame(socket, { ok: false, error: 'flush_unsupported_platform' })
		return
	}
	// The same fact `healthz` withholds, said to a caller that asked anyway:
	// a refusal the host reads as "this image cannot flush" and degrades on,
	// rather than as a flush that was attempted and failed. Without it an
	// image with no `sync` answers `flush_unconfirmed` — the shape that
	// means "the disk may be missing writes" — forever.
	if (!canFlush()) {
		writeFrame(socket, {
			ok: false,
			error: 'flush_unsupported',
			message: `no '${flushCommand().file}' on this guest's PATH, so nothing here can run syncfs(2) over ${WORKSPACE_ROOT}; healthz does not advertise 'flush' for this image`,
		})
		return
	}
	const requested = body?.timeoutMs
	let timeoutMs = FLUSH_TIMEOUT_MS
	if (requested !== undefined) {
		if (!Number.isSafeInteger(requested) || requested <= 0) {
			writeFrame(socket, {
				ok: false,
				error: 'flush_invalid_timeout',
				message: `timeoutMs must be a positive integer, got ${String(requested)}`,
			})
			return
		}
		timeoutMs = requested
	}
	try {
		const report = await runFlush(
			timeoutMs,
			requested !== undefined
				? "the flush request's own timeoutMs"
				: 'NAMZU_AGENT_FLUSH_TIMEOUT_MS',
		)
		writeFrame(socket, { ok: true, ...report })
	} catch (error) {
		writeFrame(socket, {
			ok: false,
			error: 'flush_unconfirmed',
			message: error instanceof Error ? error.message : String(error),
		})
	}
}

/**
 * Start one interactive PTY inside the guest.
 *
 * Two shapes, and the difference is what a closed connection means.
 *
 *  - **Connection-bound**, the default and what this op has always been: the
 *    PTY belongs to the framed connection that opened it, and losing the
 *    connection tears the terminal down. Unchanged in every respect but one —
 *    the teardown now reaches the whole session rather than `script`'s
 *    process group, which is what its own comment always claimed. See
 *    `processesInSessions` for what that comment was wrong about.
 *  - **Persistent**, when the body names a `sessionId` and sets
 *    `persistent: true`: the PTY belongs to the SESSION REGISTRY, output is
 *    read into a retained log whether or not anyone is attached, and closing
 *    the connection detaches without signalling anything. It ends when its
 *    program exits, on `kill-session`, or when the pod stops.
 */
function handleTerminal(socket, body) {
	let child
	let slavePath
	let ready = false
	let settled = false
	const pending = []
	// Undefined unless the host asked for one in the open body — see
	// `armStreamHeartbeat`.
	const heartbeatMs = normalizeHeartbeatMs(body?.heartbeatMs)
	let heartbeat
	/** The registry entry, for a persistent terminal only. */
	let record
	/** This connection's attachment to it, so a supersede can tell it apart. */
	let attachment
	const persistent = body?.persistent === true

	/** Every kernel session this terminal owns; see `findPtySlave`. */
	let ownedSessionIds = []

	/**
	 * Signal everything this terminal started — the shell, its jobs and
	 * `script` itself.
	 *
	 * Deliberately not a bare `process.kill(-child.pid)`: that reaches
	 * `script` and nothing else, so a job backgrounded with `&` survived
	 * every teardown this agent performed. The scan is asynchronous and this
	 * is not awaited, because every caller of it is a signal-and-forget path;
	 * `kill-session` is the op that waits and reports.
	 *
	 * `settled` is the guard this has always had, and it matters more here
	 * than it did: once the child is gone, the scan and the group kill would
	 * go out against a pid and a kernel session id the kernel is free to have
	 * given to somebody else. The signal has already been through the
	 * allow-list — {@link applyTerminalEvent} is where that rule lives, so
	 * that no connection can make this mean something another cannot.
	 */
	const kill = (signal = 'SIGTERM') => {
		if (!child?.pid || settled) return
		void signalSessionProcesses(
			{ processGroupId: child.pid, unixSessionIds: ownedSessionIds },
			signal,
		).catch(() => {})
	}

	const context = {
		child: () => child,
		slavePath: () => slavePath,
		heartbeat: () => heartbeat,
		pause: () => socket.pause(),
		resume: () => {
			if (!settled) socket.resume()
		},
		onInput: () => {
			if (record) record.lastInputAt = Date.now()
		},
		kill,
	}

	const apply = (event) => applyTerminalEvent(event, context)

	const start = async () => {
		if (!body || typeof body !== 'object') throw new Error('missing_terminal_options')
		const cols = terminalDimension(body.cols, MAX_TERMINAL_COLS, 'cols')
		const rows = terminalDimension(body.rows, MAX_TERMINAL_ROWS, 'rows')
		const cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
		await fs.mkdir(cwd, { recursive: true })

		const command = typeof body.command === 'string' && body.command ? body.command : '/bin/sh'
		const args = Array.isArray(body.args) ? body.args.map(String) : []
		if (persistent) {
			pruneSessions()
			if (!validateSessionId(body.sessionId)) throw new Error('invalid_session_id')
			if (sessions.has(body.sessionId)) throw new Error('session_exists')
			if (!makeRoomForSession()) throw new Error('session_capacity')
			record = createSessionRecord(body.sessionId, 'terminal', command, args)
		}
		const commandLine = ['exec', shellQuote(command), ...args.map(shellQuote)].join(' ')
		child = spawn('/usr/bin/script', ['-qefc', commandLine, '/dev/null'], {
			cwd,
			// Scrubbed exactly like an `execute` child. An interactive shell
			// is the shortest path from the workload to the agent's own
			// configuration — including its bind token — so the terminal
			// never inherits process.env raw. Precedence is unchanged: TERM
			// is a default the caller's own env may override.
			env: childEnvironment({ TERM: 'xterm-256color', ...(body.env || {}) }),
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		ownedSessionIds = [child.pid]
		if (record) {
			record.child = child
			record.processGroupId = child.pid
			record.unixSessionIds = ownedSessionIds
		}
		const forward = (source, chunk) => {
			// A persistent session's output goes into the ring first and to
			// the attachment second, and NOTHING here pauses the PTY: a
			// program with nobody attached must not block on a socket that is
			// not being read. A connection-bound terminal keeps the
			// backpressure it always had, because its only consumer is the
			// connection.
			if (record) {
				recordSessionOutput(record, source === child.stderr ? 'stderr' : 'stdout', chunk)
				return
			}
			if (!writeFrame(socket, { type: 'data', data: chunk.toString('utf8') })) {
				source.pause()
				socket.once('drain', () => {
					if (!settled) source.resume()
				})
			}
		}
		child.stdout.on('data', (chunk) => forward(child.stdout, chunk))
		child.stderr.on('data', (chunk) => forward(child.stderr, chunk))
		child.once('error', (error) => {
			if (record) finishSession(record, -1, undefined)
			if (settled) return
			settled = true
			heartbeat?.stop()
			writeFrame(socket, { type: 'error', error: error.message })
			socket.end()
		})
		child.once('close', (exitCode, signal) => {
			// The registry answers its own attachment — including one on a
			// DIFFERENT connection from this one — so the exit frame is sent
			// from exactly one place.
			if (record) {
				finishSession(record, exitCode, signal)
				settled = true
				return
			}
			if (settled) return
			settled = true
			heartbeat?.stop()
			writeFrame(socket, {
				type: 'exit',
				exitCode: typeof exitCode === 'number' ? exitCode : -1,
				...(signal && osConstants.signals[signal] ? { signal: osConstants.signals[signal] } : {}),
			})
			socket.end()
		})

		const pty = await findPtySlave(child.pid)
		slavePath = pty.slavePath
		// The shell's own kernel session — the one `script` created with
		// `setsid` and the one a backgrounded job stays in. Without it a kill
		// reaches `script` alone, which is the defect this whole feature is
		// built around. Recorded for a connection-bound terminal too: its
		// teardown has exactly the same gap to close.
		const shellSessionId = await readUnixSessionId(pty.shellPid)
		if (shellSessionId !== undefined) ownedSessionIds = [child.pid, shellSessionId]
		if (record) {
			record.slavePath = slavePath
			record.unixSessionIds = ownedSessionIds
		}
		await resizePty(slavePath, cols, rows)
		ready = true
		if (record) {
			// The registry builds the `ready` frame, replays (nothing yet) and
			// makes this connection the session's one attachment, so the
			// opening frame has exactly one construction site.
			attachToSession(socket, record, {
				fromOffset: 0,
				follow: true,
				...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
			})
			attachment = record.attachment
			heartbeat = attachment?.heartbeat
		} else {
			// The echo is what arms the host, and it carries the CLAMPED value
			// so both sides count the same interval. A host that asked for
			// nothing gets the same bare `ready` it always got.
			writeFrame(socket, readyFrame(undefined, heartbeatMs !== undefined ? { heartbeatMs } : {}))
			if (heartbeatMs !== undefined) {
				// Destroying the socket runs `onClose` below, which is the same
				// cleanup a host that simply went away already triggers.
				heartbeat = armStreamHeartbeat(socket, heartbeatMs, () => socket.destroy())
			}
		}
		for (const event of pending.splice(0)) apply(event)
	}

	void start().catch((error) => {
		if (settled) return
		heartbeat?.stop()
		// A terminal that failed to come up leaves nothing behind: the
		// registry entry goes with it, so its id is free for the retry.
		if (record && record.state !== 'exited') {
			sessions.delete(record.sessionId)
			record = undefined
		}
		kill('SIGKILL')
		// A terminal whose `script` has already EXITED is owed the exit frame,
		// not this error: whatever the walk could not find, the terminal is
		// over, and the frame its `close` handler writes is the one that
		// carries the exit code. That handler is the only construction site
		// (`settled` is what keeps it single), so this hands the outcome to it
		// rather than writing a second one — and the check is a check and not
		// a guess: an `exitCode` or a `signalCode` is node having reaped the
		// child, which is the same event as the `/proc/<pid>` entry the walk
		// gave up on disappearing, seen from the other side. A tick between
		// the two is exactly the race this would otherwise lose.
		if (child && (child.exitCode !== null || child.signalCode !== null)) return
		writeFrame(socket, {
			type: 'error',
			error: error instanceof Error ? error.message : String(error),
		})
		settled = true
		socket.end()
	})

	return {
		onFrame(payload) {
			let event
			try {
				event = JSON.parse(payload)
			} catch {
				return
			}
			if (ready) apply(event)
			else pending.push(event)
		},
		onClose() {
			heartbeat?.stop()
			// A persistent session outlives its connection: this is a DETACH
			// and it signals nothing. Everything else is torn down, now
			// reaching the whole session rather than `script` alone.
			if (record) {
				if (record.attachment === attachment && attachment !== undefined) {
					record.attachment = undefined
				}
				return
			}
			kill('SIGKILL')
		},
	}
}

// --- guest-loopback TCP forwarding ---------------------------------------

function handleTcpConnect(socket, body) {
	const host = body?.host || '127.0.0.1'
	const port = Number(body?.port)
	if (
		(host !== '127.0.0.1' && host !== '::1') ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	) {
		writeFrame(socket, { type: 'error', error: 'invalid_loopback_target' })
		socket.end()
		return
	}

	let settled = false
	// Undefined unless the host asked for one — see `armStreamHeartbeat`.
	const heartbeatMs = normalizeHeartbeatMs(body?.heartbeatMs)
	let heartbeat
	const upstream = net.createConnection({ host, port })
	const finish = (event) => {
		if (settled) return
		settled = true
		heartbeat?.stop()
		if (event) writeFrame(socket, event)
		upstream.destroy()
		socket.end()
	}

	upstream.once('connect', () => {
		// The echo carries the CLAMPED interval, and arms the host; a host
		// that asked for nothing gets the same bare `ready` it always got.
		writeFrame(socket, {
			type: 'ready',
			...guestIdentity(),
			...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
		})
		if (heartbeatMs !== undefined) {
			// Destroying the socket runs `onClose` below — the same cleanup a
			// host that simply went away already triggers.
			heartbeat = armStreamHeartbeat(socket, heartbeatMs, () => socket.destroy())
		}
	})
	upstream.on('data', (chunk) => {
		if (!writeFrame(socket, { type: 'data', data: chunk.toString('base64') })) {
			upstream.pause()
			socket.once('drain', () => {
				if (!settled) upstream.resume()
			})
		}
	})
	upstream.once('end', () => finish({ type: 'end' }))
	upstream.once('error', (error) => finish({ type: 'error', error: error.message }))

	return {
		onFrame(payload) {
			let event
			try {
				event = JSON.parse(payload)
			} catch {
				return
			}
			if (event?.type === 'data' && typeof event.data === 'string') {
				const bytes = Buffer.from(event.data, 'base64')
				if (bytes.byteLength <= 8 * 1024 * 1024 && !upstream.write(bytes)) {
					socket.pause()
					// Nothing is read while this is paused, so the watchdog must
					// not read that as the host having gone away.
					heartbeat?.suspend()
					upstream.once('drain', () => {
						if (!settled) socket.resume()
						heartbeat?.resume()
					})
				}
				return
			}
			if (event?.type === 'heartbeat') return
			if (event?.type === 'end') {
				upstream.end()
				return
			}
			if (event?.type === 'destroy') finish()
		},
		onClose() {
			settled = true
			heartbeat?.stop()
			upstream.destroy()
		},
	}
}

// --- per-instance credential gate ------------------------------------------

/**
 * The token this process is bound to, once one exists. Only the
 * trust-on-first-use fallback ever writes it — with
 * `NAMZU_AGENT_BIND_TOKEN` preset the expected value is the
 * environment's and no request can change it. Once bound it is never
 * rebound: a genuinely new instance is a new process (a resumed pod
 * runs a fresh agent), so a rebind could only ever serve a caller that
 * failed the first check.
 */
let boundToken

/**
 * Length- and timing-safe token comparison. `timingSafeEqual` throws on
 * operands of unequal length, and returning early on a length mismatch
 * would leak the bound token's length, so both sides are reduced to a
 * fixed-width digest first and the digests are compared.
 */
function tokensMatch(expected, presented) {
	return timingSafeEqual(
		createHash('sha256').update(expected, 'utf8').digest(),
		createHash('sha256').update(presented, 'utf8').digest(),
	)
}

/**
 * Whether this process requires a credential at all. False is the
 * Firecracker vsock/unix deployment, where the gate, the pre-auth frame
 * cap and the pre-auth idle timeout are all absent and a connection
 * behaves byte-for-byte as it did before any of them existed.
 */
function credentialGateActive() {
	return Boolean(process.env.NAMZU_AGENT_BIND_TOKEN || process.env.NAMZU_AGENT_REQUIRE_TOKEN)
}

/**
 * Refuse to start on a credential configuration that would silently
 * authenticate nothing.
 *
 * A TCP listener is reachable by whatever the network admits, so an
 * unauthenticated one is never what the operator meant; the agent used
 * to bind it anyway and say nothing. And `NAMZU_AGENT_BIND_TOKEN` set
 * to the empty string is the shape a downward-API injection takes when
 * it resolves to nothing — accepting it would open exactly the hole the
 * variable was set to close, in every listen mode, so it is refused in
 * every listen mode.
 *
 * The unix and inherited-fd paths are otherwise untouched: their
 * control channel is host↔guest only and they still require no token.
 */
function assertCredentialConfiguration(listenMode) {
	const preset = process.env.NAMZU_AGENT_BIND_TOKEN
	if (preset !== undefined && preset.length === 0) {
		throw new Error(
			'agent: NAMZU_AGENT_BIND_TOKEN is set but empty — unset it to run without a credential, or set it to a per-instance secret',
		)
	}
	if (listenMode === 'tcp' && !credentialGateActive()) {
		throw new Error(
			'agent: NAMZU_AGENT_TCP_PORT is a routed listener and needs a credential — set NAMZU_AGENT_BIND_TOKEN to a per-instance secret, or NAMZU_AGENT_REQUIRE_TOKEN to bind the first token seen',
		)
	}
}

/**
 * Whether one framed request may run. Three modes, chosen by the
 * environment the agent was started in:
 *
 *   - Neither variable set — every request is authorized. This is the
 *     vsock/unix path, whose control channel is host↔guest only; the
 *     behaviour here is byte-identical to the agent before the gate.
 *   - `NAMZU_AGENT_BIND_TOKEN` set — every request must present that
 *     exact token from its first frame.
 *   - `NAMZU_AGENT_REQUIRE_TOKEN` set with no preset token — the
 *     fallback: bind to the first token seen, refuse every other.
 *
 * `healthz` never reaches here. Readiness probing must work without a
 * secret, and its reply carries nothing but liveness and the protocol
 * version.
 */
function authorizeRequest(req) {
	const preset = process.env.NAMZU_AGENT_BIND_TOKEN
	if (!credentialGateActive()) return true
	const presented = typeof req?.token === 'string' ? req.token : ''
	// An empty token is not a credential: accepting one would let an
	// unauthenticated caller take the first-use binding for itself.
	if (!presented) return false
	const expected = preset || boundToken
	if (!expected) {
		boundToken = presented
		return true
	}
	return tokensMatch(expected, presented)
}

// --- connection dispatch ---------------------------------------------------

/**
 * The accepted connections that are in a token mode and have not yet
 * presented a credential, OLDEST FIRST — a Set iterates in insertion
 * order, which is the whole of the ordering the eviction needs. See
 * {@link MAX_PREAUTH_CONNECTIONS}: the per-connection cap bounds what one
 * unauthenticated peer may hold, and the size of this bounds how many
 * times it may hold it.
 *
 * Each member is the connection's own `{ evict }` handle, so evicting one
 * runs its own refusal against its own socket, reader and timers rather
 * than reaching into them from outside.
 */
const preAuthPool = new Set()

/**
 * What those connections are holding in their frame readers, in bytes.
 * See {@link MAX_PREAUTH_BUFFER_BYTES}.
 */
let preAuthBufferedBytes = 0

function handleConnection(socket) {
	// The gate is read once per connection, not once per frame: a
	// connection's budget must not change underneath it because something
	// edited the environment mid-flight.
	const gated = credentialGateActive()
	const reader = new FrameReader(gated ? MAX_PREAUTH_FRAME_BYTES : MAX_FRAME_BYTES)
	let dispatched = false
	let authorized = !gated
	let activeStream
	let abandoned = false
	let counted = gated
	let chargedBytes = 0
	/** Undefined outside a token mode: nothing else arms a deadline. */
	let deadlineTimer
	// `evict` is a hoisted declaration below; the handle is built here so
	// this connection joins the pool at accept, where its age starts.
	const poolEntry = { evict }
	if (counted) preAuthPool.add(poolEntry)

	/**
	 * Give this connection's place in the pre-auth budgets back — its slot
	 * and every byte it had charged. Called when it authenticates, when it
	 * is given up on, and when it closes, whichever happens first; the flag
	 * makes the rest no-ops.
	 */
	function release() {
		if (!counted) return
		counted = false
		preAuthPool.delete(poolEntry)
		preAuthBufferedBytes -= chargedBytes
		chargedBytes = 0
		// The deadline dies with the pre-auth state it bounds, so an
		// authenticated connection — a terminal, a `tcp-connect`, a
		// long-running `execute` — is never measured against it.
		if (deadlineTimer !== undefined) {
			clearTimeout(deadlineTimer)
			deadlineTimer = undefined
		}
	}

	/**
	 * Stop taking bytes from this peer. Detaching the reader is the point:
	 * while it stayed attached, every chunk a refused peer sent was still
	 * concatenated into its buffer.
	 */
	function abandon() {
		if (abandoned) return
		abandoned = true
		release()
		socket.removeListener('data', onData)
		socket.pause()
		socket.setTimeout(0)
		reader.reset()
	}

	/**
	 * Answer a peer we are not going to serve, then take the connection
	 * down.
	 *
	 * A refusal used to `end()` the socket, which half-closes it: only the
	 * writable side went away, the readable side stayed open, and a
	 * refused peer could keep streaming into the agent for as long as it
	 * liked. So the readable side is stopped first, the one refusal frame
	 * is flushed, and the socket is destroyed the moment that write
	 * completes — or after a short grace, for a peer that has stopped
	 * reading and would otherwise hold the write open.
	 */
	function refuse(reply) {
		abandon()
		if (socket.writableEnded) {
			// A `healthz` on this connection has already ended the writable
			// half, so there is nowhere to put the refusal: `end()` here would
			// be a write-after-end whose error arrives asynchronously and tells
			// nobody anything, and 'finish' has already fired, so the teardown
			// would fall back to the grace timer. Take it down now instead.
			socket.destroy()
			return
		}
		const flushTimer = setTimeout(() => socket.destroy(), REFUSAL_FLUSH_GRACE_MS)
		if (typeof flushTimer.unref === 'function') flushTimer.unref()
		socket.once('close', () => clearTimeout(flushTimer))
		socket.once('finish', () => socket.destroy())
		try {
			socket.end(frame(JSON.stringify(reply)))
		} catch {
			socket.destroy()
		}
	}

	/**
	 * Give this connection's pre-auth slot to a newer arrival, because the
	 * pool was full and this is its oldest member.
	 *
	 * Told, not dropped in silence: an evicted caller that is named the
	 * bound it lost to can raise it, and the frame costs a few dozen bytes
	 * on a connection that is going away either way. `refuse` is what makes
	 * it go away — the readable side stops, the reader is detached, and the
	 * socket is destroyed as soon as that one frame is on the wire or the
	 * flush grace expires.
	 */
	function evict() {
		refuse({
			ok: false,
			error: `too_many_unauthenticated_connections: limit ${MAX_PREAUTH_CONNECTIONS} (NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS)`,
		})
	}

	function onData(chunk) {
		if (abandoned) return
		let pending = chunk
		for (;;) {
			let frames
			try {
				frames = reader.push(pending)
			} catch {
				abandon()
				socket.destroy()
				return
			}
			pending = EMPTY_CHUNK
			for (const payload of frames) {
				if (dispatched) {
					activeStream?.onFrame(payload)
					continue
				}
				dispatched = true
				let req
				try {
					req = JSON.parse(payload)
				} catch {
					abandon()
					socket.destroy()
					return
				}
				// `healthz` is exempt from the gate so readiness probing needs
				// no secret — and, for the same reason, exempt from LIFTING
				// it: an unauthenticated probe must not buy itself the
				// post-auth frame budget.
				if (req?.op !== 'healthz') {
					if (!authorizeRequest(req)) {
						refuse({ ok: false, error: 'unauthorized' })
						return
					}
					authorized = true
					release()
					reader.maxFrameBytes = MAX_FRAME_BYTES
					socket.setTimeout(0)
				}
				activeStream = dispatch(socket, req)
			}
			if (counted) {
				// What this connection holds, against what every unauthenticated
				// connection may hold between them. Charged after the fact, so a
				// peer overshoots by at most the chunk that took it over.
				preAuthBufferedBytes += reader.length - chargedBytes
				chargedBytes = reader.length
				if (preAuthBufferedBytes > MAX_PREAUTH_BUFFER_BYTES) {
					refuse({
						ok: false,
						error: `preauth_buffer_exhausted: limit ${MAX_PREAUTH_BUFFER_BYTES} bytes (NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES)`,
					})
					return
				}
			}
			if (!reader.overflow) return
			// The frame that raised the cap may have been in this same chunk,
			// ahead of the header that overflowed the old one. Re-parse under
			// the new budget rather than refusing a legitimate peer.
			if (reader.overflow.announced <= reader.maxFrameBytes) {
				reader.overflow = undefined
				continue
			}
			// Named, not just numbered: the cap a caller trips is almost always
			// the pre-auth one, and an operator who is told only a number
			// cannot tell which of the two ceilings to raise.
			const variable = authorized
				? 'NAMZU_AGENT_MAX_FRAME_BYTES'
				: 'NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES'
			refuse({
				ok: false,
				error: `frame_too_large: announced ${reader.overflow.announced} bytes, limit ${reader.overflow.limit} (${variable})`,
			})
			return
		}
	}

	socket.on('data', onData)
	socket.on('close', () => {
		release()
		activeStream?.onClose()
	})
	socket.on('error', () => {
		// A severed connection is not fatal — the listener stays up and
		// the next dial lands fresh (resume invariant).
	})
	if (gated) {
		// Both timers are armed only in a token mode and both are cleared
		// the moment a connection authenticates, so no long-lived terminal,
		// `tcp-connect` or streaming `execute` — on this path or on the
		// Firecracker one — can be aged out by either.
		//
		// The deadline runs from accept and NOTHING resets it. That is the
		// entire point of having it beside an idle timer: `socket.setTimeout`
		// is idle-based, so a peer that trickles a byte every few seconds
		// pushes it out forever and never ages out. The idle timer stays
		// because it retires a silent connection sooner than the deadline
		// would.
		deadlineTimer = setTimeout(() => {
			if (authorized) return
			abandon()
			socket.destroy()
		}, PREAUTH_DEADLINE_MS)
		if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref()
		socket.setTimeout(PREAUTH_IDLE_TIMEOUT_MS)
		socket.on('timeout', () => {
			if (authorized) return
			abandon()
			socket.destroy()
		})
		// A full pool gives up its oldest member instead of turning this one
		// away; see {@link MAX_PREAUTH_CONNECTIONS}. The pool can be over its
		// limit by exactly one here — this connection joined it at the top of
		// this same synchronous accept, and nothing else has run since — so
		// one eviction is the whole of it, and skipping `poolEntry` means a
		// pool holding only this connection evicts nobody.
		if (preAuthPool.size > MAX_PREAUTH_CONNECTIONS) {
			const oldest = preAuthPool.values().next().value
			// Freed synchronously, so this connection is inside the bound
			// before it has read a byte.
			if (oldest !== undefined && oldest !== poolEntry) oldest.evict()
		}
	}
}

function dispatch(socket, req) {
	const op = req?.op
	if (op === 'healthz') {
		writeFrame(socket, {
			ok: !agentRetiring,
			protocolVersion: FIRECRACKER_AGENT_PROTOCOL_VERSION,
			// Additive and version-neutral: a host that has never heard of
			// `features` reads exactly the reply it always read. What is
			// claimed is what this guest can actually do — see
			// {@link advertisedFeatures} and {@link AGENT_FEATURES}.
			features: advertisedFeatures(),
			...(agentRetiring ? { retiring: true } : {}),
		})
		socket.end()
		return
	}
	// The credential gate is NOT here. It runs in `handleConnection`, on
	// the connection's first frame, because refusing a caller has to take
	// the whole connection down and only the connection owns the pieces
	// that takes — its reader, its data handler, its pre-auth timer.
	if (op === 'cancel-execution') {
		handleCancelExecution(socket, req.body)
			.catch((error) => writeFrame(socket, { ok: false, error: error.message }))
			.finally(() => socket.end())
		return
	}
	if (agentRetiring && (op === 'attach-execution' || op === 'attach-session')) {
		// Every other op is refused with the request-shaped reply below. An
		// attach's caller is reading a STREAM, so a fenced agent answers it
		// in the stream's own refusal shape — `{type:'error'}` and the
		// terminator — rather than with a frame that peer has no grammar
		// for and can only report as a protocol violation.
		writeFrame(socket, { type: 'error', error: 'agent_retiring' })
		writeTerminator(socket)
		socket.end()
		return
	}
	if (agentRetiring) {
		writeFrame(socket, { ok: false, error: 'agent_retiring' })
		socket.end()
		return
	}
	// A quiesce is counting processes and killing what it counts, so
	// anything that would start one more is refused until it settles — in
	// the shape its caller is reading, the way the fence above answers an
	// attach in the stream's own grammar rather than in a reply's. This is a
	// window of a second or two, not a state: it clears when the op answers,
	// however it answers. See `quiescing`.
	if (quiescing && QUIESCE_REFUSED_STREAM_OPS.has(op)) {
		writeFrame(socket, { type: 'error', error: 'quiesce_in_progress' })
		writeTerminator(socket)
		socket.end()
		return
	}
	if (quiescing && QUIESCE_REFUSED_OPS.has(op)) {
		writeFrame(socket, { ok: false, error: 'quiesce_in_progress' })
		socket.end()
		return
	}
	if (op === 'reserve-execution') {
		handleReserveExecution(socket, req.body)
		return
	}
	if (op === 'execute') {
		handleExecute(socket, req.body).catch((error) => {
			try {
				writeFrame(socket, { type: 'error', error: error.message })
				writeTerminator(socket)
				socket.end()
			} catch {}
		})
		return
	}
	if (op === 'attach-execution') {
		return handleAttachExecution(socket, req.body)
	}
	if (op === 'terminal') {
		return handleTerminal(socket, req.body)
	}
	if (op === 'attach-session') {
		return handleAttachSession(socket, req.body)
	}
	if (op === 'start-detached') {
		handleStartDetached(socket, req.body)
			.catch((error) => writeFrame(socket, { ok: false, error: error.message }))
			.finally(() => socket.end())
		return
	}
	if (op === 'list-sessions') {
		handleListSessions(socket)
		socket.end()
		return
	}
	if (op === 'kill-session') {
		handleKillSession(socket, req.body)
			.catch((error) => writeFrame(socket, { ok: false, error: error.message }))
			.finally(() => socket.end())
		return
	}
	// Additive, and advertised in {@link AGENT_FEATURES} rather than fenced
	// behind a protocol version, exactly like every other op added since 2:
	// an agent that predates it answers `unknown_op: quiesce`, and a host
	// only sends it to one that said it has it.
	if (op === 'quiesce') {
		handleQuiesce(socket, req.body)
			.catch((error) => writeFrame(socket, { ok: false, error: error.message }))
			.finally(() => socket.end())
		return
	}
	// Additive and advertised, exactly like `quiesce` above. A host sends it
	// only to a guest whose `healthz` named it, because an agent that
	// predates it answers `unknown_op: flush` and a host that read that as
	// "the disk is flushed" would take the pod away over unwritten pages.
	if (op === 'flush') {
		handleFlush(socket, req.body)
			.catch((error) => writeFrame(socket, { ok: false, error: error.message }))
			.finally(() => socket.end())
		return
	}
	if (op === 'tcp-connect') {
		return handleTcpConnect(socket, req.body)
	}
	if (op === 'read-file') {
		handleReadFile(socket, req.body).finally(() => socket.end())
		return
	}
	// Additive, and a STREAM branch rather than a reply branch: the
	// dispatcher keeps the connection open for whatever this returns,
	// exactly as it does for `terminal` and `tcp-connect`, so the handler
	// owns its own terminator and its own `socket.end()`. See
	// {@link AGENT_FEATURES} for why this is advertised rather than
	// versioned.
	if (op === 'read-file-stream') {
		return handleReadFileStream(socket, req.body)
	}
	if (op === 'write-file') {
		handleWriteFile(socket, req.body).finally(() => socket.end())
		return
	}
	writeFrame(socket, { ok: false, error: `unknown_op: ${String(op)}` })
	socket.end()
}

// --- entropy reseed before ready (the security fence, §7 risk #4) ----------

/**
 * Reseed the guest's userspace randomness state on every resume BEFORE
 * the agent announces ready. The pinned guest kernel is 5.10 (< 5.18),
 * so the in-kernel VMGenID auto-reseed does NOT exist; this userspace
 * reseed is the source of truth. Regenerate machine-id / host keys /
 * app secrets here too. Kept as a hook so the rootfs init owns the
 * exact commands; the agent guarantees it runs to completion before
 * `listen()` re-accepts.
 *
 * Overridable for tests via `NAMZU_AGENT_RESEED_HOOK` (a no-op default
 * keeps the loopback test from shelling out).
 */
async function reseedEntropy() {
	const hook = process.env.NAMZU_AGENT_RESEED_HOOK
	if (!hook) return
	await new Promise((resolve) => {
		const child = spawn('/bin/sh', ['-c', hook], { stdio: 'ignore' })
		child.on('error', () => resolve())
		child.on('close', () => resolve())
	})
}

// --- listen + resume re-listen ---------------------------------------------

let server

/**
 * Bind the listen socket for whichever transport this deployment
 * configured, in a fixed precedence: unix path, then the inherited
 * vsock fd, then a TCP port. Resolves with the listening `net.Server`
 * so a caller (and the loopback suites) can read the bound address —
 * a TCP deployment may ask for port 0 and learn the port afterwards.
 *
 * Rejects rather than binds when the configuration would serve a
 * routed listener with no credential; see
 * {@link assertCredentialConfiguration}.
 */
function startListening() {
	return new Promise((resolve, reject) => {
		const unixPath = process.env.NAMZU_AGENT_UNIX_PATH
		const vsockPort = process.env.NAMZU_AGENT_VSOCK_PORT
		const tcpPort = process.env.NAMZU_AGENT_TCP_PORT
		// Every rejection below happens before a `net.Server` exists, so a
		// refused startup leaves no listener object behind to leak or to
		// close.
		if (!unixPath && !vsockPort && !tcpPort) {
			reject(
				new Error(
					'agent: none of NAMZU_AGENT_UNIX_PATH, NAMZU_AGENT_VSOCK_PORT or NAMZU_AGENT_TCP_PORT set',
				),
			)
			return
		}
		const listenMode = unixPath ? 'unix' : vsockPort ? 'vsock' : 'tcp'
		let port
		if (listenMode === 'tcp') {
			port = Number(tcpPort)
			if (!Number.isInteger(port) || port < 0 || port > 65535) {
				reject(
					new Error(
						`agent: NAMZU_AGENT_TCP_PORT must be an integer port in [0, 65535], got ${JSON.stringify(tcpPort)}`,
					),
				)
				return
			}
		}
		try {
			assertCredentialConfiguration(listenMode)
		} catch (error) {
			reject(error)
			return
		}
		server = net.createServer()
		if (listenMode === 'tcp') {
			// SO_KEEPALIVE on the ROUTED listener only. The unix and vsock
			// modes are host-local and have no middlebox to lose state in;
			// setting it there would be a change to the Firecracker tier for
			// no gain. Registered BEFORE the handler, so a connection that
			// `handleConnection` refuses on its first frame has still had it
			// applied. It proves only that the peer's kernel answers — the
			// negotiated stream heartbeat is what proves its event loop does.
			server.on('connection', (socket) => {
				try {
					socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS)
				} catch {}
			})
		}
		server.on('connection', handleConnection)
		server.on('error', reject)
		if (listenMode === 'unix') {
			// Dev + test loopback peer: plain unix-domain socket.
			fs.rm(unixPath, { force: true })
				.catch(() => {})
				.finally(() => {
					server.listen(unixPath, () => resolve(server))
				})
			return
		}
		if (listenMode === 'vsock') {
			// Production: AF_VSOCK port. Node exposes no AF_VSOCK family,
			// so the rootfs runs the agent behind the kernel vsock→stream
			// bridge that terminates on the host UDS the dialer connects
			// to. From here it is a stream listener on a fd the init
			// service passes in (fd 3) — listen on the inherited handle.
			server.listen({ fd: 3 }, () => resolve(server))
			return
		}
		// Routed network: one sandbox per pod, the host dials
		// <podIP>:<port>. Bound on 0.0.0.0 because the pod's address
		// is assigned to it at admission and is not knowable here.
		// A routable listener is not a trust boundary, which is why
		// `assertCredentialConfiguration` has already refused this mode
		// unless a credential is configured for it.
		server.listen(port, '0.0.0.0', () => resolve(server))
	})
}

// --- termination: what a pod stop gets before the agent goes --------------

let terminating = false

/**
 * The drain a stopping pod gets, and the one bound it cannot exceed.
 *
 * `k8s/entrypoint.sh` execs `setpriv` into `tini`, so `tini` is the
 * container's PID 1 and this process is its child: the kubelet's stop
 * signal reaches PID 1 and `tini` forwards it here. (The comment that used
 * to sit on this handler said the opposite — that the entrypoint execs
 * straight into the agent and this process is PID 1 — which stopped being
 * true when `tini` was introduced, and the sentence about PID 1 needing its
 * own handler stopped applying with it. The handler still matters, for a
 * different reason: without one, the default disposition kills this process
 * where the sequence below has to run instead.)
 *
 * The order is the whole design, and each step exists because the one
 * before it is not enough:
 *
 *  1. **Stop accepting connections first.** Nothing new is admitted while
 *     processes are being stopped, so the guest cannot be handed work by a
 *     host that has not noticed the pod is going away.
 *  2. **Stop what this guest is running, through the quiesce routine.** Not
 *     a second implementation of it: `runQuiesce` marks every running
 *     execution so a killed group leader cannot fence the agent, scans
 *     `/proc` rather than the child list (an orphan is reparented away from
 *     this process), and works in rounds. A stop that only closed the
 *     listener would leave a compiler mid-write while the flush below ran.
 *  3. **Flush.** `syncfs(2)` over the workspace mount — the point of the
 *     whole handler, and the step nothing in this agent ever did before.
 *  4. **Exit 0**, so the container ends `Completed` rather than being
 *     SIGKILLed when the grace period runs out.
 *
 * And the bound, which is not optional: a process in uninterruptible IO
 * survives SIGKILL and a `syncfs` takes as long as the device takes, so
 * every step above can block. The bound is the WATCHDOG BELOW and nothing
 * else — at `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS` it exits whatever is still
 * in flight, which is not a clean shutdown but is better than holding the
 * pod open until the kubelet's own SIGKILL lands, the behaviour the old
 * handler's absence of a drain was avoiding by doing nothing at all.
 *
 * A REPEAT stop signal does NOT shorten that bound, though it used to: it
 * exited at once, read as a host or an operator saying "stop waiting". In
 * the pod this runs in, a second SIGTERM is the ORDINARY sequence rather
 * than anybody's instruction. `k8s/entrypoint.sh prestop` signals pid 1 and
 * waits for it, and the kubelet sends its own stop signal the moment that
 * hook returns — so exiting on the second one capped this handler at the
 * hook's wait instead of its own deadline, on precisely the slow flush the
 * handler exists for, and exited 0 over it so the truncation read as a
 * clean stop. (The hook's wait is now derived from this deadline and
 * outlives it, so in the ordinary case that second signal arrives after
 * this process is already gone.) Anything that genuinely wants this process
 * gone immediately still has SIGINT, SIGQUIT and SIGKILL, none of which
 * this agent handles.
 */
async function terminate(signal) {
	if (terminating) {
		// Reported, because a second signal means something upstream expected
		// this to be over already — and then ignored, because the deadline is
		// the bound and it is already running.
		console.error(
			`[namzu-fc-agent] ${signal}: already stopping; the drain and flush go on until NAMZU_AGENT_SHUTDOWN_DEADLINE_MS (${SHUTDOWN_DEADLINE_MS}ms) expires`,
		)
		return
	}
	terminating = true
	const deadlineAt = Date.now() + SHUTDOWN_DEADLINE_MS
	const watchdog = setTimeout(() => {
		console.error(
			`[namzu-fc-agent] ${signal}: the drain and flush did not finish within ${SHUTDOWN_DEADLINE_MS}ms (NAMZU_AGENT_SHUTDOWN_DEADLINE_MS); exiting anyway`,
		)
		process.exit(0)
	}, SHUTDOWN_DEADLINE_MS)
	if (server) {
		try {
			server.close()
		} catch {}
	}
	// The same refusal gate an explicit quiesce raises, and never lowered
	// again: a connection that is already open must not be able to start a
	// command in a guest that is being stopped.
	quiescing = true
	// The flush needs time of its own, so the drain cannot spend the whole
	// budget. A third of it, capped by the flush's own timeout, is reserved
	// before the quiesce is given what is left.
	const flushReserveMs = Math.min(
		FLUSH_TIMEOUT_MS,
		Math.max(1, Math.floor(SHUTDOWN_DEADLINE_MS / 3)),
	)
	try {
		await runQuiesce(QUIESCE_GRACE_MS, {
			deadlineMs: Math.max(1, deadlineAt - flushReserveMs - Date.now()),
			deadlineSource: 'NAMZU_AGENT_SHUTDOWN_DEADLINE_MS',
		})
	} catch (error) {
		// Reported, never fatal, and never a reason to skip the flush: a
		// process that would not stop is exactly the case where what it has
		// already written most needs to reach the device.
		console.error(`[namzu-fc-agent] ${signal}: ${error?.message ?? String(error)}`)
	}
	// Whichever of the two budgets is smaller bounds the flush, and the
	// message says which one it was: a drain that overran leaves the flush
	// with the tail of the shutdown deadline, and telling the reader to
	// raise the flush timeout there would be telling them to change a number
	// that is no longer the one binding.
	const flushBudgetMs = Math.max(1, Math.min(FLUSH_TIMEOUT_MS, deadlineAt - Date.now()))
	try {
		await runFlush(
			flushBudgetMs,
			flushBudgetMs < FLUSH_TIMEOUT_MS
				? 'NAMZU_AGENT_SHUTDOWN_DEADLINE_MS'
				: 'NAMZU_AGENT_FLUSH_TIMEOUT_MS',
		)
	} catch (error) {
		console.error(`[namzu-fc-agent] ${signal}: ${error?.message ?? String(error)}`)
	}
	clearTimeout(watchdog)
	process.exit(0)
}

async function reListenOnResume() {
	// Close current connections' listener and re-establish, AFTER reseed.
	await reseedEntropy()
	if (server) {
		await new Promise((r) => server.close(() => r()))
	}
	await startListening()
}

async function main() {
	await reseedEntropy()
	await startListening()
	// Resume signal: the orchestrator/init raises SIGUSR1 after a
	// `/snapshot/load`. Re-listen (and reseed) so first-exec-after-resume
	// never lands on a connection severed by the resume.
	process.on('SIGUSR1', () => {
		reListenOnResume().catch((err) => {
			console.error('[namzu-fc-agent] re-listen on resume failed:', err?.message)
		})
	})
	// Kubernetes tier only, but harmless everywhere: `tini` is the
	// container's PID 1 and forwards the kubelet's stop signal to this
	// process, which stops accepting connections, stops what the guest is
	// running and flushes the workspace before it exits. See
	// {@link terminate} for the order and for the bound it cannot exceed.
	process.on('SIGTERM', () => {
		void terminate('SIGTERM')
	})
}

// Export the pure pieces so the vitest loopback peer can drive the
// agent in-process without spawning a separate node binary.
module.exports = {
	AGENT_FEATURES,
	advertisedFeatures,
	sessions,
	FIRECRACKER_AGENT_PROTOCOL_VERSION,
	GUEST_BOOT_ID,
	MAX_TIMEOUT_MS,
	OutputLog,
	frame,
	FrameReader,
	handleConnection,
	startListening,
	reListenOnResume,
	resolveReadablePath,
	resolveWritablePath,
	resolveTimeoutMs,
	resolveReadRange,
}

if (require.main === module) {
	main().catch((err) => {
		console.error('[namzu-fc-agent] fatal:', err?.stack ? err.stack : err)
		process.exit(1)
	})
}
