import { type BaseEvent, EventType, type RunAgentInput, RunAgentInputSchema } from '@ag-ui/core'
import { EventEncoder } from '@ag-ui/encoder'
import {
	type Origin,
	type QueryParams,
	type SessionEvent,
	type SessionId,
	type SessionIndex,
	type Turn,
	generateSessionId,
	isEntityId,
	isTurnInProgressError,
	query,
} from '@namzu/sdk'
import { AGUIRequestError } from './errors.js'
import { AGUIEventMapper } from './events.js'
import { AGUIRunUI, type AGUIRunUIOptions, positiveLimit } from './ui.js'

/**
 * The namzu session an AG-UI `threadId` names.
 *
 * A thread is a session and a run is one turn of it. The thread id is the
 * client's string: it reaches a session when it is an existing session id or
 * when a session already claimed it, and otherwise names a new session. The
 * adapter records the thread (and the run) on the turn's `origin`, which is
 * how the index learns the mapping, so a second run on the thread finds the
 * same session even after the index is rebuilt.
 */
export interface AGUISessionResolution {
	readonly sessionId: SessionId
	/** True when no session has this thread yet: the host is starting one. */
	readonly created: boolean
}

export interface AGUIRunContext {
	/** Validated wire input. It remains untrusted application data. */
	readonly input: RunAgentInput
	readonly signal: AbortSignal
	readonly ui: AGUIRunUI
	/** HTTP request headers remain available to the host's authentication/scope resolver. */
	readonly request?: Request
	/**
	 * The session `input.threadId` resolved to, when the adapter was given a
	 * session index (`AGUIAdapterOptions.sessions`). Build the query on this
	 * `sessionId` so the run continues the thread's session.
	 */
	readonly session?: AGUISessionResolution
}

export type AGUIQueryFactory = (context: AGUIRunContext) => QueryParams | Promise<QueryParams>

export interface AGUIAdapterOptions extends AGUIRunUIOptions {
	/** Resolve authorized scope, tools and admitted history on the host. */
	readonly createQuery: AGUIQueryFactory
	/** Request JSON byte limit, including streamed/chunked bodies. Defaults to 4 MiB. */
	readonly maxRequestBytes?: number
	/** Observe host/transport exceptions. Never copied into the wire response. */
	readonly onError?: (error: unknown) => void
	/**
	 * The session index threads are resolved through. With it, each run's
	 * context carries the `session` its `threadId` names; without it the host
	 * picks the session in `createQuery` on its own.
	 */
	readonly sessions?: Pick<SessionIndex, 'getSession' | 'resolveExternal'>
	/** Mints the id of a new session for an unknown thread. Defaults to the SDK's generator. */
	readonly newSessionId?: () => SessionId
}

/**
 * `QueryParams` with the turn's origin. The adapter always sets it: it is the
 * record of which thread and which client run this turn serves.
 */
type TurnQueryParams = QueryParams & { origin?: Origin }

export interface AGUIRunOptions {
	readonly signal?: AbortSignal
}

interface PreparedRequest {
	readonly input: RunAgentInput
	readonly params: TurnQueryParams
	readonly ui: AGUIRunUI
	readonly controller: AbortController
	readonly signal: AbortSignal
	readonly detach: () => void
}

/** AG-UI on top of the Namzu kernel, usable in any Fetch-compatible HTTP framework. */
export class AGUIAdapter {
	private readonly maxRequestBytes: number
	private readonly maxEventBytes: number

	constructor(private readonly options: AGUIAdapterOptions) {
		this.maxRequestBytes = positiveLimit(options.maxRequestBytes, 4_194_304, 'maxRequestBytes')
		this.maxEventBytes = positiveLimit(options.maxEventBytes, 1_048_576, 'maxEventBytes')
		if (this.maxEventBytes < 256) throw new RangeError('maxEventBytes must be at least 256')
		positiveLimit(options.maxPendingEvents, 128, 'maxPendingEvents')
	}

	async *run(input: RunAgentInput, options: AGUIRunOptions = {}): AsyncGenerator<BaseEvent> {
		const prepared = await this.prepare(input, options.signal)
		yield* this.events(prepared)
	}

	async handle(request: Request): Promise<Response> {
		try {
			if (request.method !== 'POST')
				return this.errorResponse(new AGUIRequestError('Use POST for an AG-UI run.', 405))
			if (
				request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
				'application/json'
			)
				throw new AGUIRequestError('Content-Type must be application/json.', 415)
			if (!acceptsSSE(request.headers.get('accept')))
				throw new AGUIRequestError('This endpoint produces text/event-stream.', 406)
			const input = await readJSON(request, this.maxRequestBytes)
			const prepared = await this.prepare(input, request.signal, request)
			const iterator = this.events(prepared)
			const encoder = new EventEncoder()
			const utf8 = new TextEncoder()
			let canceled = false
			const body = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						try {
							const next = await iterator.next()
							if (canceled) return
							if (next.done) controller.close()
							else controller.enqueue(utf8.encode(encoder.encodeSSE(next.value)))
						} catch (error) {
							if (!canceled) controller.error(error)
						}
					},
					async cancel(reason) {
						canceled = true
						prepared.controller.abort(reason)
						prepared.ui.close()
						prepared.detach()
						await iterator.return(undefined)
					},
				},
				{ highWaterMark: 0 },
			)
			return new Response(body, {
				headers: {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-cache, no-transform',
					'x-accel-buffering': 'no',
				},
			})
		} catch (error) {
			if (error instanceof AGUIRequestError) return this.errorResponse(error)
			this.report(error)
			return this.errorResponse(
				new AGUIRequestError('Unable to start the Namzu turn.', 500, 'RUN_SETUP_FAILED'),
			)
		}
	}

	private async prepare(
		value: unknown,
		externalSignal?: AbortSignal,
		request?: Request,
	): Promise<PreparedRequest> {
		externalSignal?.throwIfAborted()
		const parsed = RunAgentInputSchema.safeParse(value)
		if (!parsed.success) throw new AGUIRequestError('Invalid AG-UI RunAgentInput.', 422)
		const input = parsed.data
		if (!input.threadId.trim() || !input.runId.trim())
			throw new AGUIRequestError('threadId and runId must be non-empty strings.')
		if (
			Buffer.byteLength(
				JSON.stringify({
					type: EventType.RUN_STARTED,
					threadId: input.threadId,
					runId: input.runId,
				}),
			) > this.maxEventBytes
		)
			throw new AGUIRequestError('Run identity exceeds maxEventBytes.')
		if (input.tools.length > 0)
			throw new AGUIRequestError(
				'Frontend tool execution is not supported by this adapter.',
				422,
				'UNSUPPORTED_FRONTEND_TOOLS',
			)
		if (input.resume?.length)
			throw new AGUIRequestError(
				'AG-UI interrupt resumption is not supported by this adapter.',
				422,
				'UNSUPPORTED_RESUME',
			)
		const controller = new AbortController()
		const signal = externalSignal
			? AbortSignal.any([externalSignal, controller.signal])
			: controller.signal
		let ui: AGUIRunUI
		try {
			ui = new AGUIRunUI(input.state, this.options)
		} catch {
			throw new AGUIRequestError('Initial state must be JSON within maxEventBytes.', 422)
		}
		const closeUI = () => ui.close()
		signal.addEventListener('abort', closeUI, { once: true })
		try {
			const session = this.options.sessions
				? await abortable(this.resolveThread(input.threadId, this.options.sessions), signal)
				: undefined
			const params = await abortable(
				Promise.resolve(
					this.options.createQuery({
						input,
						signal,
						ui,
						...(request ? { request } : {}),
						...(session ? { session } : {}),
					}),
				),
				signal,
			)
			signal.throwIfAborted()
			ui.sealInitialMessages()
			// Wire IDs are correlation strings, never filesystem keys or trusted
			// kernel scope. They reach the kernel only as the turn's origin: the
			// client's thread and run, recorded verbatim so the index can map a
			// later run on this thread back to its session. The turn id itself
			// is minted by the kernel when the turn begins.
			const nativeSignal = params.signal ? AbortSignal.any([params.signal, signal]) : signal
			if (nativeSignal !== signal) nativeSignal.addEventListener('abort', closeUI, { once: true })
			if (nativeSignal.aborted) closeUI()
			return {
				input,
				ui,
				controller,
				signal: nativeSignal,
				detach: () => {
					signal.removeEventListener('abort', closeUI)
					nativeSignal.removeEventListener('abort', closeUI)
				},
				params: {
					...params,
					origin: {
						protocol: 'ag-ui',
						kind: 'prompt',
						externalSessionId: input.threadId,
						externalTurnId: input.runId,
					},
					signal: nativeSignal,
				},
			}
		} catch (error) {
			controller.abort(error)
			ui.close()
			signal.removeEventListener('abort', closeUI)
			throw error
		}
	}

	private async *events(prepared: PreparedRequest): AsyncGenerator<BaseEvent> {
		const { input, params, controller, signal, ui } = prepared
		const mapper = new AGUIEventMapper({
			threadId: input.threadId,
			runId: input.runId,
			sessionId: params.sessionId,
		})
		let source: AsyncGenerator<SessionEvent, Turn> | undefined
		let sourceDone = false
		let pendingRead: Promise<void> | undefined
		let native: { next: IteratorResult<SessionEvent, Turn> } | { error: unknown } | undefined
		let terminalEvents: BaseEvent[] | undefined
		let undeliveredClosures: BaseEvent[] = []
		let terminalDelivered = false
		const visibleParts = new Set<string>()
		const part = (event: BaseEvent): { key: string; start: boolean } | undefined => {
			switch (event.type) {
				case EventType.TEXT_MESSAGE_START:
					return { key: `message:${String(event.messageId)}`, start: true }
				case EventType.TEXT_MESSAGE_END:
					return { key: `message:${String(event.messageId)}`, start: false }
				case EventType.TOOL_CALL_START:
					return { key: `tool:${String(event.toolCallId)}`, start: true }
				case EventType.TOOL_CALL_END:
					return { key: `tool:${String(event.toolCallId)}`, start: false }
				case EventType.STEP_STARTED:
					return { key: `step:${String(event.stepName)}`, start: true }
				case EventType.STEP_FINISHED:
					return { key: `step:${String(event.stepName)}`, start: false }
				default:
					return undefined
			}
		}
		const deliver = function* (this: AGUIAdapter, events: BaseEvent[]): Generator<BaseEvent> {
			undeliveredClosures = events.filter((event) => part(event)?.start === false)
			for (const event of events) {
				this.checked(event)
				const boundary = part(event)
				if (boundary?.start) visibleParts.add(boundary.key)
				else if (boundary) visibleParts.delete(boundary.key)
				if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR)
					terminalDelivered = true
				undeliveredClosures = undeliveredClosures.filter((closing) => closing !== event)
				yield event
			}
		}.bind(this)
		const wake = new WakeSignal()
		const detach = ui.onEvent(() => wake.notify())
		const pull = (): void => {
			pendingRead = source?.next().then(
				(next) => {
					native = { next }
					wake.notify()
				},
				(error: unknown) => {
					native = { error }
					wake.notify()
				},
			)
		}
		try {
			signal.throwIfAborted()
			yield* deliver(mapper.start())
			for (const event of ui.drain()) yield this.checked(event)
			source = query(params)
			pull()
			while (!sourceDone) {
				signal.throwIfAborted()
				for (const event of ui.drain()) yield this.checked(event)
				const outcome = native
				if (!outcome) {
					await wake.wait(signal)
					continue
				}
				native = undefined
				if ('error' in outcome) throw outcome.error
				if (outcome.next.done) {
					sourceDone = true
					yield* deliver(terminalEvents ?? mapper.finish())
					break
				}
				if (!mapper.ended) {
					const mapped = mapper.map(outcome.next.value)
					// query() finalizes persistence after its terminal event. Drain it
					// naturally before telling the client the run succeeded.
					if (mapper.ended) terminalEvents = mapped
					else yield* deliver(mapped)
				}
				pull()
			}
		} catch (error) {
			const canceled = signal.aborted
			// One active turn per session: a second run on a thread whose turn
			// is running, parked or interrupted is refused by the kernel. That
			// is the client's conflict to resolve, not a host failure to report.
			const inProgress = !canceled && isTurnInProgressError(error)
			if (!canceled && !inProgress) this.report(error)
			controller.abort(error)
			if (!terminalDelivered) {
				const message = canceled
					? 'Namzu turn canceled.'
					: inProgress
						? 'This thread already has an active turn. Wait for it to finish, or resume or abandon it.'
						: 'Namzu turn failed.'
				const code = canceled
					? 'NAMZU_TURN_CANCELED'
					: inProgress
						? 'NAMZU_TURN_IN_PROGRESS'
						: 'NAMZU_TURN_ERROR'
				// A mapper can already be terminal when encoding its final payload fails.
				// Complete the parts whose starts reached the client, then send one error.
				const failure = mapper.fail(message, code)
				for (const event of [
					...undeliveredClosures,
					...(terminalEvents?.filter((event) => part(event)?.start === false) ?? []),
					...(failure.length ? failure : [{ type: EventType.RUN_ERROR, message, code }]),
				]) {
					const boundary = part(event)
					if (boundary && !boundary.start && !visibleParts.delete(boundary.key)) continue
					yield this.checked(event)
				}
			}
		} finally {
			if (!sourceDone) controller.abort(signal.reason)
			detach()
			prepared.detach()
			ui.close()
			// Await kernel cleanup even when the HTTP consumer disconnects mid-request.
			try {
				if (source && !sourceDone) {
					await pendingRead
					if (native && 'next' in native && native.next.done) sourceDone = true
					while (!sourceDone) sourceDone = (await source.next()).done === true
				}
			} catch (error) {
				this.report(error)
			}
		}
	}

	/**
	 * A thread id, as the session it names: an existing session id, a thread a
	 * session already claimed, or a new session.
	 */
	private async resolveThread(
		threadId: string,
		sessions: Pick<SessionIndex, 'getSession' | 'resolveExternal'>,
	): Promise<AGUISessionResolution> {
		if (isEntityId(threadId, 'session')) {
			const existing = await sessions.getSession(threadId)
			if (existing) return { sessionId: existing.id, created: false }
		}
		const ref = await sessions.resolveExternal('ag-ui', 'thread', threadId)
		if (ref) return { sessionId: ref.sessionId, created: false }
		const mint = this.options.newSessionId ?? generateSessionId
		return { sessionId: mint(), created: true }
	}

	private checked(event: BaseEvent): BaseEvent {
		if (Buffer.byteLength(JSON.stringify(event)) > this.maxEventBytes)
			throw new RangeError('AG-UI event exceeds maxEventBytes')
		return event
	}

	private report(error: unknown): void {
		try {
			this.options.onError?.(error)
		} catch {
			/* Observability cannot own turn cleanup. */
		}
	}

	private errorResponse(error: AGUIRequestError): Response {
		return Response.json(
			{ error: { code: error.code, message: error.message } },
			{
				status: error.status,
				headers: error.status === 405 ? { allow: 'POST' } : undefined,
			},
		)
	}
}

/** One level-triggered wakeup shared by the two bounded producers. */
class WakeSignal {
	private notified = false
	private resolve?: () => void

	notify(): void {
		this.notified = true
		this.resolve?.()
	}

	async wait(signal: AbortSignal): Promise<void> {
		try {
			if (!this.notified)
				await abortable(
					new Promise<void>((resolve) => {
						this.resolve = resolve
					}),
					signal,
				)
		} finally {
			this.notified = false
			this.resolve = undefined
		}
	}
}

function acceptsSSE(accept: string | null): boolean {
	if (!accept) return true
	let specificity = -1
	let quality = 0
	for (const part of accept.split(',')) {
		const [type, ...parameters] = part.trim().toLowerCase().split(';')
		const rank = ['*/*', 'text/*', 'text/event-stream'].indexOf(type?.trim() ?? '')
		if (rank < 0 || rank < specificity) continue
		const q = parameters.find((parameter) => /^\s*q\s*=/.test(parameter))
		const requested = q ? Number(q.split('=')[1]?.trim()) : 1
		const weight = Number.isFinite(requested) && requested >= 0 && requested <= 1 ? requested : 0
		quality = rank === specificity ? Math.max(quality, weight) : weight
		specificity = rank
	}
	return quality > 0
}

async function readJSON(request: Request, limit: number): Promise<unknown> {
	const length = request.headers.get('content-length')
	if (length && Number(length) > limit)
		throw new AGUIRequestError('AG-UI request exceeds maxRequestBytes.', 413)
	const reader = request.body?.getReader()
	if (!reader) throw new AGUIRequestError('A JSON request body is required.', 400)
	const chunks: Uint8Array[] = []
	let bytes = 0
	try {
		while (true) {
			const next = await abortable(reader.read(), request.signal)
			if (next.done) break
			bytes += next.value.byteLength
			if (bytes > limit) throw new AGUIRequestError('AG-UI request exceeds maxRequestBytes.', 413)
			chunks.push(next.value)
		}
		try {
			return JSON.parse(
				new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
			)
		} catch {
			throw new AGUIRequestError('Request body must be valid JSON.', 400)
		}
	} finally {
		await reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void promise.catch(() => {})
		return Promise.reject(signal.reason)
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener('abort', abort, { once: true })
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
	})
}
