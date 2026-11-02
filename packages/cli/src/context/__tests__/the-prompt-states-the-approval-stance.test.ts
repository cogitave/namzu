import { type Message, createRuntimeContextMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { PermissionMode } from '../../permissions/mode.js'
import { reminderKindOf } from '../../reminders/frame.js'
import { modeReminders } from '../../reminders/mode.js'
import {
	type SessionPromptInput,
	composeSessionSystemPrompt,
	sessionPromptInput,
} from '../system-prompt.js'

// The stance (what a refused call is followed by) rides in the mode notice, not
// in the cached system prompt, so a mode switch never leaves a stale sentence
// in the prefix.
const STANCES = {
	strict: 'refused without asking anyone',
	classify: 'do not ask the user to approve it',
	auto: 'not a request for approval',
} as const

const base: SessionPromptInput = sessionPromptInput(
	{ environment: 'ENVIRONMENT', anyToolDeferred: false },
	{ resident: false, workflowOffered: false },
)

/** One turn under `mode`, with the reminders the host owed it. */
function turn(history: Message[], mode: PermissionMode): Message[] {
	const out = [...history, createUserMessage('go')]
	for (const text of modeReminders({ messages: out, mode, interactive: true })) {
		out.push(createRuntimeContextMessage(text, 'reminder'))
	}
	return out
}

const said = (messages: readonly Message[]) =>
	messages.filter((m) => reminderKindOf(m) !== undefined).map((m) => m.content as string)

describe('the approval stance', () => {
	it.each(Object.entries(STANCES))(
		'is told on the first request of a session that starts in %s',
		(mode, sentence) => {
			const notices = said(turn([], mode as PermissionMode))
			expect(notices).toHaveLength(1)
			expect(notices[0]).toContain(sentence)
			expect(notices[0]).not.toContain('\n\n')
		},
	)

	it.each(['strict', 'classify', 'auto', 'prompt', 'bypass', 'accept-edits'])(
		'is not in the system prompt under %s',
		(mode) => {
			const text = composeSessionSystemPrompt({ ...base, permissionMode: mode }) ?? ''
			for (const sentence of Object.values(STANCES)) expect(text).not.toContain(sentence)
			expect(text).toBe(composeSessionSystemPrompt({ ...base, permissionMode: 'prompt' }))
		},
	)

	it('leaves nothing behind when a session that started in strict switches to the default mode', () => {
		const started = composeSessionSystemPrompt({ ...base, permissionMode: 'strict' })
		const switched = composeSessionSystemPrompt({ ...base, permissionMode: 'prompt' })
		expect(switched).toBe(started)
		for (const sentence of Object.values(STANCES)) expect(switched).not.toContain(sentence)

		const notices = said(turn(turn([], 'strict'), 'prompt'))
		expect(notices).toHaveLength(2)
		expect(notices[0]).toContain(STANCES.strict)
		expect(notices[1]).toContain('The strict permission mode has ended.')
		expect(notices[1]).toContain('the user may be asked')
		expect(notices[1]).not.toContain(STANCES.strict)
	})
})
