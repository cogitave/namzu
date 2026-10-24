import {
	type Message,
	createAssistantMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { reminderKindOf } from '../frame.js'
import { HYPERMODE_REMINDER_EVERY, hypermodeReminders } from '../hypermode.js'

/**
 * What the model is told about the standing hypermode. The conversation is the
 * only record of what was said, so each case builds one.
 */

const ask = (messages: readonly Message[], on = true, toolListed = true) =>
	hypermodeReminders({ messages, on, toolListed })

/** The conversation after `reminders` were appended, as the kernel appends them. */
const withSaid = (messages: Message[], reminders: readonly string[]): Message[] => [
	...messages,
	...reminders.map((text) => createRuntimeContextMessage(text, 'reminder')),
]

const messagesAfter = (count: number): Message[] =>
	Array.from({ length: count }, (_, i) => [
		createUserMessage(`message ${i}`),
		createAssistantMessage('ok'),
	]).flat()

describe('what the model is told about the standing mode', () => {
	it('says it in full the first time, then stays quiet', () => {
		const first = ask([createUserMessage('go')])
		expect(first).toHaveLength(1)
		expect(first[0]).toContain('kind="hypermode-on" form="full"')
		expect(first[0]).toContain('Use the `workflow` tool on every substantive task')
		const history = withSaid([createUserMessage('go')], first)
		expect(ask([...history, createAssistantMessage('ok'), createUserMessage('more')])).toEqual([])
	})

	it('repeats it sparsely once ten operator messages have passed', () => {
		const history = withSaid([createUserMessage('go')], ask([createUserMessage('go')]))
		expect(ask([...history, ...messagesAfter(HYPERMODE_REMINDER_EVERY - 1)])).toEqual([])
		const [sparse] = ask([...history, ...messagesAfter(HYPERMODE_REMINDER_EVERY)])
		expect(sparse).toContain('form="sparse"')
		expect(sparse).toContain('still on')
	})

	it('counts from the latest sparse reminder, not the first', () => {
		let history = withSaid([createUserMessage('go')], ask([createUserMessage('go')]))
		history = withSaid(
			[...history, ...messagesAfter(HYPERMODE_REMINDER_EVERY)],
			ask([...history, ...messagesAfter(HYPERMODE_REMINDER_EVERY)]),
		)
		expect(ask([...history, ...messagesAfter(HYPERMODE_REMINDER_EVERY - 1)])).toEqual([])
		expect(ask([...history, ...messagesAfter(HYPERMODE_REMINDER_EVERY)])).toHaveLength(1)
	})

	it('does not say the full text again in a resumed conversation', () => {
		// The history a resumed conversation loads holds what was said before.
		const resumed = withSaid(
			[...messagesAfter(3), createUserMessage('go')],
			ask([createUserMessage('go')]),
		)
		const afterResume = [...resumed, ...messagesAfter(2)]
		expect(ask(afterResume)).toEqual([])
	})

	it('does not count a hypermode reminder as an operator message', () => {
		const history = withSaid([createUserMessage('go')], ask([createUserMessage('go')]))
		expect(history.filter((m) => reminderKindOf(m) === 'hypermode-on')).toHaveLength(1)
		expect(ask([...history, ...messagesAfter(HYPERMODE_REMINDER_EVERY - 1)])).toEqual([])
	})

	it('says once that it ended, and nothing if it was never on', () => {
		expect(ask([createUserMessage('go')], false)).toEqual([])
		const on = withSaid([createUserMessage('go')], ask([createUserMessage('go')]))
		const [exit] = ask([...on, createUserMessage('next')], false)
		expect(exit).toContain('kind="hypermode-exit"')
		expect(exit).toContain('Hypermode is off')
		const after = withSaid([...on, createUserMessage('next')], [exit as string])
		expect(ask([...after, createUserMessage('again')], false)).toEqual([])
	})

	it('says the full text again when the mode is turned back on', () => {
		const on = withSaid([createUserMessage('go')], ask([createUserMessage('go')]))
		const [exit] = ask([...on, createUserMessage('next')], false)
		const off = withSaid([...on, createUserMessage('next')], [exit as string])
		const [again] = ask([...off, createUserMessage('third')])
		expect(again).toContain('form="full"')
	})

	it('says it in full again after compaction dropped what was said', () => {
		expect(
			ask([createUserMessage('summary of earlier work'), createUserMessage('go')]),
		).toHaveLength(1)
	})

	it('points a run that cannot start a workflow at the Agent tool instead', () => {
		const [text] = ask([createUserMessage('go')], true, false)
		expect(text).toContain('not available in this run')
		expect(text).toContain('`Agent`')
		const history = withSaid([createUserMessage('go')], [text as string])
		const [sparse] = ask([...history, ...messagesAfter(HYPERMODE_REMINDER_EVERY)], true, false)
		expect(sparse).toContain('`Agent`')
	})
})
