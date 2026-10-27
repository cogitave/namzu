import type { Message } from '@namzu/sdk'

import { permissionSentence } from '../context/environment.js'
import type { PermissionMode } from '../permissions/mode.js'
import { type ReminderKind, frameReminder, reminderKindOf } from './frame.js'

/**
 * What the model is told about the permission mode, turn by turn.
 *
 * The cached system prompt states the permission rules without a mode, so a
 * Shift+Tab does not re-key it. Every mode but the usual one (`prompt`) is
 * announced the first time a request runs under it, and its end is announced
 * once; plan mode has its own reminders. The person's word `auto` is the
 * kernel's `classify`; the kernel's own `auto` is the unattended default and
 * is announced as such. None of the texts relaxes a safety rule: a mode
 * changes who is asked, never what is checked.
 */
type ModeKind = Extract<
	ReminderKind,
	'mode-auto' | 'mode-unattended' | 'mode-accept-edits' | 'mode-bypass' | 'mode-strict'
>

const KIND_OF: Readonly<Partial<Record<PermissionMode, ModeKind>>> = {
	classify: 'mode-auto',
	auto: 'mode-unattended',
	'accept-edits': 'mode-accept-edits',
	bypass: 'mode-bypass',
	strict: 'mode-strict',
}

const NAME_OF: Readonly<Record<ModeKind, string>> = {
	'mode-auto': 'auto',
	'mode-unattended': 'unattended',
	'mode-accept-edits': 'accept-edits',
	'mode-bypass': 'bypass',
	'mode-strict': 'strict',
}

const SAFETY = 'The safety rules are the same in every mode.'

export interface ModeReminderInput {
	readonly messages: readonly Message[]
	readonly mode: PermissionMode
	/** Whether a person answers the permission prompts in this session. */
	readonly interactive: boolean
}

function announced(mode: PermissionMode): ModeKind | undefined {
	return KIND_OF[mode]
}

const MODE_KINDS: ReadonlySet<ReminderKind> = new Set<ReminderKind>(Object.values(KIND_OF))

/** What the conversation last said about the mode: one of ours, plan mode, or nothing. */
type Said = ModeKind | 'mode-exit' | 'plan' | undefined

/** The latest thing said about a mode in this conversation. */
function lastSaid(messages: readonly Message[]): Said {
	for (let i = messages.length - 1; i >= 0; i--) {
		const kind = reminderKindOf(messages[i] as Message)
		if (kind === undefined) continue
		if (MODE_KINDS.has(kind)) return kind as ModeKind
		if (kind === 'mode-exit') return kind
		// An open plan stretch is a mode that is on; plan mode's own notices speak for its end.
		if (kind === 'plan-mode' || kind === 'plan-reentry') return 'plan'
		if (kind === 'plan-exit') return undefined
	}
	return undefined
}

/** The mode that ended, in the words the notice uses for it. */
function endedName(last: ModeKind): string {
	return `The ${NAME_OF[last]} permission mode`
}

/** What goes on after a mode ends, said for the mode it lands in. */
function exitSentence(landing: PermissionMode): string {
	switch (landing) {
		case 'plan':
			return 'Plan mode is on, and its own notices say what it allows.'
		case 'prompt':
			return 'Shell commands and file changes go through the permission settings again, and the user may be asked before they run.'
		default:
			return 'Shell commands and file changes go through the permission settings again.'
	}
}

/**
 * The reminders to append before the next request; empty when there is nothing to say.
 *
 * A change from one mode to another is one notice that says which mode ended
 * and which began, the ending first. Plan mode's own end is announced by its
 * own notice, which the caller places ahead of this one; the notice that
 * follows it says only what is on now.
 */
export function modeReminders(input: ModeReminderInput): string[] {
	const wanted = announced(input.mode)
	const last = lastSaid(input.messages)
	if (wanted === undefined) {
		if (last === undefined || last === 'mode-exit' || last === 'plan') return []
		return [
			frameReminder(
				'mode-exit',
				`${endedName(last)} has ended. ${exitSentence(input.mode)} ${SAFETY}`,
			),
		]
	}
	if (last === wanted) return []
	const sentence = permissionSentence({
		escape: 'refused',
		interactive: input.interactive,
		mode: input.mode,
	})
	const began = `The ${NAME_OF[wanted]} permission mode is on.`
	// Plan mode's own exit notice is sent in the same batch, so this one says only what is on now.
	const opening =
		last === undefined || last === 'mode-exit' || last === 'plan'
			? began
			: `${endedName(last)} has ended and the ${NAME_OF[wanted]} permission mode is on.`
	return [frameReminder(wanted, `${opening} ${sentence} ${SAFETY}`)]
}
