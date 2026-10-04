/** In-process rejection of a metadata read invalidated by its owner's model selection. */
export class SupersededConversationSettingsError extends Error {
	override readonly name = 'SupersededConversationSettingsError'
	constructor() {
		super('The conversation settings changed while loading. Retry this request.')
	}
}
