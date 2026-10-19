/**
 * The card for several questions: what it shows, what its keys do, and what
 * it hands back. Each step awaits the rendered frame, never a wall clock.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { QuestionDialog } from './QuestionDialog.js'
import type { QuestionAnswer, UserQuestion } from './agent.js'

const DOWN = '\u001b[B'
const RIGHT = '\u001b[C'
const LEFT = '\u001b[D'
const ENTER = '\r'
const ESC = '\u001b'
const CTRL_C = '\u0003'

const opts = (...labels: string[]) =>
	labels.map((label, i) => ({ id: `opt_${i + 1}`, label, description: `about ${label}` }))

const question: UserQuestion = {
	questionId: 'toolu_1',
	question: 'Who is it for?',
	header: 'Audience',
	options: opts('Board', 'Engineers'),
	multiSelect: false,
	allowFreeText: true,
	questions: [
		{
			id: 'toolu_1#0',
			question: 'Who is it for?',
			header: 'Audience',
			options: opts('Board', 'Engineers'),
			multiSelect: false,
			allowFreeText: true,
		},
		{
			id: 'toolu_1#1',
			question: 'Which environments?',
			header: 'Environment',
			options: [
				{ id: 'opt_1', label: 'Staging' },
				{ id: 'opt_2', label: 'Production', preview: 'live traffic\nreal money' },
				{ id: 'opt_3', label: 'Canary' },
			],
			multiSelect: true,
			allowFreeText: false,
		},
		{
			id: 'toolu_1#2',
			question: 'What is it for?',
			header: 'Purpose',
			options: opts('Report', 'Audit'),
			multiSelect: false,
			allowFreeText: true,
		},
	],
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
})

function open() {
	const answers: Array<{ answer: QuestionAnswer; summary: readonly string[] }> = []
	const harness = render(
		<QuestionDialog
			question={question}
			columns={100}
			onAnswer={(answer, summary) => answers.push({ answer, summary })}
		/>,
	)
	mounted.push(harness)
	/** Write a key, then wait until the frame has been redrawn for it. */
	const press = async (key: string, shows?: string) => {
		harness.stdin.write(key)
		if (shows) await vi.waitFor(() => expect(harness.lastFrame()).toContain(shows))
		else await new Promise((resolve) => setImmediate(resolve))
	}
	return { harness, answers, press, frame: () => harness.lastFrame() ?? '' }
}

describe('a card with three questions', () => {
	it('shows a tab for each question and the first question', async () => {
		const { frame } = open()
		await vi.waitFor(() => expect(frame()).toContain('Who is it for?'))
		for (const label of ['Audience', 'Environment', 'Purpose', 'Submit']) {
			expect(frame()).toContain(label)
		}
		expect(frame()).toContain('Something else…')
		expect(frame()).toContain('esc skip')
	})

	it('answers a batch: a single choice, a multi-select and an "other" text, then reviews', async () => {
		const { answers, press, frame } = open()
		await vi.waitFor(() => expect(frame()).toContain('Who is it for?'))

		// 1. A single choice moves on by itself.
		await press(DOWN)
		await press(ENTER, 'Which environments?')
		expect(frame()).toContain('☒ Audience')

		// 2. A multi-select toggles, previews the focused option, and moves on from its last row.
		await press(' ', '[x] Staging')
		await press(DOWN, 'live traffic')
		await press(' ', '[x] Production')
		await press(DOWN)
		await press(DOWN)
		await press(ENTER, 'What is it for?')

		// 3. "Something else…" is typed in place.
		await press(DOWN)
		await press(DOWN)
		await press(ENTER)
		for (const ch of 'monthly cost report') await press(ch)
		await press(ENTER, 'Review your answers')

		expect(frame()).toContain('Engineers')
		expect(frame()).toContain('Staging, Production')
		expect(frame()).toContain('monthly cost report')
		expect(frame()).not.toContain('You have not answered all questions')
		expect(answers).toEqual([])

		await press(ENTER)
		expect(answers).toHaveLength(1)
		expect(answers[0]?.answer).toEqual({
			kind: 'answer',
			selectedOptionIds: [],
			answers: [
				{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_2'] },
				{ questionId: 'toolu_1#1', selectedOptionIds: ['opt_1', 'opt_2'] },
				{ questionId: 'toolu_1#2', selectedOptionIds: [], freeText: 'monthly cost report' },
			],
		})
		expect(answers[0]?.summary).toEqual([
			'Answered "Who is it for?": Engineers',
			'Answered "Which environments?": Staging, Production',
			'Answered "What is it for?": monthly cost report',
		])
	})

	it('warns on the review tab when a question was left alone, and submits what was answered', async () => {
		const { answers, press, frame } = open()
		await vi.waitFor(() => expect(frame()).toContain('Who is it for?'))
		await press(ENTER, 'Which environments?')
		await press(RIGHT, 'What is it for?')
		await press(RIGHT, 'Review your answers')
		expect(frame()).toContain('You have not answered all questions')
		await press(ENTER)
		expect(answers[0]?.answer).toEqual({
			kind: 'answer',
			selectedOptionIds: [],
			answers: [{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_1'] }],
		})
	})

	it('moves back with the left arrow and keeps what was chosen', async () => {
		const { press, frame } = open()
		await vi.waitFor(() => expect(frame()).toContain('Who is it for?'))
		await press(ENTER, 'Which environments?')
		await press(LEFT, 'Who is it for?')
		expect(frame()).toContain('☒ Audience')
	})

	it('cancel on the review tab and Esc skip the whole batch', async () => {
		const first = open()
		await vi.waitFor(() => expect(first.frame()).toContain('Who is it for?'))
		await first.press(ENTER, 'Which environments?')
		await first.press(RIGHT)
		await first.press(RIGHT, 'Review your answers')
		await first.press(DOWN)
		await first.press(ENTER)
		expect(first.answers.map((a) => a.answer)).toEqual([{ kind: 'skip' }])

		const second = open()
		await vi.waitFor(() => expect(second.frame()).toContain('Who is it for?'))
		await second.press(ENTER, 'Which environments?')
		await second.press(ESC)
		await vi.waitFor(() => expect(second.answers).toHaveLength(1))
		expect(second.answers[0]?.answer).toEqual({ kind: 'skip' })
	})

	it('treats Ctrl+C as stopping the turn', async () => {
		const { answers, press, frame } = open()
		await vi.waitFor(() => expect(frame()).toContain('Who is it for?'))
		await press(CTRL_C)
		await vi.waitFor(() => expect(answers).toHaveLength(1))
		expect(answers[0]?.answer).toEqual({ kind: 'abort' })
	})

	it('leaves the typed text out when Esc backs out of "Something else…"', async () => {
		const { press, frame } = open()
		await vi.waitFor(() => expect(frame()).toContain('Who is it for?'))
		await press(DOWN)
		await press(DOWN)
		await press(ENTER)
		await press('x', 'Something else: x')
		await press(ESC, 'Something else…')
		expect(frame()).toContain('☐ Audience')
	})
})
