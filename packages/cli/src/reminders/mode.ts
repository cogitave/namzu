import type { Message } from '@namzu/sdk'

import { permissionSentence } from '../context/environment.js'
import type { PermissionMode } from '../permissions/mode.js'
import { type ReminderKind, frameReminder, reminderKindOf } from './frame.js'

/**
 * What the model is told about the permission mode, turn by turn.
 *
 * The cached system prompt states the permission rules without a mode, so a
 * Shift+Tab does not re-key it. A mode that changes what the model can expect
 * (`auto`, `accept-edits`, `bypass`) is announced the first time a request
 * runs under it, and its end is announced once. Plan mode has its own
 * reminders. None of the texts relaxes a safety rule: a mode changes who is
 * asked, never what is checked.
 */
type AnnouncedMode = 'auto' | 'accept-edits' | 'bypass'
type ModeKind = Extract<ReminderKind, 'mode-auto' | 'mode-accept-edits' | 'mode-bypass'>

const KIND_OF: Readonly<Record<AnnouncedMode, ModeKind>> = {
	auto: 'mode-auto',
	'accept-edits': 'mode-accept-edits',
	bypass: 'mode-bypass',
}

const NAME_OF: Readonly<Record<ModeKind, string>> = {
	'mode-auto': 'auto',
	'mode-accept-edits': 'accept-edits',
	'mode-bypass': 'bypass',
}

const SAFETY = 'The safety rules are the same in every mode.'

export interface ModeReminderInput {
	readonly messages: readonly Message[]
	readonly mode: PermissionMode
	/** Whether a person answers the permission prompts in this session. */
	readonly interactive: boolean
}

function announced(mode: PermissionMode): ModeKind | undefined {
	return mode === 'auto' || mode === 'accept-edits' || mode === 'bypass' ? KIND_OF[mode] : undefined
}

/** The latest thing said about a mode in this conversation. */
function lastSaid(messages: readonly Message[]): ReminderKind | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const kind = reminderKindOf(messages[i] as Message)
		if (kind === 'mode-auto' || kind === 'mode-accept-edits' || kind === 'mode-bypass') return kind
		if (kind === 'mode-exit') return kind
	}
	return undefined
}

/** The reminders to append before the next request; empty when there is nothing to say. */
export function modeReminders(input: ModeReminderInput): string[] {
	const wanted = announced(input.mode)
	const last = lastSaid(input.messages)
	if (wanted === undefined) {
		if (last === undefined || last === 'mode-exit') return []
		return [
			frameReminder(
				'mode-exit',
				`The ${NAME_OF[last as ModeKind]} permission mode has ended. Shell commands and file changes go through the permission settings again, and the user may be asked before they run. ${SAFETY}`,
			),
		]
	}
	if (last === wanted) return []
	const sentence = permissionSentence({
		escape: 'refused',
		interactive: input.interactive,
		mode: input.mode,
	})
	return [
		frameReminder(wanted, `The ${NAME_OF[wanted]} permission mode is on. ${sentence} ${SAFETY}`),
	]
}
