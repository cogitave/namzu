/** In-process rejection of a metadata read invalidated by its owner's model selection. */
export class SupersededConversationSettingsError extends Error {
	override readonly name = 'SupersededConversationSettingsError'
	constructor() {
		super('The settings for this conversation changed while they were loading.')
	}
}

/** The conversation's project, client or runtime was replaced while a metadata read was in flight. */
export class ConversationHostChangedError extends Error {
	override readonly name = 'ConversationHostChangedError'
	constructor() {
		super('Namzu couldn’t load the settings for this conversation. Try again.')
	}
}

/** How many times one read starts over because a newer selection overtook it. */
export const SUPERSEDED_READ_LIMIT = 8

/**
 * Runs a metadata read so that a person never sees it overtaken. A read that a newer model or engine
 * selection overtook waits for that selection to settle and runs again against the current choice. A
 * read whose host was replaced runs once more against the new host. Only a failure that survives
 * both reaches the caller, and then as a plain sentence.
 */
export async function readCurrent<T>(
	read: () => Promise<T>,
	selectionSettled: () => Promise<void> | undefined,
): Promise<T> {
	let overtaken = 0
	let hostRetried = false
	for (;;) {
		try {
			return await read()
		} catch (error) {
			if (error instanceof SupersededConversationSettingsError) {
				if (overtaken++ >= SUPERSEDED_READ_LIMIT) throw new ConversationHostChangedError()
				await selectionSettled()
				continue
			}
			if (error instanceof ConversationHostChangedError && !hostRetried) {
				hostRetried = true
				continue
			}
			throw error
		}
	}
}
