import { randomUUID } from 'node:crypto'
import {
	type BaseEvent,
	EventType,
	type Interrupt,
	type RunAgentInput,
	RunAgentInputSchema,
} from '@ag-ui/core'
import { EventEncoder } from '@ag-ui/encoder'
import {
	type HITLDecisionRequest,
	type HITLResumeDecision,
	type Origin,
	type QueryParams,
	type ResumeHandler,
	type SessionEvent,
	type SessionId,
	type SessionIndex,
	type ToolCallSummary,
	type ToolDefinition,
	type ToolReviewPrompt,
	type Turn,
	type TurnId,
	abandonTurn,
	createReviewHandler,
	findPendingCheckpoint,
	generateSessionId,
	isEntityId,
	isReviewExempt,
	isTurnInProgressError,
	query,
	resumeSession,
} from '@namzu/sdk'
import { AGUIRequestError } from './errors.js'
import { AGUIEventMapper } from './events.js'
import {
	type AGUIFrontendToolOptions,
	FRONTEND_RESULT_PAUSE,
	type FrontendToolResult,
	admitFrontendTools,
	encodeFrontendResult,
} from './frontend-tools.js'
import {
	type AGUIAnswer,
	type AGUIInterruptRecord,
	type AGUIInterruptStore,
	AGUIResumeError,
	InMemoryAGUIInterruptStore,
	approvalDecision,
	approvalInterrupt,
	confirmationInterrupt,
	handoffInterrupt,
	pausedInterrupt,
	questionDecision,
	questionInterrupt,
	readResume,
} from './interrupts.js'
import { LiveTurn, type Park, fromListener } from './turn.js'
import { AGUITurnUI, type AGUITurnUIOptions, positiveLimit } from './ui.js'

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

/**
 * What a request continues instead of starting a turn.
 *
 * `resume`: it answers the interrupts of the thread's last run. `tool-results`:
 * it answers, with `tool` messages, the frontend tool calls that run left
 * unanswered. Either way the adapter continues the named turn itself; the
 * host's `QueryParams` are used for their scope and, for a turn that paused,
 * for its provider and tools. Their `messages` are not read.
 */
export interface AGUIContinuation {
	readonly kind: 'resume' | 'tool-results'
	readonly sessionId: SessionId
	readonly turnId: TurnId
}

/**
 * How a host sends a decision or a question to the client of this run.
 *
 * Neither is installed for the host: which requests reach the client is the
 * host's policy, stated by where it passes these.
 */
export interface AGUITurnInterrupts {
	/**
	 * A `ResumeHandler` that asks this client whenever a person is needed:
	 *
	 * - `user_question` (`ask_user_question`, `ToolContext.requestPause`): an
	 *   `input_required` interrupt; the turn waits inside the tool.
	 * - `tool_review`: the prompt-mode review policy over `params.tools`, with
	 *   {@link prompt} as the person — reads that need no review run, and the
	 *   rest become `tool_call` interrupts on a paused turn.
	 * - `plan_approval`: a `confirmation` interrupt on a paused turn.
	 * - `iteration_checkpoint`: continue.
	 */
	readonly resumeHandler: ResumeHandler
	/**
	 * A `ToolReviewPrompt` for `createReviewHandler`/`createReviewPolicy`:
	 * where the policy would ask a person, the turn pauses and the run ends
	 * with one `tool_call` interrupt per call that needs one.
	 */
	readonly prompt: ToolReviewPrompt
}

export interface AGUITurnContext {
	/** Validated wire input. It remains untrusted application data. */
	readonly input: RunAgentInput
	readonly signal: AbortSignal
	readonly ui: AGUITurnUI
	/** HTTP request headers remain available to the host's authentication/scope resolver. */
	readonly request?: Request
	/**
	 * The session `input.threadId` resolved to, when the adapter was given a
	 * session index (`AGUIAdapterOptions.sessions`). Build the query on this
	 * `sessionId` so the run continues the thread's session.
	 */
	readonly session?: AGUISessionResolution
	/** Handlers that put decisions and questions to this run's client. */
	readonly interrupts: AGUITurnInterrupts
	/**
	 * The client's declared tools this endpoint admits (`frontendTools`), as
	 * tool definitions. Register them in `params.tools` for the model to be
	 * able to call them; each call waits for the client's result.
	 */
	readonly frontendTools: readonly ToolDefinition[]
	/** Present when this request continues a turn rather than starting one. */
	readonly continuation?: AGUIContinuation
}

export type AGUIQueryFactory = (context: AGUITurnContext) => QueryParams | Promise<QueryParams>

export interface AGUIInterruptOptions {
	/** Where interrupt records live between runs. Defaults to memory in this adapter. */
	readonly store?: AGUIInterruptStore
	/**
	 * How long an interrupt can be answered, in ms. A turn waiting inside a
	 * tool (a question, a frontend call) waits this long, 10 minutes when
	 * unset, and never past its tool's own deadline. A paused turn's
	 * interrupts expire only when this is set.
	 */
	readonly ttlMs?: number
}

export interface AGUIAdapterOptions extends AGUITurnUIOptions {
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
	/** Interrupt storage and lifetime. */
	readonly interrupts?: AGUIInterruptOptions
	/**
	 * Which tools a client may declare in `RunAgentInput.tools`. Absent, a
	 * request declaring any is refused with 422 `UNSUPPORTED_FRONTEND_TOOLS`.
	 */
	readonly frontendTools?: AGUIFrontendToolOptions
}

/**
 * `QueryParams` with the turn's origin. The adapter always sets it: it is the
 * record of which thread and which client run this turn serves.
 */
type TurnQueryParams = QueryParams & { origin?: Origin }

export interface AGUITurnOptions {
	readonly signal?: AbortSignal
}

/** What a request does, decided from the thread's open records before the host is asked. */
type Plan =
	| { readonly kind: 'refuse'; readonly error: AGUIResumeError }
	| { readonly kind: 'start' }
	| {
			readonly kind: 'resume'
			readonly records: readonly AGUIInterruptRecord[]
			readonly answers: readonly AGUIAnswer[]
	  }
	| {
			readonly kind: 'tool-results'
			readonly records: readonly AGUIInterruptRecord[]
			readonly results: ReadonlyMap<string, FrontendToolResult>
	  }

interface PreparedRequest {
	readonly input: RunAgentInput
	readonly plan: Plan
	readonly turn: LiveTurn
	readonly params: TurnQueryParams | undefined
	readonly ui: AGUITurnUI
	readonly controller: AbortController
	/** The request's own cancellation: the HTTP connection or `run`'s signal. */
	readonly signal: AbortSignal
	/** Stop closing `ui` on request cancellation; the run owns it from here. */
	readonly adopt: () => void
}

/** Thrown out of a review prompt so the handler around it answers `pause`. */
class ClientReview extends Error {
	constructor(
		readonly turn: LiveTurn,
		readonly calls: readonly ToolCallSummary[],
	) {
		super('Waiting for the AG-UI client to review the tool calls.')
		this.name = 'ClientReview'
	}
}

const DEFAULT_LIVE_TTL_MS = 10 * 60_000
/** `@namzu/sdk`'s `DEFAULT_TOOL_TIMEOUT_MS`, which it does not export. */
const SDK_DEFAULT_TOOL_TIMEOUT_MS = 120_000
/** How long before a tool's own deadline its interrupt expires. */
const TOOL_DEADLINE_MARGIN_MS = 5_000

/** AG-UI on top of the Namzu kernel, usable in any Fetch-compatible HTTP framework. */
export class AGUIAdapter {
	private readonly maxRequestBytes: number
	private readonly maxEventBytes: number
	private readonly store: AGUIInterruptStore
	private readonly ttlMs: number | undefined
	/** Turns waiting inside a tool for the client, by native turn id. */
	private readonly live = new Map<string, LiveTurn>()

	constructor(private readonly options: AGUIAdapterOptions) {
		this.maxRequestBytes = positiveLimit(options.maxRequestBytes, 4_194_304, 'maxRequestBytes')
		this.maxEventBytes = positiveLimit(options.maxEventBytes, 1_048_576, 'maxEventBytes')
		if (this.maxEventBytes < 256) throw new RangeError('maxEventBytes must be at least 256')
		positiveLimit(options.maxPendingEvents, 128, 'maxPendingEvents')
		this.ttlMs =
			options.interrupts?.ttlMs === undefined
				? undefined
				: positiveLimit(options.interrupts.ttlMs, DEFAULT_LIVE_TTL_MS, 'interrupts.ttlMs')
		this.store = options.interrupts?.store ?? new InMemoryAGUIInterruptStore()
	}

	async *run(input: RunAgentInput, options: AGUITurnOptions = {}): AsyncGenerator<BaseEvent> {
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
		const controller = new AbortController()
		const signal = externalSignal
			? AbortSignal.any([externalSignal, controller.signal])
			: controller.signal
		const plan = await abortable(this.plan(input), signal)
		const continued =
			plan.kind === 'resume' || plan.kind === 'tool-results' ? plan.records[0] : undefined
		// A turn waiting inside a tool is continued in place; everything else
		// runs a native source this request starts.
		const turn = continued?.delivery === 'live' ? this.live.get(continued.turnId) : new LiveTurn()
		if (!turn) {
			// Held by a process that is gone, or by another replica: either way
			// not answerable here, and left open it would block the thread.
			const records = (plan as Extract<Plan, { records: unknown }>).records
			await this.store
				.settle(
					records.map((record) => record.id),
					'expired',
				)
				.catch((error) => this.report(error))
			const stale = new AGUIResumeError(
				'AGUI_INTERRUPT_STALE',
				'The turn these answers were for is no longer waiting for them.',
			)
			return this.refusal(input, stale, controller, signal)
		}
		const frontendTools = admitFrontendTools(input.tools, this.options.frontendTools, {
			timeoutMs: this.liveTtl() + 30_000,
			observe: (call) =>
				turn.frontendCalls.set(call.toolCallId, { toolName: call.toolName, input: call.input }),
		})
		if (plan.kind === 'refuse') return this.refusal(input, plan.error, controller, signal)
		// A turn this request starts lives as long as the turn does, which can
		// be longer than the request: it follows the request's cancellation only
		// while a run is reading it. The host is handed that turn-scoped signal,
		// so passing it on as `params.signal` cannot end a turn that is waiting
		// for its client just because the request that started it has closed.
		const owned = continued?.delivery !== 'live'
		if (owned) turn.attach(signal)
		const hostSignal = owned ? turn.signal : signal
		let ui: AGUITurnUI
		try {
			ui = new AGUITurnUI(input.state, this.options)
		} catch {
			throw new AGUIRequestError('Initial state must be JSON within maxEventBytes.', 422)
		}
		// Request-scoped until a run starts streaming: a request abandoned
		// before its body is read revokes the capability it handed out.
		const closeUI = () => ui.close()
		signal.addEventListener('abort', closeUI, { once: true })
		const adopt = () => signal.removeEventListener('abort', closeUI)
		try {
			const session = continued
				? { sessionId: continued.sessionId as SessionId, created: false }
				: this.options.sessions
					? await abortable(this.resolveThread(input.threadId, this.options.sessions), signal)
					: undefined
			const params = await abortable(
				Promise.resolve(
					this.options.createQuery({
						input,
						signal: hostSignal,
						ui,
						interrupts: this.interruptsFor(turn),
						frontendTools,
						...(request ? { request } : {}),
						...(session ? { session } : {}),
						...(continued
							? {
									continuation: {
										kind: plan.kind === 'resume' ? 'resume' : 'tool-results',
										sessionId: continued.sessionId as SessionId,
										turnId: continued.turnId as TurnId,
									},
								}
							: {}),
					}),
				),
				signal,
			)
			signal.throwIfAborted()
			ui.sealInitialMessages()
			if (continued && params.sessionId !== continued.sessionId) {
				ui.close()
				adopt()
				return this.refusal(
					input,
					new AGUIResumeError(
						'AGUI_THREAD_MISMATCH',
						'The host resolved this thread to a different session than the one the turn belongs to.',
					),
					controller,
					signal,
				)
			}
			if (continued?.delivery === 'checkpoint' && !params.sessionLog) {
				ui.close()
				adopt()
				return this.refusal(
					input,
					new AGUIResumeError(
						'AGUI_RESUME_UNAVAILABLE',
						'Resuming a paused turn needs the session log in the query parameters.',
					),
					controller,
					signal,
				)
			}
			// Wire IDs are correlation strings, never filesystem keys or trusted
			// kernel scope. They reach the kernel only as the turn's origin: the
			// client's thread and run, recorded verbatim so the index can map a
			// later run on this thread back to its session. The turn id itself
			// is minted by the kernel when the turn begins.
			const turnParams: TurnQueryParams = {
				...params,
				resumeHandler: this.clientAware(turn, params.resumeHandler),
				signal: turn.signal,
				...(continued
					? {}
					: {
							origin: {
								protocol: 'ag-ui',
								kind: 'prompt',
								externalSessionId: input.threadId,
								externalTurnId: input.runId,
							},
						}),
			}
			if (owned) {
				turn.params = turnParams
				turn.ui = ui
				if (params.signal !== turn.signal) turn.follow(params.signal)
			}
			return { input, plan, turn, params: turnParams, ui, controller, signal, adopt }
		} catch (error) {
			controller.abort(error)
			ui.close()
			adopt()
			throw error
		}
	}

	private refusal(
		input: RunAgentInput,
		error: AGUIResumeError,
		controller: AbortController,
		signal: AbortSignal,
	): PreparedRequest {
		const ui = new AGUITurnUI(undefined, this.options)
		return {
			input,
			plan: { kind: 'refuse', error },
			turn: new LiveTurn(),
			params: undefined,
			ui,
			controller,
			signal,
			adopt: () => {},
		}
	}

	/**
	 * What the request does: answer the thread's interrupts, answer its
	 * pending frontend calls, or start a turn — checked against the thread's
	 * open records before the host is asked for anything.
	 */
	private async plan(input: RunAgentInput): Promise<Plan> {
		try {
			if (input.resume?.length) {
				const { records, answers } = await readResume(
					this.store,
					input.threadId,
					input.resume,
					Date.now(),
				)
				return { kind: 'resume', records, answers }
			}
			const now = Date.now()
			const listed = await this.store.listOpen(input.threadId)
			// A frontend call nobody answered in time is not waited for any more;
			// the turn that made it was closed when it expired.
			const lapsed = listed.filter(
				(record) =>
					record.kind === 'frontend_tool' &&
					record.expiresAt !== undefined &&
					now >= record.expiresAt,
			)
			if (lapsed.length > 0)
				await this.store.settle(
					lapsed.map((record) => record.id),
					'expired',
				)
			const open = listed.filter((record) => !lapsed.includes(record))
			if (open.some((record) => record.kind !== 'frontend_tool'))
				throw new AGUIResumeError(
					'AGUI_INTERRUPT_PENDING',
					'This thread has open interrupts; answer them in `resume` before sending new input.',
				)
			if (open.length === 0) return { kind: 'start' }
			const results = new Map<string, FrontendToolResult>()
			for (const message of input.messages) {
				if (message.role !== 'tool') continue
				results.set(message.toolCallId, {
					content: message.content,
					isError: message.error !== undefined || hasErrorMetadata(message.metadata),
				})
			}
			const missing = open.filter((record) => !results.has(record.toolCallId as string))
			if (missing.length > 0)
				throw new AGUIResumeError(
					'AGUI_TOOL_RESULT_REQUIRED',
					`This thread is waiting for the result of ${missing
						.map((record) => record.toolName ?? 'a frontend tool')
						.join(', ')}; send it as a \`tool\` message.`,
				)
			const groups = new Set(open.map((record) => record.group))
			if (groups.size > 1)
				throw new AGUIResumeError(
					'AGUI_RESUME_INVALID',
					'The pending tool calls belong to more than one run.',
				)
			return { kind: 'tool-results', records: open, results }
		} catch (error) {
			if (error instanceof AGUIResumeError) return { kind: 'refuse', error }
			throw error
		}
	}

	private async *events(prepared: PreparedRequest): AsyncGenerator<BaseEvent> {
		const { input, plan, turn } = prepared
		prepared.adopt()
		const refuse = (error: AGUIResumeError): BaseEvent[] => [
			{ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
			{ type: EventType.RUN_ERROR, message: error.message, code: error.code },
		]
		if (plan.kind === 'refuse') {
			prepared.ui.close()
			for (const event of refuse(plan.error)) yield this.checked(event)
			return
		}
		const params = prepared.params as TurnQueryParams
		if (plan.kind === 'start') {
			turn.start(query(params))
			yield* this.drive(prepared, new AGUIEventMapper(this.identity(input, params)))
			return
		}
		const first = plan.records[0] as AGUIInterruptRecord
		const ids = plan.records.map((record) => record.id)
		if (first.delivery === 'live') {
			if (
				turn.settled ||
				turn.progressed ||
				!plan.records.every((r) => turn.parks.has(r.questionId as string))
			) {
				await this.store.settle(ids, 'expired').catch((error) => this.report(error))
				prepared.ui.close()
				for (const event of refuse(
					new AGUIResumeError(
						'AGUI_INTERRUPT_STALE',
						'The turn these answers were for is no longer waiting for them.',
					),
				))
					yield this.checked(event)
				return
			}
		}
		if (!(await this.store.settle(ids, 'resolved'))) {
			prepared.ui.close()
			for (const event of refuse(
				new AGUIResumeError(
					'AGUI_INTERRUPT_RESOLVED',
					'These interrupts have already been answered.',
				),
			))
				yield this.checked(event)
			return
		}
		if (first.delivery === 'live') {
			this.live.delete(first.turnId)
			const frontend = plan.records
				.filter((record) => record.kind === 'frontend_tool')
				.map((record) => record.toolCallId as string)
			const mapper = new AGUIEventMapper({
				...this.identity(input, params),
				turnId: first.turnId,
				carriedToolCalls: turn.announcedToolCalls.keys(),
				suppressedResults: frontend,
			})
			yield* this.drive(prepared, mapper, () => {
				for (const [index, record] of plan.records.entries()) {
					turn.answer(record.questionId as string, this.liveDecision(plan, record, index))
				}
			})
			return
		}
		// A paused turn: its answer is a native decision, applied by resuming
		// the checkpoint the pause wrote — or, refused, the turn is closed.
		const answers = plan.kind === 'resume' ? plan.answers : []
		const decision = this.checkpointDecision(plan.records, answers)
		const mapper = new AGUIEventMapper({
			...this.identity(input, params),
			turnId: first.turnId,
			carriedToolCalls: first.batch ?? [],
		})
		if (decision.kind === 'abandon') {
			try {
				await abandonTurn(first.sessionId as SessionId, first.turnId as TurnId, decision.reason, {
					...(params.sessionLog ? { log: params.sessionLog } : {}),
				})
			} catch (error) {
				this.report(error)
				prepared.ui.close()
				for (const event of [
					...mapper.start(),
					...mapper.fail('The paused turn could not be closed.', 'NAMZU_TURN_ERROR'),
				])
					yield this.checked(event)
				return
			}
			prepared.ui.close()
			for (const event of [
				...mapper.start(),
				...mapper.fail('The turn was closed without continuing it.', 'NAMZU_TURN_ABANDONED'),
			])
				yield this.checked(event)
			return
		}
		turn.start(this.resume(params, first, decision.pendingDecision))
		yield* this.drive(prepared, mapper)
	}

	/** Read one native source for one AG-UI run. */
	private async *drive(
		prepared: PreparedRequest,
		mapper: AGUIEventMapper,
		onAttached?: () => void,
	): AsyncGenerator<BaseEvent> {
		const { turn, signal: requestSignal } = prepared
		const uis = [...new Set([turn.ui, prepared.ui])].filter(
			(ui): ui is AGUITurnUI => ui !== undefined,
		)
		for (const ui of uis) turn.watch(ui)
		turn.attach(requestSignal)
		let terminalEvents: BaseEvent[] | undefined
		let undeliveredClosures: BaseEvent[] = []
		let terminalDelivered = false
		let stays = false
		const visibleParts = new Set<string>()
		const drainUI = function* (this: AGUIAdapter): Generator<BaseEvent> {
			for (const ui of uis) for (const event of ui.drain()) yield this.checked(event)
		}.bind(this)
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
		try {
			turn.signal.throwIfAborted()
			yield* deliver(mapper.start())
			yield* drainUI()
			onAttached?.()
			turn.pull()
			while (true) {
				turn.signal.throwIfAborted()
				yield* drainUI()
				const parks = turn.unannounced()
				if (parks.length > 0 && !mapper.ended) {
					const closing = await this.announce(prepared, mapper, parks)
					// The interrupts are on record: the turn waits for them now,
					// whether or not this connection lasts to deliver them.
					stays = true
					this.keep(turn)
					yield* deliver(closing)
					return
				}
				const outcome = turn.take()
				if (!outcome) {
					await turn.wait(turn.signal)
					continue
				}
				if ('error' in outcome) throw outcome.error
				if (outcome.next.done) {
					if (mapper.paused) yield* deliver(await this.pause(prepared, mapper))
					else yield* deliver(terminalEvents ?? mapper.finish())
					return
				}
				if (!mapper.ended) {
					const mapped = mapper.map(outcome.next.value)
					turn.turnId ??= mapper.turn
					// query() finalizes persistence after its terminal event. Drain it
					// naturally before telling the client the run succeeded.
					if (mapper.ended) terminalEvents = mapped
					else yield* deliver(mapped)
				}
				turn.pull()
			}
		} catch (error) {
			if (stays) {
				this.report(error)
				return
			}
			const canceled = turn.signal.aborted
			// One active turn per session: a second run on a thread whose turn
			// is running, parked or interrupted is refused by the kernel. That
			// is the client's conflict to resolve, not a host failure to report.
			const inProgress = !canceled && isTurnInProgressError(error)
			const refused = !canceled && error instanceof AGUIResumeError
			if (!canceled && !inProgress && !refused) this.report(error)
			turn.abort(error)
			if (!terminalDelivered) {
				const message = canceled
					? 'Namzu turn canceled.'
					: refused
						? error.message
						: inProgress
							? 'This thread already has an active turn. Wait for it to finish, or resume or abandon it.'
							: 'Namzu turn failed.'
				const code = canceled
					? 'NAMZU_TURN_CANCELED'
					: refused
						? error.code
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
			for (const [id, name] of mapper.toolCalls) {
				if (!turn.announcedToolCalls.has(id)) turn.announcedToolCalls.set(id, name ?? '')
			}
			if (prepared.ui !== turn.ui) {
				turn.unwatch(prepared.ui)
				prepared.ui.close()
			}
			if (!stays || turn.signal.aborted) {
				if (!turn.settled) turn.abort(requestSignal.reason ?? new Error('The AG-UI run ended.'))
				turn.close()
				turn.ui?.close()
				prepared.ui.close()
				if (turn.turnId && this.live.get(turn.turnId) === turn) this.live.delete(turn.turnId)
				// Await kernel cleanup even when the HTTP consumer disconnects mid-request.
				try {
					await turn.drain()
				} catch (error) {
					this.report(error)
				}
			}
		}
	}

	/**
	 * End the run at a turn now waiting inside a tool: questions become
	 * interrupts; frontend calls, when no question is waiting, end the run as
	 * complete with the calls unanswered.
	 */
	private async announce(
		prepared: PreparedRequest,
		mapper: AGUIEventMapper,
		parks: readonly Park[],
	): Promise<BaseEvent[]> {
		const { turn } = prepared
		const questions = parks.filter((park) => park.kind === 'question')
		const announced = questions.length > 0 ? questions : parks
		const now = Date.now()
		const known = new Map([...turn.announcedToolCalls, ...mapper.toolCalls])
		const events: BaseEvent[] = []
		const records: AGUIInterruptRecord[] = []
		const interrupts: Interrupt[] = []
		const group = randomUUID()
		for (const park of announced) {
			const base = this.record(prepared, mapper, group, park.request.checkpointId, 'live')
			if (park.kind === 'frontend') {
				const toolCallId = park.questionId.slice(0, -`:${FRONTEND_RESULT_PAUSE}`.length)
				const call = turn.frontendCalls.get(toolCallId)
				if (call) events.push(...mapper.announceTool(toolCallId, call.toolName, call.input))
				records.push({
					...base,
					kind: 'frontend_tool',
					toolCallId,
					...(call ? { toolName: call.toolName } : {}),
					questionId: park.questionId,
					expiresAt: now + this.liveTtl(),
				})
				continue
			}
			const question = park.request.question
			const toolCallId = [...known.keys()].find(
				(id) => question.questionId === id || question.questionId.startsWith(`${id}:`),
			)
			const record: AGUIInterruptRecord = {
				...base,
				kind: 'question',
				...(toolCallId ? { toolCallId } : {}),
				...(toolCallId && known.get(toolCallId) ? { toolName: known.get(toolCallId) } : {}),
				questionId: park.questionId,
				options: question.options.map((option) => option.id),
				multiSelect: question.multiSelect,
				allowFreeText: question.allowFreeText,
				expiresAt: now + this.liveTtl(this.toolDeadline(turn, toolCallId && known.get(toolCallId))),
			}
			records.push(record)
			interrupts.push(questionInterrupt(record, question, toolCallId))
		}
		events.push(...this.stateSnapshot(turn))
		events.push(...(interrupts.length > 0 ? mapper.interrupt(interrupts) : mapper.yieldToClient()))
		for (const event of events) this.checked(event)
		await this.store.put(records)
		for (const park of announced) park.announced = true
		turn.openRecords = records.map((record) => record.id)
		turn.expiresAt = Math.min(
			...records.map((record) => record.expiresAt ?? Number.POSITIVE_INFINITY),
		)
		return events
	}

	/** End the run at a native pause, with the interrupts that continue it. */
	private async pause(prepared: PreparedRequest, mapper: AGUIEventMapper): Promise<BaseEvent[]> {
		const { turn } = prepared
		const params = prepared.params as TurnQueryParams
		const pause = mapper.paused as NonNullable<AGUIEventMapper['paused']>
		const turnId = (mapper.turn ?? turn.turnId) as string
		const request =
			turn.paused.get(pause.checkpointId) ?? (await this.parked(params, turnId, pause.checkpointId))
		const base = this.record(prepared, mapper, randomUUID(), pause.checkpointId, 'checkpoint')
		const expiresAt = this.ttlMs === undefined ? undefined : Date.now() + this.ttlMs
		const records: AGUIInterruptRecord[] = []
		const interrupts: Interrupt[] = []
		const events: BaseEvent[] = []
		const add = (record: AGUIInterruptRecord, interrupt: Interrupt) => {
			records.push(record)
			interrupts.push(interrupt)
		}
		if (request?.type === 'tool_review') {
			const batch = request.toolCalls.map((call) => call.id)
			const calls =
				turn.reviewCalls.get(pause.checkpointId) ?? needsPerson(request.toolCalls, params)
			for (const call of calls) {
				events.push(...mapper.announceTool(call.id, call.name, call.input))
				const record: AGUIInterruptRecord = {
					...base,
					id: randomUUID(),
					kind: 'tool_approval',
					toolCallId: call.id,
					toolName: call.name,
					...(call.escalation?.sandboxEscape ? { sandboxEscape: true } : {}),
					batch,
					gateDenied: request.toolCalls
						.filter((summary) => summary.authorization?.decision === 'deny')
						.map((summary) => summary.id),
					...(expiresAt !== undefined ? { expiresAt } : {}),
				}
				add(record, approvalInterrupt(record, call))
			}
		} else if (request?.type === 'plan_approval' || request?.type === 'iteration_checkpoint') {
			const record: AGUIInterruptRecord = {
				...base,
				kind: request.type === 'plan_approval' ? 'plan_approval' : 'checkpoint',
				...(expiresAt !== undefined ? { expiresAt } : {}),
			}
			add(record, confirmationInterrupt(record, request))
		} else if (pause.handoff) {
			const record: AGUIInterruptRecord = {
				...base,
				kind: 'handoff',
				...(expiresAt !== undefined ? { expiresAt } : {}),
			}
			add(record, handoffInterrupt(record, pause.handoff))
		}
		if (records.length === 0) {
			const record: AGUIInterruptRecord = {
				...base,
				kind: 'paused',
				...(expiresAt !== undefined ? { expiresAt } : {}),
			}
			add(record, pausedInterrupt(record, pause.reason, pause.retryable))
		}
		events.push(...this.stateSnapshot(turn), ...mapper.interrupt(interrupts))
		for (const event of events) this.checked(event)
		await this.store.put(records)
		return events
	}

	private record(
		prepared: PreparedRequest,
		mapper: AGUIEventMapper,
		group: string,
		checkpointId: string,
		delivery: AGUIInterruptRecord['delivery'],
	): AGUIInterruptRecord {
		return {
			id: randomUUID(),
			kind: 'paused',
			status: 'open',
			delivery,
			threadId: prepared.input.threadId,
			runId: prepared.input.runId,
			group,
			sessionId: (prepared.params as TurnQueryParams).sessionId,
			turnId: (mapper.turn ?? prepared.turn.turnId) as string,
			checkpointId,
			createdAt: Date.now(),
		}
	}

	/**
	 * Hold a turn that waits inside a tool until the client answers or the
	 * wait expires. From here the turn no longer follows the request that
	 * raised the interrupt: a connection closing after the run ended is not
	 * the client giving up.
	 */
	private keep(turn: LiveTurn): void {
		const turnId = turn.turnId as string
		this.live.set(turnId, turn)
		turn.detach(turn.expiresAt - Date.now(), () => {
			void this.expire(turn)
		})
	}

	/** Nobody answered in time, or the waiting tool gave up: close the turn. */
	private async expire(turn: LiveTurn): Promise<void> {
		try {
			if (!(await this.store.settle(turn.openRecords, 'expired'))) return
		} catch (error) {
			this.report(error)
		}
		if (turn.turnId && this.live.get(turn.turnId) === turn) this.live.delete(turn.turnId)
		turn.abort(new Error('The client did not answer in time.'))
		turn.close()
		turn.ui?.close()
		try {
			await turn.drain()
		} catch (error) {
			this.report(error)
		}
	}

	/** The answer a waiting tool receives. */
	private liveDecision(
		plan: Extract<Plan, { kind: 'resume' | 'tool-results' }>,
		record: AGUIInterruptRecord,
		index: number,
	): HITLResumeDecision {
		if (plan.kind === 'tool-results') {
			const result = plan.results.get(record.toolCallId as string) as FrontendToolResult
			return {
				action: 'answer_question',
				questionId: record.questionId as string,
				selectedOptionIds: [],
				freeText: encodeFrontendResult(result),
			}
		}
		return questionDecision(record, plan.answers[index] as AGUIAnswer)
	}

	private checkpointDecision(
		records: readonly AGUIInterruptRecord[],
		answers: readonly AGUIAnswer[],
	):
		| { readonly kind: 'resume'; readonly pendingDecision?: HITLResumeDecision }
		| { readonly kind: 'abandon'; readonly reason: string } {
		const first = records[0] as AGUIInterruptRecord
		const answer = answers[0] as AGUIAnswer
		switch (first.kind) {
			case 'tool_approval': {
				const denied = new Set(first.gateDenied ?? [])
				const batch = (first.batch ?? []).filter((id) => !denied.has(id))
				return { kind: 'resume', pendingDecision: approvalDecision(records, answers, batch) }
			}
			case 'plan_approval':
				return answer.kind === 'confirm' && answer.approved
					? {
							kind: 'resume',
							pendingDecision: {
								action: 'approve_plan',
								...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}),
							},
						}
					: { kind: 'abandon', reason: rejection(answer, 'The client rejected the plan.') }
			case 'checkpoint':
				return answer.kind === 'confirm' && answer.approved
					? { kind: 'resume', pendingDecision: { action: 'continue' } }
					: { kind: 'abandon', reason: rejection(answer, 'The client stopped the turn.') }
			default:
				return answer.kind === 'cancel'
					? { kind: 'abandon', reason: 'The client cancelled the paused turn.' }
					: { kind: 'resume' }
		}
	}

	/** A paused turn's continuation, as a native source. */
	private resume(
		params: TurnQueryParams,
		record: AGUIInterruptRecord,
		pendingDecision: HITLResumeDecision | undefined,
	): AsyncGenerator<SessionEvent, Turn> {
		const {
			messages: _messages,
			turnId: _turnId,
			resumeFromCheckpoint: _checkpoint,
			origin: _origin,
			pendingDecision: _decision,
			...rest
		} = params
		return fromListener<SessionEvent, Turn>(async (emit) => {
			const outcome = await resumeSession({
				...rest,
				sessionLog: params.sessionLog as NonNullable<QueryParams['sessionLog']>,
				scope: {
					tenantId: params.tenantId,
					projectId: params.projectId,
					topicId: params.topicId,
					sessionId: params.sessionId,
					turnId: record.turnId as TurnId,
					...(params.parentSessionId !== undefined
						? { parentSessionId: params.parentSessionId }
						: {}),
				},
				checkpointId: record.checkpointId as NonNullable<QueryParams['resumeFromCheckpoint']>,
				...(pendingDecision ? { pendingDecision } : {}),
				listener: emit,
			})
			if (!outcome.resumed)
				throw new AGUIResumeError(
					'AGUI_INTERRUPT_STALE',
					'The paused turn these answers were for can no longer be resumed.',
				)
			return outcome.turn
		})
	}

	/** The decision a turn parked on, read back from its session log. */
	private async parked(
		params: TurnQueryParams,
		turnId: string,
		checkpointId: string,
	): Promise<HITLDecisionRequest | undefined> {
		if (!params.sessionLog) return undefined
		try {
			const park = await findPendingCheckpoint(params.sessionLog, { turnId: turnId as TurnId })
			return park?.checkpointId === checkpointId ? park.pending.request : undefined
		} catch (error) {
			this.report(error)
			return undefined
		}
	}

	/**
	 * The host's handler, with the two things the adapter owns routed around
	 * it: a frontend tool waiting for its result, and a review the client is
	 * asked about (the host's policy answered `pause`, or its prompt was
	 * {@link AGUITurnInterrupts.prompt}).
	 */
	private clientAware(turn: LiveTurn, host: ResumeHandler): ResumeHandler {
		return async (request) => {
			if (request.type === 'user_question') {
				const suffix = `:${FRONTEND_RESULT_PAUSE}`
				const questionId = request.question.questionId
				if (
					questionId.endsWith(suffix) &&
					turn.frontendCalls.has(questionId.slice(0, -suffix.length))
				)
					return turn.park(request, 'frontend')
			}
			let decision: HITLResumeDecision
			try {
				decision = await host(request)
			} catch (error) {
				if (!(error instanceof ClientReview) || error.turn !== turn) throw error
				turn.reviewCalls.set(request.checkpointId, error.calls)
				decision = { action: 'pause', reason: error.message }
			}
			if (decision.action === 'pause' && request.type !== 'user_question')
				turn.paused.set(request.checkpointId, request)
			return decision
		}
	}

	private interruptsFor(turn: LiveTurn): AGUITurnInterrupts {
		const prompt: ToolReviewPrompt = async ({ toolCalls }) => {
			throw new ClientReview(turn, needsPerson(toolCalls, turn.params))
		}
		let review: ResumeHandler | undefined
		const resumeHandler: ResumeHandler = async (request) => {
			switch (request.type) {
				case 'user_question':
					return turn.park(request, 'question')
				case 'tool_review': {
					review ??= createReviewHandler({
						mode: 'prompt',
						prompt,
						...(turn.params ? { registry: turn.params.tools } : {}),
					})
					try {
						return await review(request)
					} catch (error) {
						if (!(error instanceof ClientReview) || error.turn !== turn) throw error
						turn.reviewCalls.set(request.checkpointId, error.calls)
						return { action: 'pause', reason: error.message }
					}
				}
				case 'plan_approval':
					return { action: 'pause', reason: 'Waiting for the AG-UI client to approve the plan.' }
				case 'iteration_checkpoint':
					return { action: 'continue' }
			}
		}
		return { resumeHandler, prompt }
	}

	private stateSnapshot(turn: LiveTurn): BaseEvent[] {
		// The state the turn's tools left behind, before the run closes: the
		// interrupt boundary is where a client takes its copy of it.
		const state = turn.ui?.state
		return state === undefined || state === null
			? []
			: [{ type: EventType.STATE_SNAPSHOT, snapshot: state }]
	}

	private liveTtl(toolDeadline?: number): number {
		const ttl = this.ttlMs ?? DEFAULT_LIVE_TTL_MS
		return toolDeadline === undefined
			? ttl
			: Math.min(ttl, Math.max(1_000, toolDeadline - TOOL_DEADLINE_MARGIN_MS))
	}

	/** How long the asking tool waits before the executor gives up on it. */
	private toolDeadline(turn: LiveTurn, toolName: string | undefined): number | undefined {
		const params = turn.params
		if (!params) return undefined
		const own = toolName ? params.tools.get(toolName)?.timeoutMs : undefined
		const deadline = own ?? params.toolTimeoutMs ?? SDK_DEFAULT_TOOL_TIMEOUT_MS
		return Number.isFinite(deadline) && deadline > 0 ? deadline : undefined
	}

	private identity(input: RunAgentInput, params: TurnQueryParams) {
		return { threadId: input.threadId, runId: input.runId, sessionId: params.sessionId }
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

/**
 * The calls in a batch a person has to decide: explicitly reviewed,
 * destructive, escalated, or not exempt as a trusted read. Calls the gate
 * denied are refused whatever anyone answers, so nobody is asked about them.
 * When the policy asked about a batch none of whose calls qualify, every
 * call it could run is asked about.
 */
function needsPerson(
	calls: readonly ToolCallSummary[],
	params: QueryParams | undefined,
): ToolCallSummary[] {
	const open = calls.filter((call) => call.authorization?.decision !== 'deny')
	const asked = open.filter(
		(call) =>
			call.authorization?.explicitReview === true ||
			call.isDestructive ||
			call.escalation !== undefined ||
			!params ||
			!isReviewExempt(params.tools, call.name, call.input),
	)
	return asked.length > 0 ? asked : open
}

function rejection(answer: AGUIAnswer, fallback: string): string {
	return answer.kind === 'confirm' && answer.feedback ? answer.feedback : fallback
}

function hasErrorMetadata(metadata: unknown): boolean {
	if (typeof metadata !== 'object' || metadata === null) return false
	const namzu = (metadata as { namzu?: unknown }).namzu
	return (
		typeof namzu === 'object' && namzu !== null && (namzu as { isError?: unknown }).isError === true
	)
}

function part(event: BaseEvent): { key: string; start: boolean } | undefined {
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
