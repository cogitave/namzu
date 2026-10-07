import { expect, it } from 'vitest'
import { applyEvent, emptyThread, restoreMessages } from './projection.js'

it('retains first host observations across stream, completion, tools and live input', () => {
	let thread = applyEvent(emptyThread(), {
		kind: 'prompt',
		sessionId: 'session',
		prompt: 'Find the source.',
		at: 1000,
	})
	const update = (at: number, value: Parameters<typeof applyEvent>[1] & { kind: 'update' }) => {
		thread = applyEvent(thread, { ...value, at })
	}
	update(1100, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: { kind: 'agent_message_chunk', messageId: 'assistant', text: 'Searching' },
	})
	update(1200, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: { kind: 'agent_message_chunk', messageId: 'assistant', text: ' now' },
	})
	update(1300, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: { kind: 'agent_thought', status: 'pending', blockId: 'thought' },
	})
	update(1350, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: { kind: 'agent_thought', status: 'completed', blockId: 'thought' },
	})
	update(1400, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: {
			kind: 'tool_call',
			toolCallId: 'search',
			title: 'Web search',
			status: 'pending',
			view: { kind: 'generic', label: '' },
		},
	})
	thread = applyEvent(thread, {
		kind: 'live-input',
		sessionId: 'session',
		inputId: 'steer',
		prompt: 'Prefer primary sources.',
		status: 'unknown',
		at: 1450,
	})
	update(1600, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: {
			kind: 'tool_call',
			toolCallId: 'search',
			title: 'Web search',
			status: 'completed',
			view: { kind: 'generic', label: 'Found two sources' },
		},
	})
	thread = applyEvent(thread, {
		kind: 'live-input',
		sessionId: 'session',
		inputId: 'steer',
		prompt: 'Prefer primary sources.',
		status: 'delivered',
		at: 1700,
	})
	update(1800, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'assistant',
			content: 'Searching now',
			stopReason: 'end_turn',
		},
	})
	expect(thread.messages[0]?.time).toEqual({ at: 1000, source: 'host' })
	expect(thread.messages[1]?.time).toEqual({ at: 1100, source: 'host' })
	expect(thread.messages[2]?.time).toEqual({ at: 1450, source: 'host' })
	expect(thread.tools['1:search']).toMatchObject({
		startedTime: { at: 1400, source: 'host' },
		endedTime: { at: 1600, source: 'host' },
	})
	expect(thread.reasoning['1:thought']).toMatchObject({
		startedTime: { at: 1300, source: 'host' },
		endedTime: { at: 1350, source: 'host' },
	})
})

it('keeps an unknown historical clock absent and accepts only explicit journal time', () => {
	const unknown = restoreMessages(emptyThread(), [{ role: 'assistant', text: 'Old answer' }])
	expect(unknown.messages[0]).not.toHaveProperty('time')
	const saved = restoreMessages(emptyThread(), [
		{ role: 'assistant', text: 'Old answer', time: { at: 1_700_000_000_000, source: 'journal' } },
	])
	expect(saved.messages[0]?.time).toEqual({ at: 1_700_000_000_000, source: 'journal' })
})
