import type { Message, SessionRecord } from '@namzu/sdk'

/**
 * The journal a folded conversation was read from.
 *
 * A resumed conversation is drawn from its messages, but the messages do not
 * keep what the screen showed of a tool call (the typed facts, the timings)
 * or where a turn began and ended. The journal does. The loader that folds the
 * messages leaves the records here, keyed by the message list it returned, so
 * a caller that only asked for messages can still ask for the journal behind
 * them. The entry goes when the list does.
 */
const journals = new WeakMap<readonly Message[], readonly SessionRecord[]>()

/** Called by the loader with the list it is about to return. */
export function rememberJournal(
	messages: readonly Message[],
	records: readonly SessionRecord[],
): void {
	journals.set(messages, records)
}

/** The journal a message list was folded from, when it came from the loader. */
export function journalOf(messages: readonly Message[]): readonly SessionRecord[] | undefined {
	return journals.get(messages)
}
