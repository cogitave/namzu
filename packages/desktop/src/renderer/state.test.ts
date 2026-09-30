import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from '../shared/projection.js'
it('keeps queued prompts out of the transcript until they actually start', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 'a',
		prompt: 'First request',
	})
	thread = applyEvent(thread, {
		kind: 'state',
		sessionId: 'a',
		running: true,
		queued: ['Next request'],
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 'a',
		update: { kind: 'agent_message_chunk', text: 'First answer' },
	})
	expect(thread.messages).toEqual([
		{ role: 'user', text: 'First request' },
		{ role: 'assistant', text: 'First answer' },
	])
	expect(thread.queued).toEqual(['Next request'])
	thread = applyEvent(thread, {
		kind: 'prompt',
		sessionId: 'a',
		prompt: 'Next request',
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 'a',
		update: { kind: 'agent_message_chunk', text: 'Next answer' },
	})
	expect(thread.messages.at(-1)?.text).toBe('Next answer')
	expect(thread.messages[1]?.text).toBe('First answer')
})
it('clears the answered approval and retains other pending questions', () => {
	let thread = emptyThread()
	for (const id of ['a', 'b'])
		thread = applyEvent(thread, {
			kind: 'permission',
			request: { id, sessionId: 's', projectId: 'p', calls: [] },
		})
	thread = applyEvent(thread, {
		kind: 'permission-cleared',
		sessionId: 's',
		requestId: 'a',
	})
	expect(thread.permissions.map((permission) => permission.id)).toEqual(['b'])
})

it('preserves the tool presentation across progress and shows actual provider failure', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call',
			toolCallId: 't',
			title: 'plugin',
			status: 'pending',
			view: { kind: 'diff', path: 'a.txt', before: 'a', after: 'b' },
		},
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call',
			toolCallId: 't',
			title: 'plugin',
			status: 'pending',
			view: { kind: 'generic', label: 'plugin' },
			progress: { message: 'Saving', fraction: 0.5 },
		},
	})
	expect(thread.tools.t?.view.kind).toBe('diff')
	expect(thread.tools.t?.progress?.message).toBe('Saving')
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'turn_ended',
			stopReason: 'error',
			error: 'The provider returned 503',
		},
	})
	expect(thread.error).toBe('The provider returned 503')
})

it('keeps interrupted tool history without animating it as work in a later turn', () => {
	const state = (running: boolean) => ({
		kind: 'state' as const,
		sessionId: 's',
		running,
		queued: [],
	})
	const tool = (id: string, status: 'pending' | 'completed') => ({
		kind: 'update' as const,
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call' as const,
			toolCallId: id,
			title: 'bash',
			status,
			view: { kind: 'generic' as const, label: 'bash' },
		},
	})
	let thread = applyEvent(emptyThread(), state(true))
	thread = applyEvent(thread, tool('interrupted', 'pending'))
	expect(thread.activeToolIds).toEqual(['interrupted'])
	thread = applyEvent(thread, state(false))
	expect(thread.activeToolIds).toEqual([])
	expect(thread.tools.interrupted?.status).toBe('pending')
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Continue' })
	thread = applyEvent(thread, state(true))
	thread = applyEvent(thread, tool('new', 'pending'))
	expect(thread.activeToolIds).toEqual(['new'])
	thread = applyEvent(thread, tool('new', 'completed'))
	expect(thread.activeToolIds).toEqual([])
	thread = applyEvent(thread, tool('aborted', 'pending'))
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: { kind: 'turn_ended', stopReason: 'cancelled' },
	})
	expect(thread.activeToolIds).toEqual([])
	expect(Object.keys(thread.tools)).toEqual(['interrupted', 'new', 'aborted'])
})
