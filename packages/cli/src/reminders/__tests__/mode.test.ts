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
		['auto', 'Nobody is asked'],
		[
			'accept-edits',
			'File edits and simple file commands in the working directory run without asking',
		],
		['bypass', 'Permission prompts are off in this mode'],
	] as const)('announces %s once, in that mode’s own words', (mode, sentence) => {
		let messages = turn([], mode)
		messages = turn(messages, mode)
		messages = turn(messages, mode)
		const said = texts(messages)
		expect(said).toHaveLength(1)
		expect(said[0]).toContain(`The ${mode} permission mode is on.`)
		expect(said[0]).toContain(sentence)
	})

	it.each(['prompt', 'plan', 'classify', 'strict'] as const)('says nothing under %s', (mode) => {
		expect(texts(turn([], mode))).toEqual([])
	})

	it('announces the end of a mode once, and never says a safety rule was relaxed', () => {
		let messages = turn([], 'bypass')
		messages = turn(messages, 'prompt')
		messages = turn(messages, 'prompt')
		const said = texts(messages)
		expect(said).toHaveLength(2)
		expect(said[1]).toContain('The bypass permission mode has ended.')
		expect(said[1]).toContain('the user may be asked')
		for (const text of said) expect(text).not.toMatch(/relax|no longer apply|disabled|ignore/i)
		expect(said[0]).toContain('safety rules')
	})

	it('moves straight from one announced mode to another with the new one', () => {
		let messages = turn([], 'accept-edits')
		messages = turn(messages, 'auto')
		const said = texts(messages)
		expect(said).toHaveLength(2)
		expect(said[1]).toContain('The auto permission mode is on.')
	})

	it('announces a mode again after the earlier announcement is gone from the conversation', () => {
		expect(texts(turn([createUserMessage('summary')], 'auto'))).toHaveLength(1)
	})

	it('says a call that would ask is refused when nobody is at the terminal', () => {
		const said = texts(turn([], 'accept-edits', false))
		expect(said[0]).toContain('Nobody is at the terminal')
	})
})
