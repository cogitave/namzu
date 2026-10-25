import type { Message } from '@namzu/sdk'
import { isReminderMessage } from '@namzu/sdk'

/**
 * The hidden reminders this terminal feeds a turn (`QueryParams.reminders`).
 *
 * Each is one user-role runtime-context message whose text opens with a tag
 * line naming what it is. The tag is how a later request finds the reminders
 * it has already sent: the conversation is the only record, so a resumed or
 * compacted conversation needs no counter of its own.
 */
export type ReminderKind =
	| 'plan-mode'
	| 'plan-reentry'
	| 'plan-exit'
	| 'task-nudge'
	| 'hypermode-on'
	| 'hypermode-exit'

const TAG = /^<system-reminder kind="([a-z-]+)"(?: form="([a-z]+)")?>/

export function frameReminder(kind: ReminderKind, text: string, form?: 'full' | 'sparse'): string {
	const open = form
		? `<system-reminder kind="${kind}" form="${form}">`
		: `<system-reminder kind="${kind}">`
	return `${open}\n${text.trim()}\n</system-reminder>`
}

/** Which of this terminal's reminders a message is, or `undefined` for any other message. */
export function reminderKindOf(message: Message): ReminderKind | undefined {
	if (!isReminderMessage(message) || typeof message.content !== 'string') return undefined
	const kind = TAG.exec(message.content)?.[1]
	return kind === 'plan-mode' ||
		kind === 'plan-reentry' ||
		kind === 'plan-exit' ||
		kind === 'task-nudge' ||
		kind === 'hypermode-on' ||
		kind === 'hypermode-exit'
		? kind
		: undefined
}

/**
 * A message the operator authored in this conversation, as opposed to context
 * the runtime inserted in the user role. A request counts as a new turn only
 * for these.
 */
export function isOperatorTurn(message: Message): boolean {
	if (message.role !== 'user') return false
	const source = message.source
	return (
		source === undefined ||
		source.type === 'goal-round' ||
		(source.type === 'runtime-context' && source.kind === 'steering')
	)
}
