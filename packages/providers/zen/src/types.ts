import type { ZenCatalogue } from './catalogue/catalogue.js'
import type { ZenProtocol } from './models.js'

export interface ZenConfig {
	/** Omit for a listed free Zen model; `public` selects the same experimental path. */
	apiKey?: string
	/** Stable conversation identity, shared by every turn and auxiliary request. */
	sessionId?: string
	/** Defaults to Space Bunny Free anonymously, or glm-5.3-flash with an API key. */
	model?: string
	/** Override the service base URL, primarily for a host-owned proxy. */
	baseURL?: string
	/** Whole request timeout in milliseconds. Defaults to 120000. */
	timeout?: number
	/** Explicit wire format for a model absent from the catalogue. */
	protocol?: ZenProtocol
	/**
	 * A runtime catalogue, from `@namzu/zen/catalogue`, consulted before the
	 * bundled snapshot for every lookup: routing, model listing, context windows
	 * and effort levels. Anonymous admission requires a zero price in the
	 * catalogue; a catalogue cannot add a model the service does not route. A function is called
	 * at each lookup, so a host can swap in a fresher catalogue for providers it
	 * already built. Returning `undefined` means the bundled snapshot alone.
	 * Omitted, the provider uses the bundled snapshot and fetches nothing.
	 */
	catalogue?: ZenCatalogue | (() => ZenCatalogue | undefined)
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
