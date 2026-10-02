import type { PalAddress } from '../communication/types.js'
import type { PalActivityCursor, PalActivityFact, PalActivityScope } from './types.js'

/** Host-owned, immutable observation scope and destination, with separately revocable consent. */
export interface PalActivitySubscription {
	readonly v: 1
	readonly id: string
	readonly revision: number
	readonly configurationRevision: number
	readonly scope: PalActivityScope
	readonly recipient: PalAddress
	readonly enabled: boolean
	readonly cursor: PalActivityCursor | null
}

export interface PalActivitySubscriptionStore {
	get(id: string): Promise<PalActivitySubscription | null>
	create(input: {
		readonly id: string
		readonly scope: PalActivityScope
		readonly recipient: PalAddress
		readonly enabled: boolean
	}): Promise<PalActivitySubscription>
	setEnabled(input: {
		readonly id: string
		readonly expectedRevision: number
		readonly enabled: boolean
	}): Promise<PalActivitySubscription>
	/** Only an unchanged cursor emitted by the trusted original-journal source may be committed. */
	advance(
		subscription: PalActivitySubscription,
		cursor: PalActivityCursor,
	): Promise<PalActivitySubscription>
}

export interface PalActivitySubscriptionAuthorizationRequest {
	/** `accept` requires observe, disclose and receive together immediately before inbox acceptance. */
	readonly phase: 'observe' | 'disclose' | 'receive' | 'accept'
	readonly subscription: PalActivitySubscription
	readonly fact?: PalActivityFact
}

export interface PalActivitySubscriptionResult {
	readonly subscription: PalActivitySubscription
	readonly accepted: readonly string[]
	readonly suppressed: readonly string[]
	readonly complete: boolean
}
