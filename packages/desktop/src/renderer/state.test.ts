import { expect, it } from 'vitest'
import { applyEvent, emptyThread, restoreMessages } from '../shared/projection.js'
it('retains event admission order across streamed narration, tools, progress and later turns', () => {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Build' })
	const chunk = (text: string) => ({
		kind: 'update' as const,
		projectId: 'p',
		sessionId: 's',
		update: { kind: 'agent_message_chunk' as const, text },
	})
	const tool = (status: 'pending' | 'completed') => ({
		kind: 'update' as const,
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call' as const,
			toolCallId: 'first',
			title: 'bash',
			status,
			view: { kind: 'generic' as const, label: 'Run tests' },
		},
	})
	thread = applyEvent(thread, chunk('I will test.'))
	thread = applyEvent(thread, tool('pending'))
	thread = applyEvent(thread, tool('completed'))
	thread = applyEvent(thread, chunk('Tests passed.'))
	thread = applyEvent(thread, chunk(' Ready.'))
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Continue' })
	thread = applyEvent(thread, chunk('Continuing.'))
	expect(thread.timeline).toEqual([
		{ kind: 'message', index: 0, turn: 1 },
		{ kind: 'message', index: 1, turn: 1 },
		{ kind: 'tool', id: '1:first', turn: 1 },
		{ kind: 'message', index: 2, turn: 1 },
		{ kind: 'message', index: 3, turn: 2 },
		{ kind: 'message', index: 4, turn: 2 },
	])
	expect(thread.messages.map((message) => message.text)).toEqual([
		'Build',
		'I will test.',
		'Tests passed. Ready.',
		'Continue',
		'Continuing.',
	])
})
it('restores text history in durable order without fabricating unavailable tool history', () => {
	const thread = restoreMessages(emptyThread(), [
		{ role: 'user', text: 'First' },
		{ role: 'assistant', text: 'Answer' },
		{ role: 'user', text: 'Next' },
	])
	expect(thread.timeline).toEqual([
		{ kind: 'message', index: 0, turn: 1 },
		{ kind: 'message', index: 1, turn: 1 },
		{ kind: 'message', index: 2, turn: 2 },
	])
	const continued = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: { kind: 'agent_message_chunk', text: 'Next answer' },
	})
	expect(continued.timeline.at(-1)).toEqual({ kind: 'message', index: 3, turn: 2 })
	expect(continued.tools).toEqual({})
})
it('keeps distinct tool receipts when a provider reuses a call ID on a later turn', () => {
	let thread = emptyThread()
	for (const title of ['First call', 'Second call']) {
		thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: title })
		for (const status of ['pending', 'completed'] as const)
			thread = applyEvent(thread, {
				kind: 'update',
				projectId: 'p',
				sessionId: 's',
				update: {
					kind: 'tool_call',
					toolCallId: 'call_0',
					title,
					status,
					view: { kind: 'generic', label: title },
				},
			})
	}
	expect(thread.timeline.filter((entry) => entry.kind === 'tool')).toEqual([
		{ kind: 'tool', id: '1:call_0', turn: 1 },
		{ kind: 'tool', id: '2:call_0', turn: 2 },
	])
	expect(thread.tools['1:call_0']?.title).toBe('First call')
	expect(thread.tools['2:call_0']?.title).toBe('Second call')
})
it('replays newer live updates onto a captured snapshot without duplicating included chunks', () => {
	const included = {
		kind: 'update' as const,
		projectId: 'p',
		sessionId: 's',
		revision: 3,
		update: { kind: 'agent_message_chunk' as const, text: 'Already captured. ' },
	}
	let snapshot = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 's',
		prompt: 'Continue',
		revision: 1,
	})
	snapshot = applyEvent(snapshot, {
		kind: 'state',
		sessionId: 's',
		running: true,
		queued: ['Pending'],
		revision: 2,
	})
	snapshot = applyEvent(snapshot, included)
	let restored = applyEvent(snapshot, included)
	restored = applyEvent(restored, {
		...included,
		revision: 4,
		update: { kind: 'agent_message_chunk', text: 'Arrived while opening.' },
	})
	restored = applyEvent(restored, {
		kind: 'state',
		sessionId: 's',
		running: false,
		queued: [],
		revision: 5,
	})
	expect(restored.messages.at(-1)?.text).toBe('Already captured. Arrived while opening.')
	expect(restored.running).toBe(false)
	expect(restored.queued).toEqual([])
	expect(
		applyEvent(restored, { kind: 'prompt', sessionId: 's', prompt: 'Stale', revision: 1 }),
	).toBe(restored)
})
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
	expect(thread.tools['0:t']?.view.kind).toBe('diff')
	expect(thread.tools['0:t']?.progress?.message).toBe('Saving')
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
	expect(thread.activeToolIds).toEqual(['0:interrupted'])
	thread = applyEvent(thread, state(false))
	expect(thread.activeToolIds).toEqual([])
	expect(thread.tools['0:interrupted']?.status).toBe('pending')
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Continue' })
	thread = applyEvent(thread, state(true))
	thread = applyEvent(thread, tool('new', 'pending'))
	expect(thread.activeToolIds).toEqual(['1:new'])
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
	expect(Object.keys(thread.tools)).toEqual(['0:interrupted', '1:new', '1:aborted'])
})
