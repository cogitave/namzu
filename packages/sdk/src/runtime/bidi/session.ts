import { NAMZU } from '../../constants/telemetry/index.js'
import type {
	BidiConnectParams,
	BidiProvider,
	BidiRunEvent,
	BidiSession,
} from '../../types/bidi/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { ToolContext, ToolRegistryContract } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateRunId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export class BidiSessionCloseTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(
			`Duplex provider session close did not settle within ${timeoutMs}ms. The local run is fenced and its tool authority was revoked, but provider cleanup is still unconfirmed.`,
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

export interface BidiRunParams {
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
	/** Overrides the generated id, so a host can correlate its own. */
	readonly runId?: RunId
}

export interface BidiRun {
	readonly runId: RunId
	/** What the loop reports, in order. Ends when the session closes. */
	events(): AsyncIterable<BidiRunEvent>
	/** Push input from the human. */
	send(input: Parameters<BidiSession['send']>[0]): Promise<void>
	/**
	 * Fence the local run immediately, abort tool contexts and close the
	 * provider once. It does not wait for tool code that ignores cancellation;
	 * provider cleanup is observed for `BidiRunParams.closeTimeoutMs`.
	 */
	close(): Promise<void>
}

export async function startBidiRun(params: BidiRunParams): Promise<BidiRun> {
	params.signal?.throwIfAborted()
	const closeTimeoutMs = params.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
	if (
		!Number.isInteger(closeTimeoutMs) ||
		closeTimeoutMs < 0 ||
		closeTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new RangeError(
			`BidiRunParams.closeTimeoutMs must be an integer from 0 through ${MAX_TIMER_DELAY_MS}`,
		)
	}
	const runId = params.runId ?? generateRunId()
	const log = resolveLogger(params.log).child({
		[SCOPE_ATTRIBUTE]: 'runtime/bidi/session',
		[NAMZU.RUN_ID]: runId,
	})
	const lifetime = new AbortController()
	const queue: BidiRunEvent[] = []
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

	const emit = (event: BidiRunEvent): boolean => {
		if (closed) return false
		queue.push(event)
		wake?.()
		return true
	}

	const executeCall = async (call: { id: string; name: string; arguments: string }) => {
		const startedUnder = generation
		if (!emit({ type: 'tool_started', runId, toolUseId: call.id, toolName: call.name })) {
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
				runId,
				workingDirectory: params.workingDirectory,
				abortSignal: lifetime.signal,
				env: params.env ?? {},
				log: (level, message) => log[level](message),
				toolUseId: call.id,
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
			emit({ type: 'tool_abandoned', runId, toolUseId: call.id, toolName: call.name })
			return
		}

		// Entering the provider send is the publication commit point. A later
		// conversational interruption cannot recall a write already handed to
		// the provider, but closing the run still closes the whole session and
		// fences the local terminal event.
		await activeSession.sendToolResult(call.id, output, isError)
		if (closed) return
		emit({
			type: 'tool_completed',
			runId,
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
						emit({ type: 'text', runId, text: event.text })
						break
					case 'audio':
						emit({ type: 'audio', runId, data: event.data, mediaType: event.mediaType })
						break
					case 'tool_call': {
						if (executionIds.has(event.id)) {
							const error = new Error(
								`Duplex provider repeated tool-call id "${event.id}". Re-executing it could repeat a side effect, so the session was closed.`,
							)
							emit({ type: 'error', runId, message: error.message })
							beginClose(error, true)
							break
						}
						executionIds.add(event.id)
						// Started, not awaited: awaiting here would stall the very
						// stream an interruption arrives on.
						void executeCall(event).catch((err: unknown) => {
							emit({ type: 'error', runId, message: toErrorMessage(err) })
						})
						break
					}
					case 'turn_complete':
						emit({ type: 'turn_complete', runId })
						break
					case 'interrupted':
						generation++
						emit({ type: 'interrupted', runId })
						break
					case 'error':
						emit({ type: 'error', runId, message: event.message })
						break
					case 'closed':
						emit({
							type: 'closed',
							runId,
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
				emit({ type: 'error', runId, message: toErrorMessage(err) })
				beginClose(err, true)
			}
		} finally {
			if (!closed) beginClose(new Error('the duplex provider event stream ended'), true)
		}
	})()
	void pump.catch(() => undefined)

	async function* events(): AsyncIterable<BidiRunEvent> {
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
		runId,
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
