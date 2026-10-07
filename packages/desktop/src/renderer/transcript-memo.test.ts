import { describe, expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import type { DesktopEvent } from '../shared/protocol.js'
import { transcriptTurns } from './transcript-layout.js'
import { turnInputsUnchanged } from './transcript-memo.js'

const update = (update: Extract<DesktopEvent, { kind: 'update' }>['update']): DesktopEvent => ({
	kind: 'update',
	projectId: 'p',
	sessionId: 's',
	update,
})

function conversation(): ThreadState {
	let thread = emptyThread()
	for (const prompt of ['first', 'second']) {
		thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt })
		thread = applyEvent(thread, { kind: 'state', sessionId: 's', running: true, queued: [] })
		thread = applyEvent(
			thread,
			update({ kind: 'agent_message_chunk', text: `answer to ${prompt}` }),
		)
		if (prompt === 'first')
			thread = applyEvent(
				thread,
				update({ kind: 'turn_ended', result: 'x', stopReason: 'end_turn' }),
			)
	}
	return thread
}

/** The data of turn `turn` before and after one event. */
function compare(before: ThreadState, after: ThreadState, turn: number): boolean {
	const group = (thread: ThreadState) => {
		const found = transcriptTurns(thread).find((item) => item.turn === turn)
		if (!found) throw new Error(`no turn ${turn}`)
		return { thread, group: found }
	}
	return turnInputsUnchanged(group(before), group(after))
}

describe('turnInputsUnchanged', () => {
	it('leaves an earlier turn alone while the last one streams', () => {
		const before = conversation()
		const after = applyEvent(before, update({ kind: 'agent_message_chunk', text: ' and more' }))
		expect(after.messages.at(-1)?.text).toContain('and more')
		expect(compare(before, after, 1)).toBe(true)
		expect(compare(before, after, 2)).toBe(false)
	})

	it('redraws an earlier turn when its own message changes', () => {
		const before = conversation()
		const messages = [...before.messages]
		messages[1] = { ...(messages[1] as (typeof messages)[number]), text: 'edited' }
		expect(compare(before, { ...before, messages }, 1)).toBe(false)
	})

	it('redraws every turn when something all turns read changes', () => {
		const before = conversation()
		expect(compare(before, { ...before, running: !before.running }, 1)).toBe(false)
		expect(compare(before, { ...before, permissions: [] }, 1)).toBe(false)
		expect(compare(before, { ...before, undo: {} }, 1)).toBe(false)
		expect(compare(before, { ...before, turns: { ...before.turns, 1: { startedAt: 5 } } }, 1)).toBe(
			false,
		)
	})

	it('ignores what no turn reads', () => {
		const before = conversation()
		expect(
			compare(before, { ...before, revision: 9, responding: !before.responding, queued: ['x'] }, 1),
		).toBe(true)
	})

	it('redraws when a field it has no rule for changes', () => {
		const before = conversation()
		const after = { ...before, somethingNew: 1 } as ThreadState
		expect(compare(before, after, 1)).toBe(false)
	})
})
