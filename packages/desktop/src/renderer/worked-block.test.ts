import type { AcpSessionUpdate } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { replyClock, transcriptTurns, workBlockOpen } from './transcript-layout.js'
import { turnInputsUnchanged } from './transcript-memo.js'
import { Transcript } from './transcript.js'

function begin(): ThreadState {
	return applyEvent(
		applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Go', at: 1000 }),
		{ kind: 'state', sessionId: 's', running: true, queued: [] },
	)
}
function update(thread: ThreadState, value: AcpSessionUpdate, at = 2000): ThreadState {
	return applyEvent(thread, { kind: 'update', sessionId: 's', projectId: 'p', update: value, at })
}
function command(thread: ThreadState, id: string, at: number): ThreadState {
	const view = { kind: 'terminal' as const, command: id, output: 'ok' }
	return update(
		update(
			thread,
			{ kind: 'tool_call', toolCallId: id, title: 'bash', status: 'pending', view },
			at,
		),
		{ kind: 'tool_call', toolCallId: id, title: 'bash', status: 'completed', view },
		at,
	)
}
function say(thread: ThreadState, text: string, id: string, at: number): ThreadState {
	return update(
		thread,
		{ kind: 'agent_message_chunk', text, phase: 'commentary', messageId: id },
		at,
	)
}
function answer(thread: ThreadState, text: string, at: number): ThreadState {
	return update(thread, { kind: 'agent_message_chunk', text, messageId: 'answer' }, at)
}
function finish(thread: ThreadState, at = 9000): ThreadState {
	return applyEvent(update(thread, { kind: 'turn_ended', stopReason: 'end_turn' }, at), {
		kind: 'state',
		sessionId: 's',
		running: false,
		queued: [],
	})
}
const render = (thread: ThreadState) => renderToStaticMarkup(createElement(Transcript, { thread }))
const clocks = (html: string) => html.match(/class="message-time"/g)?.length ?? 0

function worked(): ThreadState {
	let thread = say(begin(), 'Looking first', 'n1', 2000)
	thread = command(command(thread, 'a', 3000), 'b', 4000)
	thread = say(thread, 'Now the second part', 'n2', 5000)
	thread = command(thread, 'c', 6000)
	return thread
}

beforeEach(() => {
	vi.spyOn(Date, 'now').mockReturnValue(100000)
})
afterEach(() => {
	vi.restoreAllMocks()
})

describe('workBlockOpen', () => {
	it('is open while the reply is written and folded once it ends', () => {
		expect(workBlockOpen(undefined, true)).toBe(true)
		expect(workBlockOpen(undefined, false)).toBe(false)
	})
	it('lets the saved choice win in both states', () => {
		expect(workBlockOpen(false, true)).toBe(false)
		expect(workBlockOpen(true, false)).toBe(true)
	})
})

describe('replyClock', () => {
	const clockOf = (thread: ThreadState, live = false) => {
		const group = transcriptTurns(thread)[0]
		return group && replyClock(thread, group, live)
	}
	it('puts the one clock on the last answer message', () => {
		const clock = clockOf(finish(answer(worked(), 'Done.', 8000)))
		expect(clock?.at).toBe('answer')
		expect(clock?.time.at).toBe(8000)
	})
	it('shows no clock while the reply is being written', () => {
		expect(clockOf(answer(worked(), 'Partly', 8000), true)).toBeUndefined()
	})
	it('puts it at the bottom of the turn when the reply ends without answer text', () => {
		const clock = clockOf(finish(worked(), 9000))
		expect(clock?.at).toBe('turn')
		expect(clock?.time.at).toBe(9000)
	})
})

describe('the Worked block draws no clocks of its own', () => {
	it('shows one clock for a finished reply, under its answer', () => {
		const html = render(finish(answer(worked(), 'All done.', 8000)))
		// The person's own message keeps its clock; the reply has exactly one more.
		expect(clocks(html)).toBe(2)
		const block = html.slice(html.indexOf('data-activity-turn'), html.indexOf('All done.'))
		expect(block).not.toContain('class="message-time"')
		expect(block).toContain('Looking first')
		expect(block).toContain('Now the second part')
		expect(html.lastIndexOf('class="message-time"')).toBeGreaterThan(html.indexOf('All done.'))
		expect(html).not.toContain('turn-clock')
	})
	it('keeps the time of every row in its tooltip instead', () => {
		let thread = say(begin(), 'Looking first', 'n1', 2000)
		thread = update(thread, { kind: 'agent_thought_chunk', text: 'Thinking it over' }, 2500)
		thread = command(thread, 'a', 3000)
		const html = render(finish(answer(thread, 'All done.', 8000)))
		const block = html.slice(html.indexOf('data-activity-turn'), html.indexOf('All done.'))
		const observed = 'Observed by Namzu:'
		// Narration, the thought row and the Worked trigger carry it as a tooltip, the tool row as its description.
		expect(block).toMatch(new RegExp(`aria-label="Progress update" title="${observed}`))
		expect(block).toMatch(new RegExp(`class="reasoning"[^>]*title="${observed}`))
		expect(block).toMatch(new RegExp(`aria-label="Worked for 8s" title="${observed}`))
		expect(block).toMatch(new RegExp(`aria-description="a\\. ${observed}`))
	})
	it('keeps the whole process in one block, in order', () => {
		const html = render(finish(answer(worked(), 'All done.', 8000)))
		expect(html.match(/data-activity-turn/g)).toHaveLength(1)
		const order = ['Looking first', 'tool-run-trigger', 'Now the second part', 'All done.']
		const positions = order.map((text) => html.indexOf(text))
		expect(positions).toEqual([...positions].sort((a, b) => a - b))
		expect(positions.every((position) => position > 0)).toBe(true)
	})
	it('shows the one clock after the block when the reply has no answer text', () => {
		const html = render(finish(worked()))
		expect(clocks(html)).toBe(2)
		expect(html).toContain('turn-clock')
		expect(html.lastIndexOf('class="message-time"')).toBeGreaterThan(html.indexOf('turn-clock'))
	})
	it('shows no clock and an open block while the work is going', () => {
		const html = render(worked())
		expect(clocks(html)).toBe(1)
		expect(html).toContain('aria-expanded="true"')
	})
	it('folds the block as soon as the answer starts, so the page does not shrink at the end', () => {
		const html = render(answer(worked(), 'Partly', 8000))
		expect(clocks(html)).toBe(1)
		expect(html).toContain('aria-expanded="false"')
	})
	it('folds the block when the reply ends', () => {
		const html = render(finish(answer(worked(), 'All done.', 8000)))
		expect(html).toMatch(/aria-expanded="false"[^>]*aria-label="Worked for 8s"/)
	})
})

describe('a settled worked turn', () => {
	it('is left alone while a later turn streams', () => {
		let before = finish(answer(worked(), 'All done.', 8000))
		before = applyEvent(before, { kind: 'prompt', sessionId: 's', prompt: 'More', at: 10000 })
		before = applyEvent(before, { kind: 'state', sessionId: 's', running: true, queued: [] })
		const after = answer(before, 'Next reply', 11000)
		const pick = (thread: ThreadState, turn: number) => {
			const group = transcriptTurns(thread).find((item) => item.turn === turn)
			if (!group) throw new Error(`no turn ${turn}`)
			return { thread, group }
		}
		expect(turnInputsUnchanged(pick(before, 1), pick(after, 1))).toBe(true)
		expect(turnInputsUnchanged(pick(before, 2), pick(after, 2))).toBe(false)
	})
})
