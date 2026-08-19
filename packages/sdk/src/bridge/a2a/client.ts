import { A2A_PROTOCOL_VERSION, TERMINAL_STATES } from '../../constants/a2a/index.js'
import { A2ATaskSchema } from '../../contracts/a2a.js'
import type { A2AAgentCard, A2AMessage, A2AMethod, A2ATask } from '../../types/a2a/index.js'
import type {
	Delegate,
	DelegateCapabilities,
	DelegateRequest,
	DelegateResult,
} from '../../types/agent/delegate.js'

/**
 * The client half of the A2A bridge, as a `Delegate`.
 *
 * This kernel could SERVE an agent card and answer `message/send` for two
 * versions and could not read anybody else's — the bridge was a one-way
 * door. So the seam added in NZ-PEER-05 had no driven consumer, which is
 * the state this repo has a ratified rule about: a seam with no caller is
 * an untested guess at what a caller needs.
 *
 * It is deliberately small. Everything about scheduling, cancellation
 * bookkeeping, sibling policy and outcome predicates already lives in
 * `DelegatingTaskScheduler`; this only knows how to talk to a peer.
 */

/** Anything that answers like `fetch`. Injected so a test needs no socket. */
export type FetchLike = (
	input: string,
	init?: {
		method?: string
		headers?: Record<string, string>
		body?: string
		signal?: AbortSignal
	},
) => Promise<{
	ok: boolean
	status: number
	json(): Promise<unknown>
	text(): Promise<string>
}>

export interface FetchAgentCardOptions {
	readonly fetch: FetchLike
	/** Cancels discovery; a pre-aborted signal starts no request. */
	readonly signal?: AbortSignal
	/** Whole fetch-and-body deadline. Defaults to 30 seconds; `0` opts out. */
	readonly timeoutMs?: number
}

/** A peer that answered with something that is not an agent card. */
export class InvalidAgentCardError extends Error {
	readonly details: { url: string; reason: string }

	constructor(details: { url: string; reason: string }) {
		super(`The agent card at ${details.url} is not usable: ${details.reason}`)
		this.name = 'InvalidAgentCardError'
		this.details = details
	}
}

/** A peer speaking a protocol version this kernel does not implement. */
export class A2AProtocolMismatchError extends Error {
	readonly details: { url: string; theirs: string; ours: string }

	constructor(details: { url: string; theirs: string; ours: string }) {
		super(
			`The peer at ${details.url} speaks A2A ${details.theirs}; this kernel implements ${details.ours}.`,
		)
		this.name = 'A2AProtocolMismatchError'
		this.details = details
	}
}

/** The peer answered, and said no. */
export class A2ARequestError extends Error {
	readonly details: { method: string; status?: number; code?: string }

	constructor(message: string, details: { method: string; status?: number; code?: string }) {
		super(message)
		this.name = 'A2ARequestError'
		this.details = details
	}
}

const majorMinor = (version: string): string => version.split('.').slice(0, 2).join('.')

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_CARD_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const PEER_CANCEL_GRACE_MS = 500

function resolveTimerMs(
	value: number | undefined,
	fallback: number,
	name: string,
	allowZero: boolean,
): number {
	const resolved = value ?? fallback
	const minimum = allowZero ? 0 : 1
	if (!Number.isInteger(resolved) || resolved < minimum || resolved > MAX_TIMER_DELAY_MS) {
		throw new RangeError(
			`${name} must be an integer from ${minimum} to ${MAX_TIMER_DELAY_MS}; received ${String(resolved)}`,
		)
	}
	return resolved
}

function timeoutError(message: string): Error {
	const error = new Error(message)
	error.name = 'TimeoutError'
	return error
}

interface OperationCause {
	readonly kind: 'caller' | 'timeout'
	readonly reason: unknown
}

function taskIdOf(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'id')) return undefined
	const id = (value as { readonly id?: unknown }).id
	return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Internal control flow. Public callers receive the exact cause instead. */
class OperationInterrupted {
	constructor(readonly cause: OperationCause) {}
}

interface OperationBoundary {
	readonly signal: AbortSignal
	wait<T>(operation: Promise<T>): Promise<T>
	throwIfStopped(): void
	armTransportAbort(): void
	abortTransport(): void
	dispose(): void
}

/**
 * One caller-owned cancellation plus one kernel-owned deadline.
 *
 * The promise race is intentional even though the signal is forwarded. A
 * host can inject `FetchLike`, and accepting an AbortSignal does not prove it
 * settles when that signal fires. The race settles Namzu independently while
 * keeping the losing promise observed.
 */
function operationBoundary(options: {
	readonly callerSignal?: AbortSignal
	readonly timeoutMs: number
	readonly timeoutMessage: string
	readonly abortTransportInitially: boolean
}): OperationBoundary {
	options.callerSignal?.throwIfAborted()

	const transport = new AbortController()
	let cause: OperationCause | undefined
	let transportAbortArmed = options.abortTransportInitially
	let resolveStopped!: (cause: OperationCause) => void
	const stopped = new Promise<OperationCause>((resolve) => {
		resolveStopped = resolve
	})

	const stop = (next: OperationCause): void => {
		if (cause !== undefined) return
		cause = next
		// Latch and resolve BEFORE aborting the transport. A fetch implementation
		// may synchronously turn transport abort into a generic AbortError; that
		// fallout must not erase whether the caller or the deadline stopped us.
		resolveStopped(next)
		if (transportAbortArmed && !transport.signal.aborted) {
			transport.abort(next.reason)
		}
	}

	const onCallerAbort = (): void => {
		stop({ kind: 'caller', reason: options.callerSignal?.reason })
	}
	options.callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
	// Abort events are not replayed. The first throw closes the ordinary
	// pre-abort case; this second check closes a signal that changed while its
	// listener was being installed by a non-standard implementation.
	if (options.callerSignal?.aborted) onCallerAbort()

	const timer =
		options.timeoutMs > 0
			? setTimeout(() => {
					stop({ kind: 'timeout', reason: timeoutError(options.timeoutMessage) })
				}, options.timeoutMs)
			: undefined

	return {
		signal: transport.signal,
		async wait<T>(operation: Promise<T>): Promise<T> {
			if (cause !== undefined) throw new OperationInterrupted(cause)
			const completed = operation.then(
				(value) => ({ kind: 'value' as const, value, causeAtSettlement: cause }),
				(error: unknown) => ({ kind: 'error' as const, error, causeAtSettlement: cause }),
			)
			const winner = await Promise.race([
				completed,
				stopped.then((stoppedCause) => ({ kind: 'stopped' as const, cause: stoppedCause })),
			])
			if (winner.kind === 'stopped') throw new OperationInterrupted(winner.cause)
			// If transport.abort() made the operation reject first, the cause was
			// already latched. Preserve it rather than leaking a generic AbortError.
			if (winner.causeAtSettlement !== undefined) {
				throw new OperationInterrupted(winner.causeAtSettlement)
			}
			if (winner.kind === 'error') throw winner.error
			return winner.value
		},
		throwIfStopped(): void {
			if (cause !== undefined) throw new OperationInterrupted(cause)
		},
		armTransportAbort(): void {
			transportAbortArmed = true
			if (cause !== undefined && !transport.signal.aborted) transport.abort(cause.reason)
		},
		abortTransport(): void {
			if (!transport.signal.aborted) transport.abort(cause?.reason)
		},
		dispose(): void {
			if (timer !== undefined) clearTimeout(timer)
			options.callerSignal?.removeEventListener('abort', onCallerAbort)
		},
	}
}

/**
 * Read a peer's card, and refuse one this kernel cannot honestly use.
 *
 * Two refusals rather than a best effort. A card that does not parse is not
 * a peer with quirks, it is an unknown service at a URL somebody typed —
 * and a protocol version this kernel does not implement means every
 * subsequent request is a guess. Both are found once, at wiring time, which
 * is the only moment a human is looking; degrade here and the failure moves
 * to the middle of a delegation with a run waiting on it.
 *
 * The version comparison is on major.minor, not the patch. A2A is
 * pre-1.0, where the minor carries breaking changes — matching on the full
 * string would refuse a peer over a patch bump that changes nothing.
 */
export async function fetchAgentCard(
	baseUrl: string,
	opts: FetchAgentCardOptions,
): Promise<A2AAgentCard> {
	const timeoutMs = resolveTimerMs(
		opts.timeoutMs,
		DEFAULT_CARD_TIMEOUT_MS,
		'fetchAgentCard timeoutMs',
		true,
	)
	const boundary = operationBoundary({
		callerSignal: opts.signal,
		timeoutMs,
		timeoutMessage: `A2A agent-card request timed out after ${timeoutMs}ms`,
		abortTransportInitially: true,
	})
	const url = `${baseUrl.replace(/\/$/, '')}/.well-known/agent-card.json`
	try {
		boundary.throwIfStopped()
		const response = await boundary.wait(
			opts.fetch(url, {
				method: 'GET',
				headers: { accept: 'application/json' },
				signal: boundary.signal,
			}),
		)
		if (!response.ok) {
			throw new InvalidAgentCardError({ url, reason: `HTTP ${response.status}` })
		}

		let body: unknown
		try {
			body = await boundary.wait(response.json())
		} catch (err) {
			if (err instanceof OperationInterrupted) throw err
			throw new InvalidAgentCardError({
				url,
				reason: err instanceof Error ? err.message : 'the body is not JSON',
			})
		}

		const card = body as Partial<A2AAgentCard>
		// Checked by hand rather than through a schema, because there is no
		// `A2AAgentCardSchema` in `contracts/a2a.ts` — the card is a type here
		// and not a parser. Only the fields this client actually depends on are
		// required; inventing requirements a peer does not owe us would refuse
		// working peers.
		if (typeof card?.name !== 'string' || !Array.isArray(card.supportedInterfaces)) {
			throw new InvalidAgentCardError({ url, reason: 'no name, or no supportedInterfaces' })
		}
		if (card.supportedInterfaces.length === 0) {
			throw new InvalidAgentCardError({ url, reason: 'supportedInterfaces is empty' })
		}
		if (
			card.protocolVersion &&
			majorMinor(card.protocolVersion) !== majorMinor(A2A_PROTOCOL_VERSION)
		) {
			throw new A2AProtocolMismatchError({
				url,
				theirs: card.protocolVersion,
				ours: A2A_PROTOCOL_VERSION,
			})
		}
		return card as A2AAgentCard
	} catch (err) {
		if (err instanceof OperationInterrupted) throw err.cause.reason
		throw err
	} finally {
		boundary.dispose()
	}
}

export interface A2ADelegateConfig {
	/** The id the delegation tools name. See `Delegate.id`. */
	readonly id: string
	readonly card: A2AAgentCard
	readonly fetch: FetchLike
	/** Headers every request carries — an authorization header, in practice. */
	readonly headers?: Readonly<Record<string, string>>
	/** How often to ask `tasks/get` while the peer is still working. */
	readonly pollIntervalMs?: number
	/** Give up on the whole delegation, including `message/send`, after this long. */
	readonly timeoutMs?: number
}

/**
 * States this CLIENT will stop polling on — `TERMINAL_STATES` plus
 * `input-required`, and the difference is not a widening of the same idea.
 *
 * `TERMINAL_STATES` is the SERVER's set, and it is right there:
 * `input-required` is not terminal for a server, because the server is the
 * side that can receive the input and carry on. It is terminal for this
 * client, which has no channel to supply it — so the peer will sit in that
 * state forever and polling it is polling a state that cannot change.
 *
 * Reusing the server's set here cost a test timeout to find, and it would
 * have cost a real delegation the full ten-minute deadline for a peer that
 * had already answered "which quarter?" in the first second.
 */
const WILL_NOT_PROGRESS: ReadonlySet<string> = new Set([...TERMINAL_STATES, 'input-required'])

/** The text of every text part, in order. */
function textOf(message: A2AMessage | undefined): string | undefined {
	if (!message) return undefined
	const text = message.parts
		.filter((part): part is Extract<typeof part, { kind: 'text' }> => part.kind === 'text')
		.map((part) => part.text)
		.join('\n')
	return text.length > 0 ? text : undefined
}

/**
 * A peer's terminal task, as a delegate outcome.
 *
 * `input-required` is the interesting one. It is not a failure — the peer
 * did its work and is waiting for something — but `DelegateResult` has no
 * state for it, and inventing `completed` would hand the parent a
 * half-answer as though it were the answer. So it reports `failed` and SAYS
 * that is what happened, which is the honest reading: this delegate has no
 * channel to supply the input, so from the parent's side the delegation did
 * not produce a result.
 */
function toDelegateResult(task: A2ATask): DelegateResult {
	const message = textOf(task.status.message)
	const artifacts = (task.artifacts ?? [])
		.map((artifact) => textOf({ role: 'agent', parts: artifact.parts }))
		.filter((text): text is string => text !== undefined)
	// Artifacts first: a peer that produced one put its answer there, and the
	// status message is usually a sentence about the answer rather than the
	// answer itself.
	const output = artifacts.length > 0 ? artifacts.join('\n\n') : message

	switch (task.status.state) {
		case 'completed':
			return { status: 'completed', ...(output === undefined ? {} : { output }) }
		case 'canceled':
			return { status: 'cancelled', ...(output === undefined ? {} : { output }) }
		case 'input-required':
			return {
				status: 'failed',
				...(output === undefined ? {} : { output }),
				error: 'The peer is waiting for more input, and this delegate has no channel to supply it.',
			}
		default:
			return {
				status: 'failed',
				...(output === undefined ? {} : { output }),
				error: message ?? `The peer reported ${task.status.state}.`,
			}
	}
}

export class A2ADelegate implements Delegate {
	readonly id: string
	readonly capabilities: DelegateCapabilities

	private readonly endpoint: string
	private readonly pollIntervalMs: number
	private readonly timeoutMs: number

	constructor(private readonly config: A2ADelegateConfig) {
		this.pollIntervalMs = resolveTimerMs(
			config.pollIntervalMs,
			DEFAULT_POLL_MS,
			'pollIntervalMs',
			false,
		)
		this.timeoutMs = resolveTimerMs(config.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', false)
		this.id = config.id
		const target = config.card.supportedInterfaces.find((i) => i.transport === 'jsonrpc')
		if (!target) {
			// Refused at construction. `supportedInterfaces` is what the card
			// exists to tell us, and a peer offering only gRPC is a peer this
			// client cannot talk to — discovering that mid-delegation would
			// waste a run's time on a wiring mistake.
			throw new InvalidAgentCardError({
				url: config.card.supportedInterfaces[0]?.url ?? '(no interface)',
				reason: 'no jsonrpc interface; this client speaks jsonrpc only',
			})
		}
		this.endpoint = target.url
		this.capabilities = {
			// Always offered: `tasks/cancel` is in the A2A method set, and a
			// peer that will not cancel a particular task answers
			// `TaskNotCancelable`, which surfaces as an error rather than as a
			// silent no-op.
			cancel: true,
			// NOT offered. A2A's `message/send` with an existing task id can
			// continue a conversation, but this delegate holds one task per
			// dispatch and `Delegate.continue` is fire-and-forget with no way
			// to report that the peer refused. Claiming it would be the
			// silent-no-op the seam refuses.
			continue: false,
		}
	}

	private async rpc(method: A2AMethod, params: unknown, signal: AbortSignal): Promise<unknown> {
		const response = await this.config.fetch(this.endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				...this.config.headers,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${this.id}`, method, params }),
			signal,
		})
		if (!response.ok) {
			throw new A2ARequestError(`${method} failed with HTTP ${response.status}`, {
				method,
				status: response.status,
			})
		}
		const body = (await response.json()) as {
			result?: unknown
			error?: { code?: string | number; message?: string }
		}
		if (body.error) {
			throw new A2ARequestError(body.error.message ?? `${method} was refused`, {
				method,
				...(body.error.code === undefined ? {} : { code: String(body.error.code) }),
			})
		}
		return body.result
	}

	/** Bounded best effort; cancellation is never allowed to create a second hang. */
	private async cancelPeer(taskId: string): Promise<void> {
		const boundary = operationBoundary({
			timeoutMs: PEER_CANCEL_GRACE_MS,
			timeoutMessage: `A2A tasks/cancel timed out after ${PEER_CANCEL_GRACE_MS}ms`,
			abortTransportInitially: true,
		})
		try {
			await boundary.wait(this.rpc('tasks/cancel', { id: taskId }, boundary.signal))
		} catch {
			// Best-effort courtesy on a path already unwinding. A refusal or an
			// unreachable peer does not reverse the caller's stop or deadline.
		} finally {
			boundary.dispose()
		}
	}

	/** A client-terminal state may still be live on the peer. */
	private async settleKnownTask(task: A2ATask): Promise<DelegateResult> {
		if (!TERMINAL_STATES.has(task.status.state)) await this.cancelPeer(task.id)
		return toDelegateResult(task)
	}

	/**
	 * Give an in-flight `message/send` one short chance to reveal its task id.
	 *
	 * Aborting that first transport immediately can abandon remote work while
	 * claiming cancellation locally. A2A cannot address a task until the peer
	 * returns its id, so this bounded grace is the only honest cleanup attempt.
	 */
	private async recoverInitialTask(
		request: Promise<unknown>,
	): Promise<{ readonly taskId?: string; readonly task?: A2ATask }> {
		let timer: ReturnType<typeof setTimeout> | undefined
		const expired = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), PEER_CANCEL_GRACE_MS)
		})
		try {
			const recovered = await Promise.race([
				request.then(
					(value) => value,
					() => undefined,
				),
				expired,
			])
			if (recovered === undefined) return {}
			const taskId = taskIdOf(recovered)
			try {
				const task = this.parseTask(recovered, 'message/send')
				return { taskId: task.id, task }
			} catch {
				// The answer remains unusable, but a non-empty string id is enough
				// authority to address `tasks/cancel`. Throwing that id away because
				// an unrelated status/artifact field was malformed orphans work.
				return taskId === undefined ? {} : { taskId }
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer)
		}
	}

	private parseTask(raw: unknown, method: A2AMethod, expectedTaskId?: string): A2ATask {
		const parsed = A2ATaskSchema.safeParse(raw)
		if (!parsed.success || taskIdOf(parsed.data) === undefined) {
			// Validated rather than trusted. This is a foreign service's reply
			// being turned into a result the model will read as an answer, and
			// the difference between a malformed task and a task in a state we
			// mishandle is exactly what a parse tells us.
			throw new A2ARequestError(`${method} returned something that is not an A2A task`, {
				method,
			})
		}
		if (expectedTaskId !== undefined && parsed.data.id !== expectedTaskId) {
			throw new A2ARequestError(
				`${method} returned task ${parsed.data.id} for requested task ${expectedTaskId}`,
				{ method },
			)
		}
		return parsed.data as A2ATask
	}

	async dispatch(
		request: DelegateRequest,
		opts: { readonly signal?: AbortSignal },
	): Promise<DelegateResult> {
		if (opts.signal?.aborted) return { status: 'cancelled' }
		const boundary = operationBoundary({
			callerSignal: opts.signal,
			timeoutMs: this.timeoutMs,
			timeoutMessage: `A2A delegation timed out after ${this.timeoutMs}ms`,
			// `message/send` has not returned an addressable task id yet. Hold
			// transport abort for one bounded cleanup attempt if cancellation wins.
			abortTransportInitially: false,
		})
		let initialRequest: Promise<unknown> | undefined
		let sent: A2ATask | undefined
		let latest: A2ATask | undefined
		let taskId: string | undefined
		try {
			boundary.throwIfStopped()
			initialRequest = this.rpc(
				'message/send',
				{ message: { role: 'user', parts: [{ kind: 'text', text: request.prompt }] } },
				boundary.signal,
			)
			const initialReply = await boundary.wait(initialRequest)
			taskId = taskIdOf(initialReply)
			sent = this.parseTask(initialReply, 'message/send')
			latest = sent
			if (WILL_NOT_PROGRESS.has(latest.status.state)) return await this.settleKnownTask(latest)
			// From this point onward the peer has given us an id. Abort pending
			// poll transport immediately, then address the remote task separately.
			boundary.armTransportAbort()
			boundary.throwIfStopped()
			while (!WILL_NOT_PROGRESS.has(latest.status.state)) {
				await boundary.wait(sleep(this.pollIntervalMs, boundary.signal))
				latest = this.parseTask(
					await boundary.wait(this.rpc('tasks/get', { id: sent.id }, boundary.signal)),
					'tasks/get',
					sent.id,
				)
			}
			return await this.settleKnownTask(latest)
		} catch (err) {
			if (!(err instanceof OperationInterrupted)) {
				// A protocol/HTTP/body failure does not prove a task that was already
				// accepted by the peer stopped. Once we know its id, clean it up
				// under the same bounded best-effort path, then preserve the original
				// failure for the caller.
				if (
					taskId !== undefined &&
					(latest === undefined || !WILL_NOT_PROGRESS.has(latest.status.state))
				) {
					await this.cancelPeer(taskId)
				}
				throw err
			}

			if (sent === undefined && initialRequest !== undefined) {
				const recovered = await this.recoverInitialTask(initialRequest)
				sent = recovered.task
				latest = sent
				taskId = recovered.taskId
				boundary.abortTransport()
			}
			if (
				taskId !== undefined &&
				(latest === undefined || !WILL_NOT_PROGRESS.has(latest.status.state))
			) {
				await this.cancelPeer(taskId)
			}

			if (err.cause.kind === 'caller') return { status: 'cancelled' }
			return {
				status: 'failed',
				error:
					sent === undefined
						? `The peer did not return a task id before the ${this.timeoutMs}ms delegation deadline; its remote outcome is unknown.`
						: `The peer was still ${latest?.status.state ?? sent.status.state} after ${this.timeoutMs}ms.`,
			}
		} finally {
			boundary.dispose()
		}
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted()
	return new Promise((resolve, reject) => {
		let settled = false
		const cleanup = (): void => signal.removeEventListener('abort', onAbort)
		const onAbort = (): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			cleanup()
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			cleanup()
			resolve()
		}, ms)
		signal.addEventListener('abort', onAbort, { once: true })
		if (signal.aborted) onAbort()
	})
}
