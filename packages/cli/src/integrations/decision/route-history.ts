/**
 * What `model: auto` remembers between two turns of one conversation: the tier
 * the last turn ran on, and whether that turn failed on it, so the next turn
 * can climb one tier (`RouteFeatures.previousTurnFailedOnTier`).
 *
 * Kept per conversation, never shared: a failure in one conversation says
 * nothing about the tier's fitness for another. A flag is consumed by the very
 * next routing call whether or not it is used, so a failure can escalate one
 * turn and no more, and a turn that was never routed leaves nothing behind.
 */

import type { StopReason } from '@namzu/sdk'
import type { RouteTier } from './routing.js'

/** How a turn ended, narrowed to the fields that say whether the tier failed it. */
export type TurnEnd =
	| { readonly kind: 'done'; readonly stopReason?: StopReason }
	| {
			readonly kind: 'error'
			readonly providerError?: unknown
			readonly failure?: { readonly code: string }
			readonly turnInProgress?: unknown
	  }

/**
 * Whether a turn's end is a failure of the model it ran on. Only a provider or
 * model error is: the person interrupting, a refused permission, a budget or
 * iteration stop, a guardrail and a model's own refusal say nothing a bigger
 * model would fix, and an error that never reached a model (the conversation
 * already had a turn running, a credential that would not load) is not the
 * tier's either. `aborted` is the caller's signal, because a cancelled turn can
 * still surface as an error event.
 */
export function failedOnItsModel(end: TurnEnd, aborted: boolean): boolean {
	if (aborted) return false
	if (end.kind === 'done') return end.stopReason === 'error'
	if (end.turnInProgress !== undefined) return false
	return end.providerError !== undefined || end.failure?.code === 'provider_error'
}

export interface RouteHistory {
	/** The turn about to run was routed to `tier`. Replaces whatever was there. */
	ran(conversation: string, tier: RouteTier): void
	/** The routed turn ended; records a failure only for a turn that was routed. */
	settle(conversation: string, failed: boolean): void
	/** The tier the last turn failed on, once: reading it clears it. */
	take(conversation: string): RouteTier | undefined
	/** Drop the conversation's memory: a turn ran that routing did not choose. */
	forget(conversation: string): void
}

export function createRouteHistory(): RouteHistory {
	const last = new Map<string, { readonly tier: RouteTier; failed: boolean }>()
	return {
		ran: (conversation, tier) => {
			last.set(conversation, { tier, failed: false })
		},
		settle: (conversation, failed) => {
			const entry = last.get(conversation)
			if (entry && failed) entry.failed = true
		},
		take: (conversation) => {
			const entry = last.get(conversation)
			last.delete(conversation)
			return entry?.failed ? entry.tier : undefined
		},
		forget: (conversation) => {
			last.delete(conversation)
		},
	}
}
