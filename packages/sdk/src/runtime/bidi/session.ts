import { NAMZU } from '../../constants/telemetry/index.js'
import type {
	BidiConnectParams,
	BidiProvider,
	BidiSession,
	BidiTurnEvent,
} from '../../types/bidi/index.js'
import type { ToolResultGuardrailSpec } from '../../types/guardrail/index.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { ToolContext, ToolRegistryContract } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateSessionId, generateTurnId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { DEFAULT_TOOL_RESULT_GUARDRAILS } from '../query/guardrail-presets.js'

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export class BidiSessionCloseTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(
			`Duplex provider session close did not settle within ${timeoutMs}ms. The local turn is fenced and its tool authority was revoked, but provider cleanup is still unconfirmed.`,
		)
		this.name = 'BidiSessionCloseTimeoutError'
	}
}

async function waitForProviderClose(pending: Promise<void>, timeoutMs: number): Promise<void> {
	if (timeoutMs === 0) return await pending
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new BidiSessionCloseTimeoutError(timeoutMs)), timeoutMs)
		timer.unref?.()
	})
	try {
		await Promise.race([pending, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/**
 * Run tools for a duplex session.
 *
 * The turn-based loop can execute a batch of calls because it knows when
 * the batch is complete: the model stopped talking. Here nothing stops.
 * Two consequences shape everything below.
 *
 * **A tool must not block the stream.** The model keeps producing while a
 * tool runs, and the human keeps talking. Awaiting a tool inline would
 * stall the events that the interruption arrives on — so the loop would
 * only notice it was interrupted after finishing work the interruption
 * made pointless.
 *
 * **An interruption invalidates work in flight.** When the human speaks
 * over the model, a tool the model asked for is answering a question
 * nobody is asking. Sending its result anyway would put a stale answer
 * into a conversation that has moved on, so a call that was running when
 * the interruption arrived is abandoned rather than delivered.
 */

export interface BidiTurnParams {
	readonly provider: BidiProvider
	readonly tools: ToolRegistryContract
	readonly connect: BidiConnectParams
	readonly workingDirectory: string
	readonly env?: Record<string, string>
	/**
	 * Owns the complete run lifetime, not only connection establishment.
	 * Aborting it closes the provider session, ends local events and revokes
	 * every tool context without mutating the caller-owned controller.
	 */
	readonly signal?: AbortSignal
	/**
	 * How long `close()` waits for provider cleanup after fencing locally.
	 * Defaults to five seconds. `0` preserves an unbounded provider-close wait.
	 */
	readonly closeTimeoutMs?: number
	readonly log?: Logger
	/** The session this duplex turn belongs to. Absent: a new session id is generated. */
	readonly sessionId?: SessionId
	/** Overrides the generated turn id, so a host can correlate its own. */
	readonly turnId?: TurnId
	/**
	 * Screens for the results this session's tools produce. Absent installs
	 * {@link DEFAULT_TOOL_RESULT_GUARDRAILS}; an empty array installs none.
	 *
	 * Here rather than nowhere because this path builds its OWN tool context:
	 * a duplex session executes the tools the model asks for, and its results
	 * reach a model just as a turn's do. A registry built with
	 * `resultGuardrails` still wins, as it does on the query path.
	 */
	readonly toolResultGuardrails?: readonly ToolResultGuardrailSpec[]
}

export interface BidiTurn {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	/** What the loop reports, in order. Ends when the session closes. */
	events(): AsyncIterable<BidiTurnEvent>
	/** Push input from the human. */
	send(input: Parameters<BidiSession['send']>[0]): Promise<void>
	/**
	 * Fence the local turn immediately, abort tool contexts and close the
	 * provider once. It does not wait for tool code that ignores cancellation;
	 * provider cleanup is observed for `BidiTurnParams.closeTimeoutMs`.
	 */
	close(): Promise<void>
}

export async function startBidiTurn(params: BidiTurnParams): Promise<BidiTurn> {
	params.signal?.throwIfAborted()
	const closeTimeoutMs = params.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
	if (
		!Number.isInteger(closeTimeoutMs) ||
		closeTimeoutMs < 0 ||
		closeTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new RangeError(
			`BidiTurnParams.closeTimeoutMs must be an integer from 0 through ${MAX_TIMER_DELAY_MS}`,
		)
	}
	const sessionId = params.sessionId ?? generateSessionId()
	const turnId = params.turnId ?? generateTurnId()
	const log = resolveLogger(params.log).child({
		[SCOPE_ATTRIBUTE]: 'runtime/bidi/session',
		[NAMZU.SESSION_ID]: sessionId,
		[NAMZU.TURN_ID]: turnId,
	})
	const lifetime = new AbortController()
	const queue: BidiTurnEvent[] = []
	let wake: (() => void) | undefined
	let closed = false
	let session: BidiSession | undefined
	let transportCloseRequested = false
	let transportClosePromise: Promise<void> | undefined

	const requestTransportClose = (): Promise<void> => {
		transportCloseRequested = true
		if (!session) return Promise.resolve()
		if (!transportClosePromise) {
			const ownedSession = session
			transportClosePromise = Promise.resolve().then(async () => await ownedSession.close())
		}
		return transportClosePromise
	}

	const beginClose = (reason: unknown, closeTransport: boolean): void => {
		if (!closed) {
			closed = true
			lifetime.abort(reason)
			wake?.()
		}
		if (closeTransport) {
			void requestTransportClose().catch((error: unknown) => {
				log.warn('Duplex provider session close failed', {
					'exception.message': toErrorMessage(error),
				})
			})
		}
	}

	const onCallerAbort = (): void => beginClose(params.signal?.reason, true)
	params.signal?.addEventListener('abort', onCallerAbort, { once: true })
	lifetime.signal.addEventListener(
		'abort',
		() => params.signal?.removeEventListener('abort', onCallerAbort),
		{ once: true },
	)

	const connecting = Promise.resolve()
		.then(
			async () =>
				await params.provider.connect({
					...params.connect,
					signal: lifetime.signal,
				}),
		)
		.then((connected) => {
			session = connected
			if (transportCloseRequested) {
				void requestTransportClose().catch((error: unknown) => {
					log.warn('Late duplex provider session close failed', {
						'exception.message': toErrorMessage(error),
					})
				})
			}
			return connected
		})

	let removeConnectAbort: (() => void) | undefined
	const connectionAbort = new Promise<never>((_, reject) => {
		const rejectFromLifetime = () => reject(lifetime.signal.reason)
		removeConnectAbort = () => lifetime.signal.removeEventListener('abort', rejectFromLifetime)
		if (lifetime.signal.aborted) rejectFromLifetime()
		else lifetime.signal.addEventListener('abort', rejectFromLifetime, { once: true })
	})

	let activeSession: BidiSession
	try {
		activeSession = await Promise.race([connecting, connectionAbort])
		lifetime.signal.throwIfAborted()
	} catch (error) {
		removeConnectAbort?.()
		params.signal?.removeEventListener('abort', onCallerAbort)
		if (lifetime.signal.aborted) {
			void connecting.catch(() => undefined)
			throw lifetime.signal.reason
		}
		throw error
	}
	removeConnectAbort?.()

	// One generation of work. Bumped by every interruption, so a tool that
	// started under an older generation knows its answer is stale without
	// needing a handle on the call that cancelled it.
	let generation = 0
	const executionIds = new Set<string>()

	const emit = (event: BidiTurnEvent): boolean => {
		if (closed) return false
		queue.push(event)
		wake?.()
		return true
	}

	const executeCall = async (call: { id: string; name: string; arguments: string }) => {
		const startedUnder = generation
		if (
			!emit({ type: 'tool_started', sessionId, turnId, toolUseId: call.id, toolName: call.name })
		) {
			return
		}

		let output: string
		let isError = false
		try {
			let input: unknown
			try {
				input = JSON.parse(call.arguments || '{}')
			} catch {
				input = {}
			}
			const context: ToolContext = {
				sessionId,
				turnId,
				workingDirectory: params.workingDirectory,
				abortSignal: lifetime.signal,
				env: params.env ?? {},
				log: (level, message) => log[level](message),
				toolUseId: call.id,
				toolResultGuardrails: params.toolResultGuardrails ?? DEFAULT_TOOL_RESULT_GUARDRAILS,
			}
			const result = await params.tools.execute(call.name, input, context)
			output = result.success ? result.output : (result.error ?? 'the tool failed')
			isError = !result.success
		} catch (err) {
			output = toErrorMessage(err)
			isError = true
		}

		if (closed) return
		if (startedUnder !== generation) {
			// The human spoke over the model while this ran. Delivering the
			// answer now would put it in a conversation that has moved on.
			emit({ type: 'tool_abandoned', sessionId, turnId, toolUseId: call.id, toolName: call.name })
			return
		}

		// Entering the provider send is the publication commit point. A later
		// conversational interruption cannot recall a write already handed to
		// the provider, but closing the turn still closes the whole session and
		// fences the local terminal event.
		await activeSession.sendToolResult(call.id, output, isError)
		if (closed) return
		emit({
			type: 'tool_completed',
			sessionId,
			turnId,
			toolUseId: call.id,
			toolName: call.name,
			output,
			isError,
		})
	}

	const pump = (async () => {
		try {
			for await (const event of activeSession.events()) {
				if (closed) break
				switch (event.type) {
					case 'text':
						emit({ type: 'text', sessionId, turnId, text: event.text })
						break
					case 'audio':
						emit({ type: 'audio', sessionId, turnId, data: event.data, mediaType: event.mediaType })
						break
					case 'tool_call': {
						if (executionIds.has(event.id)) {
							const error = new Error(
								`Duplex provider repeated tool-call id "${event.id}". Re-executing it could repeat a side effect, so the session was closed.`,
							)
							emit({ type: 'error', sessionId, turnId, message: error.message })
							beginClose(error, true)
							break
						}
						executionIds.add(event.id)
						// Started, not awaited: awaiting here would stall the very
						// stream an interruption arrives on.
						void executeCall(event).catch((err: unknown) => {
							emit({ type: 'error', sessionId, turnId, message: toErrorMessage(err) })
						})
						break
					}
					case 'turn_complete':
						emit({ type: 'turn_complete', sessionId, turnId })
						break
					case 'interrupted':
						generation++
						emit({ type: 'interrupted', sessionId, turnId })
						break
					case 'error':
						emit({ type: 'error', sessionId, turnId, message: event.message })
						break
					case 'closed':
						emit({
							type: 'closed',
							sessionId,
							turnId,
							...(event.reason !== undefined ? { reason: event.reason } : {}),
						})
						beginClose(new Error(event.reason ?? 'the duplex provider session closed'), false)
						break
					default: {
						const _exhaustive: never = event
						throw new Error(`Unknown BidiEvent: ${JSON.stringify(_exhaustive)}`)
					}
				}
				if (closed) break
			}
		} catch (err) {
			if (!closed) {
				emit({ type: 'error', sessionId, turnId, message: toErrorMessage(err) })
				beginClose(err, true)
			}
		} finally {
			if (!closed) beginClose(new Error('the duplex provider event stream ended'), true)
		}
	})()
	void pump.catch(() => undefined)

	async function* events(): AsyncIterable<BidiTurnEvent> {
		while (true) {
			while (queue.length > 0) {
				const next = queue.shift()
				if (next) yield next
			}
			if (closed) return
			await new Promise<void>((resolve) => {
				wake = resolve
			})
			wake = undefined
		}
	}

	return {
		sessionId,
		turnId,
		events,
		send: async (input) => {
			lifetime.signal.throwIfAborted()
			// As with tool results, entering the provider send is the atomic
			// publication boundary. A caller must not retry merely because the
			// lifetime changed after the provider accepted the input.
			await activeSession.send(input)
		},
		close: async () => {
			beginClose(new Error('the duplex run was closed by its host'), true)
			await waitForProviderClose(requestTransportClose(), closeTimeoutMs)
		},
	}
}
