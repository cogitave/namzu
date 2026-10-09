import type { PalInboxView } from '../shared/pal-communication-protocol.js'
import type { ChatMessage } from '../shared/protocol.js'

/** A message the person sent to a Pal from one of their own conversations. */
export interface PalOperatorMessage {
	id: string
	text: string
	status: PalInboxView['status']
	/** When the Pal's inbox accepted it, in epoch milliseconds; unknown when never recorded. */
	at?: number
	operatorSessionId?: string
}

/** The owner's own messages in an inbox, oldest first. Other senders' text never reaches the renderer. */
export function operatorMessages(messages: readonly PalInboxView[]): PalOperatorMessage[] {
	return messages
		.flatMap((message) =>
			message.sourceKind === 'operator-conversation' && message.text
				? [
						{
							id: message.id,
							text: message.text,
							status: message.status,
							...(message.receivedAt === undefined ? {} : { at: message.receivedAt }),
							...(message.operatorSessionId
								? { operatorSessionId: message.operatorSessionId }
								: {}),
						},
					]
				: [],
		)
		.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER))
}

export type PalChatItem<Row> =
	| { kind: 'row'; row: Row }
	| { kind: 'operator'; message: PalOperatorMessage }

/**
 * The Pal's own chat rows with the person's quoted messages placed by time. A message with no
 * recorded time goes after everything else; a row with no time keeps its place after the rows
 * before it, so the conversation never reorders itself.
 */
export function interleavePalChat<Row extends { message: Pick<ChatMessage, 'time'> }>(
	rows: readonly Row[],
	received: readonly PalOperatorMessage[],
): PalChatItem<Row>[] {
	const result: PalChatItem<Row>[] = []
	let next = 0
	const pending = [...received]
	const flushBefore = (at: number | undefined) => {
		while (next < pending.length) {
			const message = pending[next]
			if (!message || message.at === undefined || at === undefined || message.at > at) return
			result.push({ kind: 'operator', message })
			next++
		}
	}
	for (const row of rows) {
		flushBefore(row.message.time?.at)
		result.push({ kind: 'row', row })
	}
	while (next < pending.length) {
		const message = pending[next++]
		if (message) result.push({ kind: 'operator', message })
	}
	return result
}
