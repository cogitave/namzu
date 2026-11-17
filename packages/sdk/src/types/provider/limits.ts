/**
 * What a provider can say about the account behind its credential: how much of a usage window is
 * used, or what credit is left. Every field is something the vendor reported; nothing here is a
 * guess, and a driver that does not know returns nothing at all rather than a zero.
 */

/** One usage window of a subscription, such as the last five hours. */
export interface ProviderLimitWindow {
	/** A short name the person reads, such as "5-hour limit". */
	label: string
	/** How much of the window is used, 0 to 1, as the vendor gave it. */
	usedFraction: number
	/** When the window resets, in milliseconds since the epoch. */
	resetsAt?: number
	/** The vendor refused requests because this window is used up. */
	rejected?: boolean
}

/** Money or credit the vendor reports for the account or key. */
export interface ProviderLimitCredit {
	/** ISO 4217 code ("USD", "CNY"), or "credits" where the vendor counts in its own unit. */
	currency: string
	used?: number
	limit?: number
	remaining?: number
}

export interface ProviderLimits {
	windows?: readonly ProviderLimitWindow[]
	credit?: ProviderLimitCredit
	/** The plan's name, only when the vendor gives one. */
	plan?: string
	/** When this was read, in milliseconds since the epoch. */
	asOf: number
}
