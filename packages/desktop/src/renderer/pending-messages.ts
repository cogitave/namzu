import type { ThreadState } from '../shared/projection.js'
import type { AttachmentView } from '../shared/protocol.js'

/**
 * Messages typed while a reply runs, as the rows drawn at the end of the conversation. The ones sent
 * into the running reply come first, then the ones that wait for it to finish, in the order they will
 * be used, as the terminal draws them.
 */
export interface PendingRow {
	id: string
	kind: 'steer' | 'queued'
	text: string
	attachments?: AttachmentView[]
	/** What the row says about itself in plain words, under the message. */
	note: string
	/** A message already handed to the reply cannot be taken back or changed. */
	editable: boolean
}

export interface PendingMessages {
	rows: PendingRow[]
	/** Why waiting messages are not starting, once the reply that held them has stopped. */
	hold?: string
}

/** The tray grows with its rows up to this many, then scrolls. */
export const TRAY_VISIBLE_ROWS = 4

export const SENDING_NOTE = 'Sending to this reply'
export const UNCONFIRMED_NOTE = 'Delivery not confirmed'
export const AFTER_REPLY_NOTE = 'After this reply'
export const WAITING_NOTE = 'Waiting'

function holdText(thread: Pick<ThreadState, 'stopReason'>): string {
	return thread.stopReason === 'error'
		? 'Paused after the failed reply · send a message to run them'
		: 'Paused after the stopped reply · send a message to run them'
}

export function pendingMessages(
	thread: Pick<ThreadState, 'running' | 'stopReason' | 'liveInputs' | 'queuedItems'>,
): PendingMessages {
	const parked =
		!thread.running && thread.queuedItems.length > 0 && thread.stopReason !== 'end_turn'
	const steers: PendingRow[] = thread.running
		? thread.liveInputs
				.filter((item) => item.status !== 'delivered')
				.map((item) => ({
					id: item.id,
					kind: 'steer' as const,
					text: item.prompt,
					note: item.status === 'unknown' ? UNCONFIRMED_NOTE : SENDING_NOTE,
					editable: false,
				}))
		: []
	const queued: PendingRow[] = thread.queuedItems.map((item) => ({
		id: item.id,
		kind: 'queued' as const,
		text: item.prompt,
		...(item.attachments?.length ? { attachments: item.attachments } : {}),
		note: parked ? WAITING_NOTE : AFTER_REPLY_NOTE,
		editable: true,
	}))
	return {
		rows: [...steers, ...queued],
		...(parked ? { hold: holdText(thread) } : {}),
	}
}
