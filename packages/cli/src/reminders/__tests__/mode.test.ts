import { type Message, createRuntimeContextMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { PermissionMode } from '../../permissions/mode.js'
import { reminderKindOf } from '../frame.js'
import { modeReminders } from '../mode.js'

/** One operator turn under `mode`, with whatever the host owed it. */
function turn(history: Message[], mode: PermissionMode, interactive = true): Message[] {
	const out = [...history, createUserMessage('go')]
	for (const text of modeReminders({ messages: out, mode, interactive })) {
		out.push(createRuntimeContextMessage(text, 'reminder'))
	}
	return out
}

const texts = (messages: readonly Message[]) =>
	messages.filter((m) => reminderKindOf(m) !== undefined).map((m) => m.content as string)

describe('permission mode announcements', () => {
	it.each([
		['classify', 'auto', 'are checked automatically instead, and some may still be refused'],
		['auto', 'unattended', 'Nobody is asked'],
		['strict', 'strict', 'Only preapproved tools run'],
		[
			'accept-edits',
			'accept-edits',
			'File edits and simple file commands in the working directory run without asking',
		],
		['bypass', 'bypass', 'Permission prompts are off in this mode'],
	] as const)('announces %s once, in that mode’s own words', (mode, name, sentence) => {
		let messages = turn([], mode)
		messages = turn(messages, mode)
		messages = turn(messages, mode)
		const said = texts(messages)
		expect(said).toHaveLength(1)
		expect(said[0]).toContain(`The ${name} permission mode is on.`)
		expect(said[0]).toContain(sentence)
		expect(said[0]).toContain('safety rules')
		expect(said[0]).not.toMatch(/relax|no longer apply|disabled|ignore/i)
	})

	it.each(['prompt', 'plan'] as const)('says nothing under %s', (mode) => {
		expect(texts(turn([], mode))).toEqual([])
	})

	it.each([
		['prompt', 'the user may be asked before they run'],
		['plan', 'Plan mode is on, and its own notices'],
	] as const)('words the end of a mode for the mode it lands in (%s)', (landing, sentence) => {
		let messages = turn([], 'bypass')
		messages = turn(messages, landing)
		messages = turn(messages, landing)
		const said = texts(messages)
		expect(said).toHaveLength(2)
		expect(said[1]).toContain('The bypass permission mode has ended.')
		expect(said[1]).toContain(sentence)
		if (landing === 'plan') expect(said[1]).not.toContain('may be asked')
		for (const text of said) expect(text).not.toMatch(/relax|no longer apply|disabled|ignore/i)
	})

	it('never says the user may be asked when it moves from one announced mode to another', () => {
		let messages = turn([], 'bypass')
		messages = turn(messages, 'classify')
		const said = texts(messages)
		expect(said).toHaveLength(2)
		expect(said[1]).toContain(
			'The bypass permission mode has ended and the auto permission mode is on.',
		)
		expect(said.join('\n')).not.toContain('may be asked')
	})

	it.each([
		['accept-edits', 'strict', 'accept-edits', 'strict'],
		['auto', 'accept-edits', 'unattended', 'accept-edits'],
		['bypass', 'classify', 'bypass', 'auto'],
		['classify', 'bypass', 'auto', 'bypass'],
	] as const)(
		'names both modes when %s gives way to %s, the ended one first',
		(from, to, ended, began) => {
			let messages = turn([], from)
			messages = turn(messages, to)
			messages = turn(messages, to)
			const said = texts(messages)
			expect(said).toHaveLength(2)
			const change = said[1] as string
			expect(change).toContain(
				`The ${ended} permission mode has ended and the ${began} permission mode is on.`,
			)
			expect(change.indexOf('has ended')).toBeLessThan(change.indexOf('is on.'))
			expect(change).toContain('safety rules')
		},
	)

	it('names plan mode as the one that ended when an announced mode follows it', () => {
		const planned = [
			...turn([], 'plan'),
			createRuntimeContextMessage(
				'<system-reminder kind="plan-mode" form="full">\nPlan mode is on.\n</system-reminder>',
				'reminder',
			),
		]
		const said = texts(turn(planned, 'bypass'))
		expect(said.at(-1)).toContain('Plan mode has ended and the bypass permission mode is on.')
		expect(said.at(-1)).toContain('safety rules')
	})

	it('leaves the end of plan mode to its own notice when no announced mode follows', () => {
		const planned = [
			createUserMessage('go'),
			createRuntimeContextMessage(
				'<system-reminder kind="plan-mode" form="full">\nPlan mode is on.\n</system-reminder>',
				'reminder',
			),
		]
		expect(texts(turn(planned, 'prompt')).length).toBe(1)
	})

	it('announces a mode again after the earlier announcement is gone from the conversation', () => {
		expect(texts(turn([createUserMessage('summary')], 'classify'))).toHaveLength(1)
	})

	it('says a call that would ask is refused when nobody is at the terminal', () => {
		const said = texts(turn([], 'accept-edits', false))
		expect(said[0]).toContain('Nobody is at the terminal')
	})
})
