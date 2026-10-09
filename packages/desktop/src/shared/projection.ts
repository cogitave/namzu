import type { AcpSessionUpdate, AcpTask, ToolCallView } from '@namzu/sdk'
import type {
	ChatMessage,
	DesktopEvent,
	DesktopTurnRetry,
	DesktopTurnUndo,
	PermissionView,
	QueuedMessageView,
} from './protocol.js'

type TranscriptTime = NonNullable<ChatMessage['time']>

export type TimelineEntry =
	| { kind: 'message'; index: number; turn: number }
	| { kind: 'tool'; id: string; turn: number }
	| { kind: 'reasoning'; id: string; turn: number }
export interface ReasoningSegment {
	text: string
	status: 'pending' | 'completed'
	turn: number
	messageId?: string
	blockId?: string
	startedTime?: TranscriptTime
	endedTime?: TranscriptTime
}
export interface TurnState {
	/** Host admission/settlement timestamps, unavailable for cold text history. */
	startedAt?: number
	endedAt?: number
	/** Durable journal boundaries stay distinct from the host's observed clock. */
	startedTime?: TranscriptTime
	endedTime?: TranscriptTime
	/** Durable runtime duration, distinct from Desktop host admission/settlement clocks. */
	recordedDurationMs?: number
	turnId?: string
	stopReason?: string
	reason?: string
	result?: string
}
export type ProjectedToolCall = Extract<AcpSessionUpdate, { kind: 'tool_call' }> & {
	/** First admitted call presentation, distinct from the current result view. */
	readonly callView?: ToolCallView
	/** Display-only historical outcome absent from ACP's live three-state union. */
	readonly historicalStatus?: 'skipped'
	/** A saved action whose view was never journaled: named from its tool, nothing to open. */
	readonly detailUnavailable?: true
	readonly startedTime?: TranscriptTime
	readonly endedTime?: TranscriptTime
}
export interface ThreadState {
	revision: number
	/** Agent-maintained planning records; completion is not a verification receipt. */
	tasks: AcpTask[]
	tasksNotice?: string
	messages: ChatMessage[]
	/** Admission order, independent of clocks and subsequent tool progress. */
	timeline: TimelineEntry[]
	turn: number
	turns: Record<number, TurnState>
	running: boolean
	liveInputSupported: boolean
	queued: string[]
	queuedItems: QueuedMessageView[]
	/** Accepted current-turn input remains distinct from a started next-turn prompt. */
	liveInputs: {
		id: string
		prompt: string
		status: 'pending' | 'delivered' | 'unknown'
		/** Keep a delayed delivery confirmation at its original submission position. */
		timelineIndex: number
		time?: TranscriptTime
	}[]
	error?: string
	retry?: DesktopTurnRetry
	retryNotice?: string
	/** Per journal turn id; only ever written from the CLI's undo-status. */
	undo?: Record<string, DesktopTurnUndo>
	tools: Record<string, ProjectedToolCall>
	activeToolIds: string[]
	permissions: PermissionView[]
	/** Calls that were still waiting for an answer when the turn ended: they never ran. */
	unanswered?: { turn: number; calls: { id: string; name: string }[] }
	reasoning: Record<string, ReasoningSegment>
	activeReasoningId?: string
	responding: boolean
	partial?: boolean
	/** Some saved action details were absent or exceeded their display bounds. */
	historyWorkPartial?: boolean
	stopReason?: string
	reason?: string
	result?: string
}
export const emptyThread = (): ThreadState => ({
	revision: 0,
	tasks: [],
	messages: [],
	timeline: [],
	turn: 0,
	turns: {},
	running: false,
	liveInputSupported: false,
	queued: [],
	queuedItems: [],
	liveInputs: [],
	tools: {},
	activeToolIds: [],
	permissions: [],
	reasoning: {},
	responding: false,
})
/** Durable text history provides no reasoning, tool receipts or host duration. */
export function restoreMessages(thread: ThreadState, messages: ChatMessage[]): ThreadState {
	let turn = 0
	const timeline = messages.map((message, index): TimelineEntry => {
		if (message.role === 'user') turn += 1
		return { kind: 'message', index, turn }
	})
	return {
		...thread,
		messages,
		liveInputs: [],
		timeline,
		turn,
		liveInputSupported: false,
		turns: {},
		tools: {},
		activeToolIds: [],
		reasoning: {},
		activeReasoningId: undefined,
		responding: false,
		stopReason: undefined,
		reason: undefined,
		result: undefined,
		retry: undefined,
		retryNotice: undefined,
		undo: undefined,
		historyWorkPartial: undefined,
	}
}
/** Explicit waiting and real tools take precedence over model streaming. */
export function threadPhase(
	thread: ThreadState,
): 'idle' | 'waiting' | 'tools' | 'thinking' | 'responding' | 'working' {
	if (!thread.running || thread.stopReason !== undefined) return 'idle'
	if (thread.permissions.length) return 'waiting'
	if (thread.activeToolIds.some((id) => thread.tools[id]?.status === 'pending')) return 'tools'
	const reasoning = thread.activeReasoningId
		? thread.reasoning[thread.activeReasoningId]
		: undefined
	if (reasoning?.turn === thread.turn && reasoning.status === 'pending') return 'thinking'
	return thread.responding ? 'responding' : 'working'
}
function timestamp(at: number | undefined): number | undefined {
	return at !== undefined && Number.isFinite(at) && at >= 0 ? at : undefined
}
function observedTime(at: number | undefined): TranscriptTime | undefined {
	const valid = timestamp(at)
	return valid === undefined ? undefined : { at: valid, source: 'host' }
}
function updateTurn(thread: ThreadState, update: AcpSessionUpdate): number {
	if (!('turnId' in update) || !update.turnId) return thread.turn
	for (const [turn, state] of Object.entries(thread.turns))
		if (state.turnId === update.turnId) return Number(turn)
	return thread.turn
}
function messageIndices(thread: ThreadState, turn: number, messageId?: string): number[] {
	return thread.timeline.flatMap((entry) =>
		entry.kind === 'message' &&
		entry.turn === turn &&
		thread.messages[entry.index]?.role === 'assistant' &&
		(messageId === undefined || thread.messages[entry.index]?.messageId === messageId)
			? [entry.index]
			: [],
	)
}
function appendMessage(thread: ThreadState, turn: number, message: ChatMessage): ThreadState {
	return {
		...thread,
		messages: [...thread.messages, message],
		timeline: [...thread.timeline, { kind: 'message', index: thread.messages.length, turn }],
	}
}
function replaceMessage(thread: ThreadState, index: number, message: ChatMessage): ThreadState {
	const messages = [...thread.messages]
	messages[index] = {
		...message,
		...(thread.messages[index]?.time ? { time: thread.messages[index].time } : {}),
	}
	return { ...thread, messages }
}
/** Remove superseded public rows and remap indexes without moving other activity. */
function removeMessages(thread: ThreadState, removed: number[]): ThreadState {
	if (!removed.length) return thread
	const remove = new Set(removed)
	const indices = new Map<number, number>()
	const messages = thread.messages.filter((_message, index) => {
		if (remove.has(index)) return false
		indices.set(index, indices.size)
		return true
	})
	const timeline = thread.timeline.flatMap((entry): TimelineEntry[] => {
		if (entry.kind !== 'message') return [entry]
		const index = indices.get(entry.index)
		return index === undefined ? [] : [{ ...entry, index }]
	})
	return { ...thread, messages, timeline }
}
function completedMessage(
	thread: ThreadState,
	turn: number,
	update: Extract<AcpSessionUpdate, { kind: 'agent_message' }>,
	time?: TranscriptTime,
): ThreadState {
	const last = thread.timeline.at(-1)
	const indices = update.messageId
		? messageIndices(thread, turn, update.messageId)
		: last?.kind === 'message' &&
				last.turn === turn &&
				thread.messages[last.index]?.role === 'assistant'
			? [last.index]
			: []
	if (update.textParts?.length) {
		const ids = new Set(update.textParts.map((part) => part.id))
		const superseded = indices.filter((index) => !ids.has(thread.messages[index]?.textPartId ?? ''))
		const retained = new Set<number>()
		let next = thread
		for (const part of update.textParts) {
			// A provider can expose part identities only in its settled message.
			// Reuse the aggregate's admitted position rather than moving it past tools.
			const index =
				indices.find((index) => thread.messages[index]?.textPartId === part.id) ??
				superseded.shift()
			if (index !== undefined) retained.add(index)
			const message: ChatMessage = {
				role: 'assistant',
				text: part.text,
				...(time ? { time } : {}),
				...(update.messageId ? { messageId: update.messageId } : {}),
				textPartId: part.id,
				...(part.phase ? { phase: part.phase } : {}),
				status: 'completed',
				stopReason: update.stopReason,
			}
			next =
				index === undefined
					? appendMessage(next, turn, message)
					: replaceMessage(next, index, message)
		}
		return removeMessages(
			next,
			indices.filter((index) => !retained.has(index)),
		)
	}
	if (update.content === undefined) {
		let next = thread
		for (const index of indices) {
			const message = thread.messages[index]
			if (message)
				next = replaceMessage(next, index, {
					...message,
					status: 'completed',
					stopReason: update.stopReason,
				})
		}
		return next
	}
	const index = indices.at(-1)
	const message: ChatMessage = {
		...(index === undefined ? {} : thread.messages[index]),
		role: 'assistant',
		text: update.content ?? '',
		...(time ? { time } : {}),
		...(update.messageId ? { messageId: update.messageId } : {}),
		status: 'completed',
		stopReason: update.stopReason,
	}
	if (index === undefined) return message.text ? appendMessage(thread, turn, message) : thread
	return removeMessages(
		replaceMessage(thread, index, message),
		indices.filter((entry) => entry !== index),
	)
}
function settledAnswer(
	thread: ThreadState,
	turn: number,
	result: string,
	messageId?: string,
	time?: TranscriptTime,
): ThreadState {
	const indices = messageIndices(thread, turn, messageId)
	const explicit = indices.filter((index) => thread.messages[index]?.phase === 'final_answer')
	const fallback = indices
		.filter((index) => {
			const message = thread.messages[index]
			return message?.phase !== 'commentary' && message?.stopReason !== 'tool_use'
		})
		.at(-1)
	const selected = explicit.length ? explicit : fallback === undefined ? [] : [fallback]
	if (!selected.length)
		return result
			? appendMessage(thread, turn, {
					role: 'assistant',
					text: result,
					...(time ? { time } : {}),
					status: 'completed',
					...(messageId ? { messageId } : {}),
				})
			: thread
	if (selected.map((index) => thread.messages[index]?.text).join('\n\n') === result) return thread
	if (!result) return removeMessages(thread, selected)
	const first = selected[0]
	if (first === undefined || !thread.messages[first]) return thread
	return removeMessages(
		replaceMessage(thread, first, {
			...thread.messages[first],
			text: result,
			status: 'completed',
		}),
		selected.slice(1),
	)
}
export function applyEvent(previous: ThreadState, event: DesktopEvent): ThreadState {
	if (event.kind === 'connection' || event.kind === 'background-work-status') return previous
	if (event.revision !== undefined && event.revision <= previous.revision) return previous
	let thread = event.revision === undefined ? previous : { ...previous, revision: event.revision }
	if (event.kind === 'attachment-previews-evicted') {
		const ids = new Set(event.attachmentIds)
		let changed = false
		const messages = thread.messages.map((message) => {
			if (!message.attachments?.some((file) => ids.has(file.id) && file.preview !== undefined))
				return message
			changed = true
			return {
				...message,
				attachments: message.attachments.map((file) => {
					if (!ids.has(file.id) || file.preview === undefined) return file
					const { preview: _preview, ...metadata } = file
					return metadata
				}),
			}
		})
		return changed ? { ...thread, messages } : thread
	}
	if (event.kind === 'tasks')
		return {
			...thread,
			tasks: event.tasks ?? thread.tasks,
			tasksNotice: event.notice,
		}
	if (event.kind === 'task') {
		const index = thread.tasks.findIndex((task) => task.taskId === event.task.taskId)
		const tasks = [...thread.tasks]
		if (event.deleted) {
			if (index >= 0) tasks.splice(index, 1)
		} else if (index < 0) tasks.push(event.task)
		// An update keeps the task's place in the list.
		else tasks[index] = event.task
		return { ...thread, tasks }
	}
	if (event.kind === 'prompt') {
		const turn = thread.turn + 1
		const at = timestamp(event.at)
		return {
			...appendMessage(thread, turn, {
				role: 'user',
				text: event.prompt,
				...(at === undefined ? {} : { time: { at, source: 'host' as const } }),
				...(event.attachments?.length ? { attachments: event.attachments } : {}),
			}),
			turn,
			liveInputSupported: thread.liveInputSupported,
			liveInputs: [],
			turns: {
				...thread.turns,
				[turn]: at === undefined ? {} : { startedAt: at },
			},
			error: undefined,
			stopReason: undefined,
			reason: undefined,
			result: undefined,
			retry: undefined,
			retryNotice: undefined,
			activeToolIds: [],
			activeReasoningId: undefined,
			responding: false,
		}
	}
	if (event.kind === 'live-input') {
		if (event.status === 'queued')
			return {
				...thread,
				liveInputs: thread.liveInputs.filter((item) => item.id !== event.inputId),
			}
		const prior = thread.liveInputs.find((item) => item.id === event.inputId)
		if (
			prior?.status === 'delivered' ||
			(prior?.status === event.status && prior.prompt === event.prompt)
		)
			return thread
		const timelineIndex = prior?.timelineIndex ?? thread.timeline.length
		const time = prior?.time ?? observedTime(event.at)
		const liveInputs = [
			...thread.liveInputs.filter((item) => item.id !== event.inputId),
			{
				id: event.inputId,
				prompt: event.prompt,
				status: event.status,
				timelineIndex,
				...(time ? { time } : {}),
			},
		]
		if (event.status !== 'delivered' || !prior) return { ...thread, liveInputs }
		const insertion = Math.min(timelineIndex, thread.timeline.length)
		return {
			...thread,
			messages: [
				...thread.messages,
				{ role: 'user', text: event.prompt, ...(prior.time ? { time: prior.time } : {}) },
			],
			timeline: [
				...thread.timeline.slice(0, insertion),
				{ kind: 'message', index: thread.messages.length, turn: thread.turn },
				...thread.timeline.slice(insertion),
			],
			liveInputs: liveInputs.map((item) =>
				item.id !== event.inputId && item.timelineIndex >= insertion
					? { ...item, timelineIndex: item.timelineIndex + 1 }
					: item,
			),
		}
	}
	if (event.kind === 'undo-status') {
		const undo = { ...thread.undo }
		for (const turn of event.turns) {
			const before = undo[turn.turnId]
			// The time is this window's observation; keep it while the status it belongs to stands.
			const undoneAt =
				turn.undoneAt ??
				(before && before.status === turn.status && turn.status !== 'applied'
					? before.undoneAt
					: undefined)
			undo[turn.turnId] = { ...turn, ...(undoneAt === undefined ? {} : { undoneAt }) }
		}
		return { ...thread, undo }
	}
	if (event.kind === 'retry-status')
		return { ...thread, retry: event.retry, retryNotice: event.notice }
	if (event.kind === 'retry') {
		const turn =
			Object.entries(thread.turns).find(([, state]) => state.turnId === event.turnId)?.[0] ??
			thread.turn
		return {
			...thread,
			turn: Number(turn),
			turns: {
				...thread.turns,
				[turn]: {
					...thread.turns[Number(turn)],
					turnId: event.turnId,
					endedAt: undefined,
					stopReason: undefined,
					reason: undefined,
					result: undefined,
				},
			},
			error: undefined,
			stopReason: undefined,
			reason: undefined,
			result: undefined,
			retry: undefined,
			retryNotice: undefined,
			activeToolIds: [],
			activeReasoningId: undefined,
			responding: false,
		}
	}
	if (event.kind === 'state')
		return {
			...thread,
			running: event.running,
			// A settled turn has nothing left to confirm; pending/unknown stay visible.
			liveInputs: event.running
				? thread.liveInputs
				: thread.liveInputs.filter((item) => item.status !== 'delivered'),
			liveInputSupported: event.liveInputSupported === true,
			activeToolIds: event.running ? thread.activeToolIds : [],
			activeReasoningId: event.running ? thread.activeReasoningId : undefined,
			responding: event.running && thread.responding,
			queued: event.queued,
			queuedItems: event.queuedItems ?? [],
			...(event.error ? { error: event.error } : {}),
		}
	if (event.kind === 'permission') {
		const index = thread.permissions.findIndex((permission) => permission.id === event.request.id)
		const permissions = [...thread.permissions]
		if (index < 0) permissions.push(event.request)
		else permissions[index] = event.request
		return { ...thread, permissions }
	}
	if (event.kind === 'permission-cleared') {
		// Clearing everything at once is the turn ending; what still waited never ran.
		const calls = event.requestId
			? []
			: thread.permissions.flatMap((permission) =>
					permission.calls.map((call) => ({ id: call.id, name: call.name })),
				)
		return {
			...thread,
			permissions: event.requestId
				? thread.permissions.filter((permission) => permission.id !== event.requestId)
				: [],
			...(calls.length ? { unanswered: { turn: thread.turn, calls } } : {}),
		}
	}
	if (event.kind !== 'update') return thread
	const update = event.update
	const turn = updateTurn(thread, update)
	const current = turn === thread.turn
	// The settled answer remains authoritative even if a delayed stream tail
	// arrives after its rejected/provisional row was removed.
	if (
		thread.turns[turn]?.stopReason !== undefined &&
		update.kind !== 'turn_ended' &&
		update.kind !== 'tool_call'
	)
		return thread
	if (
		'turnId' in update &&
		update.turnId &&
		thread.turns[turn]?.turnId &&
		thread.turns[turn]?.turnId !== update.turnId
	)
		return thread
	if ('turnId' in update && update.turnId && !thread.turns[turn]?.turnId)
		thread = {
			...thread,
			turns: {
				...thread.turns,
				[turn]: { ...thread.turns[turn], turnId: update.turnId },
			},
		}
	if (update.kind === 'agent_message_chunk') {
		const partId = update.textPart?.id
		const last = thread.timeline.at(-1)
		const index = update.messageId
			? messageIndices(thread, turn, update.messageId).find(
					(index) => thread.messages[index]?.textPartId === partId,
				)
			: last?.kind === 'message' &&
					last.turn === turn &&
					thread.messages[last.index]?.role === 'assistant'
				? last.index
				: undefined
		const prior = index === undefined ? undefined : thread.messages[index]
		if (prior?.status === 'completed') return thread
		const phase = update.textPart?.phase ?? update.phase ?? prior?.phase
		const time = prior?.time ?? observedTime(event.at)
		const message: ChatMessage = {
			...prior,
			role: 'assistant',
			text: (prior?.text ?? '') + update.text,
			...(time ? { time } : {}),
			...(update.messageId ? { messageId: update.messageId, status: 'pending' } : {}),
			...(partId ? { textPartId: partId } : {}),
			...(phase ? { phase } : {}),
		}
		thread =
			index === undefined
				? appendMessage(thread, turn, message)
				: replaceMessage(thread, index, message)
		return current ? { ...thread, responding: true, activeReasoningId: undefined } : thread
	}
	if (update.kind === 'agent_message') {
		thread = completedMessage(thread, turn, update, observedTime(event.at))
		return current ? { ...thread, responding: false, activeReasoningId: undefined } : thread
	}
	if (update.kind === 'agent_thought' || update.kind === 'agent_thought_chunk') {
		const last = thread.timeline.at(-1)
		const identity = update.blockId ?? update.messageId
		const id = identity
			? `${turn}:${identity}`
			: last?.kind === 'reasoning' &&
					last.turn === turn &&
					thread.reasoning[last.id]?.status === 'pending'
				? last.id
				: `${turn}:legacy-${Object.keys(thread.reasoning).length}`
		const prior = thread.reasoning[id]
		if (
			prior?.status === 'completed' &&
			(update.kind === 'agent_thought_chunk' || update.status === 'pending')
		)
			return thread
		const time = observedTime(event.at)
		const startedTime =
			prior?.startedTime ??
			(update.kind === 'agent_thought' && update.status === 'completed' ? undefined : time)
		const endedTime =
			prior?.endedTime ??
			(update.kind === 'agent_thought' && update.status === 'completed' ? time : undefined)
		const segment: ReasoningSegment = {
			text: (prior?.text ?? '') + (update.kind === 'agent_thought_chunk' ? update.text : ''),
			status: update.kind === 'agent_thought' ? update.status : 'pending',
			turn,
			...(update.messageId ? { messageId: update.messageId } : {}),
			...(update.blockId ? { blockId: update.blockId } : {}),
			...(startedTime ? { startedTime } : {}),
			...(endedTime ? { endedTime } : {}),
		}
		return {
			...thread,
			reasoning: { ...thread.reasoning, [id]: segment },
			timeline: prior ? thread.timeline : [...thread.timeline, { kind: 'reasoning', id, turn }],
			...(current
				? {
						activeReasoningId:
							segment.status === 'pending'
								? id
								: thread.activeReasoningId === id
									? undefined
									: thread.activeReasoningId,
						responding: false,
					}
				: {}),
		}
	}
	if (update.kind === 'tool_call') {
		const toolKey = `${turn}:${update.toolCallId}`
		const prior = thread.tools[toolKey]
		const callView =
			prior?.callView ?? (!update.progress && update.status === 'pending' ? update.view : undefined)
		const currentTool =
			update.progress && prior
				? { ...prior, ...update, status: prior.status, view: prior.view }
				: update
		const { historicalStatus: _historicalStatus, ...liveTool } = currentTool as ProjectedToolCall
		const time = observedTime(event.at)
		const startedTime = prior?.startedTime ?? (liveTool.status === 'pending' ? time : undefined)
		const endedTime = prior?.endedTime ?? (liveTool.status !== 'pending' ? time : undefined)
		const tool: ProjectedToolCall = {
			...liveTool,
			callView,
			...(startedTime ? { startedTime } : {}),
			...(endedTime ? { endedTime } : {}),
		}
		const activeToolIds = thread.activeToolIds.filter((id) => id !== toolKey)
		if (current && thread.running && thread.stopReason === undefined && tool.status === 'pending')
			activeToolIds.push(toolKey)
		return {
			...thread,
			activeToolIds,
			...(current ? { responding: false, activeReasoningId: undefined } : {}),
			tools: { ...thread.tools, [toolKey]: tool },
			timeline: prior ? thread.timeline : [...thread.timeline, { kind: 'tool', id: toolKey, turn }],
		}
	}
	if (update.result !== undefined)
		thread = settledAnswer(thread, turn, update.result, update.messageId, observedTime(event.at))
	const at = timestamp(event.at)
	return {
		...thread,
		turns: {
			...thread.turns,
			[turn]: {
				...thread.turns[turn],
				...(at === undefined || thread.turns[turn]?.endedAt !== undefined ? {} : { endedAt: at }),
				stopReason: update.stopReason,
				...(update.reason === undefined ? {} : { reason: update.reason }),
				...(update.result === undefined ? {} : { result: update.result }),
			},
		},
		...(current
			? {
					stopReason: update.stopReason,
					liveInputSupported: false,
					reason: update.reason,
					result: update.result,
					activeToolIds: [],
					activeReasoningId: undefined,
					responding: false,
					...(update.error ? { error: update.error } : {}),
				}
			: {}),
	}
}

/** Queued messages only drain after a clean `end_turn`; after a stop or error they wait. */
export function queueParked(
	thread: Pick<ThreadState, 'running' | 'queuedItems' | 'stopReason'>,
): boolean {
	return !thread.running && thread.queuedItems.length > 0 && thread.stopReason !== 'end_turn'
}
