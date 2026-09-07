import type { ZenProtocol } from './models.js'

export interface ZenConfig {
	/** Omit for documented free Zen models. The public sentinel also selects anonymous access. */
	apiKey?: string
	/** Stable conversation identity, shared by every turn and auxiliary request. */
	sessionId?: string
	/** Defaults to free Muse Spark 1.3 anonymously, or glm-5.3-flash with an API key. */
	model?: string
	/** Override the service base URL, primarily for a host-owned proxy. */
	baseURL?: string
	/** Whole request timeout in milliseconds. Defaults to 120000. */
	timeout?: number
	/** Explicit wire format for a model absent from the bundled catalogue. */
	protocol?: ZenProtocol
}

/** Go subscriptions require a real API key; anonymous Zen access does not apply. */
export interface ZenGoConfig extends ZenConfig {
	apiKey: string
}

export interface ZenProviderConfig extends ZenConfig {
	type: 'zen'
}

export interface ZenGoProviderConfig extends ZenGoConfig {
	type: 'zen-go'
}
