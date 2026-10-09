import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from './projection.js'

const running = () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Hello',
		at: 10,
	})
	thread = applyEvent(thread, { kind: 'state', sessionId: 's', running: true, queued: [] })
	return thread
}
const retryUpdate = (at: number, status = 429) =>
	({
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		at,
		update: {
			kind: 'provider_retry',
			attempt: 2,
			maxRetries: 5,
			delayMs: 6000,
			status,
			serverDirected: true,
		},
	}) as const

it('remembers a provider wait with the time the host saw it', () => {
	const thread = applyEvent(running(), retryUpdate(1000))
	expect(thread.providerWait).toEqual({
		at: 1000,
		delayMs: 6000,
		attempt: 2,
		maxRetries: 5,
		throttled: true,
	})
	expect(applyEvent(running(), retryUpdate(1000, 503)).providerWait?.throttled).toBe(false)
})

it('adds nothing to the transcript while waiting', () => {
	const before = running()
	const after = applyEvent(before, retryUpdate(1000))
	expect(after.messages).toBe(before.messages)
	expect(after.timeline).toBe(before.timeline)
})

it('ends the wait when anything else happens in the turn', () => {
	const waiting = applyEvent(running(), retryUpdate(1000))
	const answered = applyEvent(waiting, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		at: 8000,
		update: { kind: 'agent_message_chunk', text: 'Hi' },
	})
	expect(answered.providerWait).toBeUndefined()
	const stopped = applyEvent(waiting, {
		kind: 'state',
		sessionId: 's',
		running: false,
		queued: [],
	})
	expect(stopped.providerWait).toBeUndefined()
})

it('ignores a retry that carries no observation time rather than inventing one', () => {
	const thread = applyEvent(running(), { ...retryUpdate(1000), at: undefined })
	expect(thread.providerWait).toBeUndefined()
})
