import {
	type Message,
	createAssistantMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { frameReminder, reminderKindOf } from '../frame.js'
import { PLAN_REMINDER_EVERY_N_TURNS, planModeReminders } from '../plan-mode.js'

/**
 * The plan-mode reminder cadence: none
 * until 5 operator turns after the last one, the first of a stretch and every
 * 5th after it in full, the ones between a single line, and one note when plan
 * mode is left. The conversation is the only record, so each case builds one.
 */

const PATH = '/home/u/.namzu/projects/p/s/plans/plan.md'
const input = (messages: readonly Message[], mode = 'plan', planExists = false) => ({
	messages,
	mode,
	planPath: PATH,
	planExists,
	canAsk: true,
})

/** One operator turn: the prompt, whatever reminders the host owed, and a reply. */
function play(turns: number, mode = 'plan'): Message[] {
	const messages: Message[] = []
	for (let i = 0; i < turns; i++) {
		messages.push(createUserMessage(`turn ${i + 1}`))
		for (const text of planModeReminders(input(messages, mode))) {
			messages.push(createRuntimeContextMessage(text, 'reminder'))
		}
		messages.push(createAssistantMessage(`reply ${i + 1}`))
	}
	return messages
}

const forms = (messages: readonly Message[]) =>
	messages
		.filter((m) => reminderKindOf(m) === 'plan-mode')
		.map((m) => (m.content as string).match(/form="(\w+)"/)?.[1])

describe('plan-mode reminders', () => {
	it('says the rules in full on the first request, and names the plan file', () => {
		const [first, ...rest] = planModeReminders(input([createUserMessage('go')]))
		expect(rest).toEqual([])
		expect(first).toContain('form="full"')
		expect(first).toContain(PATH)
		expect(first).toContain('exit_plan_mode')
		expect(first).toContain('No plan exists yet')
	})

	it('says nothing more until 5 operator turns have passed', () => {
		const messages = play(PLAN_REMINDER_EVERY_N_TURNS)
		expect(forms(messages)).toEqual(['full'])
		// The 6th turn is the 5th since the reminder: a short one is due.
		expect(forms(play(PLAN_REMINDER_EVERY_N_TURNS + 1))).toEqual(['full', 'sparse'])
	})

	it('repeats the full text on every 5th reminder (the 1st, 6th, 11th …)', () => {
		// Reminders land on turns 1, 6, 11, 16, 21, 26: the 1st and 6th are full.
		const messages = play(26)
		expect(forms(messages)).toEqual(['full', 'sparse', 'sparse', 'sparse', 'sparse', 'full'])
	})

	it('does not repeat itself inside one long reply', () => {
		const messages: Message[] = [createUserMessage('go')]
		for (const text of planModeReminders(input(messages))) {
			messages.push(createRuntimeContextMessage(text, 'reminder'))
		}
		for (let i = 0; i < 20; i++) {
			messages.push(createAssistantMessage(`step ${i}`))
			expect(planModeReminders(input(messages))).toEqual([])
		}
	})

	it('says nothing when plan mode is off and was never on', () => {
		expect(planModeReminders(input(play(3, 'prompt'), 'prompt'))).toEqual([])
	})

	it('tells the model once that plan mode ended, then nothing', () => {
		const messages = play(2)
		const exit = planModeReminders(input(messages, 'accept-edits', true))
		expect(exit).toHaveLength(1)
		expect(exit[0]).toContain('kind="plan-exit"')
		expect(exit[0]).toContain('You have left plan mode')
		expect(exit[0]).toContain(PATH)
		messages.push(createRuntimeContextMessage(exit[0] as string, 'reminder'))
		expect(planModeReminders(input(messages, 'accept-edits', true))).toEqual([])
	})

	it('starts a fresh stretch on re-entry, with a note about the earlier plan', () => {
		const messages = play(2)
		messages.push(
			createRuntimeContextMessage(
				planModeReminders(input(messages, 'prompt', true))[0] as string,
				'reminder',
			),
		)
		messages.push(createUserMessage('now something else'))
		const [again, reentry, ...rest] = planModeReminders(input(messages, 'plan', true))
		expect(rest).toEqual([])
		expect(again).toContain('form="full"')
		expect(again).toContain('A plan already exists')
		expect(reentry).toContain('kind="plan-reentry"')
		expect(reentry).toContain('back in plan mode')
	})

	it('does not mistake a hidden reminder for something the operator typed', () => {
		const messages: Message[] = [
			createUserMessage('go'),
			createRuntimeContextMessage(frameReminder('plan-mode', 'x', 'full'), 'reminder'),
		]
		for (let i = 0; i < 10; i++) messages.push(createRuntimeContextMessage('note', 'steering'))
		// Steering is the operator speaking, so it counts; reminders and notices do not.
		messages.push(createRuntimeContextMessage('job done', 'job-exit'))
		expect(planModeReminders(input(messages))).toHaveLength(1)
		expect(planModeReminders(input(messages.slice(0, 4)))).toEqual([])
	})
})
