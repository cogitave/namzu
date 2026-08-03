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
import { type Logger, getRootLogger } from '../../utils/logger.js'

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
	readonly signal?: AbortSignal
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
	close(): Promise<void>
}

export async function startBidiRun(params: BidiRunParams): Promise<BidiRun> {
	const runId = params.runId ?? generateRunId()
	const log = (params.log ?? getRootLogger()).child({ component: 'BidiRun', runId })
	const session = await params.provider.connect({
		...params.connect,
		...(params.signal ? { signal: params.signal } : {}),
	})

	// One generation of work. Bumped by every interruption, so a tool that
	// started under an older generation knows its answer is stale without
	// needing a handle on the call that cancelled it.
	let generation = 0
	const inflight = new Set<Promise<void>>()

	const queue: BidiRunEvent[] = []
	let wake: (() => void) | undefined
	const emit = (event: BidiRunEvent) => {
		queue.push(event)
		wake?.()
	}

	const executeCall = async (call: { id: string; name: string; arguments: string }) => {
		const startedUnder = generation
		emit({ type: 'tool_started', runId, toolUseId: call.id, toolName: call.name })

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
				abortSignal: params.signal ?? new AbortController().signal,
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

		if (startedUnder !== generation) {
			// The human spoke over the model while this ran. Delivering the
			// answer now would put it in a conversation that has moved on.
			emit({ type: 'tool_abandoned', runId, toolUseId: call.id, toolName: call.name })
			return
		}

		emit({
			type: 'tool_completed',
			runId,
			toolUseId: call.id,
			toolName: call.name,
			output,
			isError,
		})
		await session.sendToolResult(call.id, output, isError)
	}

	let closed = false
	const pump = (async () => {
		try {
			for await (const event of session.events()) {
				switch (event.type) {
					case 'text':
						emit({ type: 'text', runId, text: event.text })
						break
					case 'audio':
						emit({ type: 'audio', runId, data: event.data, mediaType: event.mediaType })
						break
					case 'tool_call': {
						// Started, not awaited: awaiting here would stall the very
						// stream an interruption arrives on.
						const running = executeCall(event).catch((err: unknown) => {
							emit({ type: 'error', runId, message: toErrorMessage(err) })
						})
						inflight.add(running)
						void running.finally(() => inflight.delete(running))
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
						closed = true
						break
					default: {
						const _exhaustive: never = event
						throw new Error(`Unknown BidiEvent: ${JSON.stringify(_exhaustive)}`)
					}
				}
				if (closed) break
			}
		} catch (err) {
			emit({ type: 'error', runId, message: toErrorMessage(err) })
		} finally {
			closed = true
			// Let a consumer parked on the queue notice the end.
			wake?.()
		}
	})()

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
		send: (input) => session.send(input),
		close: async () => {
			await session.close()
			closed = true
			wake?.()
			// Tools still running are awaited, so a close cannot leave one
			// writing into a session nobody is reading.
			await Promise.allSettled([...inflight])
			await pump.catch(() => undefined)
		},
	}
}
