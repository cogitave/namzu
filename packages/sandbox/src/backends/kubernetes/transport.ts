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

import net from 'node:net'

import type {
	OpenTerminalOptions,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxTcpConnectOptions,
	SandboxTcpConnection,
	TerminalSession,
} from '@namzu/sdk'

import type { ExecRequest } from '../firecracker/protocol.js'
import {
	AgentDialFailedError,
	type AgentRequest,
	type SandboxAgentHandle,
	VsockAgentTransport,
	type VsockTransportOptions,
} from '../firecracker/transport.js'
import {
	RemoteCancellationUnknownError,
	type RemoteExecutionAdapter,
	RemoteExecutionController,
	RemoteResultIncompleteError,
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
	if (!response || typeof response !== 'object') return false
	const value = response as { ok?: unknown; error?: unknown }
	return value.ok === false && value.error === 'unauthorized'
}

/**
 * One framed control request, with the guest's `unauthorized` refusal
 * turned into {@link KubernetesAgentUnauthorizedError}.
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
 */
async function requestChecked(
	wire: VsockAgentTransport,
	request: AgentRequest,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await wire.request(request, signal)
	if (isUnauthorized(response)) throw new KubernetesAgentUnauthorizedError()
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

	async readFile(path: string): Promise<Buffer> {
		return await this.withRebind(async () => await this.wire.readFile(path))
	}

	async openTerminal(options: OpenTerminalOptions): Promise<TerminalSession> {
		return await this.withRebind(async () => await this.wire.openTerminal(options))
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
}
