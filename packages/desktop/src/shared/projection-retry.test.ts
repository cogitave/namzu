import { expect, it } from 'vitest'
import { applyEvent, emptyThread, threadPhase } from './projection.js'

it('continues the original admitted turn without another authored message or lost receipts', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Build',
		at: 10,
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		at: 20,
		update: {
			kind: 'turn_ended',
			turnId: 't',
			stopReason: 'cancelled',
			reason: 'paused',
			error: 'Provider unavailable',
		},
	})
	thread = applyEvent(thread, {
		kind: 'retry-status',
		sessionId: 's',
		retry: { turnId: 't', checkpointId: 'c' },
	})
	const messages = thread.messages
	const timeline = thread.timeline
	thread = applyEvent(thread, { kind: 'retry', sessionId: 's', turnId: 't' })
	thread = applyEvent(thread, {
		kind: 'state',
		sessionId: 's',
		running: true,
		queued: ['Keep queued'],
	})
	expect(thread.messages).toBe(messages)
	expect(thread.timeline).toBe(timeline)
	expect(thread.turn).toBe(1)
	expect(thread.turns[1]).toMatchObject({ startedAt: 10, turnId: 't' })
	expect(thread.turns[1]?.endedAt).toBeUndefined()
	expect(thread.stopReason).toBeUndefined()
	expect(thread.error).toBeUndefined()
	expect(thread.retry).toBeUndefined()
	expect(threadPhase(thread)).toBe('working')
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: { kind: 'agent_message_chunk', turnId: 't', text: 'continued' },
	})
	expect(thread.messages.at(-1)?.text).toBe('continued')
	expect(thread.queued).toEqual(['Keep queued'])
})
