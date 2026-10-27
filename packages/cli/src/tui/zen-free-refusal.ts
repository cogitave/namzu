/**
 * Zen answers a keyless free-model request with HTTP 403 and a body saying the free tier is not
 * available to this client. Nothing about the person's key is wrong (none was sent), so the
 * screens say that Zen did not accept the free model and offer the ways on, and keep the
 * service's own words for the Details / debug view.
 */

import { isExperimentalFreeZenModel } from '@namzu/zen/catalogue'

import { findActiveZenModel } from '../integrations/providers/zen-catalogue.js'

/** What happened, in the words a person reads. */
export const ZEN_FREE_REFUSED_WHAT = 'Zen didn’t accept the free model right now.'

/** What to do, for a surface with a model picker command. */
export const ZEN_FREE_REFUSED_NEXT =
	'Try again in a while, or choose another provider. A Zen API key also works.'

/** Exactly the keyless free-tier refusal; any other 403 keeps its own copy. */
export function isZenFreeTierRefusal(facts: {
	readonly providerId?: string | undefined
	readonly status?: number | undefined
	readonly detail?: string | undefined
}): boolean {
	return (
		facts.providerId === 'zen' && facts.status === 403 && /free[- ]?tier/i.test(facts.detail ?? '')
	)
}

/** What a person reads when a free Zen model has no allowance left for now. */
export const ZEN_FREE_LIMITED_WHAT = 'The free allowance for this model is used up for now.'

/**
 * Zen answered a free model with a rate limit. The allowance is per model, so
 * another free model, another provider or a Zen API key is the way on, and
 * waiting is the other. False when the model is not known to be a free one: a
 * paid model's rate limit keeps the ordinary wording.
 */
export function isZenFreeTierLimit(facts: {
	readonly providerId?: string | undefined
	readonly model?: string | undefined
}): boolean {
	if (facts.providerId !== 'zen' || !facts.model) return false
	return isExperimentalFreeZenModel('zen', findActiveZenModel('zen', facts.model))
}
