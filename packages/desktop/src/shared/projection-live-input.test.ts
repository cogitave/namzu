import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from './projection.js'

it('places a delayed delivered input before the following assistant reply without duplicating it', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 'conversation',
		prompt: 'Original request',
	})
	thread = applyEvent(thread, {
		kind: 'live-input',
		sessionId: 'conversation',
		inputId: 'input-1',
		prompt: 'New direction',
		status: 'unknown',
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'project',
		sessionId: 'conversation',
		update: { kind: 'agent_message_chunk', text: 'Following answer' },
	})
	thread = applyEvent(thread, {
		kind: 'live-input',
		sessionId: 'conversation',
		inputId: 'input-1',
		prompt: 'New direction',
		status: 'pending',
	})
	thread = applyEvent(thread, {
		kind: 'live-input',
		sessionId: 'conversation',
		inputId: 'input-1',
		prompt: 'New direction',
		status: 'delivered',
	})
	thread = applyEvent(thread, {
		kind: 'live-input',
		sessionId: 'conversation',
		inputId: 'input-1',
		prompt: 'New direction',
		status: 'delivered',
	})
	expect(
		thread.timeline.flatMap((entry) =>
			entry.kind === 'message' ? [thread.messages[entry.index]?.text] : [],
		),
	).toEqual(['Original request', 'New direction', 'Following answer'])
	expect(thread.messages.filter((message) => message.role === 'user')).toHaveLength(2)
})
