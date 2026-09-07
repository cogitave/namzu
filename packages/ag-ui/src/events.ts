import { randomUUID } from 'node:crypto'
import { type BaseEvent, EventType, type TokenUsage } from '@ag-ui/core'
import type { RunEvent } from '@namzu/sdk'

/** Public AG-UI identity and, optionally, the native run whose events are being adapted. */
export interface AGUIEventMapperOptions {
	threadId: string
	runId: string
	nativeRunId?: string
}

interface MessageState {
	text: string
	closed: boolean
	completed: boolean
}

interface ToolState {
	arguments: string
	closed: boolean
	resultSent: boolean
	inputTruncated: boolean
}

const PUBLIC_EVENTS = new Set<RunEvent['type']>([
	'run_started',
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
	'run_completed',
	'run_failed',
	'run_paused',
])

/**
 * Stateful projection of one native run onto AG-UI's public event lifecycle.
 *
 * Messages and tool calls retain their native identities. Private runtime events
 * are deliberately omitted. A mapper is used once: only a native successful
 * terminal event can finish it successfully; an unexpected EOF is an error.
 */
export class AGUIEventMapper {
	private readonly threadId: string
	private readonly runId: string
	private nativeRunId: string | undefined
	private started = false
	private terminal = false
	private readonly messages = new Map<string, MessageState>()
	private readonly tools = new Map<string, ToolState>()
	private readonly steps = new Map<number, boolean>()
	private readonly seenSequences = new Set<number>()
	private readonly usage: TokenUsage[] = []
	private lastMessageId: string | undefined

	constructor(options: AGUIEventMapperOptions) {
		this.threadId = options.threadId
		this.runId = options.runId
		this.nativeRunId = options.nativeRunId
	}

	get ended(): boolean {
		return this.terminal
	}

	/** Announce the public run identity exactly once, without echoing request input. */
	start(): BaseEvent[] {
		if (this.started || this.terminal) return []
		this.started = true
		return [{ type: EventType.RUN_STARTED, threadId: this.threadId, runId: this.runId }]
	}

	/** Map a native event. Child runs, private events, and repeated durable events are omitted. */
	map(event: RunEvent): BaseEvent[] {
		if (this.terminal || !PUBLIC_EVENTS.has(event.type) || !this.belongsToRun(event)) return []
		if (event.seq !== undefined) {
			if (this.seenSequences.has(event.seq)) return []
			this.seenSequences.add(event.seq)
		}

		const events = this.start()
		switch (event.type) {
			case 'run_started':
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
				this.completeToolInput(event.toolUseId, tool, event.input, events, event.inputTruncated)
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
			case 'run_completed': {
				if (event.stopReason === 'paused') {
					events.push({ type: EventType.CUSTOM, name: 'namzu.run.paused', value: {} })
					return events.concat(this.fail('Namzu run paused.', 'NAMZU_RUN_PAUSED'))
				}
				if (event.stopReason !== undefined && event.stopReason !== 'end_turn') {
					return events.concat(
						this.fail(
							`Namzu run stopped: ${event.stopReason}.`,
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
			case 'run_failed':
				return events.concat(this.fail('Namzu run failed.', 'NAMZU_RUN_ERROR'))
			case 'run_paused':
				events.push({
					type: EventType.CUSTOM,
					name: 'namzu.run.paused',
					value: { checkpointId: event.checkpointId },
				})
				return events.concat(this.fail('Namzu run paused.', 'NAMZU_RUN_PAUSED'))
			default:
				// No raw event forwarding: prompts, reasoning, checkpoint payloads,
				// and internal instrumentation are outside this public projection.
				break
		}
		return events
	}

	/** Close a consumed stream. EOF without a native terminal event is never success. */
	finish(): BaseEvent[] {
		return this.fail(
			'The native event stream ended before a terminal run event.',
			'NAMZU_STREAM_INCOMPLETE',
		)
	}

	/** Close open protocol parts before reporting a public, caller-selected error. */
	fail(message: string, code = 'NAMZU_RUN_ERROR'): BaseEvent[] {
		if (this.terminal) return []
		const events = this.start()
		this.closeOpenParts(events)
		this.terminal = true
		events.push({ type: EventType.RUN_ERROR, message, code })
		return events
	}

	private belongsToRun(event: RunEvent): boolean {
		if (!('runId' in event) || (event.lineage?.depth ?? 0) > 0) return false
		if (this.nativeRunId === undefined) this.nativeRunId = event.runId
		return event.runId === this.nativeRunId
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
	): void {
		if (tool.closed) return
		tool.inputTruncated = inputTruncated
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
			...(tool.inputTruncated ? { metadata: { namzu: { inputTruncated: true } } } : {}),
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
