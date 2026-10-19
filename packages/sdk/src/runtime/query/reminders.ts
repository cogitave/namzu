import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'

/**
 * What a reminder source is told when the kernel asks it for hidden reminders.
 */
export interface ReminderContext {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	/** The model request about to be made; 1 for the first of the turn. */
	readonly iteration: number
	/**
	 * The conversation as it stands, reminders included. Read-only: a source
	 * derives its cadence from this (how many assistant turns since it last
	 * spoke), so a resumed or compacted conversation needs no counter of its own.
	 */
	readonly messages: readonly Message[]
}

/**
 * A host's hidden reminders for the next model request.
 *
 * The kernel calls it once at the start of every model request of a turn
 * (never the closing one) and appends each returned text to the conversation
 * as a user-role message with provenance `{ type: 'runtime-context', kind:
 * 'reminder' }`. The message is part of the durable history, so it is not
 * operator input, never counts as the latest user request, and is not shown as
 * something the operator typed. The channel is opt-in
 * (`QueryParams.reminders`): a turn without a source behaves as before.
 *
 * A source that throws is treated as having nothing to say; a reminder is
 * context, and a fault in one must not end a turn.
 */
export type ReminderSource = (
	context: ReminderContext,
) => readonly string[] | undefined | Promise<readonly string[] | undefined>

/** Whether a message is a reminder the kernel appended for a {@link ReminderSource}. */
export function isReminderMessage(message: Message): boolean {
	return (
		message.role === 'user' &&
		message.source?.type === 'runtime-context' &&
		message.source.kind === 'reminder'
	)
}
