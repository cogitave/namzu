import type { ZenProtocol } from './models.js'

export interface ZenConfig {
	apiKey: string
	/** Stable conversation identity, shared by every turn and auxiliary request. */
	sessionId?: string
	/** Default model. Defaults to glm-5.3-flash. */
	model?: string
	/** Override the service base URL, primarily for a host-owned proxy. */
	baseURL?: string
	/** Whole request timeout in milliseconds. Defaults to 120000. */
	timeout?: number
	/** Explicit wire format for a model absent from the bundled catalogue. */
	protocol?: ZenProtocol
}

export interface ZenProviderConfig extends ZenConfig {
	type: 'zen'
}

export interface ZenGoProviderConfig extends ZenConfig {
	type: 'zen-go'
}
