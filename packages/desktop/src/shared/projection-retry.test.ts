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

it('keeps a provider-stopped turn open for a new message until the person goes on without it', () => {
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
		update: { kind: 'turn_ended', turnId: 't', stopReason: 'cancelled', reason: 'paused' },
	})
	thread = applyEvent(thread, {
		kind: 'retry-status',
		sessionId: 's',
		retry: { turnId: 't', checkpointId: 'c', original: { provider: 'anthropic', model: 'm' } },
		closable: true,
	})
	expect(thread.retryClosable).toBe(true)
	expect(thread.retry?.original).toEqual({ provider: 'anthropic', model: 'm' })
	// Going on closes it: the turn reads as abandoned and nothing stays offered.
	thread = applyEvent(thread, { kind: 'turn-closed', sessionId: 's' })
	expect(thread.turns[thread.turn]?.reason).toBe('abandoned')
	expect(thread.retry).toBeUndefined()
	expect(thread.retryClosable).toBeUndefined()
})

it('holds a handoff from the status until the turn continues or closes, never as a failure', () => {
	const waiting = { turnId: 't', checkpointId: 'c', reason: 'Sign in', tool: 'browser' }
	const paused = () => {
		let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Go', at: 10 })
		thread = applyEvent(thread, {
			kind: 'update',
			projectId: 'p',
			sessionId: 's',
			at: 20,
			update: { kind: 'turn_ended', turnId: 't', stopReason: 'cancelled', reason: 'paused' },
		})
		return applyEvent(thread, {
			kind: 'retry-status',
			sessionId: 's',
			handoff: waiting,
			closable: true,
		})
	}
	let thread = paused()
	expect(thread.handoff).toEqual(waiting)
	expect(thread.retry).toBeUndefined()
	expect(thread.retryNotice).toBeUndefined()
	expect(thread.retryClosable).toBe(true)
	// Continuing takes the card away at once, and the turn is the same turn.
	thread = applyEvent(thread, { kind: 'retry', sessionId: 's', turnId: 't' })
	expect(thread.handoff).toBeUndefined()
	expect(thread.turns[1]?.turnId).toBe('t')
	// Stopping or moving on takes it away too.
	thread = applyEvent(paused(), { kind: 'turn-closed', sessionId: 's' })
	expect(thread.handoff).toBeUndefined()
	expect(thread.turns[thread.turn]?.reason).toBe('abandoned')
	// A status without a handoff clears it.
	thread = applyEvent(paused(), { kind: 'retry-status', sessionId: 's' })
	expect(thread.handoff).toBeUndefined()
})
