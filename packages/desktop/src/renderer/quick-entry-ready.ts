/**
 * Whether a new conversation is ready to send the line typed into the Quick Entry box. A conversation
 * that was just made reads its saved choices and attachments for a moment, and has no model chosen
 * until that ends; sending before then does nothing, so the line waits for it.
 */
export function quickEntryReadyToSend(state: {
	savedChoicesLoading: boolean
	attachmentsLoaded: boolean
	hasModel: boolean
	modelReady: boolean
}): boolean {
	return !state.savedChoicesLoading && state.attachmentsLoaded && state.hasModel && state.modelReady
}
