import type { AcpSessionUpdate } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from './projection.js'

function update(thread: ThreadState, value: AcpSessionUpdate): ThreadState {
	return applyEvent(thread, { kind: 'update', projectId: 'p', sessionId: 's', update: value })
}

function answered(): ThreadState {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Earlier' })
	thread = update(thread, {
		kind: 'agent_message',
		status: 'completed',
		messageId: 'a1',
		textParts: [{ id: 'p1', phase: 'final_answer', text: 'Earlier answer' }],
		content: 'Earlier answer',
		stopReason: 'end_turn',
	})
	return update(thread, { kind: 'turn_ended', turnId: 't1', stopReason: 'end_turn' })
}

function stopped(prompt: string): ThreadState {
	let thread = applyEvent(answered(), { kind: 'prompt', sessionId: 's', prompt })
	thread = update(thread, { kind: 'agent_thought_chunk', text: 'Thinking about it' })
	return update(thread, {
		kind: 'turn_ended',
		turnId: 't2',
		stopReason: 'cancelled',
		reason: 'paused',
	})
}

it('takes a message out of the transcript when it is put back in the message box', () => {
	let thread = applyEvent(stopped('Failing'), {
		kind: 'turn-closed',
		sessionId: 's',
		withdrawn: true,
	})
	expect(thread.messages.map((message) => message.text)).toEqual(['Earlier', 'Earlier answer'])
	expect(thread.timeline.every((entry) => entry.turn === 1)).toBe(true)
	expect(Object.keys(thread.reasoning)).toEqual([])
	expect(thread.turn).toBe(1)
	expect(thread.turns[2]).toBeUndefined()
	expect(thread.reason).toBeUndefined()
	expect(thread.retry).toBeUndefined()
	// Sent again, the message is there once.
	thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: 'Failing' })
	expect(thread.messages.filter((message) => message.text === 'Failing')).toHaveLength(1)
	expect(thread.timeline.at(-1)).toEqual({ kind: 'message', index: 2, turn: 2 })
})

it('keeps the message and its note when the person went on with a different one', () => {
	const thread = applyEvent(stopped('Failing'), { kind: 'turn-closed', sessionId: 's' })
	expect(thread.messages.map((message) => message.text)).toContain('Failing')
	expect(thread.turns[2]?.reason).toBe('abandoned')
})
