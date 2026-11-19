import type { AcpSessionUpdate } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import type { PermissionView } from '../shared/protocol.js'
import {
	WAITING_FOR_YOU,
	livePhaseLabel,
	liveRecentSteps,
	liveStepMs,
	turnActiveMs,
} from './transcript-motion.js'
import { Transcript } from './transcript.js'

/** The live line says the step with its own seconds and the total, and a wait for the person stops the total. */

const START = 10_000
function started(): ThreadState {
	return applyEvent(
		applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Do it', at: START }),
		{ kind: 'state', sessionId: 's', running: true, queued: [] },
	)
}
function update(thread: ThreadState, value: AcpSessionUpdate, at: number): ThreadState {
	return applyEvent(thread, { kind: 'update', sessionId: 's', projectId: 'p', update: value, at })
}
const command = (thread: ThreadState, id: string, status: 'pending' | 'completed', at: number) =>
	update(
		thread,
		{
			kind: 'tool_call',
			toolCallId: id,
			title: 'bash',
			status,
			view: { kind: 'terminal', command: `run ${id}`, output: '' },
		},
		at,
	)
const request = (id: string): PermissionView => ({
	id,
	sessionId: 's',
	projectId: 'p',
	calls: [{ id: 'c', name: 'bash', input: {}, isDestructive: false }],
})
const render = (thread: ThreadState) => renderToStaticMarkup(createElement(Transcript, { thread }))
const plain = (html: string) => html.replace(/<[^>]+>/g, '')

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe('the step clock', () => {
	it('counts the running action from its own start, beside the turn total', () => {
		let thread = command(started(), 'a', 'completed', START + 2_000)
		thread = command(thread, 'b', 'pending', START + 20_000)
		expect(liveStepMs(thread, START + 32_000)).toBe(12_000)
		expect(turnActiveMs(thread, 1, START + 32_000)).toBe(32_000)
		vi.setSystemTime(START + 32_000)
		const html = render(thread)
		expect(plain(html)).toContain('Running run b')
		expect(html).toContain('data-live-step-clock="">12s<')
		expect(html).toContain('class="turn-activity-elapsed">· 32s<')
	})

	it('is left out while the first step is the whole turn, so the same seconds are not said twice', () => {
		const thread = command(started(), 'a', 'pending', START)
		vi.setSystemTime(START + 6_000)
		const html = render(thread)
		expect(plain(html)).toContain('Running run a')
		expect(html).not.toContain('data-live-step-clock')
		expect(plain(html).match(/6s/g)?.length).toBe(1)
	})

	it('counts thinking from where the reasoning began', () => {
		const thread = update(
			started(),
			{ kind: 'agent_thought_chunk', text: 'hm', messageId: 'm' } as AcpSessionUpdate,
			START + 4_000,
		)
		expect(livePhaseLabel(thread)).toBe('Thinking')
		expect(liveStepMs(thread, START + 12_000)).toBe(8_000)
	})
})

describe('a wait for the person', () => {
	it('stops the total while an approval is open and goes on after it is answered', () => {
		let thread = command(started(), 'a', 'pending', START + 1_000)
		thread = applyEvent(thread, { kind: 'permission', request: request('r1'), at: START + 5_000 })
		expect(livePhaseLabel(thread)).toBe(WAITING_FOR_YOU)
		// Five seconds of work, then the clock holds however long the wait goes on.
		expect(turnActiveMs(thread, 1, START + 5_000)).toBe(5_000)
		expect(turnActiveMs(thread, 1, START + 65_000)).toBe(5_000)
		expect(liveStepMs(thread, START + 65_000)).toBeUndefined()
		thread = applyEvent(thread, {
			kind: 'permission-cleared',
			sessionId: 's',
			requestId: 'r1',
			at: START + 65_000,
		})
		expect(turnActiveMs(thread, 1, START + 70_000)).toBe(10_000)
		// The step that was open during the wait counts from the answer.
		expect(liveStepMs(thread, START + 70_000)).toBe(5_000)
	})

	it('is said in the header once there is work, with the total held', () => {
		const thread = applyEvent(
			update(
				started(),
				{
					kind: 'agent_message_chunk',
					text: 'I am creating the page.',
					phase: 'commentary',
					messageId: 'n',
				} as AcpSessionUpdate,
				START + 1_000,
			),
			{ kind: 'permission', request: request('r1'), at: START + 3_000 },
		)
		vi.setSystemTime(START + 600_000)
		const html = render(thread)
		expect(html).toContain('aria-label="Waiting for you for 3s"')
		expect(html).toContain('class="turn-activity-elapsed">· 3s<')
	})

	it('is said by the status line when no work header exists yet, also with the total held', () => {
		// The run where nothing told the person to answer: the status line was kept out of sight
		// while an approval was open, and no header drew it either.
		const thread = applyEvent(started(), {
			kind: 'permission',
			request: request('r1'),
			at: START + 3_000,
		})
		vi.setSystemTime(START + 600_000)
		const html = render(thread)
		expect(plain(html)).toContain('Waiting for you')
		expect(html).not.toContain('transcript-status-only')
		expect(html).toContain('class="working-elapsed" aria-hidden="true">3s<')
		expect(html).not.toContain('data-live-step-clock')
	})
})

describe('the last two steps', () => {
	function run(count: number): ThreadState {
		let thread = started()
		for (let index = 1; index <= count; index++) {
			thread = command(thread, `s${index}`, 'pending', START + index * 1_000)
			if (index < count)
				thread = command(thread, `s${index}`, 'completed', START + index * 1_000 + 500)
		}
		return thread
	}
	it('keeps two in view and folds the rest behind a count', () => {
		const thread = run(5)
		const entries = thread.timeline.filter((entry) => entry.turn === thread.turn)
		const recent = liveRecentSteps(thread, entries)
		expect(recent.shown).toHaveLength(2)
		expect(recent.more).toBe(3)
		vi.setSystemTime(START + 9_000)
		const html = render(thread)
		expect(html).toContain('data-live-steps=""')
		expect(html).toContain('3 more steps')
		const live = html.slice(html.indexOf('data-live-steps'))
		expect(plain(live)).toContain('run s4')
		expect(plain(live)).toContain('run s5')
		expect(plain(live)).not.toContain('run s3')
	})
	it('says nothing extra for two or fewer, and nothing once the turn has ended', () => {
		expect(liveRecentSteps(run(2), run(2).timeline).more).toBe(0)
		let thread = run(5)
		thread = update(
			thread,
			{ kind: 'turn_ended', stopReason: 'end_turn' } as AcpSessionUpdate,
			START + 9_000,
		)
		thread = applyEvent(thread, { kind: 'state', sessionId: 's', running: false, queued: [] })
		const html = render(thread)
		expect(html).not.toContain('data-live-steps')
		expect(html).not.toContain('more steps')
	})
})
