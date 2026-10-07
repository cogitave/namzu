import { expect, it } from 'vitest'
import { applyEvent, emptyThread, queueParked } from './projection.js'

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

it('drops delivered receipts when the turn settles but keeps unconfirmed ones', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 'conversation',
		prompt: 'Original request',
	})
	for (const [inputId, status] of [
		['done', 'pending'],
		['done', 'delivered'],
		['lost', 'unknown'],
	] as const)
		thread = applyEvent(thread, {
			kind: 'live-input',
			sessionId: 'conversation',
			inputId,
			prompt: inputId,
			status,
		})
	const state = (running: boolean) =>
		applyEvent(thread, {
			kind: 'state',
			sessionId: 'conversation',
			running,
			queued: [],
		} as never)
	expect(state(true).liveInputs.map((item) => item.id)).toEqual(['done', 'lost'])
	expect(state(false).liveInputs.map((item) => [item.id, item.status])).toEqual([
		['lost', 'unknown'],
	])
})

it('parks queued messages after a stop but not after a clean end', () => {
	const queuedItems = [{ id: 'q', prompt: 'Later' }] as never
	const base = { running: false, queuedItems }
	expect(queueParked({ ...base, stopReason: 'cancelled' })).toBe(true)
	expect(queueParked({ ...base, stopReason: 'end_turn' })).toBe(false)
	expect(queueParked({ ...base, running: true, stopReason: undefined })).toBe(false)
	expect(queueParked({ running: false, queuedItems: [], stopReason: 'cancelled' })).toBe(false)
})
