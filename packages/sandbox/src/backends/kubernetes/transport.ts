/**
 * Host-side transport for the kubernetes backend's guest agent: the same
 * `agent/agent.cjs` the Firecracker tier bakes into its golden image,
 * reached over the pod network instead of a host-local vsock/unix socket.
 *
 * Every byte on the wire goes through {@link VsockAgentTransport}
 * constructed with a `{ kind: 'tcp' }` handle (`../firecracker/transport.js`):
 * the SAME per-call dial (fresh connection, no cached socket, no cached
 * IP — a Service-FQDN host re-resolves on every call, so a resumed pod's
 * new address costs nothing extra), the SAME 8-hex-length framing, and
 * the SAME token-in-envelope credential. Nothing about the wire is
 * reimplemented here.
 *
 * This module supplies its OWN {@link RemoteExecutionAdapter} to the
 * shared {@link RemoteExecutionController} — a third adapter against the
 * same controller, alongside `http-worker-client.ts` and
 * `firecracker/transport.ts`, each of which does this independently — so
 * it can report where an `exec()` call's wall time actually goes: the
 * dial(s), the reserve round trip, the execute round trip, and the small
 * amount of local bookkeeping after the peer's own work is done
 * ("drain"). That attribution is the whole point of `onTiming`: the
 * Firecracker relay path has a known, unexplained fixed cost, and the
 * sub-second warm-acquire target this backend is judged against must be
 * measured, not guessed at.
 */

import { randomUUID } from 'node:crypto'
import net from 'node:net'

import type {
	BackgroundJobStatus,
	OpenTerminalOptions,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxReadFileOptions,
	SandboxTcpConnectOptions,
	SandboxTcpConnection,
	TerminalSession,
} from '@namzu/sdk'

import {
	EXECUTION_ATTACH_FEATURE,
	type ExecRequest,
	ExecResultAccumulator,
	SESSIONS_FEATURE,
	type SessionKind,
	type SessionState,
	parseExecEvent,
} from '../firecracker/protocol.js'
import {
	AgentDialFailedError,
	type AgentRequest,
	type AgentTerminalStream,
	type SandboxAgentHandle,
	VsockAgentTransport,
	type VsockTransportOptions,
} from '../firecracker/transport.js'
import {
	type RemoteCancellationAcknowledgement,
	RemoteCancellationUnknownError,
	RemoteCommandError,
	type RemoteExecutionAdapter,
	RemoteExecutionController,
	RemoteProtocolError,
	RemoteResultIncompleteError,
	type RemoteTerminalMetadata,
} from '../remote-execution-controller.js'

/** The one {@link SandboxAgentHandle} arm this backend ever constructs. */
export type KubernetesAgentHandle = Extract<SandboxAgentHandle, { kind: 'tcp' }>

/**
 * Thrown when the guest agent refuses a request because the handle's
 * token does not match what the pod is bound to. Named distinctly from
 * {@link RemoteProtocolError} so a caller can tell "this credential is
 * wrong" (never going to succeed by retrying) from "the wire shape was
 * unexpected".
 */
export class KubernetesAgentUnauthorizedError extends Error {
	constructor(
		message = 'kubernetes tcp transport: the guest agent rejected this connection’s token (unauthorized)',
	) {
		super(message)
		this.name = 'KubernetesAgentUnauthorizedError'
	}
}

/**
 * Thrown when the guest agent refuses a request because it has FENCED
 * ITSELF: an earlier process group's shutdown could not be confirmed, so it
 * answers every op but `healthz` and `cancel-execution` with `agent_retiring`
 * and will go on doing so until the pod is replaced.
 *
 * Its own class, and deliberately NOT the Firecracker tier's mapping of the
 * same refusal. There a fenced agent becomes {@link
 * RemoteCancellationUnknownError}, which is correct for a disposable microVM:
 * the shared controller's rule is that the sandbox stops being reusable, and
 * on that tier retiring one means deleting scratch. On a workspace the same
 * error would retire the handle and take the pod — and with it every other
 * holder's terminals, dev servers and running commands — away from callers
 * who did nothing but share a workspace with the command that wedged.
 *
 * So this error refuses the ONE call rather than the workspace: the handle is
 * not retired, nothing is patched, and every other holder's pod stays where it
 * was. What it does NOT claim is that the next call will work. The fence is
 * the GUEST's, and `dispatch` gates it ahead of every data-plane branch, so
 * `readFile`, `writeFile`, `openTerminal` and `openTcpConnection` meet the
 * same refusal on the wire — under their own paths' error shapes, since only
 * the two control ops come through `requestChecked`. Only a new pod clears
 * it, which is why the message names the verbs that REPLACE the pod, on both
 * tiers that use this transport, and leaves the timing to the host: on a
 * workspace those are `suspend()` then `resume()`, and they take the live
 * sessions in that pod down with them.
 */
export class KubernetesAgentRetiringError extends Error {
	override readonly name = 'KubernetesAgentRetiringError'

	constructor(
		message = 'kubernetes tcp transport: the guest agent has fenced itself (agent_retiring) because an earlier process group’s shutdown could not be confirmed. A command of unknown state may still be running in that pod and nothing on this side can end it: only a new pod clears the fence, and until the pod is replaced every call except healthz and cancel-execution meets this same refusal — reads, writes, terminals and tcp connections included. Nothing was changed on the cluster by this refusal and this handle was not retired. On a persistent workspace, call suspend() and then resume() when you are ready for the live terminals and background processes in that pod to go down; on a task sandbox, destroy() it and take another.',
	) {
		super(message)
	}
}

/**
 * Thrown when the agent's address could not be RESOLVED — the dial never
 * reached a socket because the name has no answer here.
 *
 * Its own class, and its own message, because this is the one failure whose
 * cause is the deployment's shape rather than anything the cluster did: a
 * Service FQDN resolves through cluster DNS and nowhere else, so a host
 * outside the cluster fails every call at name resolution and reads the
 * result as a sandbox that never came up. The fix is a configuration field,
 * so the error names it.
 */
export class KubernetesAgentAddressUnresolvableError extends Error {
	override readonly name = 'KubernetesAgentAddressUnresolvableError'

	constructor(
		/** The host that did not resolve — normally a `*.svc.cluster.local`. */
		readonly host: string,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options)
	}
}

/** Every `code` and message in an error's own chain, cause by cause. */
function errorChain(error: unknown): { codes: string[]; messages: string[] } {
	const codes: string[] = []
	const messages: string[] = []
	let current: unknown = error
	// Bounded rather than `while (current)`: a cause cycle is a hang, and no
	// real chain on this path is more than three deep.
	for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
		const code = (current as { code?: unknown }).code
		if (typeof code === 'string') codes.push(code)
		messages.push(current.message)
		current = current.cause
	}
	return { codes, messages }
}

/**
 * Connect-shaped: the failure came out of the DIAL, so NOTHING was sent to
 * the guest.
 *
 * That last part is what makes a retry safe after the handle follows a
 * replaced pod — a reserved execution, a half-written file or a terminal
 * cannot be sitting in a pod this connection never opened — and it is why the
 * test is WHERE the error came from rather than which `errno` it carries.
 * A code cannot say that much: `ETIMEDOUT` is what the kernel raises when a
 * connect attempt gets no answer AND what it raises on an ESTABLISHED socket
 * that has run out of retransmits — the second of those happens mid-request,
 * with bytes already delivered, and retrying it is not safe.
 *
 * {@link AgentDialFailedError} is what {@link VsockAgentTransport}'s dial
 * throws when it gives up without a socket, so the question is asked of the
 * error's own type, anywhere in its cause chain. Not of its text: a guest
 * answers with text, and a command's stderr quoting "could not connect to
 * agent" would otherwise be read as this process's own dial failing.
 */
function isConnectFailure(error: unknown): boolean {
	let current: unknown = error
	// Bounded for the same reason {@link errorChain} is: a cause cycle is a
	// hang, and no real chain on this path is more than three deep.
	for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
		if (current instanceof AgentDialFailedError) return true
		current = current.cause
	}
	return false
}

/**
 * What one attempt's dials actually did, recorded as they happen.
 *
 * The marker above is the primary test and travels with the error, which is
 * enough for every operation that hands its failure straight back. `exec()`
 * does not: {@link RemoteExecutionController} bounds its control requests
 * (`bounded`, 2000ms by default) by RACING the operation against a timer, so
 * when the dial is still inside its 30s connect-retry budget at 2s the caller
 * is given the timer's bare `… reservation exceeded 2000ms` Error and the
 * dial's own failure — marker, `code` and all — is discarded rather than
 * wrapped. Classifying that error is impossible; the only way to know a
 * socket was never established is to have watched the dials.
 *
 * What is watched is that a connect was ATTEMPTED, not that one failed. The
 * bound is 2000ms and the dial's own connect timer is 5000ms by default, so
 * the shape this exists for — a pod IP whose SYN is dropped rather than
 * refused, which is what a released address on a routed pod network does —
 * is ABORTED by the bound before the attempt has failed at all. A watch of
 * failures alone is blind to exactly the half of the input space that made
 * the bound a problem in the first place; a fast `ECONNREFUSED` is the easy
 * half.
 *
 * `connected` is the half that makes the retry safe. It is set by the dial's
 * own success callback, so "a connect was attempted and no dial ever handed
 * back a socket" means literally nothing was sent to the guest during this
 * attempt — the same guarantee {@link AgentDialFailedError} carries, read
 * from the other end. It is as strong as it sounds on this arm: the `tcp`
 * dial resolves only on the socket's own `connect` event, so there is no
 * moment at which a byte has been written and `connected` is still false.
 */
interface DialWatch {
	/** At least one connect attempt was made — it may not have settled. */
	attempted: boolean
	/** At least one connect attempt failed, with an error to read. */
	failed: boolean
	/** At least one dial handed back a connected socket. */
	connected: boolean
	/** The last connect attempt's own error, which the bound may swallow. */
	lastError?: unknown
}

/** Nothing this attempt sent ever reached a socket. */
function neverConnected(dials: DialWatch | undefined): boolean {
	return dials?.attempted === true && !dials.connected
}

/**
 * Outcomes no rebind may retry, whatever the failure underneath them looks
 * like.
 *
 * Both are the controller's way of saying the REMOTE state is unknown: a
 * cancellation it could not confirm, a confirmed termination whose result
 * stream broke. Their own messages interpolate the underlying failure, so a
 * dial that broke mid-command travels as the `cause` of one of them — and a
 * retry there would re-run a command that may already have run, against a
 * disk that followed the pod. `RemoteCancellationUnknownError`
 * says so in its own words: "do not automatically retry the command".
 */
function isUnretryableOutcome(error: unknown): boolean {
	return (
		error instanceof RemoteCancellationUnknownError || error instanceof RemoteResultIncompleteError
	)
}

/**
 * Name-resolution-shaped: `getaddrinfo` refused the handle's host.
 *
 * Asked only of a DIAL failure, and only of a handle whose host is a name —
 * both gates are at the one call site, {@link
 * KubernetesAgentTransport.withRebind}. The message match below is
 * load-bearing (the retry wrapper's own Error does not carry the `code`
 * forward) and a substring test is exactly as strong as the text it is given,
 * so it is never asked of an arbitrary error: a `readFile` that fails because
 * the guest reported a path containing `ENOTFOUND`, or an exec whose output is
 * quoted into a message, is not a resolver failure and must not be rewritten
 * into one. `net.connect` never consults a resolver for a literal either, so a
 * `pod-ip` handle keeps its one re-read however an unrelated error is worded.
 */
const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN'])

function isNameResolutionFailure(error: unknown): boolean {
	const { codes, messages } = errorChain(error)
	if (codes.some((code) => DNS_ERROR_CODES.has(code))) return true
	// `net.connect` surfaces a `getaddrinfo ENOTFOUND <host>` message whose
	// `code` the retry wrapper's own Error does not carry forward.
	return messages.some((message) => message.includes('ENOTFOUND') || message.includes('EAI_AGAIN'))
}

/**
 * The resolver said the name does not exist — as opposed to saying it could
 * not answer right now.
 *
 * Only this half is treated as permanent, and the difference is the default
 * mode's whole retry budget. `EAI_AGAIN` is BY DEFINITION "temporary failure
 * in name resolution": it is the shape a CoreDNS restart or a conntrack race
 * produces for a host INSIDE the cluster, where the Service FQDN is correct
 * and waiting is exactly the cure — the 30s budget exists to ride over that,
 * and advice to set `agentAddress: 'pod-ip'` would be wrong for that host.
 * `ENOTFOUND` is the out-of-cluster symptom this mode exists for: a resolver
 * that has answered, definitively, that the name is not a name here, and no
 * amount of re-asking it changes that.
 *
 * A temporary failure that outlives the budget still ends as
 * {@link KubernetesAgentAddressUnresolvableError}, so the diagnosis is
 * delayed rather than lost.
 */
function isMissingNameFailure(error: unknown): boolean {
	const { codes, messages } = errorChain(error)
	if (codes.includes('ENOTFOUND')) return true
	return messages.some((message) => message.includes('ENOTFOUND'))
}

/** True for the wire shape `agent.cjs` sends when a token is rejected. */
function isUnauthorized(response: unknown): boolean {
	return refusedWith(response, 'unauthorized')
}

/**
 * True for the wire shape `agent.cjs` sends when it has fenced itself —
 * `dispatch`'s gate, and `handleReserveExecution`'s own earlier one.
 */
function isAgentRetiring(response: unknown): boolean {
	return refusedWith(response, 'agent_retiring')
}

/** One refusal envelope: `{ ok: false, error: <name> }`, and nothing else. */
function refusedWith(response: unknown, error: string): boolean {
	if (!response || typeof response !== 'object') return false
	const value = response as { ok?: unknown; error?: unknown }
	return value.ok === false && value.error === error
}

/**
 * One framed control request, with the guest's two NAMED refusals turned
 * into errors a caller can catch by class: {@link
 * KubernetesAgentUnauthorizedError} for a rejected token, and {@link
 * KubernetesAgentRetiringError} for an agent that has fenced itself.
 *
 * BOTH control requests go through here — `reserve-execution` and
 * `cancel-execution` — because the two are read by the same caller for
 * opposite reasons and neither may mistake a refusal for a blip. The
 * cancel path is the sharper of the two: {@link RemoteExecutionController}
 * RETRIES a failed cancellation for its whole confirm window and then
 * reports the cancellation UNCONFIRMED, which retires the sandbox. A
 * rejected token read as a transport failure would therefore spend that
 * window re-sending a request that can never succeed, and end by
 * describing a wrong credential as an ambiguous outcome.
 *
 * The fenced-agent refusal is the one a SECOND holder meets. `dispatch`
 * lets `cancel-execution` through the fence and refuses everything else, so
 * `agent_retiring` reaches here from `reserve-execution` — which without
 * this mapping is parsed as a reservation and rejected as
 * `RemoteProtocolError: remote sandbox returned an invalid execution
 * reservation`, a message about a wire shape for a pod that is telling the
 * truth about itself. Named here rather than in the shared controller
 * because the two tiers answer it differently: see {@link
 * KubernetesAgentRetiringError}.
 */
async function requestChecked(
	wire: VsockAgentTransport,
	request: AgentRequest,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await wire.request(request, signal)
	if (isUnauthorized(response)) throw new KubernetesAgentUnauthorizedError()
	if (isAgentRetiring(response)) throw new KubernetesAgentRetiringError()
	return response
}

/**
 * One `exec()` call's wall-time breakdown. Durations are NOT a partition
 * of a single total — `reserveMs` and `executeMs` each include their OWN
 * dial, which is also folded into `dialMs` — this is a diagnostic
 * breakdown for attribution, not an accounting identity. Never carries a
 * token, a command, its arguments, or any output.
 */
export interface KubernetesTransportTiming {
	/** Total time spent establishing TCP connections for this call. */
	readonly dialMs: number
	/** Time spent on the `reserve-execution` round trip (dial included). */
	readonly reserveMs: number
	/** Time spent on the `execute` round trip (dial included). */
	readonly executeMs: number
	/**
	 * Time between the execute round trip settling and `exec()` itself
	 * resolving — the shared controller's own post-execute bookkeeping
	 * (clearing timers, tearing down the observation race). Always small
	 * on the happy path; distinct from `executeMs` because it is spent
	 * locally, after the peer has nothing left to do.
	 */
	readonly drainMs: number
}

/**
 * What one `healthz` reply says about the agent, with the fence kept rather
 * than collapsed into a boolean.
 *
 * {@link VsockAgentTransport.healthz} answers `false` both for an agent that
 * did not reply and for one that replied "I have fenced myself", and those
 * are opposite facts for a host deciding what to do next: the first is a pod
 * that may be perfectly fine a second from now, the second is a pod that will
 * refuse every call until it is replaced.
 */
export interface KubernetesAgentHealth {
	/** The reply's own `ok` — `true` only for an agent serving normally. */
	readonly ok: boolean
	/**
	 * The agent has fenced itself and only a new pod clears it.
	 *
	 * Read from the reply's own `retiring` flag and from nothing else. A
	 * not-`ok` reply without it is NOT inferred to be a fence: the connection
	 * gate answers a `healthz` that arrived over one unauthenticated
	 * connection too many, or behind an exhausted pre-auth buffer, with a
	 * named `{ ok: false, error }` and no flag — and a caller told `retiring`
	 * there would suspend and resume a perfectly healthy pod. So `ok: false`
	 * with `retiring: false` is its own answer: this reply says nothing about
	 * whether the agent is serving.
	 */
	readonly retiring: boolean
}

/**
 * `permanentDialFailure` is deliberately NOT inherited: this transport sets
 * its own (see the constructor), so advertising the field would be offering a
 * caller a predicate that is silently overwritten.
 */
export interface KubernetesTransportOptions
	extends Omit<VsockTransportOptions, 'permanentDialFailure'> {
	/**
	 * Fires once per completed `exec()` call (success or failure) with
	 * the four phase durations above. The payload is exactly those four
	 * numbers — never the token, never a command, argv, or output.
	 */
	readonly onTiming?: (timing: KubernetesTransportTiming) => void
	/**
	 * Re-read the live pod behind this sandbox and hand back the address
	 * and token it answers on NOW.
	 *
	 * Set only by the `pod-ip` address mode, where the handle carries a
	 * literal IP that dies with its pod; a Service FQDN needs none of this
	 * because the name outlives the pod and the dial re-resolves it every
	 * call. Consulted at most ONCE per call, and only after a dial that
	 * failed at connect — see {@link KubernetesAgentTransport}.
	 */
	readonly refreshHandle?: (signal?: AbortSignal) => Promise<KubernetesAgentHandle>
}

// --- detachable executions (#479) -----------------------------------------

/** How long a detached `exec()` keeps trying to get its stream back. */
const DEFAULT_REATTACH_WINDOW_MS = 30_000
/** Pause between reattach attempts, so a refusing port is not hot-looped. */
const REATTACH_RETRY_DELAY_MS = 250
/** The guest's own default, mirrored so an observation bound exists. */
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60 * 1_000
/** Slack over the command's own timeout, as `executeRaw` allows itself. */
const EXECUTION_OBSERVATION_GRACE_MS = 10_000
/** How long a confirmed cancel is retried before it is reported unknown. */
const CANCEL_CONFIRM_WINDOW_MS = 8_000
const CANCEL_ATTEMPT_TIMEOUT_MS = 2_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Thrown before a command is admitted, when the caller asked for a
 * detachable execution and the guest does not advertise
 * {@link EXECUTION_ATTACH_FEATURE}.
 *
 * Refused rather than downgraded: a caller that asked for detach is about
 * to rely on being able to come back for the output, and running the
 * command anyway would keep nothing and tell nobody.
 */
export class KubernetesExecutionAttachUnsupportedError extends Error {
	override readonly name = 'KubernetesExecutionAttachUnsupportedError'

	constructor(
		readonly feature: string,
		message: string,
	) {
		super(message)
	}
}

/** Why an `attach-execution` could not be served. */
export type KubernetesAttachRefusal =
	| 'unknown_execution'
	| 'output_not_retained'
	| 'invalid_offset'
	| 'invalid_execution_id'
	| 'agent_retiring'
	| 'unknown'

/**
 * Thrown when the guest ANSWERED an attach and refused it — the execution
 * is past its retention, ran in a pod that has since been replaced, never
 * asked for its output to be kept, or the offset names bytes it does not
 * have.
 *
 * Distinct from a transport failure on purpose: a refusal will not become a
 * success by being retried, so the reattach loop stops on it instead of
 * spending its whole window re-asking a question already answered.
 */
export class KubernetesExecutionNotAttachableError extends Error {
	override readonly name = 'KubernetesExecutionNotAttachableError'

	/**
	 * The state the guest reported for this execution, when it reported
	 * one. `'reserved'` is the one that changes what a caller should do:
	 * the command was never started, so nothing is running.
	 */
	readonly executionState: string | undefined

	constructor(
		readonly executionId: string,
		readonly reason: KubernetesAttachRefusal,
		message: string,
		options?: { cause?: unknown; state?: string },
	) {
		super(message, options)
		this.executionState = options?.state
	}
}

/**
 * Thrown when a detached `exec()` gave up OBSERVING a command that is, as
 * far as this host knows, still the guest's to run.
 *
 * The two fields are what makes it recoverable rather than merely a
 * failure: `executionId` names the command to a second host process, and
 * `outputOffset` is the byte the next `attachExecution` should resume from
 * so nothing is read twice and no gap is invented.
 *
 * Nothing on this path cancels to reconcile. That is the whole point of
 * the feature: a reset connection used to cost the workspace its pod, and
 * a command the host has stopped watching is not a command that has to
 * die.
 */
export class KubernetesExecutionDetachedError extends Error {
	override readonly name = 'KubernetesExecutionDetachedError'

	constructor(
		readonly executionId: string,
		readonly outputOffset: number,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options)
	}
}

/** What the guest reports about a finished execution on an attach. */
interface AttachTerminal {
	readonly outcome: 'completed' | 'cancelled' | 'failed'
	readonly result?: RemoteTerminalMetadata
	readonly error?: string
}

/**
 * Everything one detached observation has read so far, across however many
 * connections it took.
 *
 * `offset` is the guest's own byte offset into the execution's retained
 * log, and it is the reason this is a mutable cursor rather than a return
 * value: a reattach resumes from it, and every chunk a previous connection
 * delivered has to be behind it.
 */
interface OutputCursor {
	offset: number
	stdout: string
	stderr: string
	/** Bytes the guest had already evicted when a reattach asked for them. */
	droppedBytes: number
}

/** One `stdout_delta`/`stderr_delta` payload, from either op's stream. */
function deltaStream(type: unknown): 'stdout' | 'stderr' | undefined {
	if (type === 'stdout_delta') return 'stdout'
	if (type === 'stderr_delta') return 'stderr'
	return undefined
}

function isAttachRefusal(value: string): value is KubernetesAttachRefusal {
	return (
		value === 'unknown_execution' ||
		value === 'output_not_retained' ||
		value === 'invalid_offset' ||
		value === 'invalid_execution_id' ||
		value === 'agent_retiring'
	)
}

function terminalMetadataOrThrow(value: unknown, executionId: string): RemoteTerminalMetadata {
	if (!value || typeof value !== 'object') {
		throw new RemoteProtocolError(
			`kubernetes: the guest ended the attach stream for ${executionId} without terminal metadata`,
		)
	}
	return value as RemoteTerminalMetadata
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		timer.unref?.()
	})
}

/**
 * The id shape the guest enforces, mirrored here so a caller-chosen id is
 * refused locally with a message that says what the shape is, rather than
 * as an `invalid_execution_id` frame after a round trip.
 */
const EXECUTION_ID_PATTERN =
	/^exec_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertExecutionId(executionId: string): void {
	if (EXECUTION_ID_PATTERN.test(executionId)) return
	throw new RemoteProtocolError(
		`kubernetes: ${JSON.stringify(executionId)} is not a valid execution id. The guest accepts exec_<uuid> and nothing else, so that an id minted by one host process is recognisable to another.`,
	)
}

/**
 * Fold one delta frame into the cursor, taking the offset FROM THE GUEST,
 * and pass the output on to the caller.
 *
 * The host never derives an offset from the string it received, on either
 * stream, and that is the whole of this function's reason to exist.
 * `Buffer.toString('utf8')` over a chunk that ends mid-character does not
 * preserve byte length — an incomplete sequence decodes to U+FFFD, which
 * is WIDER than the bytes it replaced — so a cursor advanced by
 * `Buffer.byteLength(data)` runs ahead of the guest's retained log the
 * first time a multi-byte character straddles a read boundary. A drifted
 * cursor is not a cosmetic error: the reattach either resumes past bytes
 * that are then never delivered and never reported (a silent hole in a
 * result whose truncation flags both read `false`) or names an offset the
 * guest never had and is refused `invalid_offset`, which costs the caller
 * the feature entirely. The guest stamps `nextOffset` on every delta of a
 * retained execution, on the execute stream and the attach stream alike.
 */
function applyDelta(
	cursor: OutputCursor,
	executionId: string,
	stream: 'stdout' | 'stderr',
	event: Record<string, unknown>,
	onOutput?: SandboxExecOptions['onOutput'],
): void {
	const data = typeof event.data === 'string' ? event.data : ''
	const nextOffset = Number(event.nextOffset)
	if (!Number.isFinite(nextOffset)) {
		throw new RemoteProtocolError(
			`kubernetes: the guest sent a ${stream} delta for execution ${executionId} without the byte offset a reattach resumes from. Every guest advertising '${EXECUTION_ATTACH_FEATURE}' stamps them on a retained execution's output; rebuild the workspace image from this Namzu release.`,
		)
	}
	cursor.offset = nextOffset
	if (stream === 'stdout') cursor.stdout += data
	else cursor.stderr += data
	onOutput?.({ stream, data })
}

/**
 * The guest's refusal to start a command on an id that is no longer
 * `reserved` — another host process got its `execute` in first.
 *
 * It reads as terminal (the guest answered, and answering again will not
 * change it) and it is the one case where that is the wrong conclusion:
 * the command this call asked for EXISTS, so the caller gets it by
 * attaching rather than an error about a race it does not care about.
 */
function lostTheStartRace(error: unknown): boolean {
	return error instanceof RemoteCommandError && error.message.startsWith('execution_not_reserved')
}

/**
 * Errors a reattach must NOT spend its window re-asking about: the guest
 * answered, and the answer will be the same next time.
 */
function isTerminalAttachError(error: unknown): boolean {
	return (
		error instanceof KubernetesExecutionNotAttachableError ||
		error instanceof KubernetesAgentUnauthorizedError ||
		error instanceof KubernetesAgentAddressUnresolvableError ||
		error instanceof RemoteCommandError ||
		error instanceof RemoteProtocolError
	)
}

/** The guest's `cancel-execution` reply, refusals told apart from blips. */
function parseCancellationReply(
	executionId: string,
	response: unknown,
): RemoteCancellationAcknowledgement {
	const reply = (response ?? {}) as Record<string, unknown>
	if (reply.ok === true) {
		const state = String(reply.state ?? '')
		if (state === 'cancelled' || state === 'completed' || state === 'failed') {
			return reply as unknown as RemoteCancellationAcknowledgement
		}
		throw new RemoteProtocolError(
			`kubernetes: the guest acknowledged cancelling ${executionId} with an unknown state ${JSON.stringify(reply.state)}`,
		)
	}
	const error = typeof reply.error === 'string' ? reply.error : 'unknown'
	if (error === 'unknown_execution' || error === 'invalid_execution_id') {
		throw new KubernetesExecutionNotAttachableError(
			executionId,
			error,
			`kubernetes: the guest holds no execution ${executionId} to cancel (${error}). A record is kept only for its retention window and is lost when the pod is replaced.`,
		)
	}
	throw new Error(`kubernetes: the guest refused to cancel ${executionId}: ${error}`)
}

/**
 * The SDK-shaped result of an attached observation.
 *
 * A reported gap sets BOTH truncation flags. The retained log is one
 * interleaved space, so bytes lost out of it cannot be attributed to
 * stdout or to stderr, and the contract already has exactly one way to say
 * "this output is not all of it". Saying it on one stream only would be a
 * guess; saying it on neither would hand back a short stream that looks
 * complete, which is the thing this design refuses to do.
 */
function resultFromAttachTerminal(
	executionId: string,
	terminal: AttachTerminal,
	cursor: OutputCursor,
): SandboxExecResult {
	if (terminal.outcome === 'failed' && terminal.result === undefined) {
		throw new RemoteCommandError(
			terminal.error ?? `the guest reported execution ${executionId} as failed`,
		)
	}
	const metadata = terminalMetadataOrThrow(terminal.result, executionId)
	const lost = cursor.droppedBytes > 0
	return {
		exitCode: metadata.exitCode,
		stdout: cursor.stdout,
		stderr: cursor.stderr,
		...(metadata.signal !== undefined ? { signal: metadata.signal } : {}),
		timedOut: metadata.timedOut === true,
		durationMs: metadata.durationMs,
		stdoutTruncated: metadata.stdoutTruncated === true || lost,
		stderrTruncated: metadata.stderrTruncated === true || lost,
	}
}

/**
 * What a caller passes to read an execution it did not necessarily start.
 *
 * `signal` here is an OBSERVATION signal, not the SDK's command signal:
 * aborting it stops reading and leaves the command running. That is the
 * opposite of `SandboxExecOptions.signal`, and it is why this type does not
 * extend it.
 */
export interface KubernetesAttachExecutionOptions {
	/** Byte offset to resume from. Default 0 — the whole retained log. */
	readonly fromOffset?: number
	readonly onOutput?: SandboxExecOptions['onOutput']
	/** Stops OBSERVING. Never cancels; see {@link KubernetesAgentTransport.cancelExecution}. */
	readonly signal?: AbortSignal
	/**
	 * Called when the guest reports that bytes the caller asked for had
	 * already been evicted from the retained log. The result's truncation
	 * flags say the same thing; this says how much.
	 */
	readonly onGap?: (gap: {
		readonly executionId: string
		readonly fromOffset: number
		readonly droppedBytes: number
	}) => void
}

/**
 * An `exec()` whose observation can be lost and taken up again — on this
 * handle or in another host process — instead of costing the command its
 * life.
 *
 * Deliberately NOT on the SDK's `SandboxExecOptions`: every other backend
 * would then have to answer for a field it cannot honour, and the SDK's
 * exec contract stays exactly what it was. This is a Kubernetes workspace
 * surface, layered over the shared options type rather than widening it.
 */
export interface KubernetesDetachedExecOptions
	extends SandboxExecOptions,
		Pick<KubernetesAttachExecutionOptions, 'onGap'> {
	/**
	 * The id this command is known by, to this process and to any other.
	 * Minted here when absent. Reserving an id the guest still holds does
	 * NOT start a second command: the call attaches to the one that exists,
	 * which is what makes a retried start idempotent for as long as the
	 * record lives.
	 */
	readonly executionId?: string
	/**
	 * Ask the guest to retain this command's output so the observation can
	 * be resumed. Setting `executionId` implies it; the flag is what a
	 * caller that does not care about the id passes.
	 */
	readonly detach?: boolean
	/**
	 * Stop observing and leave the command running — for a host that is
	 * shutting down. Rejects with {@link KubernetesExecutionDetachedError},
	 * which names the id and the offset to resume from.
	 *
	 * The opposite of `signal`, which keeps the SDK contract and terminates.
	 */
	readonly detachSignal?: AbortSignal
	/**
	 * How long a lost connection is retried before the call gives up and
	 * reports itself detached. Default 30s.
	 */
	readonly reattachWindowMs?: number
}

// --- guest sessions (#478) ------------------------------------------------

/**
 * Thrown before anything is started, when the caller asked for a session and
 * the guest does not advertise {@link SESSIONS_FEATURE}.
 *
 * Refused, never downgraded to a connection-bound terminal. A caller that
 * asked for a session is about to rely on coming back to it after its own
 * process has been replaced; handing it one that dies with the socket would
 * look like it worked until the one moment it was needed.
 */
export class KubernetesSessionsUnsupportedError extends Error {
	override readonly name = 'KubernetesSessionsUnsupportedError'

	constructor(
		readonly feature: string,
		message: string,
	) {
		super(message)
	}
}

/** Why the guest refused a session request. */
export type KubernetesSessionRefusal =
	| 'unknown_session'
	| 'invalid_session_id'
	| 'invalid_offset'
	| 'session_exists'
	| 'session_capacity'
	| 'missing_command'
	| 'spawn_failed'
	| 'agent_retiring'
	| 'unknown'

const SESSION_REFUSALS = new Set<KubernetesSessionRefusal>([
	'unknown_session',
	'invalid_session_id',
	'invalid_offset',
	'session_exists',
	'session_capacity',
	'missing_command',
	'spawn_failed',
	'agent_retiring',
])

function isSessionRefusal(value: string): value is KubernetesSessionRefusal {
	return SESSION_REFUSALS.has(value as KubernetesSessionRefusal)
}

/**
 * Thrown when the guest ANSWERED and refused: the session is past its
 * retention, ran in a pod that has since been replaced, the id is already
 * taken, or the offset names bytes it does not have.
 *
 * Distinct from a transport failure for the same reason
 * {@link KubernetesExecutionNotAttachableError} is: a refusal does not
 * become a success by being retried.
 */
export class KubernetesSessionRefusedError extends Error {
	override readonly name = 'KubernetesSessionRefusedError'

	constructor(
		readonly sessionId: string,
		readonly reason: KubernetesSessionRefusal,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options)
	}
}

/** One row of {@link KubernetesAgentTransport.listSessions}. */
export interface KubernetesSessionSummary {
	readonly sessionId: string
	readonly kind: SessionKind
	/** The program, as it was asked for. Never the environment it was given. */
	readonly command: string
	readonly args: readonly string[]
	readonly startedAt: number
	readonly lastInputAt?: number
	readonly lastOutputAt?: number
	/** Pass as `fromOffset` to read everything this session has printed since. */
	readonly nextOffset: number
	/** Bytes the ring has evicted over this session's life. */
	readonly droppedBytes: number
	readonly state: SessionState
	/** Whether a host process is attached to it right now. */
	readonly attached: boolean
	readonly exitCode?: number
	readonly signal?: number
}

/**
 * One read of a session's retained output, in the SDK's
 * `BackgroundJobOutput` shape — deliberately, because it answers the same
 * question for the same kind of consumer and a second vocabulary for
 * "here is the next chunk and here is what you missed" helps nobody.
 */
export interface KubernetesSessionOutput {
	readonly chunk: string
	readonly nextOffset: number
	readonly droppedBytes: number
	readonly status: BackgroundJobStatus
	readonly exitCode?: number
}

/**
 * A terminal on a workspace, with the three things only a SESSION's reader
 * needs. On a connection-bound terminal the two optional members are absent,
 * which is the honest answer: there is no session to name and nothing to
 * detach from.
 */
export interface KubernetesWorkspaceTerminal extends TerminalSession {
	/** Present exactly when this terminal belongs to a guest session. */
	readonly sessionId?: string
	/** One past the newest retained byte delivered so far. */
	nextOffset?(): number | undefined
	/**
	 * Stop reading and leave the program running — the opposite of
	 * {@link TerminalSession.kill}. `exited` then rejects with
	 * `AgentSessionDetachedError`, because a resolved `exited` would claim
	 * an exit that did not happen.
	 */
	detach?(): void
}

/**
 * What an ATTACH hands back: the same terminal, with the three session
 * members present rather than optional. `openTerminal` returns the looser
 * type because it serves both shapes and a connection-bound terminal
 * genuinely has no session to name.
 */
export interface KubernetesSessionTerminal extends KubernetesWorkspaceTerminal {
	readonly sessionId: string
	nextOffset(): number | undefined
	detach(): void
}

/** `openTerminal` on a workspace, widened by the two session fields. */
export interface KubernetesOpenTerminalOptions extends OpenTerminalOptions {
	/**
	 * Name this terminal so a later host process can find it again.
	 * Requires {@link persistent}; on its own it names nothing.
	 */
	readonly sessionId?: string
	/**
	 * Hand the PTY to the guest's session registry rather than to this
	 * connection. Losing the connection then DETACHES — no signal is sent,
	 * and the program ends when it exits, on `killSession`, or when the pod
	 * stops.
	 */
	readonly persistent?: boolean
}

/** Rejoin a terminal session that is already running. */
export interface KubernetesAttachTerminalOptions {
	/** Byte offset to replay from. Default 0 — everything the ring still holds. */
	readonly fromOffset?: number
	/** Resize the PTY on attach, for a reader whose window is a different shape. */
	readonly size?: { readonly cols: number; readonly rows: number }
}

/** Start a program with no terminal, which only a kill or the pod ends. */
export interface KubernetesStartDetachedOptions {
	readonly sessionId: string
	readonly command: string
	readonly args?: readonly string[]
	readonly cwd?: string
	readonly env?: Record<string, string>
}

/** Read a session's retained output without attaching to it. */
export interface KubernetesReadSessionOptions {
	readonly fromOffset?: number
}

function sessionNumber(value: unknown, fallback = 0): number {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : fallback
}

/** How long one `readSession` may spend reading a bounded, one-shot reply. */
const SESSION_READ_TIMEOUT_MS = 30_000

/**
 * The same shape the guest enforces, checked here so a bad id is a local
 * error naming the rule rather than a round trip that comes back
 * `invalid_session_id`.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function assertSessionId(sessionId: string): void {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error(
			`kubernetes: ${JSON.stringify(sessionId)} cannot name a session. It must be 1-64 characters of letters, digits, '.', '_' or '-', starting alphanumeric. The id is the ONLY way another host process finds this session again, so it is refused rather than sanitised.`,
		)
	}
}

/**
 * Both session fields or neither.
 *
 * A `sessionId` without `persistent` would open a terminal that dies with
 * its connection under a name nothing can use, and `persistent` without an
 * id would open one nobody can ever find. Either alone is a mistake worth a
 * message rather than a surprise.
 */
function assertSessionOpen(options: KubernetesOpenTerminalOptions): string {
	if (options.sessionId === undefined || options.persistent !== true) {
		throw new Error(
			'kubernetes: a persistent terminal needs both `sessionId` and `persistent: true`. An id without `persistent` opens a connection-bound terminal under a name nothing can attach to, and `persistent` without an id opens one nobody can find again.',
		)
	}
	assertSessionId(options.sessionId)
	return options.sessionId
}

/** The workspace-facing terminal around one open session stream. */
function sessionTerminal(
	stream: AgentTerminalStream,
	sessionId: string,
): KubernetesSessionTerminal {
	return {
		...stream.session,
		sessionId,
		nextOffset: () => stream.nextOffset(),
		detach: () => stream.detach(),
	}
}

/** The guest's row, structurally validated. */
function parseSessionSummary(value: unknown): KubernetesSessionSummary {
	if (!value || typeof value !== 'object') {
		throw new RemoteProtocolError('kubernetes: the guest sent a session row that is not an object')
	}
	const row = value as Record<string, unknown>
	if (typeof row.sessionId !== 'string') {
		throw new RemoteProtocolError('kubernetes: the guest sent a session row with no sessionId')
	}
	const kind = row.kind === 'detached' ? 'detached' : 'terminal'
	const state = row.state === 'exited' ? 'exited' : 'running'
	return {
		sessionId: row.sessionId,
		kind,
		command: typeof row.command === 'string' ? row.command : '',
		args: Array.isArray(row.args) ? row.args.map(String) : [],
		startedAt: sessionNumber(row.startedAt),
		...(row.lastInputAt !== undefined ? { lastInputAt: sessionNumber(row.lastInputAt) } : {}),
		...(row.lastOutputAt !== undefined ? { lastOutputAt: sessionNumber(row.lastOutputAt) } : {}),
		nextOffset: sessionNumber(row.nextOffset),
		droppedBytes: sessionNumber(row.droppedBytes),
		state,
		attached: row.attached === true,
		...(typeof row.exitCode === 'number' ? { exitCode: row.exitCode } : {}),
		...(typeof row.signal === 'number' ? { signal: row.signal } : {}),
	}
}

/**
 * The SDK's three-way job status, from the guest's two-way state plus the
 * signal. A program the kernel stopped is `killed`, not `exited`: the
 * distinction is the whole reason `BackgroundJobStatus` has three members.
 */
function sessionStatus(summary: {
	readonly state: SessionState
	readonly signal?: number
}): BackgroundJobStatus {
	if (summary.state === 'running') return 'running'
	return summary.signal !== undefined ? 'killed' : 'exited'
}

/** The refusal shape every session op answers a bad request with. */
function sessionRefusal(
	sessionId: string,
	reply: Record<string, unknown>,
	operation: string,
	cause?: unknown,
): KubernetesSessionRefusedError {
	const code = typeof reply.error === 'string' ? reply.error : 'unknown'
	const detail = typeof reply.message === 'string' ? ` ${reply.message}` : ''
	return new KubernetesSessionRefusedError(
		sessionId,
		isSessionRefusal(code) ? code : 'unknown',
		`kubernetes: the guest refused ${operation} for session ${sessionId} (${code}).${detail} A session lives in the pod's memory only: it is lost when the pod is replaced, and an exited one is kept for the window NAMZU_AGENT_SESSION_TERMINAL_TTL_MS names.`,
		cause !== undefined ? { cause } : undefined,
	)
}

/**
 * The same refusal, arriving on a STREAM rather than in a reply.
 *
 * `openTerminal` and `attachSession` do not get a `{ ok: false }` body: the
 * guest refuses them with an `error` FRAME, which the vsock transport
 * surfaces as a plain `Error` carrying the guest's code as its message. Left
 * alone, those two would be the only session verbs a caller could not catch
 * by class — so the code is recognised here, at the one boundary where it is
 * still recognisable, and everything else (a dial failure, an idle timeout)
 * is handed back untouched.
 */
function sessionStreamFailure(sessionId: string, operation: string, error: unknown): unknown {
	if (!(error instanceof Error) || !isSessionRefusal(error.message)) return error
	return sessionRefusal(sessionId, { error: error.message }, operation, error)
}

/**
 * The kubernetes backend's dialable transport: a `tcp` handle plus a
 * `RemoteExecutionAdapter` built from it, so `exec()` gets the same
 * reserve-before-admission behaviour (cancellation, timeout ownership,
 * "do not infer complete output on an ambiguous cancel") every other
 * remote backend gets, while every network operation is delegated to
 * {@link VsockAgentTransport} for the actual dial/frame/token work.
 */
export class KubernetesAgentTransport {
	/**
	 * Mutable, and the ONLY mutable state on this class: a `pod-ip` handle
	 * follows a replaced pod — see {@link rebind}. A `service` handle is
	 * written once in the constructor and never again, which is why the
	 * default mode's behaviour is untouched by any of this.
	 */
	private handle: KubernetesAgentHandle
	private readonly transportOptions: VsockTransportOptions
	private readonly onTiming?: (timing: KubernetesTransportTiming) => void
	private readonly refreshHandle?: (signal?: AbortSignal) => Promise<KubernetesAgentHandle>
	/** Simple pass-through operations share one transport instance. */
	private wire: VsockAgentTransport

	constructor(handle: KubernetesAgentHandle, options: KubernetesTransportOptions = {}) {
		const { onTiming, refreshHandle, ...transportOptions } = options
		this.handle = handle
		this.transportOptions = {
			...transportOptions,
			// A NAME the resolver says does not EXIST is the one connect
			// failure waiting cannot cure, and the reason it must not be
			// waited on is that the wait destroys the diagnosis. A resolver
			// that merely could not answer (`EAI_AGAIN`) is not that — see
			// {@link isMissingNameFailure} — and keeps the whole budget.
			//
			// The dial's retry budget is 30 s and the privilege probe's
			// deadline is at most 15 s, so a host with no cluster resolver
			// never reaches the wrapper below: the probe's clock expires first
			// and `create()` rejects saying the guest "accepted the connection
			// and did not answer", about a connection that was never made. The
			// address here comes off a Sandbox that reported Ready, so its
			// Service exists and its record is published — a name that fails
			// to resolve against that is a fact about THIS host, not a race
			// with the controller.
			permanentDialFailure: (err) => this.dialFailureIsPermanent(err),
		}
		this.onTiming = onTiming
		this.refreshHandle = refreshHandle
		this.wire = new VsockAgentTransport(handle, this.transportOptions)
	}

	/**
	 * The address this transport is dialing right now. Diagnostics only —
	 * host and port, and deliberately NOT the handle itself: this is read
	 * into a log line or an assertion, and the bind token has no business
	 * travelling with either.
	 */
	get address(): { readonly host: string; readonly port: number } {
		return { host: this.handle.host, port: this.handle.port }
	}

	/**
	 * Run one operation, and give a `pod-ip` handle exactly one chance to
	 * follow a pod that was replaced underneath it.
	 *
	 * The first question is always the same one, and everything else hangs
	 * off it: did the failure come out of the DIAL? A failure that did not is
	 * the guest's answer to a request it received, and nothing here may
	 * reinterpret it — not as a resolver problem, and not as a reason to
	 * repeat work the guest has already begun. Only a dial failure reaches the
	 * two branches below:
	 *
	 *  - The handle's host is a NAME and the dial failed at resolution, so
	 *    this is a Service FQDN and this host has no resolver for it.
	 *    Re-reading the pod would change nothing — the next dial would ask the
	 *    same resolver the same question — so the error is replaced with one
	 *    that names the FQDN and the configuration field that fixes it. The
	 *    name check is not decoration: a `pod-ip` handle must keep its one
	 *    re-read however an unrelated error happens to be worded.
	 *  - Otherwise, if this transport can re-read the pod, read it once. A
	 *    DIFFERENT uid means the controller replaced the pod (a resume, an
	 *    eviction, a node drain), so the handle takes the new address AND the
	 *    new token together — the same uid-change check the resume path makes
	 *    — and the operation is retried once. The retry is safe precisely
	 *    because the failure was at connect: nothing reached the guest, so
	 *    there is no half-applied write or reserved execution in the pod this
	 *    connection never opened.
	 *
	 * Anything else — a re-read that finds the SAME pod, or one that fails —
	 * leaves the original error standing. A pod that is still there and still
	 * refusing connections is a guest problem, and replacing that error with a
	 * second, later one would hide it.
	 *
	 * `signal` is the caller's own, where the operation has one: the re-read is
	 * an API round trip on a client that sets no per-request timeout, and a
	 * cancelled call must not go on to park on it.
	 *
	 * `dials` is how `exec()` answers the first question at all. Its failure
	 * can arrive as a bare timeout from the execution controller's own bound,
	 * with the dial's error discarded rather than wrapped, so that path
	 * watches its dials instead of reading its error — see {@link DialWatch}.
	 * Every other operation hands back the dial's own error and passes none.
	 */
	private async withRebind<T>(
		run: () => Promise<T>,
		signal?: AbortSignal,
		dials?: DialWatch,
	): Promise<T> {
		try {
			return await run()
		} catch (err) {
			if (isUnretryableOutcome(err)) throw err
			const fromTheDial = isConnectFailure(err) || neverConnected(dials)
			if (!fromTheDial) throw err
			if (this.dialsAName() && this.failedToResolve(err, dials)) throw this.unresolvable(err)
			if (!(await this.rebind(signal))) throw err
			return await run()
		}
	}

	/**
	 * Whether the dial gave up at name resolution.
	 *
	 * Asked of the caller's error first, and of the watched dial's own error
	 * only when nothing ever connected — the case where the error the caller
	 * holds is a bound's timer rather than the failure that caused it. A
	 * watched attempt that DID connect is never consulted: its error is the
	 * guest's answer, however it happens to be worded.
	 */
	private failedToResolve(error: unknown, dials: DialWatch | undefined): boolean {
		if (isNameResolutionFailure(error)) return true
		return neverConnected(dials) && isNameResolutionFailure(dials?.lastError)
	}

	/**
	 * The one connect failure waiting cannot cure — see the constructor.
	 * A method rather than a closure because the watched `exec()` dials wrap
	 * it, and a caller-visible answer must not depend on which wire asked.
	 */
	private dialFailureIsPermanent(error: unknown): boolean {
		return this.dialsAName() && isMissingNameFailure(error)
	}

	/** One re-read. True only when it landed on a DIFFERENT pod. */
	private async rebind(signal?: AbortSignal): Promise<boolean> {
		const refresh = this.refreshHandle
		if (refresh === undefined) return false
		let next: KubernetesAgentHandle
		try {
			next = await refresh(signal)
		} catch {
			// The re-read is a diagnosis, not an operation: a pod that cannot
			// be read is not a better error than the connect failure the
			// caller is already holding.
			return false
		}
		if (next.token === this.handle.token) return false
		this.handle = next
		this.wire = new VsockAgentTransport(next, this.transportOptions)
		return true
	}

	/** Whether the current handle's host goes through a resolver at all. */
	private dialsAName(): boolean {
		return net.isIP(this.handle.host) === 0
	}

	/** The DNS-shaped failure, in words that name the way out of it. */
	private unresolvable(cause: unknown): Error {
		const host = this.handle.host
		return new KubernetesAgentAddressUnresolvableError(
			host,
			`kubernetes: the guest agent's address ${host}:${this.handle.port} did not resolve (ENOTFOUND/EAI_AGAIN), so no connection was attempted. That is a Kubernetes Service FQDN and only the cluster's own DNS answers it: a host running OUTSIDE the cluster — a VNet peer, a CI runner, a laptop — fails every call here, readiness probes included, and the symptom looks like a sandbox that never came up. Set agentAddress: 'pod-ip' on the kubernetes backend config to dial the bound pod's IP instead, which needs a pod network routable from this host and a NetworkPolicy admitting its address range.`,
			{ cause },
		)
	}

	/**
	 * Readiness probe — never requires a token; see `protocol.ts`.
	 *
	 * Deliberately NOT wrapped in {@link withRebind}: `healthz` answers a
	 * failed dial with `false` rather than by throwing, so there is no error
	 * to classify and nothing for a re-read to be triggered by. A caller that
	 * wants the reason asks for it by making a real call.
	 */
	async healthz(signal?: AbortSignal): Promise<boolean> {
		return await this.wire.healthz(signal)
	}

	/**
	 * Poll until `healthz` succeeds or the timeout elapses. Unwrapped for the
	 * same reason, and for one more: it already owns a retry loop, so a
	 * connect failure here is not a single failed dial but a whole budget of
	 * them.
	 */
	async waitForReady(
		timeoutMs: number,
		pollIntervalMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		return await this.wire.waitForReady(timeoutMs, pollIntervalMs, signal)
	}

	/**
	 * Ask the agent how it is, and keep the two "not ok" answers apart —
	 * see {@link KubernetesAgentHealth}.
	 *
	 * Deliberately NOT wrapped in {@link withRebind}: this is a diagnostic
	 * about the pod this handle is bound to RIGHT NOW, and a rebind would
	 * silently answer it about a different pod. A caller that wants to know
	 * whether the agent it was talking to has fenced itself would then be
	 * told about the replacement, which is a different question with a
	 * different answer.
	 *
	 * It throws whatever the dial or the read threw. An agent that cannot be
	 * reached has no health to report, and inventing one here would turn
	 * "unreachable" into "fine".
	 */
	async agentHealth(signal?: AbortSignal): Promise<KubernetesAgentHealth> {
		const reply = await this.wire.request<{ ok?: unknown; retiring?: unknown }>(
			{ op: 'healthz' },
			signal,
		)
		return { ok: reply?.ok === true, retiring: reply?.retiring === true }
	}

	/**
	 * The raw `reserve-execution` primitive, exposed directly (rather than
	 * only reachable as a side effect of `exec()`) so the reservation
	 * round trip is independently observable and testable against the
	 * real guest.
	 */
	async reserve(signal?: AbortSignal): Promise<unknown> {
		return await this.withRebind(
			async () => await requestChecked(this.wire, { op: 'reserve-execution' }, signal),
			signal,
		)
	}

	/**
	 * The raw `cancel-execution` primitive, exposed for the same reason
	 * {@link reserve} is: it is a control request with its own refusal
	 * semantics, and proving those against the real guest should not require
	 * driving a whole cancelled `exec()` to reach it.
	 */
	async cancel(executionId: string, signal?: AbortSignal): Promise<unknown> {
		return await this.withRebind(
			async () =>
				await requestChecked(this.wire, { op: 'cancel-execution', body: { executionId } }, signal),
			signal,
		)
	}

	/**
	 * Delegated, `signal` included: a body larger than one pre-auth frame
	 * is written as a sequence of parts by {@link VsockAgentTransport}
	 * itself, and a cancelled sequence has to be able to stop mid-way and
	 * take its temp file with it.
	 *
	 * One transport instance, deliberately — {@link wire} is shared by
	 * every simple pass-through op — so the one `healthz` probe that asks
	 * the guest whether it can take parts is asked once for this sandbox,
	 * not once per large write.
	 *
	 * Wrapped in {@link withRebind} like every other guest-dialling op,
	 * the multi-part route included: a retry starts a fresh sequence under
	 * a new temp name (`writeFilePartTempPath` mints a UUID per call), so
	 * a sequence abandoned mid-way on the replaced pod cannot collide with
	 * the retry's offsets and never touched the target — at worst it
	 * leaves one orphan temp file behind on the workspace volume.
	 */
	async writeFile(path: string, content: Buffer, signal?: AbortSignal): Promise<void> {
		return await this.withRebind(
			async () => await this.wire.writeFile(path, content, signal),
			signal,
		)
	}

	async readFile(path: string, options?: SandboxReadFileOptions): Promise<Buffer> {
		return await this.withRebind(
			async () => await this.wire.readFile(path, options),
			options?.signal,
		)
	}

	/**
	 * Delegated, and rebound exactly once — but only around the FIRST
	 * chunk.
	 *
	 * That is the whole of what {@link withRebind} can honestly cover here.
	 * Its retry is safe because nothing reached the guest, and once a chunk
	 * has been yielded that is no longer true: re-dialing a replaced pod
	 * mid-stream would restart the file from its beginning, and the
	 * consumer — which has already taken the bytes and cannot give them
	 * back — would silently concatenate a duplicate prefix. So the first
	 * pull carries the dial, the rebind and the retry; everything after it
	 * fails as itself.
	 */
	async *readFileStream(
		path: string,
		options?: SandboxReadFileOptions,
	): AsyncGenerator<Buffer, void, undefined> {
		const started = await this.withRebind(async () => {
			const iterator = this.wire.readFileStream(path, options)[Symbol.asyncIterator]()
			try {
				return { iterator, first: await iterator.next() }
			} catch (error) {
				// The abandoned generator's own `finally` has already run by
				// the time its `next()` rejects, so the socket is down; the
				// `return()` is belt and braces for an implementation that
				// rejected without finishing.
				await iterator.return?.(undefined).catch(() => undefined)
				throw error
			}
		}, options?.signal)
		const { iterator, first } = started
		try {
			if (first.done === true) return
			yield first.value
			for (;;) {
				const next = await iterator.next()
				if (next.done === true) return
				yield next.value
			}
		} finally {
			await iterator.return?.(undefined).catch(() => undefined)
		}
	}

	/**
	 * A guest PTY. Without `sessionId`/`persistent` this is exactly the
	 * terminal it has always been, down to the wire request.
	 *
	 * With them the PTY belongs to the guest's session registry: losing this
	 * connection detaches rather than killing, a later process rejoins it
	 * with {@link attachSession}, and the capability is verified against the
	 * guest's `healthz` features BEFORE the shell is started — never
	 * downgraded to a connection-bound terminal, which would look like it
	 * worked until the rollout it exists for.
	 */
	async openTerminal(options: KubernetesOpenTerminalOptions): Promise<KubernetesWorkspaceTerminal> {
		if (options.sessionId === undefined && options.persistent !== true) {
			return await this.withRebind(async () => await this.wire.openTerminal(options))
		}
		const sessionId = assertSessionOpen(options)
		await this.assertSessionsSupported()
		return await this.sessionStream(
			sessionId,
			'openTerminal',
			async () => await this.wire.openSessionTerminal(options),
		)
	}

	/**
	 * One open of a session stream, with the guest's refusal mapped to
	 * {@link KubernetesSessionRefusedError} — see {@link sessionStreamFailure}.
	 */
	private async sessionStream(
		sessionId: string,
		operation: string,
		open: () => Promise<AgentTerminalStream>,
	): Promise<KubernetesSessionTerminal> {
		try {
			return sessionTerminal(await this.withRebind(open), sessionId)
		} catch (error) {
			throw sessionStreamFailure(sessionId, operation, error)
		}
	}

	/**
	 * Rejoin a terminal session, replaying from `fromOffset` and then
	 * following it live.
	 *
	 * The guest allows one attachment per session and ends the previous one
	 * by name, so two host processes cannot interleave keystrokes into one
	 * shell. Losing this connection detaches; ending the program is
	 * {@link killSession} and nothing else.
	 */
	async attachSession(
		sessionId: string,
		options: KubernetesAttachTerminalOptions = {},
	): Promise<KubernetesSessionTerminal> {
		assertSessionId(sessionId)
		await this.assertSessionsSupported()
		return await this.sessionStream(
			sessionId,
			'attachSession',
			async () =>
				await this.wire.attachSessionTerminal({
					sessionId,
					...(options.fromOffset !== undefined ? { fromOffset: options.fromOffset } : {}),
					...(options.size !== undefined
						? { cols: options.size.cols, rows: options.size.rows }
						: {}),
				}),
		)
	}

	/**
	 * Start a program with no terminal at all, in its own kernel session,
	 * with stdin closed and both output streams going into the guest's
	 * retained log.
	 *
	 * It is not the SDK's `spawnDetached` and deliberately does not pretend
	 * to be: that one hands back a host `ChildProcess`, which cannot cross a
	 * process boundary. This returns a NAME, and the name is what a
	 * redeployed host comes back with.
	 */
	async startDetached(
		options: KubernetesStartDetachedOptions,
		signal?: AbortSignal,
	): Promise<KubernetesSessionSummary> {
		assertSessionId(options.sessionId)
		await this.assertSessionsSupported(signal)
		const reply = (await this.withRebind(
			async () =>
				await requestChecked(
					this.wire,
					{
						op: 'start-detached',
						body: {
							sessionId: options.sessionId,
							command: options.command,
							...(options.args !== undefined ? { args: options.args } : {}),
							...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
							...(options.env !== undefined ? { env: { ...options.env } } : {}),
						},
					},
					signal,
				),
			signal,
		)) as Record<string, unknown>
		if (reply.ok !== true) throw sessionRefusal(options.sessionId, reply, 'startDetached')
		return parseSessionSummary(reply)
	}

	/** Every session this pod's agent is holding, running and recently exited. */
	async listSessions(signal?: AbortSignal): Promise<readonly KubernetesSessionSummary[]> {
		await this.assertSessionsSupported(signal)
		const reply = (await this.withRebind(
			async () => await requestChecked(this.wire, { op: 'list-sessions' }, signal),
			signal,
		)) as Record<string, unknown>
		if (reply.ok !== true) {
			throw new RemoteProtocolError(
				`kubernetes: the guest refused to list sessions: ${String(reply.error ?? 'no reason given')}`,
			)
		}
		if (!Array.isArray(reply.sessions)) {
			throw new RemoteProtocolError(
				'kubernetes: the guest sent a session list that is not an array',
			)
		}
		return reply.sessions.map(parseSessionSummary)
	}

	/**
	 * End one session and everything still in it — the shell, its
	 * backgrounded jobs, and the program a detached session started.
	 *
	 * Idempotent: a session that has already exited answers with what it
	 * exited with. The reply carries the session's state, so a program that
	 * ignored a `SIGTERM` and outlived the guest's confirm window is
	 * reported still running rather than reported dead.
	 */
	async killSession(
		sessionId: string,
		options: { readonly signal?: string; readonly abort?: AbortSignal } = {},
	): Promise<KubernetesSessionSummary> {
		assertSessionId(sessionId)
		await this.assertSessionsSupported(options.abort)
		const reply = (await this.withRebind(
			async () =>
				await requestChecked(
					this.wire,
					{
						op: 'kill-session',
						body: {
							sessionId,
							...(options.signal !== undefined ? { signal: options.signal } : {}),
						},
					},
					options.abort,
				),
			options.abort,
		)) as Record<string, unknown>
		if (reply.ok !== true) throw sessionRefusal(sessionId, reply, 'killSession')
		return parseSessionSummary(reply)
	}

	/**
	 * Read what a session has printed since `fromOffset`, without attaching
	 * to it and without signalling anything.
	 *
	 * One request, one answer, in the SDK's `BackgroundJobOutput` shape: the
	 * chunk, the offset to come back with, the bytes the ring dropped before
	 * it, and the program's status. A caller polling in a loop can neither
	 * re-read nor skip, because the offset is the guest's own.
	 */
	async readSession(
		sessionId: string,
		options: KubernetesReadSessionOptions = {},
		signal?: AbortSignal,
	): Promise<KubernetesSessionOutput> {
		assertSessionId(sessionId)
		await this.assertSessionsSupported(signal)
		const fromOffset = options.fromOffset ?? 0
		let chunk = ''
		let nextOffset = fromOffset
		let droppedBytes = 0
		let state: SessionState = 'running'
		let exitCode: number | undefined
		let exitSignal: number | undefined
		let refusal: KubernetesSessionRefusedError | undefined
		// Accumulating INSIDE a `withRebind` is safe for the one reason that
		// matters: the wrapper retries only a DIAL failure, and a dial that
		// failed delivered no frame, so a retry starts from an untouched
		// chunk and the offset the caller asked for.
		await this.withRebind(
			async () =>
				await this.wire.streamFramedRequest(
					{ op: 'attach-session', body: { sessionId, fromOffset, follow: false } },
					(event) => {
						if (isUnauthorized(event)) throw new KubernetesAgentUnauthorizedError()
						if (event.type === 'ready') {
							nextOffset = sessionNumber(event.nextOffset, nextOffset)
							droppedBytes = sessionNumber(event.droppedBytes)
							state = event.state === 'exited' ? 'exited' : 'running'
							if (typeof event.exitCode === 'number') exitCode = event.exitCode
							if (typeof event.signal === 'number') exitSignal = event.signal
							return
						}
						if (event.type === 'data') {
							chunk += String(event.data ?? '')
							nextOffset = sessionNumber(event.nextOffset, nextOffset)
							return
						}
						if (event.type === 'error') {
							refusal = sessionRefusal(
								sessionId,
								{
									error: event.error,
									...(event.message !== undefined ? { message: event.message } : {}),
								},
								'readSession',
							)
							return
						}
						throw new RemoteProtocolError(
							`kubernetes: the guest sent an unexpected frame reading session ${sessionId}: ${JSON.stringify(event).slice(0, 200)}`,
						)
					},
					{ observationTimeoutMs: SESSION_READ_TIMEOUT_MS },
					signal,
				),
			signal,
		)
		if (refusal !== undefined) throw refusal
		return {
			chunk,
			nextOffset,
			droppedBytes,
			status: sessionStatus({ state, ...(exitSignal !== undefined ? { signal: exitSignal } : {}) }),
			...(exitCode !== undefined ? { exitCode } : {}),
		}
	}

	/**
	 * Whether this guest keeps a session registry at all, asked once per
	 * transport and only when a caller wants one.
	 */
	private async assertSessionsSupported(signal?: AbortSignal): Promise<void> {
		const features = await this.wire.guestFeatures(signal)
		if (features.includes(SESSIONS_FEATURE)) return
		throw new KubernetesSessionsUnsupportedError(
			SESSIONS_FEATURE,
			`kubernetes: this workspace's guest agent does not advertise the '${SESSIONS_FEATURE}' healthz feature, so a terminal opened here would die with this connection and a detached program could not be named, read or killed. The request is refused rather than served as a connection-bound terminal. Rebuild the workspace image from this Namzu release.`,
		)
	}

	async openTcpConnection(options: SandboxTcpConnectOptions): Promise<SandboxTcpConnection> {
		return await this.withRebind(async () => await this.wire.openTcpConnection(options))
	}

	/**
	 * Run one command through a fresh, call-scoped adapter + controller.
	 * Fresh per call — not shared instance state — because
	 * {@link VsockAgentTransport} itself carries no cross-call connection
	 * state (it dials fresh every time), so building one per `exec()` is
	 * free and makes concurrent `exec()` calls on the same
	 * `KubernetesAgentTransport` correctly independent: each gets its own
	 * `onDial` closure and its own timing accumulator, with no shared
	 * mutable field for two in-flight calls to race on.
	 */
	async exec(
		command: string,
		argv?: string[],
		opts?: SandboxExecOptions,
	): Promise<SandboxExecResult> {
		let dialMs = 0
		let reserveMs = 0
		let executeMs = 0
		let executeSettledAt = 0

		// What this attempt's dials did, for the one classification `exec()`
		// cannot make from its error: the controller bounds `reserve` at 2s
		// and hands back its own timer's Error, so a dial still inside its
		// connect-retry budget is reported as a reservation that took too
		// long, with the connect failure discarded. See {@link DialWatch}.
		const dials: DialWatch = { attempted: false, failed: false, connected: false }

		// Built per ATTEMPT, from `this.handle` as it stands when the attempt
		// starts: a retry that follows a replaced pod has to dial the new
		// address, and the timing accumulators above outlive both attempts so
		// the caller still sees one call's total. The watch is reset here and
		// not there — it describes the attempt, and the second attempt is a
		// different pod's.
		const buildAttempt = (): Promise<SandboxExecResult> => {
			dials.attempted = false
			dials.failed = false
			dials.connected = false
			dials.lastError = undefined
			const timedWire = new VsockAgentTransport(this.handle, {
				...this.transportOptions,
				// Fires before each connect, so an attempt the controller's
				// bound aborts mid-connect is still on the record — see
				// {@link DialWatch}.
				onDialAttempt: () => {
					dials.attempted = true
				},
				onDial: (ms) => {
					dials.connected = true
					dialMs += ms
				},
				// Consulted by the dial on every FAILED connect attempt, which
				// is where the error the bound swallows is kept. The answer
				// itself is the transport's own, unchanged.
				permanentDialFailure: (err) => {
					dials.failed = true
					dials.lastError = err
					return this.dialFailureIsPermanent(err)
				},
			})

			const adapter: RemoteExecutionAdapter<Pick<ExecRequest, 'stdin' | 'maxOutputBytes'>> = {
				label: 'kubernetes pod-network agent',
				reserve: async (signal) => {
					const startedAt = Date.now()
					try {
						return await requestChecked(timedWire, { op: 'reserve-execution' }, signal)
					} finally {
						reserveMs += Date.now() - startedAt
					}
				},
				// Checked exactly like `reserve` — see `requestChecked`.
				cancel: async (executionId, signal) =>
					await requestChecked(
						timedWire,
						{ op: 'cancel-execution', body: { executionId } },
						signal,
					),
				execute: async (executionId, cmd, execArgv, execOpts, signal, context) => {
					const startedAt = Date.now()
					try {
						return await timedWire.executeStreamed(
							{
								...(executionId ? { executionId } : {}),
								command: cmd,
								args: execArgv ?? [],
								...(execOpts?.cwd !== undefined ? { cwd: execOpts.cwd } : {}),
								...(execOpts?.env !== undefined ? { env: execOpts.env } : {}),
								...(execOpts?.timeout !== undefined ? { timeoutMs: execOpts.timeout } : {}),
								...(context?.stdin !== undefined ? { stdin: context.stdin } : {}),
								...(context?.maxOutputBytes !== undefined
									? { maxOutputBytes: context.maxOutputBytes }
									: {}),
							},
							execOpts,
							signal,
						)
					} finally {
						executeMs += Date.now() - startedAt
						executeSettledAt = Date.now()
					}
				},
			}

			return new RemoteExecutionController(adapter).exec(command, argv, opts)
		}

		try {
			return await this.withRebind(buildAttempt, opts?.signal, dials)
		} finally {
			this.onTiming?.({
				dialMs,
				reserveMs,
				executeMs,
				drainMs: executeSettledAt > 0 ? Date.now() - executeSettledAt : 0,
			})
		}
	}

	/**
	 * Whether this guest implements the detach/attach ops at all, asked once
	 * per transport and only when a caller wants them.
	 */
	private async assertExecutionAttachSupported(signal?: AbortSignal): Promise<void> {
		const features = await this.wire.guestFeatures(signal)
		if (features.includes(EXECUTION_ATTACH_FEATURE)) return
		throw new KubernetesExecutionAttachUnsupportedError(
			EXECUTION_ATTACH_FEATURE,
			`kubernetes: this workspace's guest agent does not advertise the '${EXECUTION_ATTACH_FEATURE}' healthz feature, so a command started here would keep no output and could not be reattached to. The request is refused before the command is admitted rather than run as an ordinary exec. Rebuild the workspace image from this Namzu release.`,
		)
	}

	/** `reserve-execution` for a caller-named id, with its reported state. */
	private async reserveDetached(
		executionId: string,
		signal?: AbortSignal,
	): Promise<{ readonly state: string }> {
		const response = (await this.withRebind(
			async () =>
				await requestChecked(this.wire, { op: 'reserve-execution', body: { executionId } }, signal),
			signal,
		)) as Record<string, unknown>
		if (response.ok !== true || response.executionId !== executionId) {
			throw new RemoteProtocolError(
				`kubernetes: the guest refused the reservation for ${executionId}: ${String(response.error ?? 'no reason given')}`,
			)
		}
		return { state: typeof response.state === 'string' ? response.state : 'reserved' }
	}

	/**
	 * The `cancel-execution` control path, retried for its whole confirm
	 * window and reported UNKNOWN rather than as a failure if none of the
	 * attempts got an answer — the same rule the shared execution
	 * controller applies, because a command whose termination nobody
	 * confirmed is not a command anybody may call dead.
	 *
	 * Nothing on the detach path calls this to reconcile a lost connection.
	 * It runs when the CALLER asked for it: `SandboxExecOptions.signal`
	 * aborting, or {@link cancelExecution}.
	 */
	private async confirmCancel(
		executionId: string,
		signal?: AbortSignal,
	): Promise<RemoteCancellationAcknowledgement> {
		const deadlineAt = Date.now() + CANCEL_CONFIRM_WINDOW_MS
		let lastError: unknown = new Error('no cancellation attempt completed')
		while (Date.now() < deadlineAt) {
			const attempt = new AbortController()
			const onAbort = () => attempt.abort(signal?.reason)
			signal?.addEventListener('abort', onAbort, { once: true })
			const timer = setTimeout(
				() =>
					attempt.abort(new Error(`cancellation attempt exceeded ${CANCEL_ATTEMPT_TIMEOUT_MS}ms`)),
				Math.min(CANCEL_ATTEMPT_TIMEOUT_MS, Math.max(1, deadlineAt - Date.now())),
			)
			timer.unref?.()
			try {
				return parseCancellationReply(executionId, await this.cancel(executionId, attempt.signal))
			} catch (error) {
				if (error instanceof KubernetesExecutionNotAttachableError) throw error
				if (error instanceof KubernetesAgentUnauthorizedError) throw error
				lastError = error
				const remaining = deadlineAt - Date.now()
				if (remaining > 0) await pause(Math.min(50, remaining))
			} finally {
				clearTimeout(timer)
				signal?.removeEventListener('abort', onAbort)
			}
		}
		throw new RemoteCancellationUnknownError(
			`Remote sandbox cancellation could not be confirmed for ${executionId}: ${lastError instanceof Error ? lastError.message : String(lastError)}. The remote outcome is unknown; do not automatically retry the command.`,
			{ cause: lastError },
		)
	}

	/**
	 * End a command by id, from any host process holding the id and the
	 * bind token. Resolves only on a CONFIRMED termination.
	 *
	 * The outcome is not reported here — a cancelled execution's result and
	 * whatever output it managed is read back through
	 * {@link attachExecution}, which is the op that exists for reading.
	 */
	async cancelExecution(executionId: string, signal?: AbortSignal): Promise<void> {
		assertExecutionId(executionId)
		await this.confirmCancel(executionId, signal)
	}

	/**
	 * Observe a command that is already the guest's, from `fromOffset` on,
	 * and resolve with its result.
	 *
	 * It never signals the command. Aborting `signal` stops OBSERVING and
	 * rejects with {@link KubernetesExecutionDetachedError}; it does not
	 * cancel, and the command goes on running. Ending a command is
	 * {@link cancelExecution} and nothing else.
	 */
	async attachExecution(
		executionId: string,
		options: KubernetesAttachExecutionOptions = {},
	): Promise<SandboxExecResult> {
		assertExecutionId(executionId)
		await this.assertExecutionAttachSupported(options.signal)
		const cursor: OutputCursor = {
			offset: options.fromOffset ?? 0,
			stdout: '',
			stderr: '',
			droppedBytes: 0,
		}
		const observation = new AbortController()
		const onDetach = () => observation.abort(options.signal?.reason)
		options.signal?.addEventListener('abort', onDetach, { once: true })
		if (options.signal?.aborted) onDetach()
		try {
			return await this.attachOnce(executionId, cursor, options, observation.signal)
		} catch (error) {
			if (options.signal?.aborted) throw this.detached(executionId, cursor, error)
			throw error
		} finally {
			options.signal?.removeEventListener('abort', onDetach)
			observation.abort(new Error('kubernetes: attach observation finished'))
		}
	}

	/**
	 * Run one command whose observation can outlive this connection, and —
	 * when the connection is what failed — get it back rather than killing
	 * the command to reconcile.
	 *
	 * The order is exactly: refuse if the guest cannot keep output, reserve
	 * the id, and only then admit the command. Reserving the id the CALLER
	 * named is what makes a retried start idempotent: a second call with the
	 * same id inside retention finds the execution already running or
	 * finished, sends no `execute`, and attaches to the one that exists.
	 *
	 * `SandboxExecOptions.signal` keeps its contract — aborting it runs the
	 * confirmed cancel — and `detachSignal` is its opposite: it ends the
	 * observation and leaves the command alone, for a host that is shutting
	 * down and wants its work to survive the rollout.
	 */
	async execDetached(
		command: string,
		argv?: string[],
		opts: KubernetesDetachedExecOptions = {},
	): Promise<SandboxExecResult> {
		const executionId = opts.executionId ?? `exec_${randomUUID()}`
		assertExecutionId(executionId)
		const startedAt = Date.now()
		if (opts.signal?.aborted) {
			return {
				exitCode: 1,
				stdout: '',
				stderr: '',
				timedOut: false,
				durationMs: Math.max(0, Date.now() - startedAt),
				stdoutTruncated: false,
				stderrTruncated: false,
			}
		}
		await this.assertExecutionAttachSupported(opts.signal)

		const cursor: OutputCursor = { offset: 0, stdout: '', stderr: '', droppedBytes: 0 }
		const observationTimeoutMs = Math.min(
			MAX_TIMER_DELAY_MS,
			(typeof opts.timeout === 'number' && Number.isFinite(opts.timeout) && opts.timeout > 0
				? opts.timeout
				: DEFAULT_EXECUTION_TIMEOUT_MS) + EXECUTION_OBSERVATION_GRACE_MS,
		)
		const deadlineAt = Date.now() + observationTimeoutMs

		// The caller's abort runs the CONFIRMED cancel, in the background,
		// while the observation keeps reading: the guest answers the cancel
		// on its own connection and ends this one with the terminal frame, so
		// aborting produces a result rather than a severed stream.
		let cancelFailure: unknown
		let cancelling = false
		const cancelNow = (): void => {
			if (cancelling) return
			cancelling = true
			void this.confirmCancel(executionId).catch((error: unknown) => {
				cancelFailure = error
			})
		}
		const onAbort = () => cancelNow()
		opts.signal?.addEventListener('abort', onAbort, { once: true })

		// Aborting this stops the READING and nothing else. It is never the
		// caller's `signal`: destroying a socket does not end a guest command,
		// and a host that treats it as though it did is exactly how a network
		// blip used to cost a workspace its pod.
		const observation = new AbortController()
		const onDetach = () => observation.abort(new Error('kubernetes: observation detached'))
		opts.detachSignal?.addEventListener('abort', onDetach, { once: true })
		if (opts.detachSignal?.aborted) onDetach()

		try {
			let lastError: unknown
			const reservation = await this.reserveDetached(executionId, opts.signal)
			if (reservation.state === 'reserved') {
				try {
					return await this.executeRetained(
						executionId,
						{
							executionId,
							command,
							args: argv ?? [],
							...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
							...(opts.env !== undefined ? { env: opts.env } : {}),
							...(opts.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
							retainOutput: true,
						},
						cursor,
						opts,
						observation.signal,
						observationTimeoutMs,
					)
				} catch (error) {
					lastError = error
					// A second host process that reserved the same id and won
					// the race owns the command now. Its refusal says so, and
					// the answer is to ATTACH to the command that exists —
					// reporting a failure here would be a lie about an id
					// whose command is running.
					if (!lostTheStartRace(error) && isTerminalAttachError(error)) throw error
				}
			}

			// The window bounds GETTING BACK, and only that. It is armed as an
			// abort rather than checked between attempts because a single
			// attempt is not short: the dial carries its own connect-retry
			// budget, so a peer that is refusing connections would otherwise
			// be waited on for that whole budget inside one attempt and the
			// caller's bound would never be consulted. Once an attach has
			// actually attached the window is disarmed — a command that is
			// being read successfully is not something to give up on — and it
			// is re-armed if that connection dies in its turn.
			const reattachWindowMs = opts.reattachWindowMs ?? DEFAULT_REATTACH_WINDOW_MS
			let windowEndsAt = Date.now() + reattachWindowMs
			for (;;) {
				if (opts.detachSignal?.aborted) break
				const remainingMs = windowEndsAt - Date.now()
				if (remainingMs <= 0) break
				const window = new AbortController()
				const windowTimer = setTimeout(
					() =>
						window.abort(
							new Error(
								`kubernetes: could not reattach to execution ${executionId} within ${reattachWindowMs}ms`,
							),
						),
					remainingMs,
				)
				windowTimer.unref?.()
				let reattached = false
				try {
					return await this.attachOnce(
						executionId,
						cursor,
						opts,
						AbortSignal.any([observation.signal, window.signal]),
						deadlineAt,
						() => {
							reattached = true
							clearTimeout(windowTimer)
						},
					)
				} catch (error) {
					lastError = error
					if (isTerminalAttachError(error)) break
					if (opts.detachSignal?.aborted) break
					if (reattached) windowEndsAt = Date.now() + reattachWindowMs
					else if (window.signal.aborted) break
					await pause(REATTACH_RETRY_DELAY_MS)
				} finally {
					clearTimeout(windowTimer)
				}
			}
			throw this.detached(executionId, cursor, cancelFailure ?? lastError)
		} finally {
			opts.signal?.removeEventListener('abort', onAbort)
			opts.detachSignal?.removeEventListener('abort', onDetach)
			observation.abort(new Error('kubernetes: detached execution observation finished'))
		}
	}

	/**
	 * The `execute` leg of a detached run, read frame by frame.
	 *
	 * It deliberately does NOT go through `executeStreamed`: that path
	 * hands its caller `{stream, data}` and nothing else, and the byte
	 * offsets this cursor lives on are on the frames themselves. Reading
	 * them here is what lets a reattach resume exactly where this
	 * connection stopped, on output whose decoded length is not its byte
	 * length — see {@link applyDelta}. The frame union and its validation
	 * are the shared ones, so an ordinary exec and a detached one never
	 * disagree about what the guest said.
	 */
	private async executeRetained(
		executionId: string,
		body: ExecRequest,
		cursor: OutputCursor,
		opts: KubernetesDetachedExecOptions,
		signal: AbortSignal,
		observationTimeoutMs: number,
	): Promise<SandboxExecResult> {
		// No `onOutput` on the accumulator: this reads the frames, so the
		// caller is called exactly once per chunk, from `applyDelta`.
		const accumulator = new ExecResultAccumulator(Date.now())
		await this.wire.streamFramedRequest(
			{ op: 'execute', body },
			(frame) => {
				if (isUnauthorized(frame)) throw new KubernetesAgentUnauthorizedError()
				const event = parseExecEvent(frame)
				const stream = deltaStream(event.type)
				if (stream !== undefined) applyDelta(cursor, executionId, stream, frame, opts.onOutput)
				accumulator.push(event)
			},
			{ observationTimeoutMs },
			signal,
		)
		if (!accumulator.done) {
			throw new RemoteProtocolError(
				`kubernetes: the execute stream for ${executionId} ended without a result`,
			)
		}
		return accumulator.finish()
	}

	/** One `attach-execution` stream, read to its terminal frame. */
	private async attachOnce(
		executionId: string,
		cursor: OutputCursor,
		opts: KubernetesAttachExecutionOptions,
		signal: AbortSignal,
		deadlineAt?: number,
		onAttached?: () => void,
	): Promise<SandboxExecResult> {
		let terminal: AttachTerminal | undefined
		let refusal: KubernetesExecutionNotAttachableError | undefined
		const observationTimeoutMs =
			deadlineAt === undefined
				? MAX_TIMER_DELAY_MS
				: Math.max(1, Math.min(MAX_TIMER_DELAY_MS, deadlineAt - Date.now()))
		await this.wire.streamFramedRequest(
			{ op: 'attach-execution', body: { executionId, fromOffset: cursor.offset } },
			(event) => {
				if (isUnauthorized(event)) throw new KubernetesAgentUnauthorizedError()
				const type = event.type
				if (type === 'attached') {
					onAttached?.()
					const from = Number(event.fromOffset)
					if (Number.isFinite(from)) cursor.offset = from
					const dropped = Number(event.droppedBytes ?? 0)
					if (Number.isFinite(dropped) && dropped > 0) {
						cursor.droppedBytes += dropped
						opts.onGap?.({ executionId, fromOffset: cursor.offset, droppedBytes: dropped })
					}
					return
				}
				const stream = deltaStream(type)
				if (stream !== undefined) {
					applyDelta(cursor, executionId, stream, event, opts.onOutput)
					return
				}
				if (type === 'attach_result') {
					const next = Number(event.nextOffset)
					if (Number.isFinite(next)) cursor.offset = next
					const outcome = String(event.outcome)
					terminal = {
						outcome:
							outcome === 'cancelled' || outcome === 'failed'
								? (outcome as 'cancelled' | 'failed')
								: 'completed',
						...(event.result !== undefined
							? { result: terminalMetadataOrThrow(event.result, executionId) }
							: {}),
						...(typeof event.error === 'string' ? { error: event.error } : {}),
					}
					return
				}
				if (type === 'error') {
					const code = typeof event.error === 'string' ? event.error : 'unknown'
					const state = typeof event.state === 'string' ? event.state : undefined
					// A refusal for an execution the guest still holds as
					// `reserved` is the one case that is not about retention:
					// the command was never started, so there is nothing
					// running and nothing to come back for. Saying anything
					// else here would send a caller looking for a process
					// that does not exist.
					const because =
						state === 'reserved'
							? 'The guest holds it as reserved and never started it, so no command is running and there is nothing to reattach to.'
							: 'A record is kept for the retention window configured by NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS and is lost when the pod is replaced; only a command started with detach keeps its output at all.'
					refusal = new KubernetesExecutionNotAttachableError(
						executionId,
						isAttachRefusal(code) ? code : 'unknown',
						`kubernetes: the guest refused to attach to execution ${executionId} (${code}). ${because}`,
						{ state },
					)
					return
				}
				throw new RemoteProtocolError(
					`kubernetes: the guest sent an unexpected frame on the attach stream for ${executionId}: ${JSON.stringify(event).slice(0, 200)}`,
				)
			},
			{ observationTimeoutMs },
			signal,
		)
		if (refusal !== undefined) throw refusal
		if (terminal === undefined) {
			throw new RemoteProtocolError(
				`kubernetes: the attach stream for ${executionId} ended without a terminal frame`,
			)
		}
		return resultFromAttachTerminal(executionId, terminal, cursor)
	}

	/** The one error a lost observation ends with. */
	private detached(
		executionId: string,
		cursor: OutputCursor,
		cause: unknown,
	): KubernetesExecutionDetachedError {
		// The guest can tell us the command never started — the reservation
		// is still `reserved`, so the `execute` never reached it. Then
		// there is nothing running, nothing to reattach to and nothing to
		// cancel, and promising otherwise sends the caller after a process
		// that does not exist. Every other cause leaves the command's fate
		// genuinely unknown to this host, which is what the rest says.
		const neverStarted =
			cause instanceof KubernetesExecutionNotAttachableError && cause.executionState === 'reserved'
		const advice = neverStarted
			? 'the guest still holds it as RESERVED, so the command never started: nothing is running, and starting it again with the same id is safe.'
			: `it may still be running in the workspace pod. Reattach with attachExecution('${executionId}', { fromOffset: ${cursor.offset} }), from this process or another one, or end it with cancelExecution('${executionId}').`
		return new KubernetesExecutionDetachedError(
			executionId,
			cursor.offset,
			`kubernetes: stopped observing execution ${executionId} after ${cursor.offset} bytes of output, and did NOT cancel it — ${advice} Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		)
	}
}
