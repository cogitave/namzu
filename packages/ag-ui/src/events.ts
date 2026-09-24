import { randomUUID } from 'node:crypto'
import { type BaseEvent, EventType, type Interrupt, type TokenUsage } from '@ag-ui/core'
import type { SessionEvent, ToolHandoff } from '@namzu/sdk'

/**
 * Public AG-UI identity, and optionally the namzu session and turn whose events
 * are being adapted.
 *
 * `threadId` and `runId` are the client's own strings and are echoed verbatim;
 * neither is ever a namzu id. An AG-UI run is one namzu turn: when `turnId` is
 * absent the mapper adopts the turn of the first top-level event it sees.
 */
export interface AGUIEventMapperOptions {
	threadId: string
	runId: string
	/** Only this session's events are adapted; a child session's never are. */
	sessionId?: string
	turnId?: string
	/**
	 * Tool calls an earlier run of the same turn already announced. Their
	 * `TOOL_CALL_START`, `TOOL_CALL_ARGS` and `TOOL_CALL_END` are not sent
	 * again; a result is sent against the original id.
	 */
	carriedToolCalls?: Iterable<string>
	/** Tool calls whose result the client produced itself: no `TOOL_CALL_RESULT` is sent. */
	suppressedResults?: Iterable<string>
}

/** How a native turn paused, as `turn_paused` said. */
export interface AGUIPause {
	readonly checkpointId: string
	readonly reason: string
	readonly handoff?: ToolHandoff
	/** From the failure a provider pause carries, when there is one. */
	readonly retryable?: boolean
}

interface MessageState {
	text: string
	closed: boolean
	completed: boolean
}

/**
 * Why the runtime could not read a call's arguments, as its
 * `tool_input_completed` event says. Taken from the event rather than
 * imported by name, so an older `@namzu/sdk` that sends none still compiles.
 */
type ToolInputError = Extract<SessionEvent, { type: 'tool_input_completed' }>['inputError']

interface ToolState {
	arguments: string
	closed: boolean
	resultSent: boolean
	inputTruncated: boolean
	inputError?: ToolInputError
}

const PUBLIC_EVENTS = new Set<SessionEvent['type']>([
	'turn_started',
	'iteration_started',
	'iteration_completed',
	'message_started',
	'text_delta',
	'message_completed',
	'tool_input_started',
	'tool_input_delta',
	'tool_input_completed',
	'tool_executing',
	'tool_completed',
	'turn_completed',
	'turn_failed',
	'turn_paused',
])

/**
 * Stateful projection of one namzu turn onto AG-UI's public run lifecycle.
 *
 * Messages and tool calls retain their native identities. Private runtime events
 * are deliberately omitted. A mapper is used once: only a native successful
 * terminal event can finish it successfully; an unexpected EOF is an error.
 */
export class AGUIEventMapper {
	private readonly threadId: string
	private readonly runId: string
	private readonly sessionId: string | undefined
	private turnId: string | undefined
	private started = false
	/** No further native event is mapped. */
	private terminal = false
	/** A terminal `RUN_FINISHED` or `RUN_ERROR` has been produced. */
	private closed = false
	private pause: AGUIPause | undefined
	private readonly suppressed: Set<string>
	private readonly messages = new Map<string, MessageState>()
	private readonly tools = new Map<string, ToolState>()
	private readonly steps = new Map<number, boolean>()
	private readonly seenSequences = new Set<number>()
	private readonly usage: TokenUsage[] = []
	private readonly toolNames = new Map<string, string>()
	private lastMessageId: string | undefined

	constructor(options: AGUIEventMapperOptions) {
		this.threadId = options.threadId
		this.runId = options.runId
		this.sessionId = options.sessionId
		this.turnId = options.turnId
		for (const toolCallId of options.carriedToolCalls ?? []) {
			this.tools.set(toolCallId, {
				arguments: '',
				closed: true,
				resultSent: false,
				inputTruncated: false,
			})
		}
		this.suppressed = new Set(options.suppressedResults)
	}

	/** No further native event will be mapped: the turn ended, paused or failed. */
	get ended(): boolean {
		return this.terminal
	}

	/** Set when the native turn paused; the run is then ended by {@link interrupt} or {@link finish}. */
	get paused(): AGUIPause | undefined {
		return this.pause
	}

	/** The native turn this mapper follows, once an event named it. */
	get turn(): string | undefined {
		return this.turnId
	}

	/** Every tool call this run announced or carried, with its name when known. */
	get toolCalls(): ReadonlyMap<string, string | undefined> {
		return new Map([...this.tools.keys()].map((id) => [id, this.toolNames.get(id)]))
	}

	/** Announce the public run identity exactly once, without echoing request input. */
	start(): BaseEvent[] {
		if (this.started || this.terminal) return []
		this.started = true
		return [{ type: EventType.RUN_STARTED, threadId: this.threadId, runId: this.runId }]
	}

	/** Map a native event. Child sessions, private events, and repeated durable events are omitted. */
	map(event: SessionEvent): BaseEvent[] {
		if (this.terminal || !PUBLIC_EVENTS.has(event.type) || !this.belongsToTurn(event)) return []
		if (event.seq !== undefined) {
			if (this.seenSequences.has(event.seq)) return []
			this.seenSequences.add(event.seq)
		}

		const events = this.start()
		switch (event.type) {
			case 'turn_started':
				break
			case 'iteration_started':
				this.startStep(event.iteration, events)
				break
			case 'iteration_completed':
				this.startStep(event.iteration, events)
				this.endStep(event.iteration, events)
				break
			case 'message_started':
				this.startMessage(event.messageId, events)
				break
			case 'text_delta': {
				const message = this.startMessage(event.messageId, events)
				if (!message.closed && event.text) {
					message.text += event.text
					events.push({
						type: EventType.TEXT_MESSAGE_CONTENT,
						messageId: event.messageId,
						delta: event.text,
					})
				}
				break
			}
			case 'message_completed': {
				const message = this.startMessage(event.messageId, events)
				if (message.completed) break
				message.completed = true
				// Complete a retained prefix without duplicating already streamed
				// text. A conflicting aggregate cannot be repaired by appending.
				if (!message.closed && event.content !== undefined) {
					if (!event.content.startsWith(message.text)) {
						return events.concat(
							this.fail(
								'Completed message text disagrees with its stream.',
								'NAMZU_MESSAGE_CONTENT_MISMATCH',
							),
						)
					}
					const delta = event.content.slice(message.text.length)
					if (delta) {
						message.text = event.content
						events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: event.messageId, delta })
					}
				}
				this.endMessage(event.messageId, message, events)
				if (event.usage) {
					this.usage.push({
						inputTokens: event.usage.promptTokens,
						outputTokens: event.usage.completionTokens,
						totalTokens: event.usage.totalTokens,
						cachedInputTokens: event.usage.cachedTokens,
						...(event.usage.reasoningTokens === undefined
							? {}
							: { reasoningTokens: event.usage.reasoningTokens }),
					})
				}
				break
			}
			case 'tool_input_started':
				this.startTool(event.toolUseId, event.toolName, events, event.messageId)
				break
			case 'tool_input_delta': {
				const tool = this.tools.get(event.toolUseId)
				if (!tool) {
					return events.concat(
						this.fail('Tool arguments arrived before their call.', 'NAMZU_TOOL_LIFECYCLE'),
					)
				}
				if (!tool.closed && event.partialJson) {
					tool.arguments += event.partialJson
					events.push({
						type: EventType.TOOL_CALL_ARGS,
						toolCallId: event.toolUseId,
						delta: event.partialJson,
					})
				}
				break
			}
			case 'tool_input_completed': {
				const tool = this.tools.get(event.toolUseId)
				if (!tool) {
					return events.concat(
						this.fail('Tool input completed before its call.', 'NAMZU_TOOL_LIFECYCLE'),
					)
				}
				this.completeToolInput(
					event.toolUseId,
					tool,
					event.input,
					events,
					event.inputTruncated,
					event.inputTruncated ? event.inputError : undefined,
				)
				break
			}
			case 'tool_executing': {
				const tool = this.startTool(event.toolUseId, event.toolName, events)
				this.completeToolInput(event.toolUseId, tool, event.input, events)
				break
			}
			case 'tool_completed': {
				const tool = this.startTool(event.toolUseId, event.toolName, events)
				if (tool.resultSent) break
				this.endTool(event.toolUseId, tool, events)
				tool.resultSent = true
				if (this.suppressed.has(event.toolUseId)) break
				events.push({
					type: EventType.TOOL_CALL_RESULT,
					messageId: randomUUID(),
					toolCallId: event.toolUseId,
					role: 'tool',
					content: event.result,
					metadata: { namzu: { isError: event.isError } },
				})
				break
			}
			case 'turn_completed': {
				// A pause without the checkpoint `turn_paused` names cannot be
				// resumed, so it is reported as the stop it is.
				if (event.stopReason === 'paused') {
					return events.concat(this.fail('Namzu turn paused.', 'NAMZU_TURN_PAUSED'))
				}
				if (event.stopReason !== undefined && event.stopReason !== 'end_turn') {
					return events.concat(
						this.fail(
							`Namzu turn stopped: ${event.stopReason}.`,
							`NAMZU_${event.stopReason.toUpperCase()}`,
						),
					)
				}
				// Some native producers expose only a final result. Do not duplicate
				// text when the producer already supplied a message lifecycle.
				if (this.messages.size === 0 && event.result) {
					const messageId = randomUUID()
					this.startMessage(messageId, events)
					events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.result })
				}
				this.closeOpenParts(events)
				this.terminal = true
				this.closed = true
				events.push({
					type: EventType.RUN_FINISHED,
					threadId: this.threadId,
					runId: this.runId,
					result: event.result,
					outcome: { type: 'success' },
					...(this.usage.length ? { usage: this.usage } : {}),
				})
				break
			}
			case 'turn_failed':
				return events.concat(this.fail('Namzu turn failed.', 'NAMZU_TURN_ERROR'))
			case 'turn_paused':
				// Not terminal on the wire yet: the run ends with the interrupts
				// the host builds from this pause, or, if it builds none, with the
				// `NAMZU_TURN_PAUSED` error `finish` reports.
				this.terminal = true
				this.pause = {
					checkpointId: event.checkpointId,
					reason: event.reason,
					...(event.handoff ? { handoff: event.handoff } : {}),
					...(event.failure ? { retryable: event.failure.retryable } : {}),
				}
				break
			default:
				// No raw event forwarding: prompts, reasoning, checkpoint payloads,
				// and internal instrumentation are outside this public projection.
				break
		}
		return events
	}

	/**
	 * Close a consumed stream. EOF without a native terminal event is never
	 * success; a pause nobody turned into interrupts is reported as one.
	 */
	finish(): BaseEvent[] {
		if (this.pause) return this.fail('Namzu turn paused.', 'NAMZU_TURN_PAUSED')
		return this.fail(
			'The native event stream ended before a terminal turn event.',
			'NAMZU_STREAM_INCOMPLETE',
		)
	}

	/** Close open protocol parts before reporting a public, caller-selected error. */
	fail(message: string, code = 'NAMZU_TURN_ERROR'): BaseEvent[] {
		if (this.closed) return []
		const events = this.start()
		this.closeOpenParts(events)
		this.terminal = true
		this.closed = true
		events.push({ type: EventType.RUN_ERROR, message, code })
		return events
	}

	/**
	 * End the run as interrupted: the turn is waiting for these answers,
	 * which the next run on the thread carries in `resume`.
	 */
	interrupt(interrupts: readonly Interrupt[]): BaseEvent[] {
		if (this.closed) return []
		if (interrupts.length === 0) throw new RangeError('An interrupted run needs an interrupt')
		const events = this.start()
		this.closeOpenParts(events)
		this.terminal = true
		this.closed = true
		events.push({
			type: EventType.RUN_FINISHED,
			threadId: this.threadId,
			runId: this.runId,
			outcome: { type: 'interrupt', interrupts: [...interrupts] },
			...(this.usage.length ? { usage: this.usage } : {}),
		})
		return events
	}

	/**
	 * End the run with its frontend tool calls unanswered. The run is
	 * complete; the client runs the tools and answers them with `tool`
	 * messages on the next run.
	 */
	yieldToClient(): BaseEvent[] {
		if (this.closed) return []
		const events = this.start()
		this.closeOpenParts(events)
		this.terminal = true
		this.closed = true
		events.push({
			type: EventType.RUN_FINISHED,
			threadId: this.threadId,
			runId: this.runId,
			outcome: { type: 'success' },
			...(this.usage.length ? { usage: this.usage } : {}),
		})
		return events
	}

	/**
	 * Announce a call the stream has not shown yet, with its whole input, so
	 * an interrupt or a pending frontend call never names a call the client
	 * cannot see.
	 */
	announceTool(toolCallId: string, toolName: string, input: unknown): BaseEvent[] {
		if (this.closed || this.tools.has(toolCallId)) return []
		const events = this.start()
		const tool = this.startTool(toolCallId, toolName, events)
		this.completeToolInput(toolCallId, tool, input, events)
		return events
	}

	private belongsToTurn(event: SessionEvent): boolean {
		// A child session's events reach a parent's listener with a lineage
		// deeper than the root; they are that child's business, not this run's.
		if ((event.lineage?.depth ?? 0) > 0) return false
		if (this.sessionId !== undefined && event.sessionId !== this.sessionId) return false
		if (event.turnId === undefined) return false
		if (this.turnId === undefined) this.turnId = event.turnId
		return event.turnId === this.turnId
	}

	private startMessage(messageId: string, events: BaseEvent[]): MessageState {
		const existing = this.messages.get(messageId)
		if (existing) return existing
		const message: MessageState = { text: '', closed: false, completed: false }
		this.messages.set(messageId, message)
		this.lastMessageId = messageId
		events.push({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' })
		return message
	}

	private endMessage(messageId: string, message: MessageState, events: BaseEvent[]): void {
		if (message.closed) return
		message.closed = true
		events.push({ type: EventType.TEXT_MESSAGE_END, messageId })
	}

	private startTool(
		toolCallId: string,
		toolName: string,
		events: BaseEvent[],
		messageId?: string,
	): ToolState {
		const existing = this.tools.get(toolCallId)
		if (existing) return existing
		const parentMessageId = messageId ?? this.lastMessageId ?? randomUUID()
		const syntheticMessage = messageId === undefined && !this.messages.has(parentMessageId)
		const message = this.startMessage(parentMessageId, events)
		// Executor-only tool events have no native message end to close a
		// synthetic parent. Announce its identity with an empty envelope.
		if (syntheticMessage) {
			this.endMessage(parentMessageId, message, events)
		}
		const tool: ToolState = {
			arguments: '',
			closed: false,
			resultSent: false,
			inputTruncated: false,
		}
		this.tools.set(toolCallId, tool)
		this.toolNames.set(toolCallId, toolName)
		events.push({
			type: EventType.TOOL_CALL_START,
			toolCallId,
			toolCallName: toolName,
			parentMessageId,
		})
		return tool
	}

	private completeToolInput(
		toolCallId: string,
		tool: ToolState,
		input: unknown,
		events: BaseEvent[],
		inputTruncated = false,
		inputError?: ToolInputError,
	): void {
		if (tool.closed) return
		tool.inputTruncated = inputTruncated
		tool.inputError = inputError
		if (tool.arguments) {
			try {
				JSON.parse(tool.arguments)
			} catch {
				tool.inputTruncated = true
			}
		}
		if (!tool.inputTruncated && !tool.arguments) {
			try {
				const args = JSON.stringify(input)
				if (args === undefined) throw new TypeError('Tool input is not JSON.')
				tool.arguments = args
				events.push({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args })
			} catch {
				tool.inputTruncated = true
				events.push(
					...this.fail('Tool input could not be encoded as JSON.', 'NAMZU_TOOL_INPUT_INVALID'),
				)
				return
			}
		}
		this.endTool(toolCallId, tool, events)
	}

	private endTool(toolCallId: string, tool: ToolState, events: BaseEvent[]): void {
		if (tool.closed) return
		tool.closed = true
		events.push({
			type: EventType.TOOL_CALL_END,
			toolCallId,
			// `inputTruncated` is set for arguments cut off and malformed alike;
			// `inputError.reason` is what tells a host which.
			...(tool.inputTruncated
				? {
						metadata: {
							namzu: {
								inputTruncated: true,
								...(tool.inputError ? { inputError: tool.inputError } : {}),
							},
						},
					}
				: {}),
		})
	}

	private startStep(iteration: number, events: BaseEvent[]): void {
		if (this.steps.has(iteration)) return
		this.steps.set(iteration, false)
		events.push({ type: EventType.STEP_STARTED, stepName: `iteration-${iteration}` })
	}

	private endStep(iteration: number, events: BaseEvent[]): void {
		if (this.steps.get(iteration) !== false) return
		this.steps.set(iteration, true)
		events.push({ type: EventType.STEP_FINISHED, stepName: `iteration-${iteration}` })
	}

	private closeOpenParts(events: BaseEvent[]): void {
		for (const [toolCallId, tool] of this.tools) {
			if (!tool.closed && tool.arguments) {
				try {
					JSON.parse(tool.arguments)
				} catch {
					tool.inputTruncated = true
				}
			}
			this.endTool(toolCallId, tool, events)
		}
		for (const [messageId, message] of this.messages) this.endMessage(messageId, message, events)
		for (const iteration of this.steps.keys()) this.endStep(iteration, events)
	}
}
