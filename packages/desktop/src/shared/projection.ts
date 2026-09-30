import type { AcpSessionUpdate } from '@namzu/sdk'
import type { ChatMessage, DesktopEvent, PermissionView } from './protocol.js'
export interface ThreadState {
	messages: ChatMessage[]
	running: boolean
	queued: string[]
	error?: string
	tools: Record<string, Extract<AcpSessionUpdate, { kind: 'tool_call' }>>
	permissions: PermissionView[]
	reasoning: string
	partial?: boolean
	stopReason?: string
}
export const emptyThread = (): ThreadState => ({
	messages: [],
	running: false,
	queued: [],
	tools: {},
	permissions: [],
	reasoning: '',
})
export function applyEvent(thread: ThreadState, event: DesktopEvent): ThreadState {
	if (event.kind === 'prompt')
		return {
			...thread,
			messages: [...thread.messages, { role: 'user', text: event.prompt }],
			error: undefined,
			stopReason: undefined,
			reasoning: '',
		}
	if (event.kind === 'state')
		return {
			...thread,
			running: event.running,
			queued: event.queued,
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
		if (last?.role === 'assistant')
			messages[messages.length - 1] = {
				...last,
				text: last.text + update.text,
			}
		else messages.push({ role: 'assistant', text: update.text })
		return { ...thread, messages }
	}
	if (update.kind === 'agent_thought_chunk')
		return { ...thread, reasoning: thread.reasoning + update.text }
	if (update.kind === 'tool_call') {
		const prior = thread.tools[update.toolCallId]
		const tool = update.progress && prior ? { ...update, view: prior.view } : update
		return { ...thread, tools: { ...thread.tools, [update.toolCallId]: tool } }
	}
	return {
		...thread,
		stopReason: update.stopReason,
		...(update.error ? { error: update.error } : {}),
	}
}
