import type { AcpSessionUpdate } from '@namzu/sdk'
import type { ChatMessage, DesktopEvent, PermissionView, QueuedMessageView } from './protocol.js'
export type TimelineEntry =
	| { kind: 'message'; index: number; turn: number }
	| { kind: 'tool'; id: string; turn: number }
export interface ThreadState {
	revision: number
	messages: ChatMessage[]
	/** Admission order, independent of clocks and subsequent tool progress. */
	timeline: TimelineEntry[]
	turn: number
	running: boolean
	queued: string[]
	queuedItems: QueuedMessageView[]
	error?: string
	tools: Record<string, Extract<AcpSessionUpdate, { kind: 'tool_call' }>>
	activeToolIds: string[]
	permissions: PermissionView[]
	reasoning: string
	partial?: boolean
	stopReason?: string
}
export const emptyThread = (): ThreadState => ({
	revision: 0,
	messages: [],
	timeline: [],
	turn: 0,
	running: false,
	queued: [],
	queuedItems: [],
	tools: {},
	activeToolIds: [],
	permissions: [],
	reasoning: '',
})
/** Durable text history has no tool receipts. Do not invent them on reload. */
export function restoreMessages(thread: ThreadState, messages: ChatMessage[]): ThreadState {
	let turn = 0
	const timeline = messages.map((message, index): TimelineEntry => {
		if (message.role === 'user') turn += 1
		return { kind: 'message', index, turn }
	})
	return { ...thread, messages, timeline, turn }
}
export function applyEvent(previous: ThreadState, event: DesktopEvent): ThreadState {
	if (event.kind === 'connection') return previous
	if (event.revision !== undefined && event.revision <= previous.revision) return previous
	const thread = event.revision === undefined ? previous : { ...previous, revision: event.revision }
	if (event.kind === 'prompt')
		return {
			...thread,
			messages: [
				...thread.messages,
				{
					role: 'user',
					text: event.prompt,
					...(event.attachments?.length ? { attachments: event.attachments } : {}),
				},
			],
			timeline: [
				...thread.timeline,
				{ kind: 'message', index: thread.messages.length, turn: thread.turn + 1 },
			],
			turn: thread.turn + 1,
			error: undefined,
			stopReason: undefined,
			reasoning: '',
			activeToolIds: [],
		}
	if (event.kind === 'state')
		return {
			...thread,
			running: event.running,
			activeToolIds: event.running ? thread.activeToolIds : [],
			queued: event.queued,
			queuedItems: event.queuedItems ?? [],
			...(event.error ? { error: event.error } : {}),
		}
	if (event.kind === 'permission')
		return { ...thread, permissions: [...thread.permissions, event.request] }
	if (event.kind === 'permission-cleared')
		return {
			...thread,
			permissions: event.requestId
				? thread.permissions.filter((permission) => permission.id !== event.requestId)
				: [],
		}
	if (event.kind !== 'update') return thread
	const update = event.update
	if (update.kind === 'agent_message_chunk') {
		const messages = [...thread.messages]
		const last = messages.at(-1)
		const lastEntry = thread.timeline.at(-1)
		const continuing =
			last?.role === 'assistant' &&
			lastEntry?.kind === 'message' &&
			lastEntry.index === messages.length - 1
		if (continuing)
			messages[messages.length - 1] = {
				...last,
				text: last.text + update.text,
			}
		else messages.push({ role: 'assistant', text: update.text })
		return {
			...thread,
			messages,
			timeline: continuing
				? thread.timeline
				: [...thread.timeline, { kind: 'message', index: messages.length - 1, turn: thread.turn }],
		}
	}
	if (update.kind === 'agent_thought_chunk')
		return { ...thread, reasoning: thread.reasoning + update.text }
	if (update.kind === 'tool_call') {
		// Provider IDs can be reused on a later turn. The admitted turn owns
		// both the row and its progress/completion updates.
		const toolKey = `${thread.turn}:${update.toolCallId}`
		const prior = thread.tools[toolKey]
		const tool = update.progress && prior ? { ...update, view: prior.view } : update
		const activeToolIds = thread.activeToolIds.filter((id) => id !== toolKey)
		if (thread.running && update.status === 'pending') activeToolIds.push(toolKey)
		return {
			...thread,
			activeToolIds,
			tools: { ...thread.tools, [toolKey]: tool },
			timeline: prior
				? thread.timeline
				: [...thread.timeline, { kind: 'tool', id: toolKey, turn: thread.turn }],
		}
	}
	return {
		...thread,
		stopReason: update.stopReason,
		activeToolIds: [],
		...(update.error ? { error: update.error } : {}),
	}
}
